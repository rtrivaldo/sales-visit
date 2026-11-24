# Web / Telegram feature audit

Baseline: `f05410e` (origin/main), clean working tree; 2026-06-12.

## Before implementation

| Web module             | Existing Telegram                                         | Missing business operations                                              |
| ---------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------ |
| Overview               | none                                                      | Role-scoped dashboard summary                                            |
| Users                  | users, pending, approve, reject, setrole, disable, enable | Excel pre-registration (new in both channels)                            |
| Sales Force master     | none                                                      | Search/list/detail, create, rename, protected delete                     |
| Outlets                | outlets, outlet, outletinternal, tambah/edit/hapusoutlet  | Search; case-insensitive business lookup; remove internal detail command |
| Supervisor assignments | none                                                      | Supervisors, assignments, assign/reassign/unassign                       |
| Schedules              | jadwal, jadwalsales, tambahjadwal                         | Require business SF code in monitoring command                           |
| Visit history/details  | none                                                      | Scoped filters/pagination, visit detail                                  |
| Visit submission       | salesvisit, konfirmasi, batal                             | Existing conversational workflow already shares write logic              |
| Stock reports          | visit wizard entry only                                   | Scoped stock report reads                                                |
| Demo Mode              | demo, demo_login, demo_status, demo_logout                | Extend isolated read-only access to new read commands                    |

## Implementation checklist

- [x] Reuse Web routes/services for new Bot operations; role checks remain server-side.
- [x] Require SF code and preserve code/day in schedule continuation.
- [x] Reject case-insensitive identifier collisions; do not rewrite stored keys.
- [x] Remove only outletinternal, retain internal mutation commands.
- [x] Excel template, bounded upload, authoritative preview, explicit atomic confirmation, audit/idempotency.
- [x] Imported active Telegram identities work with start/me and existing Web login.
- [x] Supervisor-ID grouping and server-side whole-dataset search.
- [x] Compact effective-role help and Demo read-only filtering.
- [x] Regression tests and required repository checks executed; see delivery notes for baseline Windows deployment-test failures.

Additional audit closure: `/users` now includes Web's unlinked demo profiles and status filter;
`/tambahakundemo` provides Web demo-account provisioning for real Admins; `/produk`
provides the read-only directory. Outlet catalog reads now match Web's active SF access
(with a uniquely associated SF), while all outlet mutations remain Admin-only.

Purely visual charts, browser navigation and layout are not Telegram business operations.
