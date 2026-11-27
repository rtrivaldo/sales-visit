import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export const tables = [
  "sales_force",
  "users",
  "outlets",
  "products",
  "sales_force_supervisors",
  "visit_schedules",
  "visits",
  "stock_reports",
  "stock_report_items",
];
export const primary = {
  sales_force_supervisors: ["sales_force_id"],
  telegram_identities: ["user_id"],
  telegram_visit_drafts: ["user_id"],
  stock_report_items: ["stock_report_id", "product_id"],
};
export const keyOf = (table, row) =>
  JSON.stringify((primary[table] ?? ["id"]).map((column) => row[column]));
export const canonical = (row) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(row).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    )
  );
/** Receipts are full, typed row fingerprints, not raw JSON byte fingerprints.
 * Key order/whitespace may differ across writers; numbers, null and strings must
 * NOT be coerced. SQLite already materializes fixture defaults/integers for us. */
export function receiptMatches(receipt, row) {
  if (typeof receipt !== "string") return false;
  try {
    const parsed = JSON.parse(receipt);
    return (
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof parsed === "object" &&
      canonical(parsed) === canonical(row)
    );
  } catch {
    return false;
  }
}
export const literal = (value) =>
  value === null
    ? "NULL"
    : typeof value === "number"
      ? String(value)
      : `'${String(value).replaceAll("'", "''")}'`;
export const migrationFiles = () =>
  readdirSync(new URL("../packages/db/migrations/", import.meta.url))
    .filter((f) => f.endsWith(".sql"))
    .toSorted();

/** Initial seed definitions are the only master/persona/catalog source. Refresh
 * transforms their dates and schedule-derived targets, never maintains a second
 * independent set of people/outlets/products. */
export function fixtureState(now = Date.now()) {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON");
    for (const file of migrationFiles())
      db.exec(
        readFileSync(
          new URL(`../packages/db/migrations/${file}`, import.meta.url),
          "utf8"
        )
      );
    db.exec(
      readFileSync(
        new URL("../apps/api/seeds/demo.sql", import.meta.url),
        "utf8"
      )
    );
    const baseline = Object.fromEntries(
      tables.map((table) => [
        table,
        db
          .prepare(`SELECT * FROM ${table}`)
          .all()
          .map((r) => ({ ...r })),
      ])
    );
    const desired = structuredClone(baseline);
    const business = new Date(now + 7 * 3600000),
      year = business.getUTCFullYear(),
      month = business.getUTCMonth() + 1,
      day = business.getUTCDate(),
      weekday = business.getUTCDay() || 7;
    const start = Date.UTC(year, month - 1, day) - 7 * 3600000;
    for (const schedule of baseline.visit_schedules) {
      const index = Number(schedule.sales_force_id.slice(-2));
      desired.visit_schedules.push({
        ...schedule,
        id: `demo-schedule-extra-${schedule.sales_force_id}-${schedule.weekday}`,
        outlet_id: `demo-out-${String(1 + ((index * 2 + schedule.weekday + 7) % 35)).padStart(2, "0")}`,
      });
    }
    for (const sf of baseline.sales_force) {
      const first = baseline.visits.find((v) => v.sales_force_id === sf.id);
      if (!first) continue;
      const today = desired.visit_schedules.find(
        (s) => s.sales_force_id === sf.id && s.weekday === weekday
      );
      today.outlet_id = first.outlet_id;
      const extra = desired.visit_schedules.find(
        (s) => s.id === `demo-schedule-extra-${sf.id}-${weekday}`
      );
      if (extra.outlet_id === first.outlet_id)
        extra.outlet_id = baseline.outlets.find(
          (o) => o.id !== first.outlet_id
        ).id;
    }
    for (const visit of desired.visits) {
      const i = Number(visit.id.slice(-2)),
        index = Number(visit.sales_force_id.slice(-2));
      // The first observation completes today's primary schedule. All other
      // observations are within this month and never in the future.
      const offset = Math.min(i - 1, day - 1),
        date = start - offset * 86400000;
      visit.visited_at = date; // midnight WIB avoids future fixture instants
      visit.created_at = date;
      visit.reporting_month = month;
      visit.reporting_year = year;
      visit.reporting_week = 1 + ((i - 1) % 4);
      visit.digipos_balance = (index + i) * 100000;
      visit.total_purchase = (index + i) * 150000;
      for (const [j, field] of [
        "perdana_sa_stock",
        "perdana_sa_selling",
        "perdana_sa_sellout",
        "vf_data_stock",
        "vf_data_selling",
        "vf_data_sellout",
        "vf_voice_stock",
        "vf_voice_selling",
        "vf_voice_sellout",
      ].entries())
        visit[field] = (index + i + j) % 35;
      visit.is_cvm_active = i % 2;
      visit.is_voice_active = (i + 1) % 2;
      visit.is_digital_active = index % 2;
      visit.submission_channel = i % 2 ? "telegram" : "web";
    }
    for (const report of desired.stock_reports) {
      const visit = desired.visits.find((v) => v.id === report.visit_id);
      report.outlet_id = visit.outlet_id;
      report.reported_at = visit.visited_at;
      report.created_at = visit.created_at;
      report.submission_channel = visit.submission_channel;
    }
    return { baseline, desired, date: business.toISOString().slice(0, 10) };
  } finally {
    db.close();
  }
}

