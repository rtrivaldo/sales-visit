# Sales workspace, shared summary and safe demo refresh

This handoff supersedes the earlier minimal workspace and two-stage Web Visit form.
The Telegram Visit wizard, append-only reports, audit rules and idempotency keys
remain. No remote migration, refresh, deployment, commit or push is automatic.

## Sales pages

| Route                           | Function                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `/workspace`                    | Own operational summary, recent Web/Telegram Visits and Stock Reports                                   |
| `/schedules`                    | Today by default, weekday/all-week selection, grouped results, completion and bounded continuation      |
| `/visits/new`                   | Dedicated single-submit Visit form; no dashboard/history or separate Web wizard                         |
| `/visits`                       | Scoped, searchable, server-filtered/paginated history, financial values and period                      |
| `/visits/:id`                   | All current reporting fields and authorized linked Stock Reports; old missing values remain unavailable |
| `/stock-reports/new`            | Independent product-level Stock Report, optional own Visit link, zero quantities and safe retries       |
| `/directory?kind=stock-reports` | Own stock history, bounded pagination and detail links                                                  |
| `/stock-reports/:id`            | Own authorized report/items and Visit navigation                                                        |
| `/outlets`, `/outlets/:id`      | Existing authorized catalog, public business identifiers, No. RS, own schedules/history/latest activity |
| `/directory?kind=products`      | Product reference catalog                                                                               |

Sales navigation includes only these functional destinations. Administrative users,
SF management and Supervisor-assignment pages remain unavailable to Sales. Page
loaders use pending/error states; lists include meaningful empty states and
pagination. New pages use responsive layouts and existing design-system controls.

Outlet catalog authorization is intentionally unchanged: active uniquely associated
SF accounts have catalog access; a recurring schedule is not a prerequisite for an
unscheduled Visit. The Sales Outlet directory opts into `assigned=own` relevance
filtering and displays only scheduled or previously reported Outlets, without
inventing a new assignment-only reporting restriction. Schedules, completion,
Visit/Stock Report history, latest outlet
activity and dashboard data are scoped to the current SF. No new assignment-only
Outlet authorization policy is inferred. Demo catalog reads remain marked-data-only.

## Dedicated Visit form

Seven sections: Informasi Outlet (searchable ID/name selection and four business
periods), Saldo Digipos, Perdana SA, VF Data, VF Voice, Outlet Aktif and Total Belanja.
The selection label combines the public business ID and name without duplicate
identity cards. Opening from a schedule resolves/preselects the existing Outlet FK.

All quantities accept explicit zero; booleans start unanswered; shared validation
produces field errors. Rupiah input/parser behavior is unchanged. One primary
submission button sends the normalized report; Telegram keeps its existing
confirmation wizard. Optional product-level Stock Reports remain a distinct,
clearly labelled section and commit atomically with the Visit.

A duplicate-click lock and UUID/payload snapshot survive request retries while the
page stays open. After an ambiguous network result, the payload is frozen and the
same button retries the same logical report. Confirmed validation/reference errors
allow correction without clearing values. Success links directly to the saved
record. Newly submitted Web or Telegram data appears through the same D1-backed
history loaders, not localStorage or mock datasets.

Standalone Stock Report POST now authenticates real SF Bearer sessions, rechecks
session/status/association atomically during insertion, and prevents linking an
other-SF Visit. Existing injected/internal operation boundaries and stock fields
remain. Neither standalone nor linked reports can be saved by demo accounts.

Demo Sales users can explore and validate both entry forms. Preview validation
never calls a report POST. The API independently refuses direct manipulated demo
POSTs. No read-only restriction was relaxed.

## Summary API and aggregation assumptions

`GET /dashboard/summary` returns shared `OperationalSummary`. The Web Sales
workspace and Telegram `/summary` consume this same API. Existing Admin/Supervisor
14-day overview remains available separately; its business-day boundary now reuses
the same helper. Attribution comes from live accounts, never request claims.

