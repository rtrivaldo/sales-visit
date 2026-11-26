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
  stock_report_items: ["stock_report_id", "product_id"],
};
export const keyOf = (table, row) =>
  JSON.stringify((primary[table] ?? ["id"]).map((column) => row[column]));
export const canonical = (row) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(row).toSorted(([a], [b]) => a.localeCompare(b))
    )
  );
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

export function reconcile(fixture, snapshot) {
  const receipts = new Map(
    (snapshot.demo_fixture_state ?? []).map((r) => [
      `${r.table_name}:${r.record_key}`,
      r.record_json,
    ])
  );
  const eligible = new Map(),
    conflicts = [];
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
      const verified =
        !existing ||
        canonical(existing) === canonical(target) ||
        receipts.get(`${table}:${key}`) === canonical(existing) ||
        variants.some((row) => canonical(row) === canonical(existing));
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
      if (verified && !linked && !collision)
        eligible.set(`${table}:${key}`, { table, key, target, existing });
      else
        conflicts.push({
          table,
          key,
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
  // A real/ambiguous touching record blocks its fixture parents. Then propagate
  // blocks both ways through the fixture graph; never rewrite a mixed component.
  let changed = true;
  while (changed) {
    changed = false;
    const block = (id, reason) => {
      const row = eligible.get(id);
      if (row) {
        eligible.delete(id);
        conflicts.push({ table: row.table, key: row.key, reason });
        changed = true;
      }
    };
    for (const table of [
      ...tables,
      "access_audit",
      "supervisor_assignment_audit",
      "outlet_master_audit",
      "sales_force_master_audit",
      "telegram_visit_drafts",
    ])
      for (const row of snapshot[table] ?? []) {
        if (!eligible.has(`${table}:${keyOf(table, row)}`))
          for (const parent of references(table, row))
            block(parent, "Non-fixture dependency");
      }
    for (const [id, row] of eligible)
      for (const parent of references(row.table, row.target))
        if (!eligible.has(parent)) block(id, "Conflicting parent");
  }
  const actions = [...eligible.values()].map((r) => ({
    ...r,
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
    if (receipts.get(`${row.table}:${row.key}`) !== canonical(row.target))
      writes.push(
        `INSERT INTO demo_fixture_state(table_name,record_key,record_json) VALUES (${literal(row.table)},${literal(row.key)},${literal(canonical(row.target))}) ON CONFLICT(table_name,record_key) DO UPDATE SET record_json=excluded.record_json`
      );
  }
  return {
    actions,
    conflicts,
    sql: writes.length ? [...assertions, ...writes].join(";\n") + ";" : "",
  };
}
