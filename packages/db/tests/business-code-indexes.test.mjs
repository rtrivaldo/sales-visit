import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
test("0014 adds non-destructive NOCASE indexes over populated case-colliding business codes", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys = ON");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir)
    .filter((name) => name.endsWith(".sql") && name < "0014_")
    .toSorted())
    db.exec(readFileSync(new URL(file, dir), "utf8"));
  db.exec(
    "INSERT INTO sales_force(id,name) VALUES ('SF001','A'),('sf001','B'),('0001','C'); INSERT INTO outlets(id,name,business_id) VALUES ('one','A','OUT001'),('two','B','out001'),('three','C','0001');"
  );
  const snapshot = () => [
    db.prepare("SELECT * FROM sales_force ORDER BY id").all(),
    db.prepare("SELECT * FROM outlets ORDER BY id").all(),
  ];
  const before = snapshot();
  db.exec(readFileSync(new URL("0014_business_code_lookup.sql", dir), "utf8"));
  assert.deepEqual(snapshot(), before);
  for (const [table, column, code, index] of [
    ["outlets", "business_id", "Out001", "outlets_business_id_nocase_idx"],
    ["sales_force", "id", "Sf001", "sales_force_id_nocase_idx"],
  ]) {
    assert.equal(
      db
        .prepare(
          `SELECT count(*) AS n FROM ${table} WHERE ${column} = ? COLLATE NOCASE`
        )
        .get(code).n,
      2
    );
    assert.equal(
      db
        .prepare(
          `SELECT ${column} AS code FROM ${table} WHERE ${column} = ? COLLATE NOCASE`
        )
        .get("0001").code,
      "0001"
    );
    assert.match(
      db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT * FROM ${table} WHERE ${column} = ? COLLATE NOCASE`
        )
        .get(code).detail,
      new RegExp(index)
    );
  }
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});