// Select only canonical keys and their touching relationships; never enumerate
// all operational records. These same predicates guard the execution snapshot.
export function snapshotQueries(fixture) {
  const ids = (table, field = "id") =>
    [...new Set(fixture.desired[table].map((r) => r[field]))]
      .map(literal)
      .join(",");
  const sf = ids("sales_force"),
    outlets = ids("outlets"),
    visits = ids("visits"),
    reports = ids("stock_reports"),
    products = ids("products");
  const conditions = {
    sales_force: `id COLLATE NOCASE IN (${sf})`,
    users: `id IN (${ids("users")}) OR sales_force_id IN (${sf})`,
    outlets: `id IN (${outlets}) OR business_id COLLATE NOCASE IN (${ids("outlets", "business_id")})`,
    products: `id IN (${products})`,
    sales_force_supervisors: `sales_force_id IN (${sf}) OR supervisor_user_id IN (${ids("users")})`,
    visit_schedules: `id IN (${ids("visit_schedules")}) OR sales_force_id IN (${sf}) OR outlet_id IN (${outlets})`,
    visits: `id IN (${visits}) OR sales_force_id IN (${sf}) OR outlet_id IN (${outlets})`,
    stock_reports: `id IN (${reports}) OR reporter_sales_force_id IN (${sf}) OR outlet_id IN (${outlets}) OR visit_id IN (${visits})`,
    stock_report_items: `stock_report_id IN (${reports}) OR product_id IN (${products})`,
    telegram_identities: `user_id IN (${ids("users")})`,
    demo_fixture_state: "1=1",
    access_audit: `actor_user_id IN (${ids("users")}) OR target_user_id IN (${ids("users")})`,
    supervisor_assignment_audit: `sales_force_id IN (${sf}) OR actor_user_id IN (${ids("users")}) OR previous_supervisor_user_id IN (${ids("users")}) OR new_supervisor_user_id IN (${ids("users")})`,
    outlet_master_audit: `outlet_id IN (${outlets}) OR actor_user_id IN (${ids("users")})`,
    sales_force_master_audit: `sales_force_id IN (${sf}) OR actor_user_id IN (${ids("users")})`,
    telegram_visit_drafts: `sales_force_id IN (${sf}) OR user_id IN (${ids("users")}) OR visit_id IN (${visits})`,
  };
  return Object.entries(conditions).map(([table, where]) => ({
    table,
    where,
    sql: `SELECT * FROM ${table} WHERE ${where}`,
  }));
}

