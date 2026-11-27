import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { readJSON } from "./ci/targets.mjs";
import {
  fixtureState,
  migrationFiles,
  snapshotQueries,
  reconcile,
  canonical,
} from "./demo-fixtures.mjs";
import { sqlStatements } from "./demo-refresh-preflight.mjs";
import { refresh, validateRefreshTarget } from "./demo-refresh.mjs";
const now = Date.parse("2027-03-15T08:00:00Z"),
  fixture = fixtureState(now);
function database(t, seed = false) {
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
  if (seed)
    db.exec(
      readFileSync(
        new URL("../apps/api/seeds/demo.sql", import.meta.url),
        "utf8"
      )
    );
  return db;
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
function execute(db, sql) {
  db.exec("BEGIN");
  try {
    const rows = sqlStatements(sql).map((s) => {
      const p = db.prepare(s);
      if (p.columns().length)
        return { success: true, results: p.all().map((r) => ({ ...r })) };
      p.run();
      return { success: true, results: [] };
    });
    db.exec("COMMIT");
    return rows;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
test("refresh inserts missing fixtures, refreshes legacy values, current dates and relationships, and is repeatable", async (t) => {
  for (const seeded of [false, true])
    await t.test(String(seeded), async (child) => {
      const db = database(child, seeded);
      if (seeded)
        db.exec(
          "UPDATE visits SET reporting_week=NULL,reporting_month=NULL,reporting_year=NULL,digipos_balance=NULL,perdana_sa_stock=NULL,perdana_sa_selling=NULL,perdana_sa_sellout=NULL,vf_data_stock=NULL,vf_data_selling=NULL,vf_data_sellout=NULL,vf_voice_stock=NULL,vf_voice_selling=NULL,vf_voice_sellout=NULL,is_cvm_active=NULL,is_voice_active=NULL,is_digital_active=NULL,total_purchase=NULL"
        );
      db.exec(
        "INSERT INTO outlets(id,name,business_id) VALUES ('real','Real Outlet','REAL');"
      );
      const real = canonical(
        db.prepare("SELECT * FROM outlets WHERE id='real'").get()
      );
      const lines = [];
      const first = await refresh({
        target: "local",
        apply: true,
        now,
        env: {},
        execute: async (sql) => execute(db, sql),
        output: (line) => lines.push(line),
      });
      assert.equal(first.conflicts.length, 0);
      assert.ok(
        lines.some((line) => line.includes("Real records modified: 0"))
      );
      assert.equal(
        db
          .prepare(
            "SELECT count(*) AS n FROM visits WHERE reporting_month=3 AND reporting_year=2027 AND total_purchase IS NOT NULL"
          )
          .get().n,
        156
      );
      assert.equal(
        canonical(db.prepare("SELECT * FROM outlets WHERE id='real'").get()),
        real
      );
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
      const second = await refresh({
        target: "local",
        apply: true,
        now,
        env: {},
        execute: async (sql) => execute(db, sql),
        output: () => {},
      });
      assert.equal(second.sql, "");
      assert.ok(second.actions.every((a) => a.action === "unchanged"));
      const next = fixtureState(now + 86400000),
        plan = reconcile(next, snapshot(db));
      assert.equal(plan.conflicts.length, 0);
      assert.ok(plan.actions.some((a) => a.action === "update"));
      execute(db, plan.sql);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    });
});
test("dry-run does not write; conflicting fingerprints, shared products and Telegram identities block reconciliation", async (t) => {
  const db = database(t, true),
    before = db
      .prepare("SELECT total_purchase FROM visits ORDER BY id LIMIT 1")
      .get().total_purchase;
  const preview = await refresh({
    target: "local",
    now,
    env: {},
    execute: async (sql) => {
      assert.match(sql.trim(), /^SELECT/);
      return execute(db, sql);
    },
    output: () => {},
  });
  assert.ok(preview.actions.some((a) => a.action === "update"));
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM demo_fixture_state").get().n,
    0
  );
  db.exec(
    "UPDATE products SET name='Shared real product' WHERE id='demo-prd-01'; INSERT INTO telegram_identities(user_id,telegram_user_id) VALUES ('demo-admin-01','123');"
  );
  const plan = reconcile(fixture, snapshot(db));
  assert.ok(plan.conflicts.some((r) => r.table === "products"));
  assert.ok(plan.conflicts.some((r) => r.table === "users"));
  assert.ok(
    !plan.actions.some(
      (a) => a.table === "products" && a.target.id === "demo-prd-01"
    )
  );
  if (plan.sql) execute(db, plan.sql);
  assert.equal(
    db.prepare("SELECT name FROM products WHERE id='demo-prd-01'").get().name,
    "Shared real product"
  );
  // A conflicted shared Product freezes its linked reports, not unrelated
  // unlinked Visits merely sharing the same SF/Outlet.
  assert.notEqual(
    db.prepare("SELECT total_purchase FROM visits ORDER BY id LIMIT 1").get()
      .total_purchase,
    before
  );
  assert.ok(
    plan.actions.some((a) => a.table === "visits" && a.action === "update")
  );
  assert.ok(
    plan.conflicts.some(
      (c) => c.kind === "propagated" && c.root.startsWith("products:")
    )
  );
});
test("real dependencies and concurrent changes never get overwritten", (t) => {
  const db = database(t, true);
  db.exec(
    "INSERT INTO visits(id,outlet_id,sales_force_id,visited_at,submission_channel) VALUES ('real-visit','demo-out-01','demo-sf-01',1,'web')"
  );
  const plan = reconcile(fixture, snapshot(db));
  assert.ok(
    plan.protections.some((r) => r.reason === "Non-fixture dependency")
  );
  const sf = plan.actions.find(
    (a) => a.table === "sales_force" && a.target.id === "demo-sf-01"
  );
  assert.equal(sf.protected, true);
  assert.equal(sf.action, "unchanged");
  assert.equal(sf.receiptTarget, null);
  assert.ok(plan.conflicts.some((c) => c.root === "external:visits"));
  const before = canonical(
    db.prepare("SELECT * FROM visits WHERE id='real-visit'").get()
  );
  if (plan.sql) execute(db, plan.sql);
  assert.equal(
    canonical(db.prepare("SELECT * FROM visits WHERE id='real-visit'").get()),
    before
  );
  const empty = database(t);
  const initial = reconcile(fixture, snapshot(empty));
  empty.exec(
    "INSERT INTO outlets(id,name) VALUES ('demo-out-01','Concurrent real collision')"
  );
  assert.throws(() => execute(empty, initial.sql));
  assert.equal(
    empty.prepare("SELECT count(*) AS n FROM sales_force").get().n,
    0
  );
  assert.equal(
    empty.prepare("SELECT name FROM outlets").get().name,
    "Concurrent real collision"
  );
});
test("Development dry-run verifies remote identity and uses read-only REST queries", async (t) => {
  const db = database(t, true),
    paths = [];
  await refresh({
    target: "dev",
    now,
    env: { CLOUDFLARE_ACCOUNT_ID: "a".repeat(32) },
    inspect: async (path, body) => {
      paths.push(path);
      if (path === "") return { id: "a".repeat(32) };
      if (path.endsWith("/query")) {
        assert.match(body.sql.trim(), /^SELECT/);
        return execute(db, body.sql);
      }
      return {
        uuid: "66aadb98-21f9-413e-8646-7347555b2268",
        name: "sales-visit-dev",
      };
    },
    output: () => {},
  });
  assert.ok(paths.some((p) => p.endsWith("/query")));
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM demo_fixture_state").get().n,
    0
  );
});
test("business-code collisions are skipped rather than inserted or overwritten", (t) => {
  const db = database(t);
  db.exec(
    "INSERT INTO outlets(id,name,business_id) VALUES ('human','Real Outlet','demo-out-01'); INSERT INTO sales_force(id,name) VALUES ('DEMO-SF-01','Real SF');"
  );
  const plan = reconcile(fixture, snapshot(db));
  assert.ok(plan.conflicts.some((r) => r.reason.includes("collision")));
  assert.ok(
    !plan.actions.some(
      (r) => r.table === "outlets" && r.target.id === "demo-out-01"
    )
  );
  assert.ok(
    !plan.actions.some(
      (r) => r.table === "sales_force" && r.target.id === "demo-sf-01"
    )
  );
  if (plan.sql) execute(db, plan.sql);
  assert.equal(
    db.prepare("SELECT name FROM outlets WHERE id='human'").get().name,
    "Real Outlet"
  );
  assert.equal(
    db.prepare("SELECT name FROM sales_force WHERE id='DEMO-SF-01'").get().name,
    "Real SF"
  );
});
test("target protection, migration prerequisite and explicit remote confirmation fail closed", async () => {
  const dev = readJSON("apps/api/wrangler.dev.jsonc"),
    prod = readJSON("apps/api/wrangler.jsonc");
  assert.throws(() => validateRefreshTarget("production", prod, prod, {}));
  assert.throws(() => validateRefreshTarget("dev", prod, prod, {}));
  assert.throws(() =>
    validateRefreshTarget("dev", dev, prod, { WRANGLER_ENV: "production" })
  );
  for (const key of [
    "CLOUDFLARE_API_BASE_URL",
    "CF_API_BASE_URL",
    "WRANGLER_API_ENVIRONMENT",
  ])
    assert.throws(() =>
      validateRefreshTarget("dev", dev, prod, { [key]: "unapproved" })
    );
  const changed = structuredClone(dev);
  changed.d1_databases[0].database_id = prod.d1_databases[0].database_id;
  assert.throws(() => validateRefreshTarget("dev", changed, prod, {}));
  await assert.rejects(
    refresh({ target: "dev", apply: true, env: {}, output: () => {} })
  );
  let calls = 0;
  await assert.rejects(
    refresh({
      target: "local",
      env: {},
      execute: async () => {
        calls++;
        return [{ results: [], success: true }];
      },
      output: () => {},
    }),
    /migrations/
  );
  assert.equal(calls, 1);
});
