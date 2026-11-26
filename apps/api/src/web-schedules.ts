import type { Context } from "hono";

import { isDemoAccount } from "./demo-data.ts";
import { ScheduleOperations } from "./schedules.ts";
import { businessClock } from "./summary.ts";
import type { WebEnv } from "./web-auth.ts";

// Additive read-only endpoint. Existing Web routes and response shapes remain
// intact. GET /schedules equals /jadwal semua for SF, /jadwalsales for monitors;
// weekday=1..7 corresponds to a Bot day filter (no filter means all weekdays).
export async function webSchedules(c: Context<WebEnv>) {
  const account = c.get("account");
  const own = account.role === "sales_force";
  if (own && c.req.query("salesForceId") !== undefined)
    return c.json({ error: "Forbidden" }, 403);
  const weekday = c.req.query("weekday");
  if (weekday !== undefined && !/^[1-7]$/.test(weekday))
    return c.json({ error: "Invalid request" }, 400);
  const input = {
    ...(weekday === undefined ? {} : { weekday: Number(weekday) }),
    ...(c.req.query("after") === undefined
      ? {}
      : { after: c.req.query("after") }),
    ...(c.req.query("salesForceId") === undefined
      ? {}
      : { salesForceId: c.req.query("salesForceId") }),
  };
  const result = await new ScheduleOperations(
    c.env.DB,
    await isDemoAccount(c.env.DB, account.id)
  ).web(account.id, input, own);
  if (!result.ok)
    return c.json(
      { error: "Schedule unavailable" },
      result.code === "forbidden" ? 403 : result.code === "invalid" ? 400 : 503
    );
  const clock = businessClock();
  const completed = await c.env.DB.prepare(
    "SELECT DISTINCT sales_force_id AS sf, outlet_id AS outlet FROM visits WHERE visited_at>=? AND visited_at<? AND EXISTS(SELECT 1 FROM json_each(?) target WHERE json_extract(target.value,'$[0]')=sales_force_id AND json_extract(target.value,'$[1]')=outlet_id)"
  )
    .bind(
      clock.start,
      clock.start + 86400000,
      JSON.stringify(
        result.data.items.map((item) => [item.salesForceId, item.outletId])
      )
    )
    .all<{ sf: string; outlet: string }>();
  // Only expose completion for already-authorized schedule rows.
  const targets = new Set(
    completed.results.map((r) => JSON.stringify([r.sf, r.outlet]))
  );
  return c.json({
    ...result.data,
    today: clock.today,
    weekday: clock.weekday,
    items: result.data.items.map((item) => ({
      ...item,
      completedToday:
        item.weekday === clock.weekday &&
        targets.has(JSON.stringify([item.salesForceId, item.outletId])),
    })),
  });
}