- Business date: current Asia/Jakarta day (WIB); zero-to-zero next-day boundaries.
- Monthly reports: stored reporting month/year for new Visits. Only legacy Visits
  lacking both fields fall back to their actual WIB visit month. All four selected
  business periods are included; no calculated ISO week or fifth period is added.
- Assigned outlets: distinct outlets appearing in the scoped recurring schedules.
  This is a schedule-derived assignment count, not a new ownership relationship.
- Today's targets: distinct `(SF, Outlet)` pairs scheduled on today's weekday.
  Completion requires at least one scoped Visit by that SF at that Outlet today.
  Repeated Visits do not increase completion. Team totals retain each SF's target;
  two SF assigned the same Outlet are two independent responsibilities.
- Remaining is never negative; percentage is bounded 0–100 and is 0 when there are
  no scheduled targets. All actual monthly Visits still count in monthly volume.
- Total Belanja sums supplied values, without inventing financial formulas. A
  partial known sum includes an explicit missing-report count. All-missing finance
  is `null`/`—`; an empty month is actual zero. Unsafe aggregate integer totals are
  unavailable rather than rounded or overflowed.
- Outlet activity uses the latest scoped report **within the reporting month** for
  each distinct Outlet, ordered by visit time then ID. Each explicit flag is counted
  independently. Missing flags are reported as unavailable, not N/zero assumptions.
- Stock counts use the independent report's own timestamp/reporter, not the Visit
  owner or an assumption that every Visit contains stock.
- SF scope is own; Supervisor scope is the current assigned team; Admin scope is
  system-wide within the authorized dataset. Scope predicates resolve live D1
  roles/links. Real summaries exclude marked synthetic SF, Outlet and Schedule data;
  demo summaries require marked synthetic data. User counts are live Admin-only.
- Recent lists are bounded to five. SQL aggregates/window functions avoid browser
  dataset loading and N+1 record requests. No financial KPI is inferred from stock.

`summaryText` and the number/currency/percentage helpers live in contracts. Output
is plain text (no HTML/Markdown escaping issue), bounded names/IDs, concise sections
and one message below Telegram's limit. Zero and unavailable states are explicit.
Demo summaries never advertise a forbidden submission command.

## Telegram command changes

The old dashboard command is replaced by `/summary` with no alias. Outlet search
and internal-ID Outlet mutation commands have no remaining handlers or help entries.
Public `/outlet ID_OUTLET`, `/editoutlet ID_OUTLET ...` and
`/hapusoutlet ID_OUTLET KONFIRMASI` remain. Public lookup is case-insensitive,
preserves leading zeros, and refuses ambiguity; mutations resolve the public
identifier to its stored spelling before using the existing guarded operation.
Internal database IDs/FKs and Web administration operations are not removed.

`/help` includes `/summary` for every active role, including read-only demo roles.
The current [command reference](telegram-bot-reference.md) contains registered names
only. There is no setMyCommands registration mechanism in this repository.

Illustrative output (fixture examples, never production defaults):

```text
📊 RINGKASAN SALES
━━━━━━━━━━━━━━━━━━━━
Nama: Akun sintetis
Kode SF: SF001
Periode: Maret 2027

👥 CAKUPAN
Sales Force: 1
Outlet terjadwal: 4

📅 KUNJUNGAN HARI INI
Jadwal: 8 outlet
Selesai: 5 outlet
Belum Visit: 3 outlet
Progress: 62,5%
██████░░░░

📋 KUNJUNGAN BULAN INI
Total Visit: 24
Outlet Visit: 18
Total Belanja: Rp 24.850.000

🏪 OUTLET AKTIF
CVM: 15 outlet
Voice: 12 outlet
Digital: 17 outlet
Status belum tersedia: 0 outlet

📦 LAPORAN STOK
Hari Ini: 5 laporan
Bulan Ini: 24 laporan

/jadwal — Jadwal kunjungan
/salesvisit — Input kunjungan
```

Supervisor example (current assigned team only):

