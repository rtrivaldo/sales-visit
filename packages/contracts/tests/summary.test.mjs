import assert from "node:assert/strict";
import { test } from "node:test";

import { completion, summaryText, formatProgress } from "../src/summary.ts";
import { sampleSummary } from "./summary-fixture.mjs";
test("summary formatting is concise, Indonesian, safe for empty/missing and large data", () => {
  assert.deepEqual(completion(0, 0), {
    scheduled: 0,
    completed: 0,
    remaining: 0,
    percentage: 0,
  });
  assert.equal(completion(2, 20).percentage, 100);
  assert.equal(completion(8, 5).percentage, 62.5);
  assert.equal(formatProgress(62.5), "62,5%");
  for (const role of ["admin", "supervisor", "sales_force"]) {
    const s = sampleSummary(role),
      text = summaryText(s);
    assert.match(text, /RINGKASAN/);
    assert.match(text, /Rp 24.850.000/);
    assert.ok(text.length < 4096);
    s.name = "😀".repeat(10000);
    s.salesForceId = "界".repeat(10000);
    assert.ok(summaryText(s).length < 4096);
    s.month.totalPurchase = null;
    s.month.missingPurchaseReports = 24;
    assert.match(summaryText(s), /Total Belanja: —/);
    assert.match(summaryText(s), /belum tersedia: 24/);
    s.month.totalPurchase = 0;
    assert.match(summaryText(s), /Rp 0/);
    s.readOnly = true;
    assert.doesNotMatch(summaryText(s), /\/salesvisit/);
  }
});
