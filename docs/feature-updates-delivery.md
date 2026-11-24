# Feature updates delivery

## Baseline and changes

Implementation baseline: clean `main`, `f05410e`, fetched and verified equal to
`origin/main`. No commit, push, deployment, remote migration or Production changes.
Relevant domain ADRs retain their shared API/D1, dual-channel and static Web decisions.

- Extended Telegram business coverage using allowlisted private RPC and existing
  Web handlers, preserving their authorization, validation, concurrency and audits.
- Required SF business code in schedule monitoring; case-insensitive unambiguous
  SF/outlet lookup; removed internal outlet detail without removing internal APIs.
- Added all-or-nothing Excel active-account pre-registration in Web and Telegram.
- Added Supervisor-ID groups and whole-dataset server-side search with bounded paging.
- Preserved compact effective-role help, Demo read-only mode and synthetic provenance.
- Catalog reads now match Web's active SF permissions; mutations remain Admin-only.
- Imported display names render immediately, and verified Telegram interactions fill
  only missing profile metadata without changing account authority.

## Web-to-Telegram parity

See the complete [matrix](design/telegram-bot-parity.md) and original
[pre-implementation audit](feature-parity-checklist.md). Every requested Web module
has a Telegram business workflow; visual charts/navigation are intentionally omitted.
No schedule edit/delete operations are invented where Web does not provide them.

### Commands

New:
`dashboard`, `salesforce`, `detailsalesforce`, `tambahsalesforce`, `editsalesforce`,
`hapussalesforce`, `supervisors`, `penugasan`, `assignsupervisor`,
`unassignsupervisor`, `riwayatvisit`, `detailvisit`, `stockreport`, `carioutlet`,
`produk`, `templatepengguna`, `importpengguna`, `tambahakundemo`.

Modified: `start`, `me`, `help`, `users` (status filter and unlinked demo accounts),
`outlets`/`outlet` (Web-equivalent catalog access), `jadwalsales`.
Removed: internal outlet detail command only. Internal outlet edit/delete remain.

`/jadwalsales kode_sf [hari]` requires the existing `sales_force.id` business code.
No day means all recurring weekdays. Both code/day matching are case-insensitive;
ambiguous/unknown codes fail. Pagination retains the original code/day, and
Supervisor assignment scope is checked in D1. Telegram-ID and named-filter Bot
syntaxes are removed. `/outlet outlet_id` uses only the outlet business ID.

[Excel workflow](user-import.md): blank template, upload, authoritative row-level
preview, explicit Admin confirmation, atomic active-user/identity/audit creation,
receipt reconciliation and immediate Telegram/Web eligibility. No overwrite or
reactivation. [Supervisor workflow](supervisor-grouping.md): Supervisor-name matches
show full teams; SF-name matches show only matching members under their Supervisor;
combined matches do not duplicate rows. Search is performed before pagination.

## Dependencies

- API runtime: `@e965/xlsx@0.20.3`, SheetJS-compatible pure JavaScript XLSX reader/writer,
  bundled successfully for Cloudflare Workers. No browser Excel dependency is needed.
- Web development only: `esbuild` (already used in API tests; bundles TSX for tests)
  and `happy-dom` (DOM-based React interaction tests without a new test runner).
- No Production configuration changes. Frozen-lockfile installation verified.
  This Windows environment required `--ignore-scripts` for installation because
  the existing Lefthook prepare hook failed to spawn; no application build uses it.

## Database

Additive `0014_business_code_lookup.sql`: **two non-unique NOCASE indexes only**.
Drizzle schema, journal and snapshot are updated. No table rebuild, data rewrite,
backfill, identity normalization or destructive uniqueness enforcement.

Read-only inspection of both existing local D1 SQLite files found **zero**
case-insensitive collision groups in outlet business IDs and SF IDs. No remote or
Production data was accessed. Tests deliberately create collisions and assert clear
errors. Operators should inspect their target dataset before rollout; legacy
collisions are preserved for manual resolution, never silently selected.

## Verification

- `pnpm typecheck`: pass (API, Bot, Web, contracts, database).
- `pnpm lint`: pass, no warnings after cleanup.
- `pnpm format:check`: pass.
- `pnpm build:web`: pass; existing-style >500 KiB chunk-size warning remains.
- API/Bot automated suites: 219 tests pass, including import transactions, concurrency,
  identity recognition, manual registration, role scope, demo isolation, command
  syntax/pagination, collisions, grouped search and existing lifecycle regressions.
- Contracts: 19 tests pass. Database: 18 tests pass, including populated collision
  migration/index use and preserved references. Web: DOM interaction tests cover
  grouped loading/search/empty/error/clearing and the import dialog/display names.
- `pnpm --filter @sales-visit/db db:check`: pass.
- Hono CLI route inspection: pass.
- API and Bot Development `wrangler deploy --dry-run`: pass; **not deployed**.
- `pnpm test:deployment`: **158 pass / 12 fail** on Windows. An untouched `main`
  snapshot reproduced exactly the same 12 failures: POSIX path/mode assumptions,
  Git source-snapshot subprocess behavior, Unix signal semantics and restricted
  symlink creation. These failures are baseline/environment issues, not hidden or
  skipped. No deployment scripts/security checks were weakened to make them pass.

