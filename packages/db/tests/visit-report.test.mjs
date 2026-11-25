import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

test("0015 preserves legacy Visits and independent/linked Stock Reports; enforces integer bounds", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys=ON");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql") && f < "0015")
    .toSorted())
    db.exec(readFileSync(new URL(file, dir), "utf8"));
  db.exec(`INSERT INTO sales_force(id,name) VALUES ('sf','SF');
    INSERT INTO outlets(id,name) VALUES ('o','Outlet');
    INSERT INTO products(id,name) VALUES ('p','Product');
    INSERT INTO visits(id,outlet_id,sales_force_id,visited_at,submission_channel) VALUES ('v','o','sf',1,'web');
    INSERT INTO stock_reports(id,outlet_id,reporter_sales_force_id,visit_id,reported_at,submission_channel) VALUES ('r','o','sf','v',1,'web'), ('independent','o','sf',NULL,2,'telegram');
    INSERT INTO stock_report_items(stock_report_id,product_id,quantity) VALUES ('r','p',0),('independent','p',10);`);
  const before = db.prepare("SELECT * FROM stock_reports ORDER BY id").all();
  db.exec(readFileSync(new URL("0015_visit_report.sql", dir), "utf8"));
  assert.deepEqual(
    db.prepare("SELECT * FROM stock_reports ORDER BY id").all(),
    before
  );
  assert.equal(
    db.prepare("SELECT reporting_week, digipos_balance FROM visits").get()
      .reporting_week,
    null
  );
  assert.equal(
    db.prepare("SELECT reporting_week, digipos_balance FROM visits").get()
      .digipos_balance,
    null
  );
  for (const [field, invalid] of [
    ["reporting_week", 5],
    ["reporting_week", 0],
    ["reporting_month", 13],
    ["reporting_year", 0],
    ["digipos_balance", -1],
    ["total_purchase", 1.5],
    ["vf_voice_stock", 9007199254740992],
    ["is_cvm_active", 2],
  ])
    assert.throws(() =>
      db.prepare(`UPDATE visits SET ${field}=?`).run(invalid)
    );
  db.exec(
    "UPDATE visits SET digipos_balance=0, reporting_week=4, is_cvm_active=0"
  );
  assert.equal(
    db.prepare("SELECT digipos_balance FROM visits").get().digipos_balance,
    0
  );
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});
