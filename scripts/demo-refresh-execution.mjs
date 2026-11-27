import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const knownTables = new Set([
  "sales_force",
  "users",
  "outlets",
  "products",
  "sales_force_supervisors",
  "visit_schedules",
  "visits",
  "stock_reports",
  "stock_report_items",
  "demo_fixture_state",
]);
const knownColumns = new Set([
  "id",
  "name",
  "business_id",
  "no_rs",
  "sales_force_id",
  "outlet_id",
  "weekday",
  "visit_id",
  "product_id",
  "stock_report_id",
  "table_name",
  "record_key",
  "record_json",
  "quantity",
  "role",
  "status",
]);

/** Never echo arbitrary error messages/SQL/URLs/paths/headers. Project only known
 * diagnostic categories, numeric codes, static schema identifiers and byte counts.
 * This also protects failures containing snapshot rows or credential-shaped text. */
export function diagnosticFacts(value) {
  const text =
    typeof value === "string"
      ? value
      : `${String(value?.message ?? "")}\n${String(value?.cause?.message ?? "")}\n${String(value?.cause?.code ?? "")}`;
  const findings = new Set();
  const codes = new Set();
  const fields = new Set();
  const patterns = [
    ["snapshot_conflict", /snapshot conflict|malformed JSON/i],
    [
      "foreign_key_constraint",
      /FOREIGN KEY constraint|SQLITE_CONSTRAINT_FOREIGNKEY/i,
    ],
    [
      "unique_constraint",
      /UNIQUE constraint|SQLITE_CONSTRAINT_UNIQUE|SQLITE_CONSTRAINT_PRIMARYKEY/i,
    ],
    ["check_constraint", /CHECK constraint|SQLITE_CONSTRAINT_CHECK/i],
    ["not_null_constraint", /NOT NULL constraint|SQLITE_CONSTRAINT_NOTNULL/i],
    [
      "sql_syntax",
      /syntax error|SQLITE_ERROR|no such (?:table|column)|SQLITE_AUTH|not authorized to use function/i,
    ],
    [
      "authorization",
      /Authentication error|authorization failed|permission denied|insufficient permission|HTTP\s*(?:401|403)\b|\[code:\s*10000\]/i,
    ],
    [
      "statement_limit",
      /statement.{0,40}(?:too long|too large)|SQLITE_TOOBIG|SQL string exceeds/i,
    ],
    [
      "parameter_limit",
      /too many (?:SQL variables|parameters)|parameter.{0,30}limit/i,
    ],
    ["request_limit", /request.{0,30}(?:too large|limit)|HTTP\s*413\b/i],
    [
      "query_timeout",
      /query.{0,30}(?:timeout|timed out)|exceeded.{0,25}(?:time|CPU)/i,
    ],
    ["rate_limit", /rate limit|HTTP\s*429\b|too many requests/i],
    [
      "network",
      /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR_[A-Z_]+/i,
    ],
    [
      "tls",
      /CERT_[A-Z_]+|certificate.{0,30}(?:expired|verify|invalid)|unable to verify|self signed certificate|UNABLE_TO_GET_ISSUER_CERT_LOCALLY/i,
    ],
    [
      "upload_failed",
      /File could not be uploaded|File did not upload successfully|File contents did not upload successfully/i,
    ],
    [
      "import_rolled_back",
      /D1 reset before execute completed|DB will return to its original state.*(?:failed|error)/i,
    ],
  ];
  if (["AbortError", "TimeoutError"].includes(value?.name))
    findings.add("request_timeout");
  for (const [name, pattern] of patterns)
    if (pattern.test(text)) findings.add(name);
  for (const match of text.matchAll(
    /\[code:\s*(\d{3,6})\]|"(?:code|status|statusCode)"\s*:\s*(\d{3,6})(?!\d)/g
  )) {
    const code = Number(match[1] ?? match[2]);
    codes.add(code);
    if ([401, 403, 10000].includes(code)) findings.add("authorization");
    if (code === 413) findings.add("request_limit");
    if (code === 429) findings.add("rate_limit");
  }
  for (const match of text.matchAll(/\b([a-z_]+)\.([a-z_]+)\b/g)) {
    if (knownTables.has(match[1]) && knownColumns.has(match[2]))
      fields.add(`${match[1]}.${match[2]}`);
  }
  for (const match of text.matchAll(/HTTP\s+(\d{3})\b/g))
    codes.add(Number(match[1]));
  const systemCode =
    value &&
    typeof value === "object" &&
    ["ENOENT", "EACCES", "EPERM", "ENOEXEC", "ENOBUFS", "ETIMEDOUT"].includes(
      value.code
    )
      ? value.code
      : undefined;
  if (["EACCES", "EPERM"].includes(systemCode)) {
    findings.delete("authorization");
    findings.add("process_permissions");
  }
  return {
    findings: [...findings],
    codes: [...codes],
    fields: [...fields],
    ...(systemCode ? { systemCode } : {}),
  };
}
export class RefreshFailure extends Error {
  constructor(
    stage,
    outcome,
    facts = {},
    detail = "Operation did not complete"
  ) {
    super(detail);
    this.name = "RefreshFailure";
    this.stage = stage;
    this.outcome = outcome;
    this.facts = facts;
  }
}
class RefreshApiFailure extends Error {
  constructor(facts) {
    super("Cloudflare request was not confirmed");
    this.safeFacts = facts;
  }
}
export function createRefreshApi(account, token, fetcher = fetch) {
  if (!/^[a-f0-9]{32}$/.test(account ?? "") || !token)
    throw new RefreshFailure(
      "identity.credentials",
      "not_started",
      {},
      "Cloudflare account/API token is missing or invalid"
    );
  return async (path, body) => {
    let response, payload;
    try {
      response = await fetcher(
        `https://api.cloudflare.com/client/v4/accounts/${account}${path}`,
        {
          method: body ? "POST" : "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          redirect: "error",
          signal: AbortSignal.timeout(30000),
        }
      );
    } catch (error) {
      throw new RefreshApiFailure({
        ...diagnosticFacts(error),
        apiPhase: "transport",
      });
    }
    try {
      payload = await response.json();
    } catch {
      const facts = diagnosticFacts(
        JSON.stringify({ status: response.status })
      );
      throw new RefreshApiFailure({
        ...facts,
        findings: [...facts.findings, "invalid_json"],
        apiPhase: "json",
        httpStatus: response.status,
      });
    }
    if (!response.ok || payload?.success !== true || payload.result == null)
      throw new RefreshApiFailure({
        ...diagnosticFacts(
          JSON.stringify({ status: response.status, errors: payload?.errors })
        ),
        apiPhase: "response",
        httpStatus: response.status,
      });
    return payload.result;
  };
}
export function stageFailure(stage, outcome, error, detail) {
  if (error instanceof RefreshFailure) return error;
  return new RefreshFailure(
    stage,
    outcome,
    error instanceof RefreshApiFailure
      ? error.safeFacts
      : diagnosticFacts(error),
    detail
  );
}
function streamFacts(source, text) {
  const value = typeof text === "string" ? text : "";
  return {
    source,
    bytes: Buffer.byteLength(value),
    digest: createHash("sha256").update(value).digest("hex").slice(0, 16),
    ...diagnosticFacts(value),
  };
}
function has(facts, ...names) {
  return facts.findings?.some((name) => names.includes(name));
}
export function subprocessFailure(stage, result, write) {
  const stdout = streamFacts("stdout", result.stdout),
    stderr = streamFacts("stderr", result.stderr);
  const processFacts = diagnosticFacts(result.error);
  const findings = [...new Set([...stdout.findings, ...stderr.findings])];
  const facts = {
    exit: Number.isInteger(result.status) ? result.status : null,
    signal: [
      "SIGINT",
      "SIGTERM",
      "SIGHUP",
      "SIGKILL",
      "SIGABRT",
      "SIGSEGV",
    ].includes(result.signal)
      ? result.signal
      : null,
    ...processFacts,
    findings,
    streams: [stdout, stderr],
  };
  // A failed process launch is different from losing output after a child ran.
  const notStarted =
    ["ENOENT", "EACCES", "EPERM", "ENOEXEC"].includes(
      processFacts.systemCode
    ) &&
    result.status === null &&
    !result.signal;
  const rejected =
    !result.error &&
    !result.signal &&
    has(
      facts,
      "snapshot_conflict",
      "foreign_key_constraint",
      "unique_constraint",
      "check_constraint",
      "not_null_constraint",
      "sql_syntax",
      "import_rolled_back",
      "upload_failed"
    );
  const outcome =
    !write || notStarted ? "not_started" : rejected ? "failed" : "uncertain";
  return new RefreshFailure(
    stage,
    outcome,
    facts,
    "Wrangler subprocess did not confirm success"
  );
}
export function parseD1Response(text, stage, write) {
  let parsed;
  try {
    // Wrangler 4.156.2 remote --file uses cli-interactive's logRaw spinner,
    // bypassing --json's logger suppression. Accept only its verified preamble,
    // never arbitrary surrounding text or a guessed JSON substring.
    const lines = stripVTControlCharacters(text).split(/\r?\n/);
    while (
      lines.length &&
      (!lines[0].trim() ||
        /^[├│]\s*(?:Checking if file needs uploading|🌌 Uploading .+)?\s*$/.test(
          lines[0]
        ))
    )
      lines.shift();
    parsed = JSON.parse(lines.join("\n"));
  } catch {
    throw new RefreshFailure(
      stage,
      write ? "uncertain" : "not_started",
      { streams: [streamFacts("stdout", text)] },
      "Wrangler response is not valid JSON"
    );
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.length ||
    parsed.some((r) => r?.success !== true || !Array.isArray(r.results))
  ) {
    const facts = streamFacts("stdout", text);
    const rejected = has(
      facts,
      "snapshot_conflict",
      "foreign_key_constraint",
      "unique_constraint",
      "check_constraint",
      "not_null_constraint",
      "sql_syntax"
    );
    throw new RefreshFailure(
      stage,
      write ? (rejected ? "failed" : "uncertain") : "not_started",
      { ...facts, streams: [facts] },
      "D1 response did not contain a nonempty successful result array"
    );
  }
  return parsed;
}
export function executionVersion() {
  let wrangler = "unavailable";
  try {
    const version = JSON.parse(
      readFileSync(
        new URL(
          "../apps/api/node_modules/wrangler/package.json",
          import.meta.url
        ),
        "utf8"
      )
    ).version;
    if (/^\d+\.\d+\.\d+(?:[-.][a-zA-Z0-9.-]+)?$/.test(version))
      wrangler = version;
  } catch {
    /* Report absence without exposing a path. */
  }
  return { node: process.version, wrangler, platform: process.platform };
}
export function createWranglerExecutor({
  target,
  dir,
  empty,
  env,
  remoteApi,
  validateWrite,
  spawn = spawnSync,
  persistTo,
}) {
  let sequence = 0;
  return async (sql, write = false, stage = "d1.read") => {
    if (target === "dev" && !write) return remoteApi(sql);
    let file;
    try {
      if (write) validateWrite();
      file = join(dir, `batch-${++sequence}.sql`);
      writeFileSync(file, sql);
    } catch (error) {
      throw stageFailure(
        `${stage}.prepare`,
        "not_started",
        error,
        "Wrangler target/file preparation failed before launch"
      );
    }
    const args = [
      fileURLToPath(
        new URL(
          "../apps/api/node_modules/wrangler/bin/wrangler.js",
          import.meta.url
        )
      ),
      "d1",
      "execute",
      "DB",
      target === "dev" ? "--remote" : "--local",
      "--config",
      target === "dev" ? "wrangler.dev.jsonc" : "wrangler.jsonc",
      "--env-file",
      empty,
      "--file",
      file,
      "--json",
      ...(persistTo ? ["--persist-to", persistTo] : []),
    ];
    let result;
    try {
      result = spawn(process.execPath, args, {
        cwd: fileURLToPath(new URL("../apps/api/", import.meta.url)),
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        timeout: 180000,
        env: { ...env, WRANGLER_SEND_METRICS: "false" },
      });
    } catch (error) {
      throw new RefreshFailure(
        `${stage}.spawn`,
        write ? "uncertain" : "not_started",
        diagnosticFacts(error),
        "Wrangler launcher threw before returning process status"
      );
    }
    if (result.error || result.status !== 0)
      throw subprocessFailure(`${stage}.execute`, result, write);
    try {
      return parseD1Response(result.stdout, `${stage}.response`, write);
    } catch (error) {
      if (error instanceof RefreshFailure) {
        error.facts.exit = result.status;
        error.facts.signal = null;
        error.facts.streams = [
          streamFacts("stdout", result.stdout),
          streamFacts("stderr", result.stderr),
        ];
      }
      throw error;
    }
  };
}
export function describeRefreshFailure(error, { verifying = false } = {}) {
  const failure =
    error instanceof RefreshFailure
      ? error
      : new RefreshFailure(
          "unexpected",
          "not_started",
          {},
          "Unexpected refresh failure"
        );
  const facts = failure.facts;
  const findings = new Set([
    ...(facts.findings ?? []),
    ...(facts.streams ?? []).flatMap((s) => s.findings),
  ]);
  const messages = [
    `${verifying ? "Wrangler receipt unavailable. Continuing with read-only verification." : "Demo refresh stopped."}\nStage: ${failure.stage}\nWrite outcome: ${failure.outcome}\nReason: ${failure.message}`,
  ];
  if (facts.runtime)
    messages.push(
      `Runtime: Node ${facts.runtime.node}; Wrangler ${facts.runtime.wrangler}; ${facts.runtime.platform}`
    );
  if (Object.hasOwn(facts, "exit"))
    messages.push(
      `Wrangler exit: ${facts.exit ?? "unavailable"}; signal: ${facts.signal ?? "none"}${facts.systemCode ? `; process: ${facts.systemCode}` : ""}`
    );
  for (const stream of facts.streams ?? [])
    messages.push(
      `Wrangler ${stream.source}: ${stream.bytes} bytes; signature ${stream.digest}; ${stream.findings.join(", ") || "no allowlisted error category"}${stream.codes.length ? `; codes ${stream.codes.join(", ")}` : ""}${stream.fields.length ? `; fields ${stream.fields.join(", ")}` : ""}`
    );
  if (facts.apiPhase)
    messages.push(
      `Cloudflare API phase: ${facts.apiPhase}${facts.httpStatus ? `; HTTP ${facts.httpStatus}` : ""}`
    );
  if (facts.codes?.length)
    messages.push(`Cloudflare/D1 codes: ${facts.codes.join(", ")}`);
  if (findings.size)
    messages.push(
      `Diagnostics: ${[...findings].join(", ")}${facts.systemCode ? `; ${facts.systemCode}` : ""}`
    );
  if (facts.statement)
    messages.push(
      `Isolated SQL preflight: statement ${facts.statement}; operation ${facts.operation ?? "unknown"}; table ${facts.table ?? "unknown"}`
    );
  if (facts.table && !facts.statement)
    messages.push(
      `Isolated snapshot context: ${facts.table}; ${facts.operation ?? "unknown"}`
    );
  if (facts.systemCode === "ENOENT" || findings.has("process_permissions"))
    messages.push(
      "Check the Node/Wrangler installation and execution/temp-directory permissions in the current OS. Do not share WSL node_modules symlinks with native Windows Node."
    );
  if (findings.has("authorization"))
    messages.push(
      "Check that CLOUDFLARE_API_TOKEN has Account / D1 / Edit for the verified Development account. Successful identity and SELECT checks prove read access, not import/write permission."
    );
  if (findings.has("network") || findings.has("tls"))
    messages.push(
      "Inspect WSL DNS, proxy and CA configuration for the Wrangler subprocess. Do not disable TLS verification."
    );
  if (findings.has("snapshot_conflict"))
    messages.push(
      "The snapshot/provenance guard rejected drift. Run a fresh read-only preview and review conflicts; do not remove the guard."
    );
  if ([...findings].some((f) => f.includes("constraint") || f === "sql_syntax"))
    messages.push(
      "The isolated/remote database rejected SQL or a constraint. Inspect the reported static table/fields and schema; do not disable foreign keys or delete conflicting records."
    );
  if ([...findings].some((f) => f.endsWith("limit") || f === "query_timeout"))
    messages.push(
      "Review the reported SQL size/count and D1 limits. Do not split guarded writes into independently committed retries."
    );
  if (verifying)
    messages.push(
      "A fresh read-only snapshot will verify the original plan. No write will be repeated."
    );
  else if (failure.outcome === "applied_unverified")
    messages.push(
      "The write returned a success receipt, but post-refresh verification failed. Do not repeat --apply. Run pnpm db:refresh:demo:dev --dry-run (or the local equivalent) and inspect rows/provenance receipts."
    );
  else if (failure.outcome === "uncertain")
    messages.push(
      "The write may have committed. Do not blindly retry --apply. Run a read-only preview and verify the database/provenance receipts first."
    );
  else if (failure.outcome === "failed")
    messages.push(
      "The atomic execution was rejected; no successful write is confirmed. Resolve the reported cause, then review a fresh dry-run before a separately approved apply."
    );
  else
    messages.push(
      "No refresh write was started. Correct this stage and rerun a dry-run before applying."
    );
  messages.push(
    "No automatic write retry was attempted. Raw stdout/stderr, SQL, paths and credentials are not printed."
  );
  return messages.join("\n");
}
