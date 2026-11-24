# Supervisor grouping and search

`/supervisor-assignments` now uses `GET /supervisor-assignment-groups` for its
Admin-only default view. Groups are keyed by **Supervisor user ID**, not name.
Two Supervisors with the same name remain separate. Each group shows the display
name, total assigned SF, SF name/business code, and existing assignment controls.
Inactive/unavailable Supervisors retain their indicators. Eligible Supervisors
with no team remain visible; unassigned SF have a separate **Belum Ditugaskan** group.

Search placeholder: **Cari nama Supervisor atau Sales Force...**. Input is trimmed,
case-insensitive and partial; SQL `instr` treats wildcard characters literally.

- Supervisor-name match: include the complete team, regardless of member names.
- SF-name match only: include only matching SF under their Supervisor.
- Both: full teams for matching Supervisors, matching members for other groups.
- No duplicates; clearing search restores the default groups.

Filtering occurs **before pagination in the database**, not on the current Web
page. Groups are paginated ten at a time; each team initially loads up to 100 SF.
Large teams expose **Muat anggota berikutnya**, preserving group/query/cursor via
the existing bounded `/supervisor-assignments` endpoint. Thus a full-team search
never drops nonmatching teammates, but very large teams are progressively loaded
rather than making an unbounded SQL query. The displayed total is the complete
assigned count, not just the visible/search-matching member count.

Loading skeletons, empty teams, no-result and error messages have accessible status
semantics. Horizontal table overflow remains handled by the existing shadcn Table.
The existing selection and confirmation dialog are retained. Mutations use the
unchanged assignment transaction/audit; success reloads affected group data and
counts, while uncertain outcomes require reconciliation before another change.

Demo Admin reads include only marked SF and eligible unlinked demo Supervisors;
Bot Demo Mode can never mutate assignments. Supervisor monitoring scope is still
based on current assignments, not names or historical snapshots.
