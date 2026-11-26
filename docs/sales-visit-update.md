# Sales Visit reporting update

> The single-submit Web form, completed Sales pages, standalone Stock Reports and
> refreshed demo workflow now supersede the earlier rollout descriptions below.
> See [current Sales workspace handoff](sales-workspace.md).

This is the current implementation handoff, superseding the original minimal
Telegram wizard and deferred Web-submission notes. No deployment, remote
migration, database reset, commit or push is part of this change.

## Form and shared contracts

Web and Telegram write the same `visits` table through `createVisit()` and
`createVisitSchema`. Required fields:

- Informasi Outlet: existing Outlet FK, reportingWeek (integer 1–4).
- Saldo Digipos: digiposBalance.
- Perdana SA: perdanaSaStock, perdanaSaSelling, perdanaSaSellout.
- VF Data: vfDataStock, vfDataSelling, vfDataSellout.
- VF Voice: vfVoiceStock, vfVoiceSelling, vfVoiceSellout.
- Outlet Aktif: isCvmActive, isVoiceActive, isDigitalActive.
- Total Belanja: totalPurchase.

Numbers are nonnegative safe integers, not formatted strings; zero and false are
explicit valid answers. All three booleans start unanswered. No new mandatory
notes, follow-up or product-level Stock Report. Existing optional notes/follow-up
and nested Stock Report contracts remain available to callers.

`reportingMonth` and `reportingYear` are derived server-side from `visitedAt` in
Asia/Jakarta. Clients cannot supply them. Four business periods are selected,
never calculated from calendar/ISO week numbers. The Telegram wizard captures
visit time once at Outlet selection; Web captures it when preparing the review.

`packages/contracts/src/visit-report.ts` owns numeric/boolean validation,
strict Rupiah parsing and IDR formatting (`id-ID`), report question metadata,
reporting-calendar derivation and shared detail/review summary formatting.
Pasted invalid currency is never repaired by stripping arbitrary characters.

## Database and historical compatibility

Forward-only `packages/db/migrations/0015_visit_report.sql` adds 17 nullable
columns, with week/month/year, boolean and safe-integer checks. No table is
removed/recreated, no old migration is edited, and no historical financial values
or reporting periods are backfilled. No additional indexes are introduced.

The read contract allows unavailable new fields on old rows. The serializer omits
NULL fields; summaries display `—`, not zero or N. New writes require every field.
Seeds preserve existing records; newly inserted synthetic demo Visits include
explicit report values. New local Outlet fixtures include synthetic business IDs;
rerunning the seed deliberately does not overwrite already-existing outlets.
An Admin must separately populate missing real business identifiers.

D1 draft schema/constraints remain intact. The existing durable `notes` answer
state now collects report questions; the next question is derived from missing
payload fields, not in-memory state. Old editable drafts can collect missing
answers, and incomplete old review drafts return to questions on confirmation.
Committed legacy receipts remain recoverable without fabricating report values.
A pre-upgrade submitting draft with no committed receipt should be cancelled and
restarted; its incomplete frozen payload cannot create a new-format report.

## API, authorization and idempotency

- `POST /visits`: active real SF Bearer session, UUID `Idempotency-Key`.
  Server derives SF/channel, resolves the exact existing FK and rejects unknown
  fields including outlet name/attribution. Session/role/SF ownership are rechecked
  in the guarded INSERT. Admin, Supervisor and unlinked demo accounts cannot submit.
- `GET /visits/entry-permission`: live SF submission capability for the Web form.
- `GET /outlets?view=page&q=...&limit=20`: bounded server search by ID/name/business
  ID; page references now include businessId. Array reads remain unchanged.
- Visit list/detail reads include new fields; optional `reportingWeek`,
  `reportingMonth`, `reportingYear` filters validate their ranges. Existing filters,
  current Supervisor-team scoping and independent reporter scoping remain intact.
- `GET /stock-reports/:id`: one report with products/reporter, under the same
  reporter authorization as stock history.
- Existing Admin list APIs accept exact `telegramId` filters for targeted user
  and Supervisor commands; Web list pages and shared listing RPCs remain.
- CORS explicitly permits Idempotency-Key; existing origin validation remains.

The existing scoped SHA-256/UUID submission identity, immutable payload comparison,
409 conflicts, atomic Visit/optional Stock Report batch and retry recovery remain.
Do not edit a frozen payload after an ambiguous save; retry with the same key.
There is no new Visit edit/delete API: reporting remains append-only, as before.

## Web

