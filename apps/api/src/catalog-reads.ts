import { createDb, sql, salesForce, outlets, products } from "@sales-visit/db";
import type { Context } from "hono";

import { demoOutletPredicate, webDemoCatalogScope } from "./demo-data.ts";
import { operationalScope } from "./read-scope.ts";
import type { WebEnv } from "./web-auth.ts";

export async function catalogPage(
  c: Context<WebEnv>,
  kind: "salesForce" | "outlets" | "products"
) {
  const table = { salesForce, outlets, products }[kind];
  const db = createDb(c.env.DB);
  const q = c.req.query("q");
  const baseScope =
    kind === "salesForce"
      ? sql`${operationalScope(c.get("account").id, salesForce.id)} and ${webDemoCatalogScope(c.get("account").id, "sales_force.demo_only = 1")}`
      : kind === "outlets"
        ? webDemoCatalogScope(c.get("account").id, demoOutletPredicate())
        : sql`1 = 1`;
  const scope =
    kind === "outlets" && c.req.query("assigned") === "own"
      ? sql`${baseScope} AND EXISTS(SELECT 1 FROM users owner WHERE owner.id=${c.get("account").id} AND owner.status='active' AND owner.role='sales_force' AND (EXISTS(SELECT 1 FROM visit_schedules s WHERE s.sales_force_id=owner.sales_force_id AND s.outlet_id=${outlets.id}) OR EXISTS(SELECT 1 FROM visits v WHERE v.sales_force_id=owner.sales_force_id AND v.outlet_id=${outlets.id}) OR EXISTS(SELECT 1 FROM stock_reports r WHERE r.reporter_sales_force_id=owner.sales_force_id AND r.outlet_id=${outlets.id})))`
      : baseScope;
  const where = q
    ? sql`${scope} and instr(lower(${table.name} || ' ' || ${table.id} || ' ' || ${kind === "outlets" ? sql`coalesce(${outlets.businessId}, '') || ' ' || coalesce(${outlets.noRs}, '')` : sql`''`}), lower(${q.trim()})) > 0`
    : scope;
  const [items, totals] = await db.batch([
    db
      .select({
        id: table.id,
        name: table.name,
        ...(kind === "outlets" ? { businessId: outlets.businessId } : {}),
      })
      .from(table)
      .where(where)
      .orderBy(table.id)
      .limit(Number(c.req.query("limit") ?? 100))
      .offset(Number(c.req.query("offset") ?? 0)),
    db
      .select({ total: sql<number>`count(*)` })
      .from(table)
      .where(where),
  ]);
  return c.json({ items, total: totals[0]!.total });
}

export async function outletDetail(c: Context<WebEnv>) {
  const outlet = await createDb(c.env.DB).query.outlets.findFirst({
    columns: { id: true, name: true, businessId: true, noRs: true },
    where: (t, { eq, and }) =>
      and(
        eq(t.id, c.req.param("id")!),
        webDemoCatalogScope(c.get("account").id, demoOutletPredicate())
      ),
  });
  if (!outlet) return c.json({ error: "Outlet not found" }, 404);
  if (c.get("account").role !== "sales_force") return c.json(outlet);
  const [schedules, latest] = await Promise.all([
    c.env.DB.prepare(
      "SELECT weekday FROM visit_schedules WHERE outlet_id=? AND sales_force_id=? ORDER BY weekday"
    )
      .bind(outlet.id, c.get("account").salesForceId)
      .all<{ weekday: number }>(),
    createDb(c.env.DB).query.visits.findFirst({
      where: (t, { and, eq }) =>
        and(
          eq(t.outletId, outlet.id),
          operationalScope(c.get("account").id, t.salesForceId)
        ),
      orderBy: (t, { desc, asc }) => [desc(t.visitedAt), asc(t.id)],
    }),
  ]);
  return c.json({
    ...outlet,
    scheduleWeekdays: schedules.results.map((r) => r.weekday),
    activity: latest
      ? {
          cvm: latest.isCvmActive,
          voice: latest.isVoiceActive,
          digital: latest.isDigitalActive,
          visitedAt: latest.visitedAt.toISOString(),
        }
      : null,
  });
}
