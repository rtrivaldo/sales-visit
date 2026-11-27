import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  fixtureState,
  migrationFiles,
  snapshotQueries,
  reconcile,
} from "./demo-fixtures.mjs";
import {
  createWranglerExecutor,
  describeRefreshFailure,
  subprocessFailure,
  parseD1Response,
  createRefreshApi,
  stageFailure,
} from "./demo-refresh-execution.mjs";
import {
  preflightReconciliation,
  sqlMetrics,
  sqlStatements,
} from "./demo-refresh-preflight.mjs";
import { refresh } from "./demo-refresh.mjs";
const fixture = fixtureState(Date.parse("2026-11-26T08:00:00Z"));
function database(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE d1_migrations(name text);");
  for (const file of migrationFiles()) {
    db.exec(
      readFileSync(
        new URL(`../packages/db/migrations/${file}`, import.meta.url),
        "utf8"
      )
    );
    db.prepare("INSERT INTO d1_migrations VALUES (?)").run(file);
  }
  db.exec(
    readFileSync(new URL("../apps/api/seeds/demo.sql", import.meta.url), "utf8")
  );
  return db;
}
function execute(db, sql) {
  db.exec("BEGIN");
  try {
    const result = sqlStatements(sql).map((query) => {
      const stmt = db.prepare(query);
      if (stmt.columns().length)
        return { success: true, results: stmt.all().map((r) => ({ ...r })) };
      stmt.run();
      return { success: true, results: [] };
    });
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
const snapshot = (db) =>
  Object.fromEntries(
    snapshotQueries(fixture).map((q) => [
      q.table,
      db
        .prepare(q.sql)
        .all()
        .map((r) => ({ ...r })),
    ])
  );

test("subprocess diagnostics preserve exit/signal and both streams without leaking credentials, SQL or paths", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "refresh-execution-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const empty = join(dir, "empty.env");
  writeFileSync(empty, "");
  const token = "synthetic_CLOUDFLARE_SECRET_DO_NOT_PRINT",
    name = "Private Person",
    url = "https://private.invalid/account/token";
  let calls = 0;
  const run = createWranglerExecutor({
    target: "dev",
    dir,
    empty,
    env: { CLOUDFLARE_API_TOKEN: token },
    validateWrite: () => {},
    spawn: (command, args, options) => {
      calls++;
      assert.equal(command, process.execPath);
      assert.ok(args.includes("--remote"));
      assert.ok(args.includes("wrangler.dev.jsonc"));
      assert.equal(args.includes(token), false);
      assert.equal(options.env.CLOUDFLARE_API_TOKEN, token);
      assert.equal(options.timeout, 180000);
      return {
        status: 1,
        signal: null,
        stdout: JSON.stringify({
          error: { code: 10000, text: `Authentication error ${token} ${url}` },
        }),
        stderr: `HTTP 403; Authorization: Bearer ${token}; SQL: UPDATE users SET display_name='${name}'; /home/private/user/secret.log`,
      };
    },
  });
  await assert.rejects(run("SELECT 1;", true, "write"), (error) => {
    assert.equal(error.stage, "write.execute");
    assert.equal(error.outcome, "uncertain");
    assert.equal(error.facts.exit, 1);
    const text = describeRefreshFailure(error);
    assert.match(text, /stdout/);
    assert.match(text, /stderr/);
    assert.match(text, /D1 \/ Edit/);
    assert.match(text, /10000/);
    assert.doesNotMatch(
      text,
      new RegExp(`${token}|${name}|private.invalid|UPDATE|/home/private`)
    );
    return true;
  });
  assert.equal(calls, 1);
});
test("known SQL rejection, launch failure, timeout, buffer overflow and invalid receipts are distinct", () => {
  const rejected = subprocessFailure(
    "write.execute",
    {
      status: 1,
      stderr:
        '{"error":{"text":"UNIQUE constraint failed: visit_schedules.sales_force_id, visit_schedules.outlet_id, visit_schedules.weekday [code: 7500]"}}',
    },
    true
  );
  assert.equal(rejected.outcome, "failed");
  assert.match(describeRefreshFailure(rejected), /visit_schedules.weekday/);
  assert.equal(
    subprocessFailure(
      "write.execute",
      { status: null, error: { code: "ENOENT" } },
      true
    ).outcome,
    "not_started"
  );
  assert.equal(
    subprocessFailure(
      "write.execute",
      { status: null, error: { code: "ENOBUFS" } },
      true
    ).outcome,
    "uncertain"
  );
  assert.equal(
    subprocessFailure(
      "write.execute",
      { status: null, signal: "SIGTERM", error: { code: "ETIMEDOUT" } },
      true
    ).outcome,
    "uncertain"
  );
  for (const text of [
    "",
    'logs before JSON\n[{"success":true,"results":[]}]',
    "[]",
    "{}",
    "null",
    '[{"success":true}]',
  ])
    assert.throws(
      () => parseD1Response(text, "write.response", true),
      (e) => e.stage === "write.response" && e.outcome === "uncertain"
    );
  assert.throws(
    () =>
      parseD1Response(
        '[{"success":false,"error":"FOREIGN KEY constraint failed"}]',
        "write.response",
        true
      ),
    (e) => e.outcome === "failed"
  );
  assert.equal(
    parseD1Response(
      '[{"success":true,"results":[],"finalBookmark":"opaque"}]',
      "write.response",
      true
    ).length,
    1
  );
});
test("read-only API errors retain safe HTTP/code and network/TLS facts without raw response bodies", async () => {
  const api = createRefreshApi("a".repeat(32), "DO_NOT_PRINT", async () =>
    Response.json(
      {
        success: false,
        errors: [
          {
            code: 10000,
            message: "secret DO_NOT_PRINT and https://private.invalid/token",
          },
        ],
      },
      { status: 403 }
    )
  );
  let error;
  try {
    await api("/d1/database/verified/query", { sql: "SELECT 1" });
  } catch (cause) {
    error = stageFailure(
      "snapshot.after",
      "applied_unverified",
      cause,
      "Post-refresh snapshot failed"
    );
  }
  const text = describeRefreshFailure(error);
  assert.match(text, /403/);
  assert.match(text, /10000/);
  assert.match(text, /applied_unverified/);
  assert.doesNotMatch(text, /DO_NOT_PRINT|private.invalid|SELECT 1/);
  const html = createRefreshApi(
    "a".repeat(32),
    "secret",
    async () => new Response("private HTML DO_NOT_PRINT", { status: 403 })
  );
  await assert.rejects(html(""), (e) => {
    const message = describeRefreshFailure(
      stageFailure(
        "snapshot.after",
        "applied_unverified",
        e,
        "Snapshot read failed"
      )
    );
    assert.match(message, /HTTP 403/);
    assert.match(message, /phase: json/);
    assert.doesNotMatch(message, /private HTML|DO_NOT_PRINT/);
    return true;
  });
  const network = createRefreshApi("a".repeat(32), "secret", async () => {
    throw new Error("fetch failed", {
      cause: new Error("CERT_HAS_EXPIRED private certificate"),
    });
  });
  await assert.rejects(network(""), (e) => {
    assert.match(
      describeRefreshFailure(
        stageFailure(
          "identity.account",
          "not_started",
          e,
          "Account read failed"
        )
      ),
      /tls/
    );
    return true;
  });
});
test("SQL preflight handles quoted delimiters, statement/import limits and real constraints before writes", (t) => {
  assert.equal(
    sqlStatements(
      "SELECT 'semi;colon''quote'; SELECT '--literal'; -- comment\nSELECT 1;"
    ).length,
    3
  );
  assert.equal(
    sqlMetrics("SELECT '😀';").bytes,
    Buffer.byteLength("SELECT '😀';")
  );
  assert.throws(
    () => sqlMetrics(`SELECT '${"x".repeat(100000)}';`),
    (e) => e.stage === "sql.limits" && e.outcome === "not_started"
  );
  const db = database(t),
    state = snapshot(db),
    plan = reconcile(fixture, state);
  const metrics = preflightReconciliation(fixture, state, plan);
  assert.ok(metrics.maxStatementBytes < 100000);
  assert.equal(metrics.boundParameters, 0);
  for (const [tail, finding] of [
    [
      "INSERT INTO products(id,name) VALUES ('demo-prd-01','private');",
      "unique_constraint",
    ],
    ["UPDATE stock_report_items SET quantity=-1;", "check_constraint"],
    [
      "UPDATE stock_reports SET outlet_id='unavailable';",
      "foreign_key_constraint",
    ],
    ["UPDTE visits SET reporting_week=1;", "sql_syntax"],
  ]) {
    assert.throws(
      () =>
        preflightReconciliation(fixture, state, {
          ...plan,
          sql: plan.sql + tail,
        }),
      (e) => {
        assert.equal(e.outcome, "not_started");
        assert.ok(e.facts.findings.includes(finding));
        assert.ok(e.facts.statement > 0);
        assert.doesNotMatch(
          describeRefreshFailure(e),
          /VALUES|unavailable|demo-prd-01|UPDTE/
        );
        return true;
      }
    );
  }
});
test("refresh distinguishes rejected write, uncertain committed write and successful write with failed verification; never retries", async (t) => {
  for (const scenario of [
    "rejected",
    "uncertain-not-committed",
    "uncertain-snapshot-failed",
    "snapshot-failed",
    "snapshot-process-failed",
    "snapshot-malformed",
    "row-mismatch",
    "receipt-mismatch",
  ]) {
    await t.test(scenario, async (child) => {
      const db = database(child),
        lines = [];
      let writes = 0;
      await assert.rejects(
        refresh({
          target: "local",
          apply: true,
          now: Date.parse("2026-11-26T08:00:00Z"),
          env: {},
          output: (s) => lines.push(s),
          execute: async (sql, write, stage) => {
            if (write) {
              writes++;
              if (scenario === "rejected")
                throw subprocessFailure(
                  "write.execute",
                  { status: 1, stderr: "FOREIGN KEY constraint failed" },
                  true
                );
              if (scenario.startsWith("uncertain")) {
                if (scenario !== "uncertain-not-committed") execute(db, sql);
                return parseD1Response(
                  "corrupted success output",
                  "write.response",
                  true
                );
              }
              return execute(db, sql);
            }
            if (stage === "snapshot.after") {
              if (
                scenario === "snapshot-failed" ||
                scenario === "uncertain-snapshot-failed"
              )
                throw new Error("Cloudflare inspection refused (HTTP 403)");
              if (scenario === "snapshot-process-failed")
                throw subprocessFailure(
                  "snapshot.after.execute",
                  { status: 1, stderr: "HTTP 403" },
                  false
                );
              if (scenario === "snapshot-malformed") return [];
              const result = execute(db, sql);
              if (scenario === "row-mismatch")
                result[0].results[0].name = "private drift";
              if (scenario === "receipt-mismatch")
                result[
                  snapshotQueries(fixture).findIndex(
                    (q) => q.table === "demo_fixture_state"
                  )
                ].results[0].record_json = "{}";
              return result;
            }
            return execute(db, sql);
          },
        }),
        (e) => {
          const outcome =
            scenario === "rejected"
              ? "failed"
              : scenario.startsWith("uncertain")
                ? "uncertain"
                : "applied_unverified";
          assert.equal(e.outcome, outcome);
          assert.equal(
            e.stage,
            scenario === "rejected"
              ? "write.execute"
              : scenario === "uncertain-not-committed"
                ? "verification.compare"
                : scenario === "uncertain-snapshot-failed"
                  ? "snapshot.after"
                  : scenario === "snapshot-process-failed"
                    ? "snapshot.after.execute"
                    : scenario.startsWith("snapshot-")
                      ? "snapshot.after"
                      : "verification.compare"
          );
          assert.doesNotMatch(describeRefreshFailure(e), /private drift/);
          return true;
        }
      );
      assert.equal(writes, 1);
      assert.ok(!lines.some((s) => s.includes("completed successfully")));
    });
  }
});