`/workspace` links to `/visits/new` and the SF's scoped history. The form has seven
clear sections, server-searched Outlet selection (20 results), four periods,
explicit Y/N controls, field errors, review before save and duplicate-click guards.
Rupiah inputs show the Rp prefix, format digit edits and strict pasted values,
and preserve the cursor by digit position. Failed writes keep form/review values.
Ambiguous outcomes freeze the reviewed payload for an idempotent retry.

The existing optional Stock Report controls are retained separately, now with
bounded API product search rather than a production dependency on mock products.
Visit stock/selling/sellout observations are NOT Stock Report Items. A selected
product-level report commits atomically alongside the Visit and keeps its normal
FK/relationship. Details and both desktop/mobile history show reporting values;
period filters are server-side. Demo submission controls are read-only.

## Telegram commands and wizard

Removed registrations: `/outlets`, `/users`, `/salesforce`, `/supervisors`.
Replacements (existing established names retained where possible):

```text
/outlet 4300014332
/user 123456789
/detailsalesforce SF001
/supervisor 123456789
/detailvisit VISIT_ID
/detailstok STOCK_REPORT_ID
/jadwalsales SF001 senin
```

Identifiers above are usage examples, not production defaults. Missing arguments
return usage, never a collection. Outlet lookup uses case-insensitive business IDs,
keeps leading zeros and rejects ambiguity. Existing `/detailsalesforce` is reused
rather than introducing an overlapping `/salesforce` detail alias.

Filtered collections `/produk`, `/riwayatvisit`, `/stockreport` require
a search/owner/date/reporting filter and return ten records per page. Stock history
and Visit-linked stock are concise references, not bulk product-item dumps; use
`/detailstok` for the requested report's items. `/penugasan`
requires q and returns five. `/pending` and daily/user-specific schedules remain
bounded operational workflows. Replies are packed below Telegram's message limit.
All management mutations, imports, assignments, demo commands and cancellations
remain. No command-menu registration mechanism exists in this repository;
role-aware `/help` and the [command reference](telegram-bot-reference.md) are updated.

The wizard asks Outlet ID, period, balance, the nine quantities, three booleans,
Total Belanja, then review. It resolves and displays the Outlet name itself.
Only Y at review (or `/konfirmasi`) saves; N or `/batal` cancels. Invalid answers
keep previous answers. D1 revisions/message watermarks, 24-hour TTL, persisted UUID,
transaction-time authorization and recoverable receipts work across webhooks and
Worker executions. Success includes the persisted Visit ID, never a speculative ID.

## Stock Report regression and baseline boundaries

Stock Report tables, items, relationships, existing input schemas, API operations,
read pages/components and history/detail commands are retained. Tests exercise
independent and linked reports, zero quantities, nested Web submission, rollback,
retry/conflict and reporter authorization. The new Visit fields do not replace them.

The repository originally had no standalone Telegram Stock Report submission
wizard, operational standalone Web stock-entry route, export system, or Visit
editing API. This change does not claim those absent workflows existed or add
unrelated features. Standalone `POST /stock-reports` retains its existing
trusted-identity authentication boundary; ordinary Web sessions submit optional
linked reports through the authorized Visit operation.

## Local setup (no remote operations)

Use Node 24.x and pnpm 10.30.1. Keep separate native-Windows and WSL checkouts or
node_modules trees; Linux symlinks/native binaries are not usable by Windows Node.
For WSL with nvm, load nvm or add its Node 24 bin directory to PATH first.

```sh
pnpm install --frozen-lockfile
pnpm db:migrate:local
pnpm db:seed:local
```

Copy `.dev.vars.example` / `.env.example` only when files are absent, and configure
private test credentials as in the app READMEs. Never print or commit those files.
In separate terminals, `pnpm dev:api`, `pnpm dev:bot`, `pnpm dev:web` use the existing
local configuration/bindings. Approve a real test SF with a unique existing SF link
for submission; demo login intentionally cannot save. Use the existing dedicated
Quick Tunnel/test-bot setup in `apps/bot/README.md` for local Telegram delivery.

Existing local legacy outlets with NULL business IDs are not automatically renamed
or backfilled. Create a synthetic Outlet through Admin management for wizard tests.

## Development deployment (operator only; do not use Production configs)

First verify the signed-in Cloudflare account and these reviewed configs:

- D1 `sales-visit-dev`, ID `66aadb98-21f9-413e-8646-7347555b2268`.
- API `apps/api/wrangler.dev.jsonc`, Worker `sales-visit-api-dev`.
- Bot `apps/bot/wrangler.dev.jsonc`, Worker `sales-visit-bot-dev`, IDENTITY bound
  to `sales-visit-api-dev` / `BotIdentity` (not Production).