```text
📊 RINGKASAN SUPERVISOR
━━━━━━━━━━━━━━━━━━━━
Nama: Supervisor sintetis
Periode: Maret 2027

👥 CAKUPAN
Sales Force: 5
Outlet terjadwal: 120

📅 KUNJUNGAN HARI INI
Jadwal: 40 outlet
Selesai: 28 outlet
Belum Visit: 12 outlet
Progress: 70%
███████░░░

📋 KUNJUNGAN BULAN INI
Total Visit: 185
Outlet Visit: 100
Total Belanja: Rp 185.450.000

🏪 OUTLET AKTIF
CVM: 85 outlet
Voice: 72 outlet
Digital: 96 outlet
Status belum tersedia: 0 outlet

📦 LAPORAN STOK
Hari Ini: 28 laporan
Bulan Ini: 180 laporan
```

Administrator example (authorized system dataset, not demo plus real combined):

```text
📊 RINGKASAN SISTEM
━━━━━━━━━━━━━━━━━━━━
Nama: Admin sintetis
Periode: Maret 2027

👥 PENGGUNA
Admin: 2
Supervisor: 4
Sales: 14
Pending: 3

Outlet terjadwal: 350

📅 KUNJUNGAN HARI INI
Jadwal: 120 outlet
Selesai: 90 outlet
Belum Visit: 30 outlet
Progress: 75%
████████░░

📋 KUNJUNGAN BULAN INI
Total Visit: 1.250
Outlet Visit: 300
Total Belanja: Rp 1.250.450.000

🏪 OUTLET AKTIF
CVM: 250 outlet
Voice: 215 outlet
Digital: 280 outlet
Status belum tersedia: 0 outlet

📦 LAPORAN STOK
Hari Ini: 90 laporan
Bulan Ini: 1.180 laporan
```

These examples demonstrate formatting only; actual values always come from D1.

## Demo fixture source and refresh

Initial seeding is still available:

```sh
pnpm db:seed:demo:local
pnpm db:seed:demo:dev
```

Seeding is for initial setup and deliberately preserves conflicts/edits. It does
not refresh old dates or backfill existing report fields. Do not treat a reseed as
a reset or a reconciliation command.

`scripts/demo-fixtures.mjs` builds its canonical baseline by applying the real
migrations and **existing `apps/api/seeds/demo.sql`** in an isolated in-memory
SQLite database. There is no second independent persona/outlet/product dataset.
Refresh derives current-month dates, reporting fields, both submission channels,
primary completed schedule targets and additional pending targets from that
baseline. Stable user/SF/Outlet/Visit/Stock IDs and product quantities are retained.
The first Sales persona has both today's completed/pending targets, monthly
financial data, Visit history and Stock Reports. Empty-activity personas remain
useful zero-data cases. No dashboard values are hardcoded.

The verified fixture row is recognized by an exact canonical seed fingerprint,
a recognized pre-0015 Visit fingerprint with unavailable new fields, or an exact
previous refresh receipt. Markers and all stored metadata/business fields are
checked; a broad ID prefix alone is never sufficient. Case-insensitive business-code
collisions and any Telegram-linked fixture user are rejected.

New migration **0016_demo_fixture_state.sql** adds only an operator provenance
receipt table (table name, composite record key, canonical JSON). No business rows
are changed by migration. Receipts permit later date/feature reconciliation while
rejecting user edits since the prior refresh. There is no application mutation API
for these receipts.

Safety controls:

1. Only `local` and `dev` are accepted. Local explicitly uses `--local`; Development
   uses `apps/api/wrangler.dev.jsonc`, DB binding `DB`, database `sales-visit-dev`,
   UUID `66aadb98-21f9-413e-8646-7347555b2268`, and enabled staging demo configuration.
   Production DB identity/configuration and environment/config overrides are refused.
2. Remote preview/apply inspect the Cloudflare account and actual remote D1 UUID/name.
   Required migration names, including 0016, must already be present before planning.
3. Default behavior is dry-run. Remote writes additionally require explicit apply
   and exact Development confirmation. Secrets are never command arguments/output.
