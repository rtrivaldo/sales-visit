# Demo refresh reconciliation, verification and recovery

## Verified incident findings (November 27, 2026)

`main` and fetched `origin/main` were both `544c4cd` during this investigation.
Existing uncommitted diagnostic work was retained. Inspection used the installed
Wrangler **4.156.2**, its bundled implementation, retained Wrangler logs, and
**read-only Development API requests** after checking the configured database's
UUID/name. No remote writes, migrations, deployments, resets, deletes, commits or
pushes were performed.

### The fingerprint conflict is an intentional, audited reassignment

The persisted `sales_force_supervisors["demo-sf-01"]` differs from the seed in
`supervisor_user_id` and `updated_at` (1795176516000 rather than 1793664000000).
The associated `reassign` audit independently confirms all of the following:

- Previous Supervisor equals the seed Supervisor.
- New Supervisor equals the persisted assignment.
- Audit time equals the assignment's `updated_at`.

There is no receipt for that assignment. It must **not** be adopted or restored
by a refresh/provenance-repair option. This is not a timestamp-normalization,
boolean, null, default-value or JSON-key-order defect. The seed baseline is loaded
through SQLite, so defaults and integer timestamps already have their persisted
representations. No seconds/milliseconds conversion or string/boolean coercion
was added. All fields remain part of the fingerprint.

### The previous import committed a limited plan, not the demo refresh

