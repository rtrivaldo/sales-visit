import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import { summaryText } from "@sales-visit/contracts";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

import {
  fixtureState,
  snapshotQueries,
  reconcile,
} from "../../../scripts/demo-fixtures.mjs";
import { createApp } from "../src/index.ts";
import { businessClock } from "../src/summary.ts";
import { hashToken } from "../src/web-auth.ts";
async function setup(t) {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("test")}}',
      compatibilityDate: "2026-11-02",
      d1Databases: { DB: "sales-summary" },
    })
  );
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  const dir = new URL("../../../packages/db/migrations/", import.meta.url);
  for (const f of readdirSync(dir)
    .filter((s) => s.endsWith(".sql"))
    .toSorted())
    await execute(db, readFileSync(new URL(f, dir), "utf8"));
  return db;
}
async function execute(db, sql) {
  return db.batch(
    sql
      .replace(/^\s*--.*$/gm, "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => db.prepare(s))
  );
}
test("Sales/monitor summary is scoped, distinct, month-aware, demo-isolated and shared with Telegram formatting", async (t) => {
  const db = await setup(t),
    clock = businessClock();
  await execute(
    db,
    `INSERT INTO sales_force(id,name,demo_only) VALUES ('sf1','Sales One',0),('sf2','Sales Two',0),('demo','Demo Sales',1); INSERT INTO outlets(id,name,business_id,demo_only) VALUES ('a','Outlet A','000A',0),('b','Outlet B','000B',0),('d','Demo Outlet','DEMO',1); INSERT INTO products(id,name) VALUES ('p','Product');`
  );
  const tokens = {};
  for (const [id, role, sf, telegram] of [
    ["admin", "admin", null, "1"],
    ["super", "supervisor", null, "2"],
    ["s1", "sales_force", "sf1", "3"],
    ["s2", "sales_force", "sf2", "4"],
    ["demo-user", "sales_force", "demo", null],
  ]) {
    await db
      .prepare(
        "INSERT INTO users(id,display_name,status,role,sales_force_id) VALUES (?,?,'active',?,?)"
      )
      .bind(id, id, role, sf)
      .run();
    if (telegram)
      await db
        .prepare(
          "INSERT INTO telegram_identities(user_id,telegram_user_id,first_name) VALUES (?,?,?)"
        )
        .bind(id, telegram, id)
        .run();
    const token = String(Object.keys(tokens).length + 1).repeat(64);
    tokens[id] = token;
    await db
      .prepare(
        "INSERT INTO web_sessions(token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)"
      )
      .bind(await hashToken(token), id, Date.now(), Date.now() + 60000)
      .run();
  }
  await db
    .prepare(
      "INSERT INTO sales_force_supervisors(sales_force_id,supervisor_user_id) VALUES ('sf1','super')"
    )
    .run();
  await db
    .prepare(
      "INSERT INTO visit_schedules(id,sales_force_id,outlet_id,weekday,demo_only) VALUES ('a','sf1','a',?,0),('b','sf1','b',?,0),('c','sf2','a',?,0),('d','demo','d',?,1)"
    )
    .bind(clock.weekday, clock.weekday, clock.weekday, clock.weekday)
    .run();
  for (const [id, sf, outlet, money, cvm, time] of [
    ["v1", "sf1", "a", 1000, 1, clock.start],
    ["v2", "sf1", "a", 2000, 0, clock.start + 1],
    ["legacy", "sf1", "a", null, null, clock.start - 1],
    ["other", "sf2", "a", 9000, 1, clock.start + 2],
    ["demo-v", "demo", "d", 999999, 1, clock.start],
  ])
    await db
      .prepare(
        "INSERT INTO visits(id,outlet_id,sales_force_id,visited_at,submission_channel,reporting_month,reporting_year,total_purchase,is_cvm_active,is_voice_active,is_digital_active) VALUES (?,?,?,?,'web',?,?,?,?,?,?)"
      )
      .bind(id, outlet, sf, time, clock.month, clock.year, money, cvm, cvm, cvm)
      .run();
  const app = createApp(),
    env = { DB: db };
  const request = (path, who = "s1", init = {}) =>
    app.request(
      path,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${tokens[who]}`,
          "Content-Type": "application/json",
          ...init.headers,
        },
      },
      env
    );
  const sales = await (await request("/dashboard/summary")).json();
  assert.equal(sales.today.scheduled, 2);
  assert.equal(sales.today.completed, 1);
  assert.equal(sales.today.remaining, 1);
  assert.equal(sales.today.percentage, 50);
  assert.equal(sales.month.totalPurchase, 3000);
  assert.equal(sales.month.missingPurchaseReports, 1);
  assert.equal(sales.activity.cvm, 0);
  assert.equal(sales.salesForce, 1);
  assert.ok(sales.recentVisits.every((v) => v.salesForceId === "sf1"));
  const supervisor = await (
    await request("/dashboard/summary", "super")
  ).json();
  assert.deepEqual(supervisor.today, sales.today);
  assert.equal(supervisor.month.totalPurchase, 3000);
  const admin = await (await request("/dashboard/summary", "admin")).json();
  assert.equal(admin.today.scheduled, 3);
  assert.equal(admin.today.completed, 2);
  assert.equal(admin.month.totalPurchase, 12000);
  assert.equal(admin.activity.cvm, 1);
  assert.equal(admin.users.sales_force, 2);
  const demo = await (await request("/dashboard/summary", "demo-user")).json();
  assert.equal(demo.month.totalPurchase, 999999);
  assert.equal(demo.recentVisits.length, 1);
  assert.equal(
    (
      await request("/stock-reports", "demo-user", {
        method: "POST",
        body: "{}",
      })
    ).status,
    403
  );
  for (const s of [sales, supervisor, admin, demo]) {
    const text = summaryText(s);
    assert.ok(text.length < 4096);
    assert.match(text, /RINGKASAN/);
    assert.doesNotMatch(text, /NaN|Infinity/);
  }
  assert.match(summaryText(sales), /Rp 3.000/);
  assert.match(summaryText(admin), /66,7%/);
  const schedules = await (await request("/schedules")).json();
  assert.equal(
    schedules.items.find((r) => r.outletId === "a").completedToday,
    true
  );
  assert.equal(
    schedules.items.find((r) => r.outletId === "b").completedToday,
    false
  );
  assert.equal((await request("/schedules?salesForceId=sf2")).status, 403);
  const ownOutlets = await (
    await request("/outlets?view=page&assigned=own", "s2")
  ).json();
  assert.deepEqual(
    ownOutlets.items.map((r) => r.id),
    ["a"]
  );
  const outlet = await (await request("/outlets/a")).json();
  assert.equal(outlet.activity.cvm, false);
  assert.ok(outlet.scheduleWeekdays.includes(clock.weekday));
  const data = {
      outletId: "a",
      reportedAt: new Date().toISOString(),
      items: [{ productId: "p", quantity: 0 }],
    },
    key = crypto.randomUUID();
  const post = () =>
    request("/stock-reports", "s1", {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify(data),
    });
  const response = await post();
  assert.equal(response.status, 201);
  const report = await response.json();
  assert.equal((await post()).status, 200);
  assert.equal(
    (await request(`/stock-reports/${report.id}`, "s2")).status,
    404
  );
  assert.equal((await request(`/stock-reports/${report.id}`)).status, 200);
  assert.equal(
    (
      await request("/stock-reports", "s1", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ ...data, visitId: "other" }),
      })
    ).status,
    404
  );
  assert.equal((await request("/dashboard/summary")).status, 200);
  await execute(
    db,
    "INSERT INTO sales_force(id,name) VALUES ('empty-sf','Empty'); INSERT INTO users(id,display_name,status,role,sales_force_id) VALUES ('empty','Empty','active','sales_force','empty-sf'); INSERT INTO telegram_identities(user_id,telegram_user_id) VALUES ('empty','999');"
  );
  tokens.empty = "e".repeat(64);
  await db
    .prepare(
      "INSERT INTO web_sessions(token_hash,user_id,created_at,expires_at) VALUES (?,'empty',?,?)"
    )
    .bind(await hashToken(tokens.empty), Date.now(), Date.now() + 60000)
    .run();
  const zero = await (await request("/dashboard/summary", "empty")).json();
  assert.deepEqual(zero.today, {
    scheduled: 0,
    completed: 0,
    remaining: 0,
    percentage: 0,
  });
  assert.equal(zero.month.totalPurchase, 0);
  assert.equal(zero.recentVisits.length, 0);
  await db
    .prepare(
      "INSERT INTO visits(id,outlet_id,sales_force_id,visited_at,submission_channel) VALUES ('unknown-finance','b','empty-sf',?,'web')"
    )
    .bind(clock.start)
    .run();
  const unknown = await (await request("/dashboard/summary", "empty")).json();
  assert.equal(unknown.month.totalPurchase, null);
  assert.equal(unknown.activity.unknown, 1);
  assert.equal(unknown.month.missingPurchaseReports, 1);
  await db.prepare("UPDATE users SET status='disabled' WHERE id='s1'").run();
  assert.equal((await post()).status, 401);
  assert.equal((await request("/dashboard/summary")).status, 401);
});
test("refresh runs against isolated real D1 and populates an operational Sales demo dashboard", async (t) => {
  const db = await setup(t),
    fixture = fixtureState(),
    queries = snapshotQueries(fixture);
  const read = async () =>
    Object.fromEntries(
      await Promise.all(
        queries.map(async (q) => [
          q.table,
          (await db.prepare(q.sql).all()).results,
        ])
      )
    );
  const plan = reconcile(fixture, await read());
  await execute(db, plan.sql);
  assert.equal(reconcile(fixture, await read()).sql, "");
  assert.deepEqual(
    (await db.prepare("PRAGMA foreign_key_check").all()).results,
    []
  );
  const token = "a".repeat(64);
  await db
    .prepare(
      "INSERT INTO web_sessions(token_hash,user_id,created_at,expires_at) VALUES (?,'demo-sf-01',?,?)"
    )
    .bind(await hashToken(token), Date.now(), Date.now() + 60000)
    .run();
  const response = await createApp().request(
    "/dashboard/summary",
    { headers: { Authorization: `Bearer ${token}` } },
    { DB: db }
  );
  assert.equal(response.status, 200);
  const s = await response.json();
  assert.equal(s.today.scheduled, 2);
  assert.equal(s.today.completed, 1);
  assert.equal(s.today.remaining, 1);
  assert.ok(s.month.totalPurchase > 0);
  assert.ok(s.month.visits > 0);
  assert.ok(s.recentStock.length > 0);
  assert.ok(summaryText(s).length < 4096);
});