export function reconcile(
  fixture,
  snapshot,
  { repairProvenance = false, evidenceFixture } = {}
) {
  for (const query of snapshotQueries(fixture))
    if (!Array.isArray(snapshot[query.table]))
      throw new Error("Incomplete dependency snapshot");
  const receipts = new Map(
    (snapshot.demo_fixture_state ?? []).map((r) => [
      `${r.table_name}:${r.record_key}`,
      r.record_json,
    ])
  );
  const fixtureKeys = new Set(
    tables.flatMap((table) =>
      fixture.desired[table].map((row) => `${table}:${keyOf(table, row)}`)
    )
  );
  const dependencyCounts = {};
  const eligible = new Map(),
    conflicts = [],
    owned = new Set(),
    protectedRows = new Map();
  const provenance = {
    verified: 0,
    missing: 0,
    mismatched: 0,
    independentlyVerified: 0,
  };
  const current = new Map(
    tables.map((table) => [
      table,
      new Map((snapshot[table] ?? []).map((r) => [keyOf(table, r), r])),
    ])
  );
  for (const table of tables)
    for (const target of fixture.desired[table]) {
      const key = keyOf(table, target),
        existing = current.get(table).get(key);
      const base = fixture.baseline[table].find((r) => keyOf(table, r) === key);
      const variants = base ? [base] : [];
      if (base && ["sales_force", "outlets", "visit_schedules"].includes(table))
        variants.push({ ...base, demo_only: 0 });
      if (base && table === "visits") {
        const legacy = { ...base };
        for (const field of Object.keys(base).filter(
          (f) =>
            f.startsWith("reporting_") ||
            f.startsWith("perdana_") ||
            f.startsWith("vf_") ||
            f.startsWith("is_") ||
            ["digipos_balance", "total_purchase"].includes(f)
        ))
          legacy[field] = null;
        variants.push(legacy);
      }
      const id = `${table}:${key}`;
      if (repairProvenance && !existing) continue;
      const historical = evidenceFixture?.desired[table].find(
        (r) => keyOf(table, r) === key
      );
      // Historical evidence is opt-in, reproducible and full-row exact. Never
      // infer ownership from timestamps/prefixes or a partially matching row.
      if (repairProvenance && historical) variants.push(historical);
      const independent =
        existing &&
        (canonical(existing) === canonical(target) ||
          variants.some((row) => canonical(row) === canonical(existing)));
      const receipt = receipts.get(id);
      const validReceipt = existing && receiptMatches(receipt, existing);
      if (existing) {
        provenance[
          validReceipt
            ? "verified"
            : receipt === undefined
              ? "missing"
              : "mismatched"
        ]++;
        if (independent) provenance.independentlyVerified++;
      }
      const verified = !existing || independent || validReceipt;
      const collision =
        table === "outlets"
          ? (snapshot.outlets ?? []).some(
              (r) =>
                r.id !== target.id &&
                r.business_id?.toLowerCase() ===
                  target.business_id?.toLowerCase()
            )
          : table === "sales_force" &&
            (snapshot.sales_force ?? []).some(
              (r) =>
                r.id !== target.id &&
                r.id.toLowerCase() === target.id.toLowerCase()
            );
      const linked =
        table === "users" &&
        (snapshot.telegram_identities ?? []).some(
          (t) => t.user_id === target.id
        );
      if (verified && !linked && !collision) {
        owned.add(id);
        eligible.set(id, {
          table,
          key,
          target: repairProvenance ? existing : target,
          existing,
        });
      } else
        conflicts.push({
          table,
          key,
          kind: "direct",
          root: id,
          fields: existing
            ? Object.keys(target).filter(
                (field) => existing[field] !== target[field]
              )
            : [],
          reason: collision
            ? "Case-insensitive business-code collision"
            : linked
              ? "Telegram identity present"
              : "Fingerprint conflict",
        });
    }
  const references = (table, row) => {
    if (!Object.hasOwn(snapshot, table))
      throw new Error("Incomplete dependency snapshot");
    const refs = [];
    const add = (t, ...values) => refs.push(`${t}:${JSON.stringify(values)}`);
    if (table === "telegram_identities") add("users", row.user_id);
    if (table === "users" && row.sales_force_id)
      add("sales_force", row.sales_force_id);
    if (table === "sales_force_supervisors") {
      add("sales_force", row.sales_force_id);
      add("users", row.supervisor_user_id);
    }
    if (table === "visit_schedules" || table === "visits") {
      add("sales_force", row.sales_force_id);
      add("outlets", row.outlet_id);
    }
    if (table === "stock_reports") {
      add("sales_force", row.reporter_sales_force_id);
      add("outlets", row.outlet_id);
      if (row.visit_id) add("visits", row.visit_id);
    }
    if (table === "stock_report_items") {
      add("stock_reports", row.stock_report_id);
      add("products", row.product_id);
    }
    if (
      [
        "access_audit",
        "supervisor_assignment_audit",
        "outlet_master_audit",
        "sales_force_master_audit",
      ].includes(table)
    ) {
      if (row.actor_user_id) add("users", row.actor_user_id);
      if (row.target_user_id) add("users", row.target_user_id);
      if (row.sales_force_id) add("sales_force", row.sales_force_id);
      if (row.outlet_id) add("outlets", row.outlet_id);
      if (row.previous_supervisor_user_id)
        add("users", row.previous_supervisor_user_id);
      if (row.new_supervisor_user_id) add("users", row.new_supervisor_user_id);
    }
    if (table === "telegram_visit_drafts") {
      add("users", row.user_id);
      add("sales_force", row.sales_force_id);
      if (row.visit_id) add("visits", row.visit_id);
    }
    return refs;
  };
  const blocked = new Map(conflicts.map((c) => [`${c.table}:${c.key}`, c]));
  const protect = (id, cause) => {
    if (fixtureKeys.has(id) && !protectedRows.has(id))
      protectedRows.set(id, cause);
  };
  // Ownership does not disappear when a verified row is blocked. Treating such
  // rows as real data was the old bidirectional graph-poisoning defect.
  for (const table of [
    ...tables,
    "telegram_identities",
    "access_audit",
    "supervisor_assignment_audit",
    "outlet_master_audit",
    "sales_force_master_audit",
    "telegram_visit_drafts",
  ])
    for (const row of snapshot[table]) {
      const id = `${table}:${keyOf(table, row)}`;
      if (!owned.has(id)) {
        const parents = references(table, row).filter((parent) =>
          fixtureKeys.has(parent)
        );
        if (!blocked.has(id) && parents.length)
          dependencyCounts[table] = (dependencyCounts[table] ?? 0) + 1;
        const cause = blocked.has(id)
          ? { via: id, root: id, reason: "Blocked fixture dependency" }
          : {
              via: `external:${table}`,
              root: `external:${table}`,
              reason: "Non-fixture dependency",
            };
        for (const parent of parents) protect(parent, cause);
      }
    }
  let changed = true;
  while (changed) {
    changed = false;
    const block = (id, reason, cause) => {
      const row = eligible.get(id);
      if (!row) return;
      eligible.delete(id);
      const conflict = {
        table: row.table,
        key: row.key,
        kind: cause.via.startsWith("external:") ? "direct" : "propagated",
        reason,
        fields: [],
        via: cause.via,
        root: cause.root,
      };
      blocked.set(id, conflict);
      conflicts.push(conflict);
      // Only persisted relationships can protect a parent; an absent blocked
      // insert must not contaminate an unrelated shared fixture.
      if (row.existing)
        for (const parent of references(row.table, row.existing))
          protect(parent, {
            via: id,
            root: cause.root,
            reason: "Blocked fixture dependency",
          });
      changed = true;
    };
    for (const [id, row] of eligible) {
      const protection = protectedRows.get(id);
      // A verified, byte-for-byte unchanged parent is a frozen anchor, not a
      // reason to block every sibling sharing that SF, Outlet or Product.
      if (
        protection &&
        (!row.existing || canonical(row.existing) !== canonical(row.target))
      ) {
        block(id, protection.reason, protection);
        continue;
      }
      const previousParents = row.existing
        ? references(row.table, row.existing)
        : [];
      for (const parent of references(row.table, row.target)) {
        if (!eligible.has(parent)) {
          block(id, "Conflicting parent", {
            via: fixtureKeys.has(parent)
              ? parent
              : `external:${parent.split(":")[0]}`,
            root:
              blocked.get(parent)?.root ??
              (fixtureKeys.has(parent)
                ? parent
                : `external:${parent.split(":")[0]}`),
          });
          break;
        }
        if (protectedRows.has(parent) && !previousParents.includes(parent)) {
          block(id, "New relationship to protected fixture", {
            via: parent,
            root: protectedRows.get(parent).root,
          });
          break;
        }
      }
    }
  }
  const actions = [...eligible.values()].map((r) => ({
    ...r,
    protected: protectedRows.has(`${r.table}:${r.key}`),
    receiptTarget: protectedRows.has(`${r.table}:${r.key}`)
      ? (receipts.get(`${r.table}:${r.key}`) ?? null)
      : receiptMatches(receipts.get(`${r.table}:${r.key}`), r.target)
        ? receipts.get(`${r.table}:${r.key}`)
        : canonical(r.target),
    action: !r.existing
      ? "insert"
      : canonical(r.existing) === canonical(r.target)
        ? "unchanged"
        : "update",
  }));
  const assertions = [];
  for (const query of snapshotQueries(fixture)) {
    const rows = snapshot[query.table] ?? [];
    assertions.push(
      `SELECT CASE WHEN (SELECT count(*) FROM ${query.table} WHERE ${query.where})=${rows.length} THEN 1 ELSE json('snapshot conflict') END`
    );
    for (const row of rows)
      assertions.push(
        `SELECT CASE WHEN EXISTS(SELECT 1 FROM ${query.table} WHERE ${Object.entries(
          row
        )
          .map(([field, value]) => `${field} IS ${literal(value)}`)
          .join(" AND ")}) THEN 1 ELSE json('snapshot conflict') END`
      );
  }
  const writes = [];
  for (const row of actions) {
    if (row.action === "insert")
      writes.push(
        `INSERT INTO ${row.table} (${Object.keys(row.target).join(",")}) VALUES (${Object.values(row.target).map(literal).join(",")})`
      );
    if (row.action === "update")
      writes.push(
        `UPDATE ${row.table} SET ${Object.entries(row.target)
          .map(([k, v]) => `${k}=${literal(v)}`)
          .join(
            ","
          )} WHERE ${(primary[row.table] ?? ["id"]).map((k) => `${k} IS ${literal(row.target[k])}`).join(" AND ")}`
      );
    if (
      !row.protected &&
      !receiptMatches(receipts.get(`${row.table}:${row.key}`), row.target)
    )
      writes.push(
        `INSERT INTO demo_fixture_state(table_name,record_key,record_json) VALUES (${literal(row.table)},${literal(row.key)},${literal(canonical(row.target))}) ON CONFLICT(table_name,record_key) DO UPDATE SET record_json=excluded.record_json`
      );
  }
  return {
    actions,
    conflicts,
    provenance,
    protections: [...protectedRows].map(([id, cause]) => ({ id, ...cause })),
    dependencyCounts,
    pendingChanges: actions.filter((r) => r.action !== "unchanged").length,
    receiptChanges: actions.filter(
      (r) =>
        !r.protected &&
        !receiptMatches(receipts.get(`${r.table}:${r.key}`), r.target)
    ).length,
    status: conflicts.length
      ? writes.length
        ? "partially_blocked"
        : "completely_blocked"
      : writes.length
        ? "changes_available"
        : "up_to_date",
    sql: writes.length ? [...assertions, ...writes].join(";\n") + ";" : "",
  };
}
