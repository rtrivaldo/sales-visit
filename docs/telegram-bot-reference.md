# Telegram Bot reference

Private chats only; the verified sender determines authority. `/help` follows the
live role. Demo Mode is read-only and overrides the real account's role.
A = active Admin; S = active Supervisor; SF = active Sales Force.

## Common and identity

- `/start`, `/help`, `/me`, `/register`: unchanged registration/profile flows.
- `/pending [KURSOR]`: A, approval queue, ten per page.
- `/user ID_TELEGRAM`: A, one exact Telegram-linked user; no bulk fallback.
- `/approve ID_TELEGRAM admin|supervisor` or `/approve ID_TELEGRAM sales_force KODE_SF`.
- `/reject ID_TELEGRAM`, `/disable ID_TELEGRAM`, `/enable ID_TELEGRAM`.
- `/setrole ID_TELEGRAM admin|supervisor` or `/setrole ID_TELEGRAM sales_force KODE_SF`.

Account protection, reserved SF associations and audit logging are unchanged.
Use Web user management for unlinked demo accounts. IDs remain strings.

## Targeted monitoring

| Command                     | Access / result                                                    |
| --------------------------- | ------------------------------------------------------------------ |
| `/outlet ID_OUTLET`         | A/S/SF; one Outlet by case-insensitive **business ID**             |
| `/detailsalesforce KODE_SF` | A/S; one authorized SF, established command retained               |
| `/supervisor ID_TELEGRAM`   | A; one active Supervisor                                           |
| `/detailvisit ID_KUNJUNGAN` | A/S/SF; Visit, financial/reporting fields and linked Stock Reports |
| `/detailstok ID_LAPORAN`    | A/S/SF; one independently authorized Stock Report                  |
| `/dashboard`                | A/S; bounded 14-day activity summary                               |

Missing identifiers produce usage instructions, never a list. Unknown/unauthorized
records do not disclose restricted data. Visit/Stock Report scope is global for A,
currently assigned team for S, and own records for SF. Outlet catalog access is
catalog-wide for authorized users; an assigned schedule is not required to report.
Leading zeros are preserved. Case-colliding business IDs fail as ambiguous.

Removed registrations: `/outlets`, `/users`, `/salesforce`, `/supervisors`.
Web lists and shared API/RPC listing operations remain available.

## Filtered collections

At least one substantive filter is required (an offset/cursor alone is insufficient).
Copy returned continuation commands, which preserve filters.

- `/carioutlet q=NAMA [offset=ANGKA]`: ten authorized Outlet references.
- `/produk q=NAMA [offset=ANGKA]`: ten product references.
- `/riwayatvisit outletId=ID [offset=ANGKA]`: ten Visits; alternative filters:
  `q`, `salesForceId`, `channel=web|telegram`, `stock=with|without`,
  `date=YYYY-MM-DD`, `reportingWeek=1..4`, `reportingMonth=1..12`, `reportingYear`.
- `/stockreport outletId=ID [offset=ANGKA]` or `/stockreport salesForceId=KODE`:
  ten Stock Reports, including independent reports.
- `/penugasan q=NAMA [after=KURSOR]`: A, five assignment records.

Plain-text replies are split at logical boundaries below Telegram's 4096-unit limit.

## Visit submission

`/salesvisit` starts/resumes a durable, 24-hour D1 draft for a real active SF.
Answer with ordinary text, without field prefixes:

1. Outlet **business ID**; the API resolves its existing internal FK and name.
2. Periode: `1`, `2`, `3` or `4` (Minggu ke-1 through Minggu ke-4).
3. Saldo Digipos.
4. Perdana SA: Stok, Selling, Sellout.
5. VF Data: Stok, Selling, Sellout.
6. VF Voice: Stok, Selling, Sellout.
7. Outlet Aktif: CVM, Voice, Digital.
8. Total Belanja.
9. Review; `Y` saves, `N` cancels. `/konfirmasi` also saves/retries safely.

No separate Outlet-name, visit-time, notes or follow-up questions. Visit time is
captured at Outlet selection; month/year derive from that instant in Asia/Jakarta.
Periods are business selections, not calculated calendar/ISO weeks.

All quantities and money require safe nonnegative integers, including zero.
Money accepts `1000000`, `1.000.000`, `Rp 1.000.000`, `Rp1.000.000`,
`Rp. 1.000.000`, `rp 1.000.000`, `1 000 000`, with outer whitespace.
Malformed grouping, decimals, negatives, arbitrary text, exponents and overflow
are rejected. Booleans accept Y/Yes/Ya and N/No/Tidak, case-insensitively.
Invalid answers repeat the current question without changing previous answers.

`/batal` cancels an uncommitted draft. After an uncertain submission,
`/konfirmasi` recovers the same identifier, including across Worker restarts.
No success is sent before persistence. Starting a genuinely new report requires
an explicit `/salesvisit` after the old report is submitted/cancelled/expired.
Visit fields do not replace product-level Stock Reports.

## Management and schedules

All existing create/update/delete/assignment/import operations remain:

- `/tambahoutlet BUSINESS_ID NO_RS NAMA_OUTLET` (A).
- `/editoutlet BUSINESS_ID NO_RS_BARU NAMA_OUTLET_BARU` (A).
- `/hapusoutlet BUSINESS_ID KONFIRMASI` (A; refuses references).
- `/editoutletinternal INTERNAL_ID NO_RS_BARU NAMA_OUTLET_BARU`,
  `/hapusoutletinternal INTERNAL_ID KONFIRMASI` (A, exact legacy IDs).
- `/jadwal [HARI|semua] [after=KURSOR]` (SF, own; default today Jakarta).
- `/jadwalsales KODE_SF [HARI] [after=KURSOR]` (A/S, assigned team for S).
- `/tambahjadwal KODE_SF INTERNAL_OUTLET_ID HARI` (A).
- `/tambahsalesforce KODE_SF NAMA KONFIRMASI`,
  `/editsalesforce KODE_SF NAMA_BARU KONFIRMASI`,
  `/hapussalesforce KODE_SF KONFIRMASI` (A).
- `/assignsupervisor KODE_SF SUPERVISOR_USER_ID KONFIRMASI`,
  `/unassignsupervisor KODE_SF KONFIRMASI` (A).
- `/templatepengguna`, .xlsx caption `/importpengguna`, then
  `/importpengguna KONFIRMASI` (append `ADMIN` when importing Admins).
  Existing 256-KiB/50-row limits, atomic validation and audits remain.

Example: `/jadwalsales SF001 senin`. Code/day matching is case-insensitive;
Indonesian days are senin, selasa, rabu, kamis, jumat, sabtu, minggu.
Schedules remain plans, never evidence of a completed Visit.

## Demo and tokens

`/demo`, `/demo_login account_id`, `/demo_status`, `/demo_logout` preserve isolated
local/staging read-only sessions. Real Admins retain
`/tambahakundemo admin|supervisor|sales_force TOKEN_NAMA [KODE_SF] KONFIRMASI`.
No Telegram identity is linked by demo login. Production rejects demo support.

Simple command IDs/cursors use raw `[A-Za-z0-9_.-]+`; other exact values use `~`
plus canonical unpadded base64url UTF-8. Copy returned continuations unchanged.
The Visit wizard accepts the plain business ID rather than an internal token.

See [implementation, migration and Development deployment](sales-visit-update.md).