- Web `apps/web/wrangler.dev.jsonc`, Worker `sales-visit-dev`.

Back up Development D1 and inspect pending migrations before applying them.
These commands are cross-shell (PowerShell or WSL/Linux), from the repository root:

```sh
pnpm --filter @sales-visit/api exec wrangler whoami
pnpm --filter @sales-visit/api exec wrangler d1 migrations list DB --remote --config wrangler.dev.jsonc
# Explicit operator approval required before the next command:
pnpm db:migrate:dev
pnpm deploy:api:dev
pnpm deploy:bot:dev
pnpm deploy:web:dev
```

`deploy:web:dev` uses the existing cross-platform build wrapper and defaults to
`https://sales-visit-api-dev.rtrivaldo05.workers.dev`; review VITE_API_URL overrides.
The API config already allows the Development Web origin. Keep the Development
OIDC Client ID/origins separate from Production. Do not seed/reset existing remote
business records to satisfy a smoke test.

If provisioning the Development Bot for the first time, supply its two secrets
**interactively**, never as command arguments or in logs:

```sh
pnpm --filter @sales-visit/bot exec wrangler secret put TELEGRAM_BOT_TOKEN --config wrangler.dev.jsonc
pnpm --filter @sales-visit/bot exec wrangler secret put TELEGRAM_WEBHOOK_SECRET --config wrangler.dev.jsonc
```

Existing Development webhook registrations are unchanged by Worker deployment.
Verify getMe/getWebhookInfo privately against the dedicated Development bot; its
webhook must be the reviewed Development Worker HTTPS root, use the same secret,
and allow message/callback_query updates as before. Do not reuse the local Quick
Tunnel helper for a workers.dev URL, take over another bot's webhook, or send a
secret in shell history. Initial webhook registration is a separate operator
credentialed action. For first-time setup only, save this snippet to a temporary
`.mjs` file outside Git, then run `node PATH_TO_FILE.mjs` from the repository root.
Place only the dedicated Development credentials and expected bot username in
ignored `apps/bot/.dev.vars` first; never use Production credentials here.
The script refuses to replace a webhook at any other URL and prints no secrets.

```js
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
const env = parseEnv(readFileSync("apps/bot/.dev.vars", "utf8"));
const url = "https://sales-visit-bot-dev.rtrivaldo05.workers.dev/";
async function telegram(method, body = {}) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error("Telegram refused operation");
  return data.result;
}
try {
  if (
    !env.TELEGRAM_BOT_TOKEN ||
    !env.TELEGRAM_WEBHOOK_SECRET ||
    !env.TELEGRAM_LOCAL_TEST_BOT_USERNAME
  )
    throw new Error("Missing credentials");
  const me = await telegram("getMe");
  if (!me.is_bot || me.username !== env.TELEGRAM_LOCAL_TEST_BOT_USERNAME)
    throw new Error("Wrong Development bot");
  const before = await telegram("getWebhookInfo");
  if (before.url && before.url !== url)
    throw new Error("Existing foreign webhook");
  await telegram("setWebhook", {
    url,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
  });
  if ((await telegram("getWebhookInfo")).url !== url)
    throw new Error("Not verified");
  console.log("Development webhook verified.");
} catch {
  console.error(
    "Development webhook not confirmed. Verify bot/config privately before retrying."
  );
  process.exitCode = 1;
}
```

Verify the Worker URL against actual deploy output **before** running this snippet.
If your account uses a different subdomain, review the URL change explicitly.

After release: `/health`, unauthenticated reads (401), demo read-only refusal,
real-SF Web and Telegram submissions, leading-zero Outlet lookup, Y/N review,
retry receipt, financial/period details, other-SF detail denial, stock history,
assignments and schedules. Browser/mobile caret and keyboard behavior still need
manual smoke verification; automated checks do not replace it.

## Verification results

Successfully executed under WSL/Linux with Node 24.22.3 and pnpm 10.30.1:

| Command / suite                                       | Result                                              |
| ----------------------------------------------------- | --------------------------------------------------- |
| `pnpm typecheck`                                      | Passed across all packages/apps                     |
| `pnpm lint`                                           | Passed, no warnings                                 |
| `pnpm format:check`                                   | Passed                                              |
| `pnpm build:web`                                      | Passed; existing large-chunk warning remains        |
| `pnpm test:deployment`                                | 170 passed                                          |
| `pnpm -r --if-present test`                           | 259 passed: contracts 22, DB 19, API/Bot 215, Web 3 |
| Hono CLI routes, `/health`, unauthenticated `/visits` | Routes inspected; 200 / 401 as expected             |

