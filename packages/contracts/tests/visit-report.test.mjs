import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseRupiah,
  formatRupiah,
  parseQuantity,
  parseYesNo,
  createVisitSchema,
  visitSchema,
  reportingCalendar,
  visitReportSummary,
  visitQuestions,
} from "../src/index.ts";
import { visitReport } from "./visit-fixture.mjs";

test("strict shared Rupiah parser accepts Indonesian integer formats", () => {
  for (const text of [
    "1000000",
    "1.000.000",
    "Rp 1.000.000",
    "Rp1.000.000",
    "Rp. 1.000.000",
    "rp 1.000.000",
    "1 000 000",
    "  Rp 1.000.000  ",
  ])
    assert.equal(parseRupiah(text), 1000000, text);
  for (const text of ["0", "Rp 0", " 0 "]) assert.equal(parseRupiah(text), 0);
  for (const text of [
    "",
    " ",
    "Rp",
    "-1000000",
    "1.5",
    "1,5",
    "1.00.000",
    "abc",
    "Rp abc",
    "1e6",
    "9007199254740992",
    "9".repeat(400),
    "1.000 000",
    "1  000",
    "1\n000",
    "+1",
    "1_000",
    "12Rp",
  ])
    assert.equal(parseRupiah(text), undefined, text);
  assert.equal(
    parseRupiah(String(Number.MAX_SAFE_INTEGER)),
    Number.MAX_SAFE_INTEGER
  );
  assert.equal(formatRupiah(1000000), "Rp 1.000.000");
  assert.equal(formatRupiah(0), "Rp 0");
  assert.throws(() => formatRupiah(-1));
});
test("quantities, booleans and explicit required business periods", () => {
  for (const text of ["0", "1", String(Number.MAX_SAFE_INTEGER)])
    assert.equal(parseQuantity(text), Number(text));
  for (const text of ["-1", "1.0", "1,0", "1e6", "abc", "", "9007199254740992"])
    assert.equal(parseQuantity(text), undefined);
  for (const text of ["Y", "yes", "Ya", " YES "])
    assert.equal(parseYesNo(text), true);
  for (const text of ["N", "No", "Tidak", " tidak "])
    assert.equal(parseYesNo(text), false);
  for (const text of ["true", "false", "1", "0", ""])
    assert.equal(parseYesNo(text), undefined);
  const data = {
    ...visitReport,
    outletId: "record",
    visitedAt: "2026-11-30T18:00:00Z",
  };
  for (const reportingWeek of [1, 2, 3, 4])
    assert.ok(createVisitSchema.safeParse({ ...data, reportingWeek }).success);
  for (const reportingWeek of [0, 5, 1.1, "1", null])
    assert.equal(
      createVisitSchema.safeParse({ ...data, reportingWeek }).success,
      false
    );
  for (const [field] of visitQuestions) {
    const missing = { ...data };
    delete missing[field];
    assert.equal(createVisitSchema.safeParse(missing).success, false, field);
  }
  assert.equal(
    createVisitSchema.safeParse({ ...data, reportingMonth: 5 }).success,
    false
  );
  assert.deepEqual(reportingCalendar(data.visitedAt), {
    reportingMonth: 12,
    reportingYear: 2026,
  });
});
test("historical fields stay unavailable rather than zero", () => {
  const legacy = visitSchema.parse({
    id: "v",
    outletId: "o",
    salesForceId: "sf",
    visitedAt: "2026-11-01T00:00:00Z",
    submissionChannel: "web",
  });
  assert.equal(legacy.digiposBalance, undefined);
  assert.match(visitReportSummary(legacy), /Saldo Digipos: —/);
  assert.match(visitReportSummary(visitReport), /Stok: 0/);
  assert.match(visitReportSummary(visitReport), /CVM: N/);
});
