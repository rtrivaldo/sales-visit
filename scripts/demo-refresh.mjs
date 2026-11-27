import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { readJSON } from "./ci/targets.mjs";
import {
  fixtureState,
  tables,
  keyOf,
  canonical,
  receiptMatches,
  migrationFiles,
  snapshotQueries,
  reconcile,
} from "./demo-fixtures.mjs";
import {
  RefreshFailure,
  stageFailure,
  createRefreshApi,
  createWranglerExecutor,
  executionVersion,
  describeRefreshFailure,
} from "./demo-refresh-execution.mjs";
import {
  preflightReconciliation,
  sqlMetrics,
} from "./demo-refresh-preflight.mjs";

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
    "WRANGLER_API_ENVIRONMENT",
    "CLOUDFLARE_API_BASE_URL",
    "CF_API_BASE_URL",
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
const snapshotFingerprint = (rows) =>
  rows
    .map((r) => canonical(r))
    .toSorted()
    .join("\n");
function successfulResults(result, count) {
  return (
    Array.isArray(result) &&
    result.length > 0 &&
    (count === undefined || result.length === count) &&
    result.every((r) => r?.success === true && Array.isArray(r.results))
  );
}
const stageReason = {
  "target.validation":
    "Target/configuration was refused. Only local or the reviewed Development DB is allowed; remove configuration overrides.",
  "confirmation.validation":
    "Remote apply requires --apply --confirm=sales-visit-dev after reviewing a dry-run.",
  "identity.account":
    "Cloudflare account verification failed; check the approved account and token read permissions.",
  "identity.database":
    "Development database UUID/name verification failed; no write was started.",
  "files.prepare": "Could not prepare isolated temporary execution files.",
  "migrations.read":
    "Could not read applied migrations. Verify read permissions and database identity.",
  "migrations.validate":
    "Required migrations are missing or the migration response is invalid; migrate the selected target first.",
  "fixtures.generate":
    "The checked-in migrations/demo fixture definitions could not generate an isolated baseline.",
  "snapshot.before":
    "The pre-refresh database snapshot could not be retrieved or parsed.",
  "reconciliation.plan":
    "Provenance/dependency reconciliation could not produce a safe plan.",
  "sql.preflight":
    "Generated SQL did not pass isolated validation/size checks; no write was started.",
  write:
    "The write did not return a trustworthy success receipt; inspect sanitized subprocess diagnostics.",
  "snapshot.after":
    "The post-dispatch snapshot could not be retrieved or parsed; the write outcome remains as reported.",
  "verification.compare":
    "Post-refresh rows or provenance receipts do not match the approved plan.",
};