Reconstructing the pre-import snapshot by removing only the two matching receipts
reproduced **exactly 303,084 UTF-8 bytes and 750 SQL statements** with the old planner.
The only writes were two receipt upserts, for two independently eligible users;
there were **no business-row updates or inserts**. The retained Wrangler log has a
successful 750-query import summary (D1's rows-written counter is 4). Both expected
receipts now exist and match their persisted records; no other receipts exist.

Thus the import committed that limited plan. It did **not** update the remaining
fixtures and then lose their provenance. A SQL statement count includes the many
snapshot guards; it must not be interpreted as a count of refreshed records.
Receipts and business writes share the same guarded atomic execution file; there
was no separate receipt phase that could account for the blocked fixture graph.

### Why 827 records were blocked

There are 829 desired fixture records. The old algorithm removed a conflicted row
from `eligible`, then treated **every row removed from eligibility as non-fixture
operational data** on its next iteration. It protected parents, blocked children,
and repeated in both directions through shared SF, Supervisor users, Outlets,
Products, Visits and Stock Reports. The assignment audit also references fixture
users/SF. One direct fingerprint conflict consequently poisoned the shared graph:
**1 direct + 826 propagated = 827 blocked**, leaving two unconnected users eligible.

The new planner separates ownership from eligibility. Verified unchanged parents
can be **frozen anchors**: their business fields and receipts are not written.
Existing, independently fingerprinted children retaining that relationship may
refresh. New links/inserts against protected anchors are blocked. Changed parents
needed by operational or blocked records stay blocked; a blocked absent insert
cannot poison other parents because it has no persisted relationship.

The captured Development snapshot now plans **821 eligible records, 1 direct
conflict and 7 propagated conflicts**. Those seven are missing extra schedules for
the protected SF. Isolated replay for business date 2026-11-27 measured 337 business
changes and 815 receipt writes, 789,317 bytes / 1,902 statements (largest 7,099 bytes,
zero bound parameters). Replay converged without further eligible writes, preserved
all assignments/audits and produced zero FK violations. Actual future previews can
differ by business date or intervening operational changes.

### Why exit zero failed JSON parsing

Wrangler's `executeRemotely()` calls `spinnerWhile()` for file import initialization
and uploads. Its noninteractive spinner calls `cli-interactive`'s **`logRaw()`**, which
writes directly to stdout and does not share the logger level suppressed by
`--json`. Therefore successful stdout contains progress lines such as:

```text
├ Checking if file needs uploading
│
[ ... successful import result array ... ]
```

The old runner required `JSON.parse(entireStdout)`. A regression invokes the actual
installed Wrangler against a **loopback fake Cloudflare API**, with synthetic
credentials, and verifies this exact non-JSON stdout and successful result shape.
It never contacts Cloudflare. Pure JSON is also supported. Only the verified ANSI-
stripped spinner preamble is accepted; arbitrary banners/trailing data are not
silently scanned for a convenient JSON fragment.

If an exit-zero response still cannot be trusted, the runner performs **read-only
verification of the original plan**, without another write. Exit zero alone is
never proof of success.

## Implemented safety and reporting

- Default dry-run; fixed Development identity/configuration; Production and
  environment/API/config redirects refused; explicit remote confirmation retained.
- Full typed fingerprints: JSON object key order/whitespace are immaterial in a
  receipt, but missing/null/string/number/boolean differences are not coerced.
  Valid full-row receipts recognize prior generated versions. Exact seed and known
  legacy Visit variants remain supported. Prefixes and markers alone prove nothing.
- Roots, propagated conflicts, frozen shared anchors, operational dependency counts
  and `via`/`root` chains are reported before dispatch. Non-fixture record values,
  credentials, URLs, SQL and raw process output are not printed.
- Counts distinguish eligible, unchanged, pending business changes, pending receipt
  writes, matching/missing/mismatched receipts and independent fingerprints.
- Exact SQL is preflighted in an isolated SQLite snapshot with statement/UTF-8
  limits, real constraints and FK-before/after comparison. FK disabling is used
  only to load potentially incomplete _in-memory_ snapshots, never on the target.
- Full row/count snapshot guards precede all business and provenance writes in one
  local D1 batch or remote file import. No split commits or automatic write retries.
- After dispatch, verification checks expected rows/relationships, receipts,
  unplanned snapshot drift and a fresh reconciliation with no remaining eligible
  writes. Existing blocked records/audits must remain unchanged. Only then can
  eligible changes be reported as verified. Partial reconciliation is not reported
  as full success.
- Subprocess diagnostics retain stage, Node/Wrangler versions, exit/signal,
  allowlisted categories/codes/fields, stream byte counts and digests. Raw streams,
  SQL, paths, record values and credentials are never echoed. Node is launched
  directly with argument arrays, a 180-second timeout and 32-MB output limit.

### Reconciliation states and exit codes

| State                | Meaning                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `up_to_date`         | No unresolved conflicts and no business/provenance writes needed.                                                   |
| `changes_available`  | Safe changes exist and no conflicts were found.                                                                     |
| `partially_blocked`  | Safe writes exist, but other records are blocked.                                                                   |
| `completely_blocked` | Conflicts remain and no safe writes remain; eligible records may already be unchanged. **Zero SQL is not success.** |

`--verify-only` also distinguishes currently verified expected state from a
**previous write outcome not established by current state**. A date rollover or
intentional conflict cannot by itself prove whether an older transaction committed.
It does not fabricate historical certainty from counts.

CLI exit codes: **0** clean preview/verified reconciliation; **1** validation,
execution or verification error; **2** unresolved reconciliation conflicts, or an
incomplete `--verify-only` check. A partial approved apply can return 2 even though
its eligible writes were verified. Inspect the summary; do not repeat the write
merely to obtain exit zero.

Failure stages include `identity.account`, `identity.database`, `migrations.read`,
`snapshot.before`, `reconciliation.plan`, `sql.preflight`, `write.prepare`,
`write.execute`, `write.response`, `snapshot.after` and `verification.compare`.

| Write outcome        | Meaning/action                                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `not_started`        | Validation, read, preparation or process-launch failure before a write. Fix and preview.                                                      |
| `failed`             | Recognized atomic SQL/import rejection. Resolve the cause, then review a fresh preview.                                                       |
| `uncertain`          | Process/response did not establish a commit. If read-only verification cannot establish the expected state, stop; do not blindly apply again. |
| `applied_unverified` | A success receipt was received, but subsequent state verification failed. Inspect read-only; do not repeat apply.                             |

A corrupt/missing response that is followed by successful full verification resolves
the original plan without another dispatch. If verification fails, uncertainty is
preserved rather than relabeled as rollback. Authorization during polling does not
prove ingestion never ran. For a real authorization diagnostic, verify scoped
Account / D1 / Edit permission privately; successful SELECT only proves read access.
For TLS failures, fix CA/proxy/DNS configuration rather than disabling verification.

## Exact read-only inspection commands

From the repository root, Node 24.x/pnpm 10.x, with approved
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` configured **privately in the same
shell**. Do not put credentials in arguments or share raw Wrangler logs. The runner
checks the fixed Development UUID/name before snapshot reads.

```sh
pnpm db:refresh:demo:dev --verify-only
pnpm db:refresh:demo:dev --dry-run
```

Both commands are read-only, even when they exit 2. Additional operator SELECTs:

```sh
pnpm --filter @sales-visit/api exec wrangler d1 execute DB --remote --config wrangler.dev.jsonc --command "SELECT table_name, count(*) AS receipts FROM demo_fixture_state GROUP BY table_name ORDER BY table_name;" --json
pnpm --filter @sales-visit/api exec wrangler d1 execute DB --remote --config wrangler.dev.jsonc --command "SELECT a.sales_force_id,a.action,a.previous_supervisor_user_id='demo-supervisor-01' AS previous_matches_seed,a.new_supervisor_user_id=s.supervisor_user_id AS new_matches_assignment,a.created_at=s.updated_at AS time_matches_assignment FROM supervisor_assignment_audit a JOIN sales_force_supervisors s ON s.sales_force_id=a.sales_force_id WHERE a.sales_force_id='demo-sf-01' ORDER BY a.created_at;" --json
```

Receipt counts alone are not verification. Use `--verify-only`/the full preview for
typed receipt comparisons, dependency inspection and mismatch counts. The incident
inspection found two matching receipts, 729 missing receipts and **zero mismatched
receipts** among existing canonical records. Missing receipts on exact initial seed
rows are normal before their first refresh.

## Recovery: inspect first, never force ownership

**No provenance repair is needed for this incident.** Preserve the audited
reassignment. The corrected planner can refresh independently verified records;
it will intentionally keep the assignment and seven unavailable new schedules
blocked. A clean, conflict-free result requires a separate human business decision
through the authorized assignment workflow, not a fingerprint bypass.

If a _different_ inspection finds inconsistent/missing receipts for older generated
fixtures, begin with a provenance-only dry-run. This never inserts or updates
business rows and never deletes anything. With an explicitly reviewed prior business
date, the planner regenerates that version from the checked-in fixture generator
and requires **full-row exact equality** (or another independently recognized
seed/current version). It does not infer ownership from a date alone, from a bad
receipt, or from a prefix. A valid existing receipt needs no repair. Unknown/edited
records stay blocked. Frozen parents' receipts stay untouched.

Example only if the reviewed prior fixture business date really was 2026-11-27:

```sh
pnpm db:refresh:demo:dev --repair-provenance --fixture-date=2026-11-27 --dry-run
```

Review every root conflict and the proposed receipt-only count. Only after explicit
operator approval, use **both** database and provenance-repair confirmations:

```sh
pnpm db:refresh:demo:dev --repair-provenance --fixture-date=2026-11-27 --apply --confirm=sales-visit-dev --confirm-provenance-repair
```

There is no unrestricted force/adopt option. Missing fixtures are not created in
recovery mode. The evidence date must be real, non-future `YYYY-MM-DD`; it is only
accepted in provenance-recovery mode. Repair cannot legitimize the audited manual
assignment. If independent full-row evidence is insufficient, stop for review;
do not recreate receipts or reset/reseed/delete operational data.

## Safely complete the Development refresh

After reviewing the read-only commands and explicitly approving the safe portion:

```sh
pnpm db:refresh:demo:dev --apply --confirm=sales-visit-dev
pnpm db:refresh:demo:dev --verify-only
pnpm db:refresh:demo:dev --dry-run
```

With the reassignment retained, expect unresolved conflicts/exit 2, **not** global
success. Already verified eligible records/receipts generate no further same-date
writes. Do not blindly rerun apply on uncertain or applied-unverified outcomes.
No migration/deployment is required for this script-only fix; missing required
migrations still stop the runner instead of applying them automatically.

Local equivalents use existing API-local D1, never remote Production:

```sh
pnpm db:refresh:demo:local --verify-only
pnpm db:refresh:demo:local --dry-run
pnpm db:refresh:demo:local --apply
```

Native Windows and WSL must use separate dependency trees. The runner uses Node
path/process APIs, not POSIX shell quoting; do not share Linux node_modules symlinks
with native Windows Wrangler.

## Regression coverage and verification

Tests cover initial seeding, repeat and subsequent dates, typed receipts/defaults/
nulls/booleans/timestamps, alternate JSON serialization, audited supervisor edits,
manual report edits, direct/propagated conflicts, shared anchors, independent
branches, operational dependencies, zero-SQL blocked states, guarded rollback,
uncertain-response recovery, failed reads/comparisons, no duplicate dispatch,
explicit dated receipt-only recovery, Production/redirect/confirmation protection,
and FK integrity.

Real Wrangler/local-D1 tests use temporary persistence, not normal local state.
They verify atomic business/receipt rollback, successful refresh, subsequent-date
refresh with an audited conflict and read-only repetition. A separate installed-CLI
format regression uses **only a loopback fake API**, synthetic credentials and a
synthetic DB ID to reproduce remote-file stdout; refresh API overrides stay refused.
No test contacts Cloudflare or performs a remote write.

Verification commands:

```sh
pnpm test:deployment
pnpm typecheck
pnpm lint
pnpm format:check
node --test scripts/demo-fixtures.test.mjs
```

Executed results:

- `pnpm test:deployment`: **206 passed**, zero failures/skips (including real local
  D1 atomic rollback/repeat/date-change tests and installed-CLI loopback format test).
- `pnpm typecheck`, `pnpm lint` (zero warnings), `pnpm format:check`: passed under
  WSL Node 24.22.3 / Wrangler 4.156.2.
- Native PowerShell Node 24.16.0: `node --test scripts/demo-fixtures.test.mjs` passed,
  including the isolated SQL/constraint preflight.
- The new runner's Development `verifyOnly` path was exercised with approved stored
  authentication: four read-only API calls, zero write dispatches; 821 eligible,
  one direct/seven propagated conflicts and two matching/zero mismatched receipts.
- The captured Development snapshot was replayed **only in isolated SQLite**,
  confirming safe convergence, preservation of the actual assignment/audit, and
  zero FK violations.
- `git diff --check`: passed. Native Windows Wrangler is not claimed with this
  checkout's WSL dependency tree. No remote write/deployment/migration was run.

### Modified paths for this fix and retained diagnostic work

- `scripts/demo-fixtures.mjs`, `scripts/demo-fixtures.test.mjs`
- `scripts/demo-refresh.mjs`, `scripts/demo-refresh.test.mjs`
- `scripts/demo-refresh-execution.mjs`, `scripts/demo-refresh-execution.test.mjs`
- `scripts/demo-refresh-preflight.mjs`
- `scripts/demo-refresh-reconciliation.test.mjs`
- `scripts/demo-refresh-wrangler.test.mjs`
- `scripts/demo-refresh-wrangler-format.test.mjs`
- `docs/demo-refresh-diagnostics.md`, `docs/sales-workspace.md`

Seeds, provenance migration 0016, Development Wrangler configuration and installed
Wrangler were inspected, not modified. No new migration or dependency is needed.

References: [D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
[D1 file imports](https://developers.cloudflare.com/d1/best-practices/import-export-data/),
[Sales workspace](sales-workspace.md).
