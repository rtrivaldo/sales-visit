import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { readJSON, cloudflare } from "./ci/targets.mjs";
import {
  fixtureState,
  tables,
  keyOf,
  canonical,
  migrationFiles,
  snapshotQueries,
  reconcile,
} from "./demo-fixtures.mjs";

const development = {
  id: "66aadb98-21f9-413e-8646-7347555b2268",
  name: "sales-visit-dev",
};
export function validateRefreshTarget(target, config, production, env) {
  if (!["local", "dev"].includes(target))
    throw new Error(
      "Only local and Development are supported; Production is forbidden"
    );
  for (const name of [
    "WRANGLER_ENV",
    "WRANGLER_CONFIG",
    "WRANGLER_CI_OVERRIDE_NAME",
    "CF_ACCOUNT_ID",
    "CF_API_KEY",
    "CLOUDFLARE_API_KEY",
  ])
    if (env[name]) throw new Error("Environment overrides are forbidden");
  if (config.env || config.routes || config.d1_databases?.length !== 1)
    throw new Error("Unexpected database configuration");
  const db = config.d1_databases[0];
  if (
    db.binding !== "DB" ||
    db.migrations_dir !== "../../packages/db/migrations" ||
    Object.keys(db).some(
      (k) =>
        !["binding", "database_name", "database_id", "migrations_dir"].includes(
          k
        )
    )
  )
    throw new Error("Unexpected D1 binding");
  if (
    target === "dev" &&
    (config.name !== "sales-visit-api-dev" ||
      config.vars?.APP_ENV !== "staging" ||
      config.vars?.DEMO_AUTH_ENABLED !== "true" ||
      db.database_name !== development.name ||
      db.database_id !== development.id ||
      production.d1_databases.some((d) => d.database_id === db.database_id))
  )
    throw new Error("Refusing non-Development target");
  if (config.account_id && config.account_id !== env.CLOUDFLARE_ACCOUNT_ID)
    throw new Error("Cloudflare account mismatch");
  return db;
}
export async function refresh({
  target,
  apply = false,
  confirm,
  now = Date.now(),
  env = process.env,
  execute,
  inspect,
  output = console.log,
}) {
  const config = readJSON(
      `apps/api/wrangler${target === "dev" ? ".dev" : ""}.jsonc`
    ),
    production = readJSON("apps/api/wrangler.jsonc");
  const db = validateRefreshTarget(target, config, production, env);
  let remoteApi;
  if (target === "dev") {
    if (apply && confirm !== development.name)
      throw new Error(
        "Use --apply --confirm=sales-visit-dev after reviewing the preview"
      );
    const api =
      inspect ??
      cloudflare(env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_API_TOKEN);
    remoteApi = api;
    const account = await api("");
    if (account.id !== env.CLOUDFLARE_ACCOUNT_ID)
      throw new Error("Cloudflare account mismatch");
    const actual = await api(`/d1/database/${db.database_id}`);
    if (actual.uuid !== development.id || actual.name !== development.name)
      throw new Error("Remote D1 identity mismatch");
  }
  const dir = mkdtempSync(join(tmpdir(), "sales-visit-demo-refresh-"));
  try {
    const empty = join(dir, "empty.env");
    writeFileSync(empty, "");
    let sequence = 0;
    const run =
      execute ??
      (async (sql, write = false) => {
        if (target === "dev" && !write)
          return remoteApi(`/d1/database/${db.database_id}/query`, { sql });
        if (target === "dev")
          validateRefreshTarget(
            target,
            readJSON("apps/api/wrangler.dev.jsonc"),
            production,
            env
          );
        const file = join(dir, `batch-${++sequence}.sql`);
        writeFileSync(file, sql);
        const args = [
          fileURLToPath(
            new URL(
              "../apps/api/node_modules/wrangler/bin/wrangler.js",
              import.meta.url
            )
          ),
          "d1",
          "execute",
          "DB",
          target === "dev" ? "--remote" : "--local",
          "--config",
          target === "dev" ? "wrangler.dev.jsonc" : "wrangler.jsonc",
          "--env-file",
          empty,
          "--file",
          file,
          "--json",
        ];
        const result = spawnSync(process.execPath, args, {
          cwd: fileURLToPath(new URL("../apps/api/", import.meta.url)),
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
          env: { ...env, WRANGLER_SEND_METRICS: "false" },
        });
        if (result.error || result.status !== 0)
          throw new Error(
            "D1 operation failed; no refresh success is confirmed"
          );
        try {
          const parsed = JSON.parse(result.stdout);
          if (!Array.isArray(parsed) || parsed.some((r) => r.success !== true))
            throw new Error();
          return parsed;
        } catch {
          throw new Error("Invalid D1 response");
        }
      });
    const applied = await run("SELECT name FROM d1_migrations;");
    if (
      !Array.isArray(applied) ||
      !applied[0]?.success ||
      !Array.isArray(applied[0].results) ||
      migrationFiles().some(
        (file) => !applied[0].results.some((row) => row.name === file)
      )
    )
      throw new Error(
        "Required migrations are missing; migrate this target before refreshing"
      );
    const fixture = fixtureState(now),
      queries = snapshotQueries(fixture);
    const read = async () => {
      const result = await run(queries.map((q) => q.sql).join(";\n") + ";");
      if (
        !Array.isArray(result) ||
        result.length !== queries.length ||
        result.some((r) => !r.success || !Array.isArray(r.results))
      )
        throw new Error("Incomplete D1 snapshot");
      return Object.fromEntries(
        queries.map((q, i) => [q.table, result[i].results])
      );
    };
    const snapshot = await read(),
      plan = reconcile(fixture, snapshot);
    output(
      `${apply ? "Refreshing" : "Previewing"} demo data...\nEnvironment: ${target === "dev" ? "Development" : "Local D1"}\nDatabase: ${db.database_name}\nSchema: Up to date\nBusiness date: ${fixture.date}`
    );
    if (apply && plan.sql) await run(plan.sql, true); // Wrangler local batch / remote import are atomic.
    const actual = apply ? await read() : snapshot;
    let verified = 0;
    for (const table of tables) {
      const rows = plan.actions.filter((a) => a.table === table);
      const inserted = rows.filter((r) => r.action === "insert").length,
        updated = rows.filter((r) => r.action === "update").length;
      const reconciled = apply
        ? rows.filter((r) =>
            (actual[table] ?? []).some(
              (row) =>
                keyOf(table, row) === r.key &&
                canonical(row) === canonical(r.target)
            )
          ).length
        : rows.length;
      verified += reconciled;
      output(
        `${table}: ${reconciled} ${apply ? "reconciled" : "eligible"} (${inserted} ${apply ? "inserted" : "to insert"}, ${updated} ${apply ? "updated" : "to update"}, ${rows.length - inserted - updated} unchanged)`
      );
    }
    if (apply && verified !== plan.actions.length)
      throw new Error(
        "Post-refresh verification failed; inspect before retrying"
      );
    const legacy = plan.actions.filter(
      (a) =>
        a.table === "visits" &&
        a.existing?.reporting_week === null &&
        a.action === "update"
    ).length;
    output(
      `Legacy demo visits: ${legacy} ${apply ? "refreshed" : "to refresh"}\nConflicting records: ${plan.conflicts.length}\nReal records modified: 0\nRecords removed: 0`
    );
    for (const row of plan.conflicts.slice(0, 20))
      output(`Skipped ${row.table} ${row.key}: ${row.reason}`);
    if (plan.conflicts.length > 20)
      output(`${plan.conflicts.length - 20} additional conflicts skipped.`);
    output(
      apply
        ? "Demo data refresh completed successfully."
        : "Dry run complete. No database writes performed. Use --apply to reconcile."
    );
    return plan;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [target, ...flags] = process.argv.slice(2);
    if (
      flags.some(
        (f) =>
          !["--dry-run", "--apply", "--confirm=sales-visit-dev"].includes(f)
      ) ||
      (flags.includes("--dry-run") && flags.includes("--apply"))
    )
      throw new Error("Invalid refresh arguments");
    await refresh({
      target,
      apply: flags.includes("--apply"),
      confirm: flags.includes("--confirm=sales-visit-dev")
        ? "sales-visit-dev"
        : undefined,
    });
  } catch {
    console.error(
      "Demo refresh refused or failed. Verify environment, migrations and fixture conflicts; no success is confirmed."
    );
    process.exitCode = 1;
  }
}