After the final stock-summary/sorting changes, the complete API/Bot suite (215),
typecheck, lint, format check and Web build were rerun successfully. One concurrent
static/build invocation timed out; a separate Web build then completed successfully.
Tests use disposable local D1, real migrations and real Bot/API Service Binding
calls. No remote database or live Telegram webhook was touched.

Native Windows is **not fully verified** in this checkout. Its existing WSL
node_modules symlinks prevent native `pnpm typecheck` from finding tsc; a native
frozen installation attempt also encountered EACCES on that shared tree. In a
PowerShell run of the existing `telegram-local` and `telegram-test-bot` suites,
52/61 tests passed and nine failed on POSIX permission-mode assumptions, process
signals or Windows symlink privileges (EPERM). Those unrelated deployment-tool
portability issues were not hidden or fixed through security relaxation. Use a
separate native dependency tree and resolve those platform-specific tests before
claiming full native-Windows release verification. The new implementation adds
no OS-specific dependencies or shell scripts.

Browser/mobile editing, currency caret/paste behavior and a real Development
Telegram/OIDC smoke test remain operator checks; no automated browser suite was
introduced, consistent with the frontend project instructions.

## File map

- Contracts: `packages/contracts/src/{index,visit,visit-wizard,write,dashboard,visit-report}.ts`.
- Database: `packages/db/src/schema.ts`, `migrations/0015_visit_report.sql`.
- API: `apps/api/src/{index,operations,records,catalog-reads,visit-reads,admin-users,supervisor-assignments,bot-business}.ts`, `visits/wizard.ts`.
- Bot: `apps/bot/src/commands.ts`, `visits/commands.ts`, `outlets/commands.ts`,
  `business/commands.ts`, `registration/{commands,help}.ts`.
- Web: `router.tsx`, workspace page, Visit entry/detail/history pages, filter/read
  helpers, `visits/components/rupiah-input.tsx`, Stock Report fields.
- Fixtures: `apps/api/seeds/{local,demo}.sql`.
- Tests: shared write/currency/period tests, D1 migration test, API write/Visit/stock
  integration, Bot command/help/planning/identity and existing auth/demo assertions.
- Docs: root/app READMEs, this handoff, API/Telegram references and historical
  wizard supersession notice.

Exact changed-file manifest (including new files):

```text
README.md
apps/api/README.md
apps/api/seeds/demo.sql
apps/api/seeds/local.sql
apps/api/src/admin-users.ts
apps/api/src/bot-business.ts
apps/api/src/catalog-reads.ts
apps/api/src/index.ts
apps/api/src/operations.ts
apps/api/src/records.ts
apps/api/src/supervisor-assignments.ts
apps/api/src/visit-reads.ts
apps/api/src/visits/wizard.ts
apps/api/tests/api.test.mjs
apps/api/tests/bot-business.test.mjs
apps/api/tests/bot-help.test.mjs
apps/api/tests/bot-planning.test.mjs
apps/api/tests/bot-visits.test.mjs
apps/api/tests/demo-data-sync.test.mjs
apps/api/tests/identity.test.mjs
apps/api/tests/visit-guard-worker.ts
apps/api/tests/web-auth.test.mjs
apps/bot/src/business/commands.ts
apps/bot/src/commands.ts
apps/bot/src/outlets/commands.ts
apps/bot/src/registration/commands.ts
apps/bot/src/registration/help.ts
apps/bot/src/visits/commands.ts
apps/web/README.md
apps/web/src/features/auth/pages/workspace-page.tsx
apps/web/src/features/stock-reports/components/stock-report-fields.tsx
apps/web/src/features/visits/components/rupiah-input.tsx
apps/web/src/features/visits/lib/filter-visits.ts
apps/web/src/features/visits/lib/visit-reads.ts
apps/web/src/features/visits/pages/new-visit-page.tsx
apps/web/src/features/visits/pages/visit-detail-page.tsx
apps/web/src/features/visits/pages/visits-page.tsx
apps/web/src/router.tsx
docs/api-reference.md
docs/design/telegram-visit-wizard.md
docs/sales-visit-update.md
docs/telegram-bot-reference.md
packages/contracts/src/dashboard.ts
packages/contracts/src/index.ts
packages/contracts/src/visit-report.ts
packages/contracts/src/visit-wizard.ts
packages/contracts/src/visit.ts
packages/contracts/src/write.ts
packages/contracts/tests/visit-fixture.mjs
packages/contracts/tests/visit-report.test.mjs
packages/contracts/tests/write.test.mjs
packages/db/migrations/0015_visit_report.sql
packages/db/src/schema.ts
packages/db/tests/visit-report.test.mjs
```
