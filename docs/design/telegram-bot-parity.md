# Web / Telegram business feature parity

Current baseline audit: [checklist](../feature-parity-checklist.md). Commands are
private-chat only. A = active Admin, S = active Supervisor, SF = active Sales Force.
Every operation is authorized server-side, including follow-up pages.

| Web module             | Telegram workflows                                                      | Access                                                |
| ---------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------- |
| Overview               | summary: daily/monthly scoped Visits, stock and activity                | A/S/SF; live scope, demo read-only                    |
| Users                  | user ID_TELEGRAM, pending, approve, reject, setrole, disable, enable    | A, not Demo                                           |
| Pre-registration       | templatepengguna, importpengguna with document preview and confirmation | Real A only                                           |
| SF directory           | detailsalesforce KODE_SF                                                | A/S; S team only                                      |
| SF master              | tambahsalesforce, editsalesforce, hapussalesforce                       | A, not Demo; Web protected-reference/audit rules      |
| Outlets                | outlet ID_OUTLET; tambah/edit/hapusoutlet                               | Catalog reads A/S/SF as on Web; mutations A, not Demo |
| Supervisor assignments | supervisor ID_TELEGRAM, penugasan, assignsupervisor, unassignsupervisor | A; Demo reads synthetic records only                  |
| Recurring schedules    | jadwal; jadwalsales kode_sf [hari]; tambahjadwal                        | Own SF; A/S monitoring; creation A                    |
| Visit history          | riwayatvisit, detailvisit                                               | A global, S assigned team, SF own                     |
| Visit submission       | salesvisit, konfirmasi, batal                                           | Active SF, not Demo                                   |
| Stock reports          | stockreport, detailstok; Web standalone/linked entry                    | Reads scoped by role; submission SF                   |
| Demo Mode              | demo, demo_login, demo_status, demo_logout                              | Opt-in local/staging, isolated and read-only          |

The read-only product directory is available through `/produk` (A/S/SF).
Real Admins can create eligible demo profiles with `/tambahakundemo` when demo
support is enabled; this never links a Telegram identity. `/users` now shares the
Web list, includes unlinked demo accounts and supports status filtering.

Visual charts and browser navigation are intentionally not reproduced.
Web currently has no schedule edit/delete UI; no new schedule lifecycle is invented.
Internal outlet edit/delete commands remain, but the internal detail command is removed.

## Shared implementation

`BotIdentity.business` is a private, allowlisted RPC adapter. It resolves only the
verified Telegram sender (or eligible live demo session), creates a private
30-second credential, invokes the existing Web API handlers in-process, then deletes
the credential in `finally`. Credentials never leave the API Worker. Web handlers
recheck the live role, references, session and audit guards; no business mutation
logic is copied into Bot. Public HTTP cannot supply a Bot actor or invoke the RPC.
No arbitrary paths, authentication routes or caller-supplied roles are accepted.
Demo mutations and all administrative import/master reads fail closed before invocation.
Dashboard/Visit/stock queries for unlinked demo accounts require marked SF provenance.

## Identifier rules

- `sales_force.id` is the existing **business code**, not a Telegram ID.
- `outlets.business_id` is the user-facing outlet business ID. Detail lookup uses
  parameterized `COLLATE NOCASE`, returns the stored spelling and preserves zeros.
- Multiple case-insensitive matches return `ambiguous`; never pick the first row.
- Internal outlet primary keys/FKs and APIs remain intact. No automatic fallback.
- Non-unique NOCASE indexes (0014) improve lookup without breaking legacy collisions.
- Raw simple tokens use `[A-Za-z0-9_.-]+`; other exact IDs/cursors use `~` plus
  unpadded base64url UTF-8. Copy continuation commands verbatim.

See [command grammar](../telegram-bot-reference.md), [user import](../user-import.md),
and [Supervisor grouping](../supervisor-grouping.md).

## Historical attribution

The original parity work inspected `rtrivaldo/telegram_bot` at
`e7de4a9965b2a815160bd389a89be5fa6b1b73a7`. Credit to rtrivaldo/Paldo and the
original contributors for Indonesian command vocabulary and guided Visit UX.
This repository's grammY/API/D1 implementation is an independent adaptation,
not a Telegraf/PostgreSQL port. The reference package declares ISC; no standalone
LICENSE was found in that audit, so confirm reuse terms before redistribution.
