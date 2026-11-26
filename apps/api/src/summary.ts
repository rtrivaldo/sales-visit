import { completion, type OperationalSummary } from "@sales-visit/contracts";
import { createDb, salesForce, sql } from "@sales-visit/db";
import type { Context } from "hono";

import { demoEligibility } from "./demo-auth.ts";
import { isDemoAccount } from "./demo-data.ts";
import { operationalScope } from "./read-scope.ts";
import { toVisit } from "./records.ts";
import type { WebEnv } from "./web-auth.ts";

export function businessClock(now = Date.now()) {
  const date = new Date(now + 7 * 3600000);
  const today = date.toISOString().slice(0, 10);
  const month = date.getUTCMonth() + 1,
    year = date.getUTCFullYear();
  return {
    today,
    month,
    year,
    weekday: date.getUTCDay() || 7,
    start: Date.parse(`${today}T00:00:00+07:00`),
    monthStart: Date.UTC(year, month - 1, 1) - 7 * 3600000,
    monthEnd: Date.UTC(year, month, 1) - 7 * 3600000,
  };
}
export async function operationalSummary(c: Context<WebEnv>) {
  if (Object.keys(c.req.query()).length)
    return c.json({ error: "Invalid request" }, 400);
  const account = c.get("account"),
    db = createDb(c.env.DB);
  const demo = await isDemoAccount(c.env.DB, account.id),
    mode = demo ? 1 : 0;
  const clock = businessClock();
  const scope = db
    .select({ id: salesForce.id })
    .from(salesForce)
    .where(
      sql`${operationalScope(account.id, salesForce.id)} AND ${salesForce.demoOnly} = ${mode}`
    )
    .toSQL();
  const cte = `WITH actor AS (SELECT role FROM users WHERE id=? AND status='active'), scoped_sf AS (${scope.sql}),
    v AS (SELECT v.* FROM visits v JOIN scoped_sf sf ON sf.id=v.sales_force_id JOIN outlets o ON o.id=v.outlet_id WHERE o.demo_only=${mode}),
    monthly AS (SELECT * FROM v WHERE (reporting_month=${clock.month} AND reporting_year=${clock.year}) OR (reporting_month IS NULL AND reporting_year IS NULL AND visited_at>=${clock.monthStart} AND visited_at<${clock.monthEnd})),
    latest AS (SELECT *, row_number() OVER (PARTITION BY outlet_id ORDER BY visited_at DESC,id) AS position FROM monthly),
    schedules AS (SELECT DISTINCT s.sales_force_id,s.outlet_id,s.weekday FROM visit_schedules s JOIN scoped_sf sf ON sf.id=s.sales_force_id JOIN outlets o ON o.id=s.outlet_id WHERE s.demo_only=${mode} AND o.demo_only=${mode}),
    reports AS (SELECT r.* FROM stock_reports r JOIN scoped_sf sf ON sf.id=r.reporter_sales_force_id JOIN outlets o ON o.id=r.outlet_id WHERE o.demo_only=${mode})`;
  const queries = [
    `SELECT (SELECT count(*) FROM scoped_sf) AS salesForce,(SELECT count(DISTINCT outlet_id) FROM schedules) AS assignedOutlets,
      count(*) AS scheduled,coalesce(sum(EXISTS(SELECT 1 FROM v WHERE v.sales_force_id=s.sales_force_id AND v.outlet_id=s.outlet_id AND v.visited_at>=${clock.start} AND v.visited_at<${clock.start + 86400000})),0) AS completed FROM schedules s WHERE weekday=${clock.weekday}`,
    `SELECT count(*) AS visits,count(DISTINCT outlet_id) AS outlets,sum(total_purchase*1.0) AS totalPurchase,count(total_purchase) AS knownPurchaseReports,count(*)-count(total_purchase) AS missingPurchaseReports FROM monthly`,
    `SELECT coalesce(sum(is_cvm_active=1),0) AS cvm,coalesce(sum(is_voice_active=1),0) AS voice,coalesce(sum(is_digital_active=1),0) AS digital,coalesce(sum(is_cvm_active IS NULL OR is_voice_active IS NULL OR is_digital_active IS NULL),0) AS unknown FROM latest WHERE position=1`,
    `SELECT coalesce(sum(reported_at>=${clock.start} AND reported_at<${clock.start + 86400000}),0) AS today,coalesce(sum(reported_at>=${clock.monthStart} AND reported_at<${clock.monthEnd}),0) AS month FROM reports`,
    `SELECT id,outlet_id AS outletId,reported_at AS reportedAt,(SELECT name FROM outlets WHERE id=outlet_id) AS outletName FROM reports ORDER BY reported_at DESC,id LIMIT 5`,
    `SELECT u.role,count(*) AS count FROM users u WHERE EXISTS(SELECT 1 FROM actor WHERE role='admin') AND ${demo ? demoEligibility : "EXISTS(SELECT 1 FROM telegram_identities t WHERE t.user_id=u.id)"} AND u.status='active' GROUP BY u.role UNION ALL SELECT 'pending',count(*) FROM users u WHERE EXISTS(SELECT 1 FROM actor WHERE role='admin') AND u.status='pending' AND ${demo ? "0" : "EXISTS(SELECT 1 FROM telegram_identities t WHERE t.user_id=u.id)"}`,
  ];
  const rows = await c.env.DB.batch<Record<string, unknown>>(
    queries.map((query) =>
      c.env.DB.prepare(`${cte} ${query}`).bind(account.id, ...scope.params)
    )
  );
  const daily = rows[0]!.results[0] as {
    salesForce: number;
    assignedOutlets: number;
    scheduled: number;
    completed: number;
  };
  const monthly = rows[1]!.results[0] as OperationalSummary["month"];
  monthly.totalPurchase =
    monthly.visits === 0
      ? 0
      : Number.isSafeInteger(monthly.totalPurchase)
        ? monthly.totalPurchase
        : null;
  const recent = await db.query.visits.findMany({
    where: (t) =>
      sql`${operationalScope(account.id, t.salesForceId)} AND EXISTS(SELECT 1 FROM sales_force sf JOIN outlets o ON o.id=${t.outletId} WHERE sf.id=${t.salesForceId} AND sf.demo_only=${mode} AND o.demo_only=${mode})`,
    limit: 5,
    orderBy: (t, { desc, asc }) => [desc(t.visitedAt), asc(t.id)],
    with: {
      outlet: { columns: { id: true, name: true, businessId: true } },
      salesForce: { columns: { id: true, name: true } },
    },
  });
  const counts = Object.fromEntries(
    rows[5]!.results.map((row) => [String(row.role), Number(row.count)])
  );
  const result: OperationalSummary = {
    role: account.role,
    readOnly: demo,
    name: account.name,
    salesForceId: account.role === "sales_force" ? account.salesForceId : null,
    period: {
      month: clock.month,
      year: clock.year,
      today: clock.today,
      timeZone: "Asia/Jakarta",
    },
    assignedOutlets: daily.assignedOutlets,
    salesForce: daily.salesForce,
    users:
      account.role === "admin"
        ? {
            admin: counts.admin ?? 0,
            supervisor: counts.supervisor ?? 0,
            sales_force: counts.sales_force ?? 0,
            pending: counts.pending ?? 0,
          }
        : null,
    today: completion(daily.scheduled, daily.completed),
    month: monthly,
    activity: rows[2]!.results[0] as OperationalSummary["activity"],
    stock: rows[3]!.results[0] as OperationalSummary["stock"],
    recentVisits: recent.map((row) => ({
      ...toVisit(row),
      outlet: row.outlet,
      member: row.salesForce,
    })),
    recentStock: rows[4]!.results.map((row) => ({
      id: String(row.id),
      outletId: String(row.outletId),
      reportedAt: new Date(Number(row.reportedAt)).toISOString(),
      outlet: { id: String(row.outletId), name: String(row.outletName) },
    })),
  };
  return c.json(result);
}
