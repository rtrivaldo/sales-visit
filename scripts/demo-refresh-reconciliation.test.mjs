import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  fixtureState,
  migrationFiles,
  snapshotQueries,
  reconcile,
  canonical,
  keyOf,
  receiptMatches,
  tables,
} from "./demo-fixtures.mjs";
import { parseD1Response } from "./demo-refresh-execution.mjs";
import {
  sqlStatements,
  preflightReconciliation,
} from "./demo-refresh-preflight.mjs";
import { refresh } from "./demo-refresh.mjs";

const now = Date.parse("2027-03-15T08:00:00Z");
function setup(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE d1_migrations(name text);");
  for (const name of migrationFiles()) {
    db.exec(
      readFileSync(
        new URL(`../packages/db/migrations/${name}`, import.meta.url),
        "utf8"
      )
    );
    db.prepare("INSERT INTO d1_migrations VALUES (?)").run(name);
  }
  db.exec(
    readFileSync(new URL("../apps/api/seeds/demo.sql", import.meta.url), "utf8")
  );
  const run = (sql) => {
    db.exec("BEGIN");
    try {
      const result = sqlStatements(sql).map((s) => {
        const q = db.prepare(s);
        if (q.columns().length)
          return { success: true, results: q.all().map((r) => ({ ...r })) };
        q.run();
        return { success: true, results: [] };
      });
      db.exec("COMMIT");
      return result;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  const snapshot = (f = fixtureState(now)) =>
    Object.fromEntries(
      snapshotQueries(f).map((q) => [
        q.table,
        db
          .prepare(q.sql)
          .all()
          .map((r) => ({ ...r })),
      ])
    );
  const options = {
    target: "local",
    now,
    env: {},
    output: () => {},
    execute: async (sql) => run(sql),
  };
  return { db, run, snapshot, options };
}
function reassign(db) {
  db.exec(
    "UPDATE sales_force_supervisors SET supervisor_user_id='demo-supervisor-02',updated_at=1795176516000 WHERE sales_force_id='demo-sf-01'; INSERT INTO supervisor_assignment_audit(id,actor_user_id,sales_force_id,previous_supervisor_user_id,new_supervisor_user_id,action,created_at) VALUES ('reviewed-reassignment','demo-admin-01','demo-sf-01','demo-supervisor-01','demo-supervisor-02','reassign',1795176516000);"
  );
}

test("seed -> refresh -> successful dry-run -> same date -> following date preserves typed full-row receipts and FKs", async (t) => {
  const { db, snapshot, options } = setup(t);
  assert.equal(
    reconcile(fixtureState(now), snapshot()).status,
    "changes_available"
  );
  await refresh({ ...options, apply: true });
  const lines = [];
  const preview = await refresh({
    ...options,
    verifyOnly: true,
    output: (s) => lines.push(s),
  });
  assert.equal(preview.status, "up_to_date");
  assert.equal(preview.sql, "");
  assert.equal(preview.provenance.verified, 829);
  assert.ok(lines.some((s) => s.includes("All demo fixtures are up to date")));
  const persisted = snapshot();
  for (const r of persisted.demo_fixture_state) {
    const row = persisted[r.table_name].find(
      (x) => keyOf(r.table_name, x) === r.record_key
    );
    assert.ok(receiptMatches(r.record_json, row));
  }
  const assignment = snapshot().sales_force_supervisors[0];
  assert.equal(typeof assignment.created_at, "number");
  assert.equal(assignment.created_at, 1793664000000);
  assert.equal(typeof snapshot().visits[0].is_cvm_active, "number");
  assert.ok(snapshot().visits.some((v) => v.follow_up === null));
  const count = db.prepare("SELECT count(*) n FROM demo_fixture_state").get().n;
  await refresh({ ...options, apply: true });
  assert.equal(
    db.prepare("SELECT count(*) n FROM demo_fixture_state").get().n,
    count
  );
  await refresh({ ...options, now: now + 86400000, apply: true });
  assert.equal(reconcile(fixtureState(now + 86400000), snapshot()).sql, "");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("receipt serialization accepts ordering/whitespace, but never coerces timestamps, nulls, strings or booleans", async (t) => {
  const { db, options, snapshot } = setup(t);
  await refresh({ ...options, apply: true });
  for (const receipt of snapshot().demo_fixture_state) {
    const row = JSON.parse(receipt.record_json);
    const reordered = JSON.stringify(
      Object.fromEntries(Object.entries(row).toReversed()),
      null,
      2
    );
    db.prepare(
      "UPDATE demo_fixture_state SET record_json=? WHERE table_name=? AND record_key=?"
    ).run(reordered, receipt.table_name, receipt.record_key);
  }
  const result = await refresh({ ...options, apply: true });
  assert.equal(result.sql, "");
  const row = snapshot().sales_force_supervisors[0];
  assert.ok(receiptMatches(JSON.stringify(row), row));
  assert.equal(
    receiptMatches(
      JSON.stringify({ ...row, created_at: String(row.created_at) }),
      row
    ),
    false
  );
  assert.equal(receiptMatches('{"flag":true}', { flag: 1 }), false);
  assert.equal(receiptMatches('{"value":null}', { value: "" }), false);
  assert.equal(receiptMatches("{}", row), false);
  assert.equal(receiptMatches("null", row), false);
});

test("audited supervisor edit is one direct conflict, not 827; frozen shared anchors permit independent fixtures", async (t) => {
  const { db, snapshot, options } = setup(t);
  reassign(db);
  const before = canonical(snapshot().sales_force_supervisors[0]);
  const lines = [];
  const plan = await refresh({ ...options, output: (s) => lines.push(s) });
  const roots = plan.conflicts.filter((c) => c.kind === "direct");
  assert.equal(roots.length, 1);
  assert.equal(roots[0].table, "sales_force_supervisors");
  assert.deepEqual(roots[0].fields.toSorted(), [
    "supervisor_user_id",
    "updated_at",
  ]);
  assert.equal(plan.status, "partially_blocked");
  assert.equal(plan.actions.length, 821);
  assert.equal(plan.conflicts.length, 8);
  assert.ok(
    plan.conflicts.some(
      (c) => c.kind === "propagated" && c.root === roots[0].root
    )
  );
  const sf = plan.actions.find(
    (r) => r.table === "sales_force" && r.target.id === "demo-sf-01"
  );
  assert.equal(sf.protected, true);
  assert.equal(sf.action, "unchanged");
  assert.equal(sf.receiptTarget, null);
  await refresh({ ...options, apply: true });
  assert.equal(canonical(snapshot().sales_force_supervisors[0]), before);
  assert.equal(snapshot().supervisor_assignment_audit.length, 1);
  assert.ok(snapshot().visits.every((v) => v.reporting_month === 3));
  const second = await refresh(options);
  assert.equal(second.sql, "");
  assert.equal(second.status, "completely_blocked");
  assert.ok(second.conflicts.length > 0);
  const verify = await refresh({
    ...options,
    verifyOnly: true,
    output: (s) => lines.push(s),
  });
  assert.equal(verify.status, "completely_blocked");
  assert.ok(lines.some((s) => s.includes("Previous write outcome: uncertain")));
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("real report dependencies freeze their Visit, not unrelated SF/Outlet/Product branches", async (t) => {
  const { db, run, snapshot } = setup(t);
  db.exec(
    "INSERT INTO stock_reports(id,outlet_id,reporter_sales_force_id,visit_id,reported_at,submission_channel) VALUES ('operational-report','demo-out-03','demo-sf-01','demo-visit-01-01',1,'web');"
  );
  const original = canonical(
    db.prepare("SELECT * FROM visits WHERE id='demo-visit-01-01'").get()
  );
  const real = canonical(
    db
      .prepare("SELECT * FROM stock_reports WHERE id='operational-report'")
      .get()
  );
  const f = fixtureState(now),
    before = snapshot(),
    plan = reconcile(f, before);
  assert.ok(
    plan.conflicts.some(
      (c) =>
        c.table === "visits" &&
        c.reason === "Non-fixture dependency" &&
        c.kind === "direct"
    )
  );
  assert.ok(
    plan.actions.some(
      (a) =>
        a.table === "visits" &&
        a.target.id === "demo-visit-02-01" &&
        a.action === "update"
    )
  );
  preflightReconciliation(f, before, plan);
  run(plan.sql);
  assert.equal(
    canonical(
      db.prepare("SELECT * FROM visits WHERE id='demo-visit-01-01'").get()
    ),
    original
  );
  assert.equal(
    canonical(
      db
        .prepare("SELECT * FROM stock_reports WHERE id='operational-report'")
        .get()
    ),
    real
  );
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("multiple operational identities and drafts retain their user_id keys during full post-write verification", async (t) => {
  const { db, options } = setup(t);
  db.exec(
    "INSERT INTO telegram_identities(user_id,telegram_user_id) VALUES ('demo-admin-01','111'),('demo-admin-02','222'); INSERT INTO telegram_visit_drafts(user_id,submission_key,sales_force_id,step,last_message,expires_at) VALUES ('demo-sf-13','operational-draft-13','demo-sf-13','outlet',1,1800000000000),('demo-sf-14','operational-draft-14','demo-sf-14','outlet',2,1800000000000);"
  );
  const read = (table) =>
    db.prepare(`SELECT * FROM ${table}`).all().map(canonical).toSorted();
  const identities = read("telegram_identities"),
    drafts = read("telegram_visit_drafts");
  const plan = await refresh({ ...options, apply: true });
  assert.ok(
    plan.conflicts.some((c) => c.reason === "Telegram identity present")
  );
  assert.deepEqual(read("telegram_identities"), identities);
  assert.deepEqual(read("telegram_visit_drafts"), drafts);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("zero SQL with conflicts is blocked, never up-to-date or a success", async (t) => {
  const { db, snapshot, options } = setup(t);
  for (const table of tables.filter((entry) => entry !== "stock_report_items"))
    db.exec(`UPDATE ${table} SET created_at=created_at+1;`);
  db.exec("UPDATE stock_report_items SET quantity=quantity+1;");
  const lines = [];
  const p = await refresh({ ...options, output: (s) => lines.push(s) });
  assert.equal(p.sql, "");
  assert.equal(p.status, "completely_blocked");
  assert.equal(p.actions.length, 0);
  assert.equal(p.conflicts.length, 829);
  assert.ok(lines.some((s) => s.includes("even if SQL is zero")));
  assert.ok(
    !lines.some(
      (s) =>
        s.includes("completed successfully") ||
        s.includes("All demo fixtures are up to date")
    )
  );
  assert.equal(snapshot().demo_fixture_state.length, 0);
});

test("uncertain exit-zero response is verified read-only without retry; committed and uncommitted results differ", async (t) => {
  for (const committed of [true, false])
    await t.test(String(committed), async (child) => {
      const { run, options } = setup(child);
      let writes = 0;
      const lines = [];
      const request = refresh({
        ...options,
        apply: true,
        output: (s) => lines.push(s),
        execute: async (sql, write) => {
          if (write) {
            writes++;
            if (committed) run(sql);
            return parseD1Response(
              "unexpected non-JSON stdout",
              "write.response",
              true
            );
          }
          return run(sql);
        },
      });
      if (committed) await request;
      else
        await assert.rejects(
          request,
          (e) => e.stage === "verification.compare" && e.outcome === "uncertain"
        );
      assert.equal(writes, 1);
      assert.equal(
        lines.some((s) => s.includes("completed successfully")),
        committed
      );
      assert.ok(lines.some((s) => s.includes("write will NOT be repeated")));
    });
});

test("explicit dated provenance recovery repairs only independently reproduced records; manual edits remain blocked", async (t) => {
  const { db, snapshot, options } = setup(t);
  const old = now - 86400000;
  await refresh({ ...options, now: old, apply: true });
  db.exec(
    "UPDATE demo_fixture_state SET record_json='{}' WHERE table_name='visits' AND record_key='[\"demo-visit-01-01\"]'; UPDATE visits SET notes='Intentional manual observation' WHERE id='demo-visit-02-01';"
  );
  const business = Object.fromEntries(
    tables.map((table) => [table, snapshot()[table].map(canonical).toSorted()])
  );
  const normal = await refresh(options);
  assert.ok(
    normal.conflicts.some(
      (c) =>
        c.table === "visits" &&
        c.key === '["demo-visit-01-01"]' &&
        c.kind === "direct"
    )
  );
  const undated = await refresh({ ...options, repairProvenance: true });
  assert.ok(undated.conflicts.some((c) => c.key === '["demo-visit-01-01"]'));
  const preview = await refresh({
    ...options,
    repairProvenance: true,
    fixtureDate: "2027-03-14",
  });
  assert.ok(!preview.conflicts.some((c) => c.key === '["demo-visit-01-01"]'));
  assert.ok(preview.conflicts.some((c) => c.key === '["demo-visit-02-01"]'));
  assert.equal(preview.pendingChanges, 0);
  assert.equal(preview.receiptChanges, 1);
  await assert.rejects(
    refresh({
      ...options,
      repairProvenance: true,
      fixtureDate: "2027-03-14",
      apply: true,
    }),
    (e) => e.outcome === "not_started"
  );
  await refresh({
    ...options,
    repairProvenance: true,
    fixtureDate: "2027-03-14",
    apply: true,
    confirmProvenanceRepair: true,
  });
  for (const table of tables)
    assert.deepEqual(
      snapshot()[table].map(canonical).toSorted(),
      business[table]
    );
  const repeated = await refresh({
    ...options,
    repairProvenance: true,
    fixtureDate: "2027-03-14",
  });
  assert.equal(repeated.sql, "");
  assert.equal(repeated.receiptChanges, 0);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("mock Development dispatch verifies identity, non-JSON success and dated receipt-only repair without duplicate writes", async (t) => {
  const { db, run, options } = setup(t);
  const paths = [];
  let writes = 0;
  const dev = {
    ...options,
    target: "dev",
    confirm: "sales-visit-dev",
    env: { CLOUDFLARE_ACCOUNT_ID: "a".repeat(32) },
    inspect: async (path) => {
      paths.push(path);
      return path === ""
        ? { id: "a".repeat(32) }
        : {
            uuid: "66aadb98-21f9-413e-8646-7347555b2268",
            name: "sales-visit-dev",
          };
    },
    execute: async (sql, write) => {
      if (write) {
        writes++;
        assert.equal(paths.length, 2);
        run(sql);
        return parseD1Response(
          "non-JSON successful output",
          "write.response",
          true
        );
      }
      return run(sql);
    },
  };
  await refresh({ ...dev, apply: true });
  assert.equal(writes, 1);
  db.exec(
    "UPDATE demo_fixture_state SET record_json='{}' WHERE table_name='visits' AND record_key='[\"demo-visit-01-01\"]';"
  );
  paths.length = 0;
  const repair = await refresh({
    ...dev,
    repairProvenance: true,
    fixtureDate: "2027-03-15",
    apply: true,
    confirmProvenanceRepair: true,
  });
  assert.equal(repair.pendingChanges, 0);
  assert.equal(repair.receiptChanges, 1);
  assert.equal(writes, 2);
  paths.length = 0;
  const verify = await refresh({ ...dev, verifyOnly: true });
  assert.equal(verify.sql, "");
  assert.equal(writes, 2);
});

test("recovery retains target, date, read-only and Development confirmations", async (t) => {
  const { options } = setup(t);
  let writes = 0;
  const noWrite = {
    ...options,
    execute: async () => {
      writes++;
      throw Error("unexpected dispatch");
    },
  };
  for (const extra of [
    { target: "production", repairProvenance: true },
    { verifyOnly: true, apply: true },
    { fixtureDate: "2027-03-14" },
    { repairProvenance: true, fixtureDate: "2027-02-30" },
    { repairProvenance: true, fixtureDate: "2027-03-16" },
    {
      target: "dev",
      apply: true,
      repairProvenance: true,
      confirmProvenanceRepair: true,
    },
  ])
    await assert.rejects(refresh({ ...noWrite, ...extra }));
  assert.equal(writes, 0);
});
