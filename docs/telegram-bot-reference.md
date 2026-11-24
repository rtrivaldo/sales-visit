# Telegram Bot reference

Commands run only in private chats using the verified Telegram sender ID. `/help`
is compact and role-aware; Demo Mode overrides the real role and hides writes.
A = active Admin; S = active Supervisor; SF = active Sales Force.

## Common and identity

- `/start`, `/help`, `/me`: welcome, allowed commands, current identity.
- `/register`: existing manual pending-registration flow. Imported active accounts
  are recognized by `/start` and never need registration or another approval.
- `/users [KURSOR] [status=active|pending|disabled|rejected]`, `/pending [KURSOR]`: Admin lists, ten per page. Users includes unlinked demo accounts, as on Web.
- `/approve TELEGRAM_ID admin|supervisor` or
  `/approve TELEGRAM_ID sales_force KODE_SF` (`sales` remains an alias).
- `/reject TELEGRAM_ID`, `/disable TELEGRAM_ID`, `/enable TELEGRAM_ID`.
- `/setrole TELEGRAM_ID admin|supervisor` or
  `/setrole TELEGRAM_ID sales_force KODE_SF`.

User administration is real Admin only. Active/protected/last Admin invariants,
immutable reserved SF associations, audits and rejection finality are unchanged.
Telegram IDs are positive decimal **strings**, never staff codes or usernames.
Verify identity and SF association out of band before approval or import.

## Dashboard and monitoring

- `/dashboard`: A/S, 14-day WIB counts, channels, daily activity and recent Visits.
- `/salesforce [q=TOKEN] [offset=ANGKA]`: A/S, scoped directory search.
- `/produk [q=TOKEN] [offset=ANGKA]`: all active roles, read-only product catalog.
- `/detailsalesforce kode_sf`: exact business record detail within scope.
- `/riwayatvisit [q=TOKEN] [salesForceId=KODE] [outletId=ID] [channel=web|telegram] [stock=with|without] [date=YYYY-MM-DD] [offset=ANGKA]`.
- `/detailvisit visit_id`: notes, follow-up, references and linked stock reports.
- `/stockreport [salesForceId=KODE] [outletId=ID] [offset=ANGKA]`.

Visits and stock reads are global for A, current assigned team for S, own for SF.
Continuation commands preserve all filters. Reporting lists contain ten records.

## Outlet and recurring schedules

| Command                                                       | Access                                                         |
| ------------------------------------------------------------- | -------------------------------------------------------------- |
| `/outlets [KURSOR]`                                           | A/S/SF, 50 records                                             |
| `/carioutlet [q=TOKEN] [offset=ANGKA]`                        | A/S/SF, search                                                 |
| `/outlet outlet_id`                                           | A/S/SF, case-insensitive **business ID**, no internal fallback |
| `/tambahoutlet BUSINESS_ID NO_RS NAMA_OUTLET`                 | A                                                              |
| `/editoutlet BUSINESS_ID NO_RS_BARU NAMA_OUTLET_BARU`         | A                                                              |
| `/hapusoutlet BUSINESS_ID KONFIRMASI`                         | A; rejects referenced records                                  |
| `/editoutletinternal INTERNAL_ID NO_RS_BARU NAMA_OUTLET_BARU` | A, retained                                                    |
| `/hapusoutletinternal INTERNAL_ID KONFIRMASI`                 | A, retained                                                    |
| `/jadwal [hari                                                | semua] [after=KURSOR]`                                         | SF, own; defaults today Jakarta |
| `/jadwalsales kode_sf [hari] [after=KURSOR]`                  | A/S, S assigned team only                                      |
| `/tambahjadwal KODE_SF INTERNAL_OUTLET_ID HARI`               | A                                                              |

Without arguments `/jadwalsales` displays:

```text
Format: /jadwalsales kode_sf [hari]

Contoh:
/jadwalsales SF001
/jadwalsales SF001 senin
```

