import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  migrationFiles,
  snapshotQueries,
  canonical,
} from "./demo-fixtures.mjs";
import { diagnosticFacts, RefreshFailure } from "./demo-refresh-execution.mjs";

// Generated SQL may contain semicolons, quotes or comments in snapshot strings.
// Never use split(';') to measure statements or identify a failing operation.
export function sqlStatements(sql) {
  const statements = [];
  let start = 0,
    quote = null,
    line = false,
    block = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i],
      next = sql[i + 1];
    if (line) {
      if (c === "\n") line = false;
      continue;
    }
    if (block) {
      if (c === "*" && next === "/") {
        block = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (c === quote) {
        if (next === quote) i++;
        else quote = null;
      }
      continue;
    }
    if (c === "-" && next === "-") {
      line = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      block = true;
      i++;
      continue;
    }
    if (["'", '"', "`"].includes(c)) {
      quote = c;
      continue;
    }
    if (c === ";") {
      const part = sql.slice(start, i).trim();
      if (part) statements.push(part);
      start = i + 1;
    }
  }
  if (quote || block)
    throw new RefreshFailure(
      "sql.preflight",
      "not_started",
      { findings: ["sql_syntax"] },
      "Generated SQL has an unterminated literal/comment"
    );
  const tail = sql.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}
export function sqlMetrics(sql) {
  const statements = sqlStatements(sql);
  const bytes = Buffer.byteLength(sql),
    maxStatementBytes = statements.reduce(
      (maximum, s) => Math.max(maximum, Buffer.byteLength(s)),
      0
    );
  if (maxStatementBytes > 100000)
    throw new RefreshFailure(
      "sql.limits",
      "not_started",
      { findings: ["statement_limit"] },
      "Generated SQL exceeds D1's 100,000-byte individual statement limit"
    );
  if (bytes > 5_000_000_000)
    throw new RefreshFailure(
      "sql.limits",
      "not_started",
      { findings: ["request_limit"] },
      "Generated SQL exceeds the conservative 5-GB file-import limit"
    );
  return {
    bytes,
    statements: statements.length,
    maxStatementBytes,
    boundParameters: 0,
  };
}
/** Simulate the exact guarded file before launching a write. The snapshot may
 * omit unrelated FK parents, so compare FK violations before/after instead of
 * misreporting an intentionally incomplete isolated model as a corrupt remote DB.
 * No remote schema/data changes, SQL bypass or transactions are sent to D1. */
export function preflightReconciliation(fixture, snapshot, plan) {
  const metrics = sqlMetrics(plan.sql);
  if (!plan.sql) return metrics;
  const db = new DatabaseSync(":memory:");
  let statement,
    phase = "sql.preflight.schema",
    snapshotTable;
  try {
    for (const file of migrationFiles())
      db.exec(
        readFileSync(
          new URL(`../packages/db/migrations/${file}`, import.meta.url),
          "utf8"
        )
      );
    db.exec("PRAGMA foreign_keys=OFF");
    phase = "sql.preflight.snapshot";
    for (const { table } of snapshotQueries(fixture)) {
      snapshotTable = table;
      const allowed = new Set(
        db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((c) => c.name)
      );
      for (const row of snapshot[table] ?? []) {
        const columns = Object.keys(row);
        if (columns.some((c) => !allowed.has(c)))
          throw new RefreshFailure(
            "sql.preflight.schema",
            "not_started",
            {},
            "Snapshot columns do not match the checked-in schema; inspect migrations before applying"
          );
        if (
          Object.values(row).some(
            (v) => typeof v === "number" && !Number.isSafeInteger(v)
          )
        )
          throw new RefreshFailure(
            "sql.preflight.snapshot",
            "not_started",
            {},
            "Snapshot contains an integer that cannot be guarded losslessly with JavaScript safe integers"
          );
        db.prepare(
          `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`
        ).run(...Object.values(row));
      }
    }
    db.exec("PRAGMA foreign_keys=ON");
    const violations = () =>
      db.prepare("PRAGMA foreign_key_check").all().map(canonical).toSorted();
    const before = violations();
    db.exec("BEGIN");
    phase = "sql.preflight";
    const statements = sqlStatements(plan.sql);
    for (let i = 0; i < statements.length; i++) {
      statement = i + 1;
      const query = db.prepare(statements[i]);
      if (query.columns().length) query.all();
      else query.run();
    }
    const after = violations();
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw new RefreshFailure(
        "sql.preflight.foreign_keys",
        "not_started",
        { findings: ["foreign_key_constraint"] },
        "Reconciliation changes foreign-key integrity in the isolated snapshot"
      );
    db.exec("COMMIT");
    return metrics;
  } catch (error) {
    if (error instanceof RefreshFailure) throw error;
    const sql = statement ? sqlStatements(plan.sql)[statement - 1] : "";
    const operation = /^(SELECT|UPDATE|INSERT)\b/.exec(sql)?.[1];
    const table =
      /^(?:UPDATE|INSERT INTO) ([a-z_]+)/.exec(sql)?.[1] ??
      /\bFROM ([a-z_]+)/.exec(sql)?.[1] ??
      snapshotTable;
    throw new RefreshFailure(
      phase,
      "not_started",
      {
        ...diagnosticFacts(error),
        ...(statement
          ? { statement, operation, table }
          : snapshotTable
            ? { table: snapshotTable, operation: "SNAPSHOT_LOAD" }
            : {}),
      },
      "Generated SQL or the captured snapshot failed isolated SQLite validation"
    );
  } finally {
    db.close();
  }
}
