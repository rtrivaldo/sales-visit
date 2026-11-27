import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  fixtureState,
  migrationFiles,
  snapshotQueries,
  reconcile,
} from "./demo-fixtures.mjs";
import { refresh } from "./demo-refresh.mjs";

const root = new URL("../", import.meta.url);
const wrangler = fileURLToPath(
  new URL("apps/api/node_modules/wrangler/bin/wrangler.js", root)
);

test(
  "Wrangler 4 file execution applies the November 26 seeded reconciliation in isolated local D1",
  { timeout: 300000 },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "demo-refresh-wrangler-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const empty = join(dir, "empty.env");
    writeFileSync(empty, "");
    const state = join(dir, "state");
    const memory = new DatabaseSync(":memory:");
    t.after(() => memory.close());
    let schema = "";
    for (const name of migrationFiles())
      schema +=
        readFileSync(new URL(`packages/db/migrations/${name}`, root), "utf8") +
        "\n";
    const seed = readFileSync(new URL("apps/api/seeds/demo.sql", root), "utf8");
    memory.exec(schema + seed);
    const fixture = fixtureState(Date.parse("2026-11-26T08:00:00Z"));
    const snapshot = Object.fromEntries(
      snapshotQueries(fixture).map((q) => [
        q.table,
        memory.prepare(q.sql).all(),
      ])
    );
    const plan = reconcile(fixture, snapshot);
    assert.equal(plan.conflicts.length, 0);
    const run = (sql, name, expectSuccess = true) => {
      const file = join(dir, `${name}.sql`);
      writeFileSync(file, sql);
      const result = spawnSync(
        process.execPath,
        [
          wrangler,
          "d1",
          "execute",
          "DB",
          "--local",
          "--config",
          "wrangler.jsonc",
          "--persist-to",
          state,
          "--env-file",
          empty,
          "--file",
          file,
          "--json",
        ],
        {
          cwd: fileURLToPath(new URL("apps/api/", root)),
          encoding: "utf8",
          timeout: 90000,
          maxBuffer: 32 * 1024 * 1024,
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            SystemRoot: process.env.SystemRoot,
            WRANGLER_SEND_METRICS: "false",
          },
        }
      );
      // Fixture-only subprocess, no credentials or remote execution.
      if (!expectSuccess) {
        assert.notEqual(result.status, 0);
        return;
      }
      assert.equal(
        result.status,
        0,
        JSON.stringify({
          status: result.status,
          error: result.error?.code,
          stdout: result.stdout,
          stderr: result.stderr,
        })
      );
      return JSON.parse(result.stdout);
    };
    const history = `CREATE TABLE d1_migrations(name text);\n${migrationFiles()
      .map((name) => `INSERT INTO d1_migrations VALUES ('${name}');`)
      .join("\n")}`;
    run(schema + seed + history, "bootstrap");
    run(plan.sql + ";SELECT json('intentional rollback');", "rollback", false);
    const rollback = run(
      "SELECT visited_at FROM visits WHERE id='demo-visit-01-01';SELECT count(*) n FROM demo_fixture_state;SELECT count(*) n FROM visit_schedules WHERE id LIKE 'demo-schedule-extra-%';PRAGMA foreign_key_check;",
      "rollback-verify"
    );
    assert.equal(
      rollback[0].results[0].visited_at,
      snapshot.visits.find((v) => v.id === "demo-visit-01-01").visited_at
    );
    assert.equal(rollback[1].results[0].n, 0);
    assert.equal(rollback[2].results[0].n, 0);
    assert.deepEqual(rollback[3].results, []);
    const messages = [];
    const actual = await refresh({
      target: "local",
      apply: true,
      now: Date.parse("2026-11-26T08:00:00Z"),
      persistTo: state,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        SystemRoot: process.env.SystemRoot,
      },
      output: (message) => messages.push(message),
    });
    assert.equal(actual.conflicts.length, 0);
    assert.ok(messages.some((s) => s.includes("Success receipt received")));
    assert.ok(messages.some((s) => s.includes("completed successfully")));
    assert.equal(actual.actions.length, plan.actions.length);
    const results = run(
      "SELECT count(*) AS reports FROM visits WHERE reporting_year=2026 AND reporting_month=11; PRAGMA foreign_key_check;",
      "verify"
    );
    assert.equal(results[0].results[0].reports, 156);
    assert.deepEqual(results[1].results, []);
    run(
      "UPDATE sales_force_supervisors SET supervisor_user_id='demo-supervisor-02',updated_at=1795176516000 WHERE sales_force_id='demo-sf-01';INSERT INTO supervisor_assignment_audit(id,actor_user_id,sales_force_id,previous_supervisor_user_id,new_supervisor_user_id,action,created_at) VALUES ('audited-edit','demo-admin-01','demo-sf-01','demo-supervisor-01','demo-supervisor-02','reassign',1795176516000);",
      "manual-edit"
    );
    const options = {
      target: "local",
      now: Date.parse("2026-11-27T08:00:00Z"),
      persistTo: state,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        SystemRoot: process.env.SystemRoot,
      },
      output: () => {},
    };
    const partial = await refresh({ ...options, apply: true });
    assert.equal(
      partial.conflicts.filter((c) => c.kind === "direct").length,
      1
    );
    assert.equal(partial.conflicts[0].table, "sales_force_supervisors");
    const repeat = await refresh(options);
    assert.equal(repeat.sql, "");
    const preserved = run(
      "SELECT supervisor_user_id,updated_at FROM sales_force_supervisors WHERE sales_force_id='demo-sf-01';PRAGMA foreign_key_check;",
      "manual-verify"
    );
    assert.equal(
      preserved[0].results[0].supervisor_user_id,
      "demo-supervisor-02"
    );
    assert.equal(preserved[0].results[0].updated_at, 1795176516000);
    assert.deepEqual(preserved[1].results, []);
  }
);