SF code is mandatory and is `sales_force.id`. No Telegram-ID/day-only/named-filter
syntax is supported. No day means **all weekdays** for that SF. Code/day matching
is case-insensitive; leading zeros and stored spelling are preserved. Unknown or
ambiguous codes are rejected. Indonesian days: senin, selasa, rabu, kamis, jumat,
sabtu, minggu. Next-page commands retain SF code and weekday.

Outlet detail similarly accepts `OUT001`, `out001`, `Out001`. Case collisions
produce an explicit ambiguity error, not an arbitrary record. Stored IDs are never
normalized. No. RS is an opaque reference, not necessarily a phone number.
Internal outlet tokens still identify immutable FKs in Visit/schedule entry.
Schedules are recurring plans, **not completed Visits**.

Outlet catalog reads (outlets, carioutlet, outlet) are also available to active,
uniquely associated SF accounts, matching Web catalog access. SF cannot modify outlets.

## SF and assignment management

- `/tambahsalesforce kode_sf nama KONFIRMASI`.
- `/editsalesforce kode_sf nama_baru KONFIRMASI`: changes only name;
  shares Web optimistic-concurrency and audit guards.
- `/hapussalesforce kode_sf KONFIRMASI`: refuses every protected reference.
- `/supervisors [after=KURSOR]`: active Supervisor options, A only.
- `/penugasan [q=TOKEN] [after=KURSOR]`: assignment search, A only.
- `/assignsupervisor kode_sf supervisor_user_id KONFIRMASI`: assign/reassign.
- `/unassignsupervisor kode_sf KONFIRMASI`: remove responsibility.

No business rule is bypassed by Telegram; changes are immediately in the same D1
used by Web. After uncertain transport failures, reconcile lists/audits before retrying.

## Excel user pre-registration (real Admin only)

- `/templatepengguna`: download the blank .xlsx template with separate examples.
- Send .xlsx document with caption `/importpengguna`: authoritative validation/preview.
- After reviewing, re-send with `/importpengguna KONFIRMASI`; append `ADMIN` if
  the workbook contains Admin accounts. All rows are revalidated before saving.
- Limits: 256 KiB, 50 users, four text columns; formulas/numeric identifiers rejected.
- All-or-nothing account, Telegram identity and audit creation. Existing accounts
  are never overwritten/reactivated. See [import workflow](user-import.md).

## Visit submission and Demo Mode

`/salesvisit` starts/resumes the existing durable SF Visit wizard. Follow its
outlet/time/notes/follow-up/optional-stock prompts; `/konfirmasi` saves or recovers
the result; `/batal` discards an uncommitted draft. Idempotency is unchanged.

Real Admins can create an unlinked demo profile with
`/tambahakundemo admin|supervisor|sales_force TOKEN_NAMA [kode_sf] KONFIRMASI`
when demo support is enabled. Names with spaces use the token format below.

`/demo`, `/demo_login account_id`, `/demo_status`, `/demo_logout` select isolated
local/staging read-only credentials. No real identity is linked/replaced. All new
reads use the same marked dataset as Web, with role/assignment scope. No writes or
real user imports are permitted. See [Demo Mode](telegram-demo-mode.md).

## Exact token format

Simple IDs/cursors are raw `[A-Za-z0-9_.-]+`. Other exact values (including search
phrases with spaces) use `~` + canonical unpadded base64url UTF-8. No normalization
or numeric conversion is performed. Example:

```js
const text = "Budi Santoso";
console.log("~" + Buffer.from(text, "utf8").toString("base64url"));
```

Copy returned IDs/continuations exactly. Pages are live, not frozen exports.
Plain-text replies are packed/split at logical boundaries below 4096 characters.

## Development release

Migration `0014_business_code_lookup.sql` adds only non-unique lookup indexes.
Existing case collisions remain for manual review; no records or IDs are rewritten.

```sh
pnpm db:migrate:dev
pnpm deploy:api:dev
pnpm deploy:bot:dev
pnpm deploy:web:dev
```

These commands target existing Development resources, never Production. Do not
seed or reset business data. Migrate before API, then Bot and Web. See the full
[implementation and testing notes](feature-updates-delivery.md).
