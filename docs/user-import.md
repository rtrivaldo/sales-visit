# Bulk Telegram user pre-registration

## Web workflow

1. Sign in with a verified, active, Telegram-linked Admin account.
2. Open **Pengguna & Akses → Import Pengguna**.
3. Download **Template Excel**. Fill only `Pengguna`; examples/instructions live
   on `Petunjuk` and can never become imported example users.
4. Upload `.xlsx` (max **256 KiB**, **50 users**). Every column must contain text:
   `telegram_id`, `nama`, `role`, `kode_sf`. Numeric IDs are rejected rather than
   guessing whether Excel already rounded them. Preserve leading zeros in SF codes.
5. Review every row and the total/valid/invalid/duplicate counts. No writes occur.
6. Fix all errors and upload again. Confirm explicitly; importing Admin accounts
   also requires a separate Admin-access checkbox.
7. Successful imports report the number created and refresh User Management.
   If transport fails, **Periksa hasil impor** uses the existing operation receipt
   protocol; do not submit a second operation until the first outcome is known.

Canonical roles: `admin`, `supervisor`, `sales_force`. Only Sales Force accounts
require `kode_sf`; other roles must leave it blank. Case-insensitive SF code
resolution must yield exactly one non-demo business record.

The server checks required headers/values, text types, formulas, names, roles,
Telegram identity conflicts (including pending/rejected/disabled), duplicates,
SF existence/ambiguity, duplicate associations and existing reservations.
IDs are never parsed as JavaScript numbers. No formulas, links or embedded content
are executed. ZIP expansion is bounded before parsing. Role dropdown validation
is not emitted by the chosen workbook writer; the instruction sheet and server
role validation remain authoritative.

## Account and transaction behavior

`POST /admin/user-import/preview` and `/commit` accept `{filename, content}`;
`content` is base64 workbook bytes. Commit additionally requires server-issued
`operationId`, `confirm: true`, and `confirmAdmins: true` if applicable.
`GET /admin/user-import/template` returns base64 template bytes for downloading.
All three endpoints are active real Admin only, no-store, authenticated and bounded.

One D1 transaction creates **all users, Telegram identities and access audits**.
A transaction-time whole-file gate rejects conflicts introduced after preview.
An audit failure rolls the entire batch back. There is no separate pre-registration
table and no overwrite/reactivation path. SF associations are checked against all
accounts, including inactive/reserved associations. Protected/last-Admin rules are
not weakened: import only adds accounts, never modifies an existing Admin.

Each row receives a `register` audit with `channel: excel_import` and the workbook
hash. The existing 30-second Web operation ID/deadline and primary audit lookup are
reused. Repeating the same committed operation/file returns its original count;
reusing that operation for different bytes fails. A new operation importing already
registered IDs is a conflict, never a duplicate account.

Imported accounts are immediately `active`, with the selected canonical role and
verified Telegram ID association. `/start` recognizes the active account, `/me`
shows its role/link, and normal verified Telegram Web login works. The first
verified Bot interaction fills only missing Telegram metadata; it cannot change
role, status or SF association. Manual `/register` is unchanged for unknown users.

## Telegram alternative

A real Admin can download `/templatepengguna`, send a workbook with caption
`/importpengguna` for preview, then explicitly re-send with caption
`/importpengguna KONFIRMASI` (append `ADMIN` for Admin accounts). The same API
validation and transaction run in both channels. Demo Mode forbids both paths.

## Limits

Use multiple separately reviewed batches for more than 50 people. Workbooks with
numeric identifiers must be corrected at their authoritative source if precision
has already been lost. Legacy case-colliding SF codes require operator resolution;
imports never guess or rewrite them. Local/staging Demo accounts cannot import
real users. No live Telegram or Cloudflare deployment is performed by tests.
