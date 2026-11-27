import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  fixtureState,
  migrationFiles,
  snapshotQueries,
  reconcile,
} from "./demo-fixtures.mjs";
import { preflightReconciliation } from "./demo-refresh-preflight.mjs";
test("platform-independent demo fixture generation and atomic reconciliation", (t) => {
  const now = Date.parse("2027-04-01T00:00:00+07:00"),
    fixture = fixtureState(now),
    db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys=ON");
  for (const file of migrationFiles())
    db.exec(
      readFileSync(
        new URL(`../packages/db/migrations/${file}`, import.meta.url),
        "utf8"
      )
    );
  const read = () =>
    Object.fromEntries(
      snapshotQueries(fixture).map((q) => [
        q.table,
        db
          .prepare(q.sql)
          .all()
          .map((r) => ({ ...r })),
      ])
    );
  const before = read();
  const plan = reconcile(fixture, before);
  const preflight = preflightReconciliation(fixture, before, plan);
  assert.equal(preflight.boundParameters, 0);
  assert.ok(preflight.maxStatementBytes < 100000);
  assert.equal(plan.conflicts.length, 0);
  db.exec("BEGIN");
  db.exec(plan.sql);
  db.exec("COMMIT");
  assert.equal(reconcile(fixture, read()).sql, "");
  assert.ok(
    fixture.desired.visits.every(
      (v) =>
        v.reporting_month === 4 &&
        v.reporting_year === 2027 &&
        v.visited_at <= now
    )
  );
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});