Existing API tests used URL `.pathname` as filesystem paths, breaking on Windows
and spaces; affected tests now use `fileURLToPath`. Production code is unaffected.

## Limits / operator verification

- Import max 50 users / 256 KiB compressed / 2 MiB declared ZIP expansion per file.
  Numeric identifiers must be corrected at their source if Excel already lost precision.
- Role dropdowns are not emitted by the XLSX writer; role instructions and authoritative
  server validation are provided. Examples are isolated on a non-imported sheet.
- SQLite NOCASE/lower matching follows SQLite's built-in ASCII case folding; no
  Unicode collation extension is installed in D1.
- Ten groups per page; large teams progressively load 100 members at a time, preserving
  full-team semantics without unbounded SQL reads. Lists are live, not frozen exports.
- No real Telegram client, Microsoft Excel application, mobile browser or remote
  Development smoke test was run. Automated Workers/DOM tests and local bundle checks
  are not claimed as evidence of deployment or operational approval.
- Re-run deployment-helper tests on the supported Linux CI environment before release.

## Exact Cloudflare Development commands (not executed)

From repository root, with authorized Development credentials and existing bindings:

```sh
pnpm install --frozen-lockfile
pnpm db:migrate:dev
pnpm deploy:api:dev
pnpm deploy:bot:dev
pnpm deploy:web:dev
```

These scripts explicitly use `wrangler.dev.jsonc`: D1 `sales-visit-dev`, Workers
`sales-visit-api-dev`, `sales-visit-bot-dev`, `sales-visit-dev` (Web). Migration must
precede API, then Bot and Web. Do not run demo seeds on operational data. No webhook
or secret changes are required for document messages (the existing allowed update
kind is `message`). Verify the API/Web URLs and the private `IDENTITY` binding
point to the same Development environment before a manual Telegram smoke test.

Local migration alternative (not remote):

```sh
pnpm --filter @sales-visit/api exec wrangler d1 migrations apply DB --local --config wrangler.dev.jsonc
```

## Changed/new files

### API

```text
apps/api/package.json
apps/api/src/bot-business.ts
apps/api/src/bot-service.ts
apps/api/src/catalog-reads.ts
apps/api/src/identity.ts
apps/api/src/index.ts
apps/api/src/outlets.ts
apps/api/src/planning-access.ts
apps/api/src/read-scope.ts
apps/api/src/sales-force-management.ts
apps/api/src/schedules.ts
apps/api/src/supervisor-assignments.ts
apps/api/src/user-import.ts
apps/api/src/web-auth.ts
apps/api/src/worker.ts
```

### Bot and Web

```text
apps/bot/src/business/commands.ts
apps/bot/src/commands.ts
apps/bot/src/outlets/commands.ts
apps/bot/src/planning/shared.ts
apps/bot/src/registration/commands.ts
apps/bot/src/registration/help.ts
apps/bot/src/schedules/commands.ts
apps/bot/src/webhook.ts
apps/web/package.json
apps/web/src/features/auth/session.ts
apps/web/src/features/supervisor-assignments/pages/assignments-page.tsx
apps/web/src/features/user-management/data.ts
apps/web/src/features/user-management/import-dialog.tsx
apps/web/src/features/user-management/page.tsx
```

### Shared schema / dependency lock

```text
packages/contracts/src/identity.ts
packages/contracts/src/planning.ts
packages/contracts/tests/planning.test.mjs
packages/db/src/schema.ts
packages/db/migrations/0014_business_code_lookup.sql
packages/db/migrations/meta/0014_snapshot.json
packages/db/migrations/meta/_journal.json
pnpm-lock.yaml
```

### Tests

```text
apps/api/tests/api.test.mjs
apps/api/tests/auth-abuse.test.mjs
apps/api/tests/bot-business.test.mjs
apps/api/tests/bot-callback-webhook.test.mjs
apps/api/tests/bot-group.test.mjs
apps/api/tests/bot-help.test.mjs
apps/api/tests/bot-planning.test.mjs
apps/api/tests/bot-transport.test.mjs
apps/api/tests/bot-visits.test.mjs
apps/api/tests/business-demo.test.mjs
apps/api/tests/feature-updates.test.mjs
apps/api/tests/identity.test.mjs
apps/api/tests/planning.test.mjs
apps/api/tests/supervisor-assignments.test.mjs
apps/api/tests/telegram-demo.test.mjs
apps/api/tests/web-auth.test.mjs
apps/web/tests/feature-updates.test.mjs
packages/db/tests/business-code-indexes.test.mjs
```

### Documentation

```text
docs/api-reference.md
docs/deployment.md
docs/design/telegram-bot-integration-alignment.md
docs/design/telegram-bot-parity.md
docs/feature-parity-checklist.md
docs/feature-updates-delivery.md
docs/supervisor-grouping.md
docs/telegram-bot-reference.md
docs/telegram-demo-mode.md
docs/user-import.md
```