export async function refresh({
  target,
  apply = false,
  confirm,
  verifyOnly = false,
  repairProvenance = false,
  fixtureDate,
  confirmProvenanceRepair = false,
  now = Date.now(),
  env = process.env,
  execute,
  inspect,
  output = console.log,
  // Internal process seam for isolated tests only. No CLI target/persistence overrides.
  spawn,
  persistTo,
}) {
  let stage = "target.validation",
    outcome = "not_started",
    dir;
  const runtime = executionVersion();
  try {
    if (
      (verifyOnly && apply) ||
      (fixtureDate && !repairProvenance) ||
      (confirmProvenanceRepair && !repairProvenance) ||
      (repairProvenance && apply && !confirmProvenanceRepair)
    )
      throw new Error(
        "Verification is read-only; provenance apply requires --confirm-provenance-repair"
      );
    let evidenceFixture;
    if (fixtureDate) {
      const date = Date.parse(`${fixtureDate}T00:00:00+07:00`);
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(fixtureDate) ||
        !Number.isFinite(date) ||
        new Date(date + 7 * 3600000).toISOString().slice(0, 10) !==
          fixtureDate ||
        date > now
      )
        throw new Error(
          "Evidence date must be a real, non-future YYYY-MM-DD business date"
        );
      evidenceFixture = fixtureState(date);
    }
    const options = { repairProvenance, evidenceFixture };
    const config = readJSON(
        `apps/api/wrangler${target === "dev" ? ".dev" : ""}.jsonc`
      ),
      production = readJSON("apps/api/wrangler.jsonc");
    const db = validateRefreshTarget(target, config, production, env);
    let remoteApi;
    if (target === "dev") {
      stage = "confirmation.validation";
      if (apply && confirm !== development.name)
        throw new Error("Missing explicit Development confirmation");
      stage = "identity.account";
      const api =
        inspect ??
        createRefreshApi(env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_API_TOKEN);
      remoteApi = api;
      if ((await api("")).id !== env.CLOUDFLARE_ACCOUNT_ID)
        throw new Error("Cloudflare account mismatch");
      stage = "identity.database";
      const actual = await api(`/d1/database/${db.database_id}`);
      if (actual.uuid !== development.id || actual.name !== development.name)
        throw new Error("Remote D1 identity mismatch");
    }
    stage = "files.prepare";
    dir = mkdtempSync(join(tmpdir(), "sales-visit-demo-refresh-"));
    const empty = join(dir, "empty.env");
    writeFileSync(empty, "");
    const run =
      execute ??
      createWranglerExecutor({
        target,
        dir,
        empty,
        env,
        spawn,
        persistTo,
        remoteApi: (sql) =>
          remoteApi(`/d1/database/${db.database_id}/query`, { sql }),
        validateWrite: () => {
          if (target === "dev") {
            const current = readJSON("apps/api/wrangler.dev.jsonc");
            validateRefreshTarget(target, current, production, env);
            if (JSON.stringify(current) !== JSON.stringify(config))
              throw new Error(
                "Development configuration changed since identity verification"
              );
          }
        },
      });
    stage = "migrations.read";
    const applied = await run("SELECT name FROM d1_migrations;", false, stage);
    stage = "migrations.validate";
    if (
      !successfulResults(applied, 1) ||
      migrationFiles().some(
        (file) => !applied[0].results.some((row) => row.name === file)
      )
    )
      throw new Error("Required migrations are missing");
    stage = "fixtures.generate";
    const fixture = fixtureState(now),
      queries = snapshotQueries(fixture);
    const snapshotSQL = queries.map((q) => q.sql).join(";\n") + ";";
    sqlMetrics(snapshotSQL);
    const read = async () => {
      const result = await run(snapshotSQL, false, stage);
      if (!successfulResults(result, queries.length))
        throw new Error("Incomplete D1 snapshot");
      return Object.fromEntries(
        queries.map((q, i) => [q.table, result[i].results])
      );
    };
    stage = "snapshot.before";
    const snapshot = await read();
    stage = "reconciliation.plan";
    const plan = reconcile(fixture, snapshot, options);
    output(
      `${apply ? "Refreshing" : "Previewing"} demo data...\nEnvironment: ${target === "dev" ? "Development" : "Local D1"}\nDatabase: ${db.database_name}\nSchema: Up to date\nBusiness date: ${fixture.date}`
    );
    stage = "sql.preflight";
    const info = preflightReconciliation(fixture, snapshot, plan);
    output(
      `Runtime: Node ${runtime.node}; Wrangler ${runtime.wrangler}; ${runtime.platform}\nSQL preflight: passed; ${info.bytes} bytes; ${info.statements} statements; largest statement ${info.maxStatementBytes} bytes; ${info.boundParameters} bound parameters.\nSnapshot request: ${Buffer.byteLength(JSON.stringify({ sql: snapshotSQL }))} JSON bytes.`
    );
    const direct = plan.conflicts.filter((c) => c.kind === "direct");
    const propagated = plan.conflicts.filter((c) => c.kind === "propagated");
    const reconciliationStatus =
      !plan.sql && plan.conflicts.length && plan.actions.length
        ? "up_to_date_with_protected_conflicts"
        : plan.status;
    output(
      `Reconciliation: ${reconciliationStatus}\nDirect conflicts: ${direct.length}; propagated conflicts: ${propagated.length}\nEligible records: ${plan.actions.length}; unchanged records: ${plan.actions.filter((r) => r.action === "unchanged").length}; pending business changes: ${plan.pendingChanges}; pending provenance writes: ${plan.receiptChanges}\nFrozen verified anchors: ${plan.actions.filter((r) => r.protected).length}\nProvenance before: ${plan.provenance.verified} matching; ${plan.provenance.missing} missing; ${plan.provenance.mismatched} mismatched; ${plan.provenance.independentlyVerified} independently fingerprinted.`
    );
    output(
      `Operational/identity dependency rows: ${Object.values(plan.dependencyCounts).reduce((sum, n) => sum + n, 0)}${
        Object.keys(plan.dependencyCounts).length
          ? ` (${Object.entries(plan.dependencyCounts)
              .map(([table, count]) => `${table}: ${count}`)
              .join(", ")})`
          : ""
      }`
    );
    for (const anchor of plan.protections
      .filter((p) =>
        plan.actions.some((r) => r.protected && `${r.table}:${r.key}` === p.id)
      )
      .slice(0, 12))
      output(
        `Frozen shared anchor ${anchor.id}: no business/provenance writes; via ${anchor.via}; root ${anchor.root}`
      );
    for (const c of direct.slice(0, 20))
      output(
        `Root conflict ${c.table} ${c.key}: ${c.reason}${c.fields.length ? `; differing fields: ${c.fields.join(", ")}` : ""}`
      );
    if (direct.length > 20)
      output(
        `${direct.length - 20} additional direct conflicts; inspect the read-only snapshot privately.`
      );
    for (const c of propagated.slice(0, 20))
      output(
        `Propagated ${c.table} ${c.key}: ${c.reason}; via ${c.via}; root ${c.root}`
      );
    if (repairProvenance)
      output(
        `Provenance-only recovery: no business rows inserted or updated. Evidence: exact seed/current fixture${fixtureDate ? ` or generated ${fixtureDate} fixture` : ""}/valid existing receipt. Ambiguous edits remain protected.`
      );
    if (apply && plan.sql) {
      stage = "write";
      output(
        "[write] Starting one guarded atomic execution. No automatic retry."
      );
      // Dispatch proves nothing; even a trustworthy receipt needs state verification.
      outcome = "uncertain";
      try {
        const receipt = await run(plan.sql, true, stage);
        if (!successfulResults(receipt))
          throw new RefreshFailure(
            "write.response",
            "uncertain",
            {},
            "Write response did not contain a trustworthy nonempty success receipt"
          );
        outcome = "applied_unverified";
        output(
          "[write] Success receipt received. Retrieving post-refresh snapshot..."
        );
      } catch (error) {
        if (
          !(error instanceof RefreshFailure) ||
          error.stage !== "write.response" ||
          error.outcome !== "uncertain"
        )
          throw error;
        output(describeRefreshFailure(error, { verifying: true }));
        output(
          "[write.response] Receipt unavailable. Performing read-only verification of the original plan; the write will NOT be repeated."
        );
      }
    }
    stage = "snapshot.after";
    const actual = apply ? await read() : snapshot;
    stage = "verification.compare";
    if (apply) {
      const receipts = new Map(
        (actual.demo_fixture_state ?? []).map((r) => [
          `${r.table_name}:${r.record_key}`,
          r.record_json,
        ])
      );
      let rowMismatch = 0,
        receiptMismatch = 0;
      for (const row of plan.actions) {
        if (
          !(actual[row.table] ?? []).some(
            (r) =>
              keyOf(row.table, r) === row.key &&
              canonical(r) === canonical(row.target)
          )
        )
          rowMismatch++;
        const actualReceipt = receipts.get(`${row.table}:${row.key}`) ?? null;
        if (
          actualReceipt !== row.receiptTarget &&
          !(
            row.receiptTarget !== null &&
            receiptMatches(actualReceipt, JSON.parse(row.receiptTarget))
          )
        )
          receiptMismatch++;
      }
      // Verify relationships and the entire guarded snapshot, not just a count
      // or Wrangler exit status. Concurrent/unplanned drift must remain visible.
      let unplannedDrift = 0;
      for (const query of queries) {
        const expected = new Map(
          snapshot[query.table].map((r) => [
            query.table === "demo_fixture_state"
              ? `${r.table_name}:${r.record_key}`
              : keyOf(query.table, r),
            r,
          ])
        );
        for (const row of plan.actions) {
          if (query.table === row.table) expected.set(row.key, row.target);
          if (
            query.table === "demo_fixture_state" &&
            row.receiptTarget !== null
          )
            expected.set(`${row.table}:${row.key}`, {
              table_name: row.table,
              record_key: row.key,
              record_json: row.receiptTarget,
            });
        }
        if (
          snapshotFingerprint([...expected.values()]) !==
          snapshotFingerprint(actual[query.table])
        )
          unplannedDrift++;
      }
      const afterPlan = reconcile(fixture, actual, options);
      if (rowMismatch || receiptMismatch || unplannedDrift || afterPlan.sql)
        throw new RefreshFailure(
          stage,
          outcome,
          {},
          `Post-refresh verification failed: ${rowMismatch} row mismatch(es), ${receiptMismatch} provenance receipt mismatch(es), ${unplannedDrift} unplanned table drift(s), ${afterPlan.pendingChanges + afterPlan.receiptChanges} pending change(s)`
        );
    }
    if (apply)
      output(
        "Post-write verification: expected rows, relationships, receipts and reconciliation verified. No duplicate write dispatched."
      );
    if (verifyOnly)
      output(
        plan.sql
          ? "Eligible fixture changes remain pending. No writes performed."
          : plan.conflicts.length
            ? plan.actions.length
              ? "All eligible fixtures and required provenance verified. Protected conflicts remain. No writes required for eligible records."
              : "Verification blocked: no eligible fixtures. Protected conflicts remain. No writes performed."
            : "Current expected fixture state and required provenance verified."
      );
    for (const table of tables) {
      const rows = plan.actions.filter((a) => a.table === table),
        inserted = rows.filter((r) => r.action === "insert").length,
        updated = rows.filter((r) => r.action === "update").length;
      output(
        `${table}: ${rows.length} ${apply ? "reconciled" : "eligible"} (${inserted} ${apply ? "inserted" : "to insert"}, ${updated} ${apply ? "updated" : "to update"}, ${rows.length - inserted - updated} unchanged)`
      );
    }
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
      plan.conflicts.length
        ? !plan.actions.length
          ? "Refresh remains blocked by unresolved conflicts (even if SQL is zero). No eligible fixtures."
          : apply
            ? "Eligible reconciliation verified successfully. Protected conflicts remain unchanged."
            : plan.sql
              ? "Eligible changes are available. Protected conflicts will be skipped."
              : "All eligible fixtures are up to date. Protected conflicts remain; no eligible database writes required."
        : repairProvenance
          ? apply
            ? "Provenance-only recovery verified. Business data was not refreshed. Run a normal dry-run next."
            : plan.sql
              ? "Provenance-only changes available; review before a separately confirmed recovery apply."
              : "Provenance is up to date for independently verified existing fixtures. Run a normal dry-run to inspect business refresh changes."
          : apply
            ? "Demo data refresh completed successfully."
            : plan.sql
              ? "Changes available. Dry run complete; no writes performed. Review before a separately confirmed --apply."
              : "All demo fixtures are up to date. No writes required."
    );
    return plan;
  } catch (error) {
    const failure = stageFailure(
      stage,
      outcome,
      error,
      stageReason[stage] ?? "Refresh stage did not complete"
    );
    // A read/response failure after a confirmed write must not masquerade as a
    // failed/not-started write (the executor itself only sees a read operation).
    if (
      ["snapshot.after", "verification.compare"].includes(stage) &&
      ["applied_unverified", "uncertain"].includes(outcome)
    )
      failure.outcome = outcome;
    failure.facts.runtime = runtime;
    throw failure;
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        output(
          "Warning: temporary SQL-file cleanup failed; inspect the operating-system temporary directory privately."
        );
      }
    }
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [target, ...flags] = process.argv.slice(2);
    if (
      flags.some(
        (f) =>
          ![
            "--dry-run",
            "--apply",
            "--confirm=sales-visit-dev",
            "--verify-only",
            "--repair-provenance",
            "--confirm-provenance-repair",
          ].includes(f) && !/^--fixture-date=\d{4}-\d{2}-\d{2}$/.test(f)
      ) ||
      (flags.includes("--dry-run") && flags.includes("--apply")) ||
      new Set(flags.map((f) => f.split("=")[0])).size !== flags.length
    )
      throw new RefreshFailure(
        "arguments.validation",
        "not_started",
        {},
        "Only local/dev and the documented dry-run/apply/confirmation flags are accepted"
      );
    const plan = await refresh({
      target,
      apply: flags.includes("--apply"),
      verifyOnly: flags.includes("--verify-only"),
      repairProvenance: flags.includes("--repair-provenance"),
      fixtureDate: flags
        .find((f) => f.startsWith("--fixture-date="))
        ?.slice("--fixture-date=".length),
      confirmProvenanceRepair: flags.includes("--confirm-provenance-repair"),
      confirm: flags.includes("--confirm=sales-visit-dev")
        ? "sales-visit-dev"
        : undefined,
    });
    if (
      plan.conflicts.length ||
      (flags.includes("--verify-only") && plan.sql)
    ) {
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(describeRefreshFailure(error));
    process.exitCode = 1;
  }
}