4. Candidate keys, alternate business-code collisions and touching relationships are
   inspected, including users, reports/items, schedules, audit references and drafts.
   Ambiguous or mixed real/demo dependency components are skipped conservatively;
   the command reports counts and bounded conflict explanations, never silently
   adopts them. Shared products require exact synthetic proof.
5. Snapshot count/full-row assertions precede all mutations in the same atomic
   Wrangler local D1 batch / remote D1 file import. Concurrent inserts, identity
   changes, edited fingerprints or new dependencies abort the batch rather than
   overwrite them. Remote reads use the read-only D1 query API, not file-import
   metadata pretending to be query results.
6. Reconciliation inserts missing eligible rows, updates changed verified rows,
   writes provenance receipts and verifies actual persisted results. Unchanged
   fixtures generate no writes on repeated same-day execution. No records are
   deleted, no tables are dropped/recreated and no whole database is reset.
7. Output uses actual plan/persisted counts per entity, legacy Visit refresh counts,
   skips, zero removed records and zero real records modified. A failure never
   prints a completion success message. Ephemeral SQL files contain fixtures, not
   credentials, and are removed after execution.

A conflict can block multiple connected fixture records; this is deliberate safety,
not permission to delete those records. Review provenance/dependencies manually.
No arbitrary `demo-*` record, custom demo persona or edited report is overwritten.

## Exact local commands

From the repository root, Node 24.x and pnpm 10.30.1:

```sh
pnpm install --frozen-lockfile
pnpm db:migrate:local
pnpm db:refresh:demo:local            # preview, no business writes
pnpm db:refresh:demo:local --dry-run  # explicit equivalent
pnpm db:refresh:demo:local --apply    # reconcile eligible local fixtures
```

The local target uses API-local D1 and its existing production-named local binding,
**never** the remote Production database. Existing local migrations/seed commands
use the same local binding/state. Configure demo auth in ignored local variables as
in the app READMEs. Real SF submission requires an approved, uniquely associated
Telegram account; demo sessions stay read-only.

## Development migration, refresh and deployment (operator only)

Do not execute these automatically. Verify the intended Cloudflare account and
back up Development D1 first. Provide the approved account/API token privately in
the environment for remote identity verification; do not paste secrets into commands.

```sh
pnpm --filter @sales-visit/api exec wrangler whoami
pnpm --filter @sales-visit/api exec wrangler d1 migrations list DB --remote --config wrangler.dev.jsonc
pnpm db:migrate:dev
pnpm db:refresh:demo:dev
pnpm db:refresh:demo:dev --apply --confirm=sales-visit-dev
pnpm deploy:api:dev
pnpm deploy:bot:dev
pnpm deploy:web:dev
```

Review the preview before apply. Never substitute Production configs or IDs. The
refresh does not migrate or deploy anything itself. The Bot's Development IDENTITY
binding remains `sales-visit-api-dev` / `BotIdentity`; existing webhook/secrets do not
need rotation. Web uses the existing cross-platform Development build wrapper.

Both refresh scripts use Node filesystem/path/process APIs, not POSIX shell env
assignments, `/dev/null`, or platform-specific dependency binaries. Native Windows
and WSL must use separate node_modules trees; sharing Linux symlinks with Windows
Node is unsupported by the existing dependency installation.

## Verification and limitations

Executed successfully under WSL/Linux (Node 24.22.3, pnpm 10.30.1):

| Check                                                          | Result                                                |
| -------------------------------------------------------------- | ----------------------------------------------------- |
| `pnpm typecheck`                                               | Passed                                                |
| `pnpm lint`                                                    | Passed, no warnings                                   |
| `pnpm format:check`                                            | Passed                                                |
| `pnpm build:web`                                               | Passed; existing large-chunk warning remains          |
| Contracts suite                                                | 23 passed                                             |
| Database suite                                                 | 19 passed                                             |
| Existing Web suite                                             | 3 passed                                              |
| Complete API/Bot suite                                         | 217 passed                                            |
| `pnpm test:deployment`                                         | 179 passed, including refresh safety tests            |
| Hono CLI                                                       | Routes inspected; unauthenticated summary returns 401 |
| Native PowerShell `node --test scripts/demo-fixtures.test.mjs` | Passed                                                |

There were no test skips or failures in the completed suites. A concurrent recursive
workspace-test/build invocation timed out in this environment; core/Web suites had
completed, and the full API suite and Web build were then rerun successfully on
their own. Full native-Windows typecheck/build/deployment verification is not claimed
with the existing WSL dependency tree; use a separate native install. The new core
fixture generator/reconciler was actually tested on both platforms.

Tests cover role-scoped shared summaries, distinct completion, missing
finance, real/demo isolation, stock authorization, schedule status, strict refresh
fingerprints, missing/legacy/current records, repeatability, dependencies/collisions,
dry-run, transaction rollback and Development target/migration refusal. An isolated
real D1 refresh verifies FK integrity and a nonempty Sales demo dashboard.

Frontend project instructions prohibit introducing a new browser/unit-test framework.
Existing Web suites, typecheck and production build are retained. Actual browser,
mobile keyboard/currency caret and live Development Telegram/OIDC acceptance require
operator smoke testing; static checks do not claim those manual checks occurred.

## Modified files

```text
README.md
apps/api/README.md
apps/api/src/bot-business.ts
apps/api/src/catalog-reads.ts
apps/api/src/dashboard.ts
apps/api/src/index.ts
apps/api/src/operations.ts
apps/api/src/summary.ts
apps/api/src/visit-reads.ts
apps/api/src/web-schedules.ts
apps/api/tests/api.test.mjs
apps/api/tests/bot-business.test.mjs
apps/api/tests/bot-help.test.mjs
apps/api/tests/bot-planning.test.mjs
apps/api/tests/bot-visits.test.mjs
apps/api/tests/demo-data-sync.test.mjs
apps/api/tests/identity.test.mjs
apps/api/tests/sales-summary.test.mjs
apps/api/tests/web-auth.test.mjs
apps/bot/src/business/commands.ts
apps/bot/src/outlets/commands.ts
apps/bot/src/registration/help.ts
apps/web/README.md
apps/web/src/app/components/app-sidebar.tsx
apps/web/src/app/components/dashboard-breadcrumbs.tsx
apps/web/src/features/auth/pages/workspace-page.tsx
apps/web/src/features/directory/pages/directory-page.tsx
apps/web/src/features/outlets/lib/outlet-data.ts
apps/web/src/features/outlets/pages/outlet-detail-page.tsx
apps/web/src/features/outlets/pages/outlets-page.tsx
apps/web/src/features/stock-reports/components/stock-report-card.tsx
apps/web/src/features/stock-reports/components/stock-report-fields.tsx
apps/web/src/features/stock-reports/pages/stock-detail-page.tsx
apps/web/src/features/stock-reports/pages/stock-entry-page.tsx
apps/web/src/features/visits/pages/new-visit-page.tsx
apps/web/src/features/visits/pages/schedules-page.tsx
apps/web/src/features/visits/pages/visits-page.tsx
apps/web/src/router.tsx
docs/api-reference.md
docs/design/telegram-bot-parity.md
docs/feature-updates-delivery.md
docs/sales-visit-update.md
docs/sales-workspace.md
docs/telegram-bot-reference.md
docs/telegram-demo-mode.md
package.json
packages/contracts/src/dashboard.ts
packages/contracts/src/index.ts
packages/contracts/src/summary.ts
packages/contracts/tests/summary-fixture.mjs
packages/contracts/tests/summary.test.mjs
packages/db/migrations/0016_demo_fixture_state.sql
packages/db/src/schema.ts
scripts/demo-fixtures.mjs
scripts/demo-fixtures.test.mjs
scripts/demo-refresh.mjs
scripts/demo-refresh.test.mjs
```
