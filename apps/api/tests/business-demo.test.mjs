import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
const bundled = await build({
  entryPoints: [
    fileURLToPath(new URL("../src/bot-service.ts", import.meta.url)),
  ],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
});
const { botService } = await import(
  "data:text/javascript;base64," +
    Buffer.from(bundled.outputFiles[0].text).toString("base64")
);
test("new business reads isolate Demo Admin from real data, and all writes fail closed", async (t) => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      compatibilityDate: "2026-11-02",
      script: 'export default {fetch(){return new Response("fixture")}}',
      d1Databases: { DB: "business-demo" },
    })
  );
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  const dir = new URL("../../../packages/db/migrations/", import.meta.url);
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .toSorted())
    await db.batch(
      readFileSync(new URL(file, dir), "utf8")
        .replace(/^\s*--.*$/gm, "")
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => db.prepare(s))
    );
  await db
    .prepare(
      "INSERT INTO sales_force(id,name,demo_only) VALUES ('real','REAL PRIVATE SF',0),('synthetic','Synthetic SF',1)"
    )
    .run();
  await db
    .prepare(
      "INSERT INTO users(id,display_name,status,role) VALUES ('real-admin','REAL PRIVATE ADMIN','active','admin'),('demo-admin','Demo Admin','active','admin'),('real-sup','REAL PRIVATE SUPERVISOR','active','supervisor'),('demo-sup','Demo Supervisor','active','supervisor')"
    )
    .run();
  await db
    .prepare(
      "INSERT INTO telegram_identities(user_id,telegram_user_id) VALUES ('real-admin','100'),('real-sup','200')"
    )
    .run();
  await db
    .prepare(
      "INSERT INTO outlets(id,name,business_id,demo_only) VALUES ('real-out','REAL PRIVATE OUTLET','REAL001',0),('demo-out','Demo Outlet','DEMO001',1)"
    )
    .run();
  await db
    .prepare(
      "INSERT INTO visits(id,outlet_id,sales_force_id,visited_at,submission_channel) VALUES ('real-visit','real-out','real',?,'web'),('demo-visit','demo-out','synthetic',?,'web')"
    )
    .bind(Date.now(), Date.now())
    .run();
  const service = botService({
      DB: db,
      APP_ENV: "local",
      DEMO_AUTH_ENABLED: "true",
    }),
    actor = { telegramUserId: "100" };
  assert.ok((await service.demoLogin(actor, "demo-admin")).ok);
  for (const path of [
    "/dashboard/overview",
    "/sales-force?view=page",
    "/visits?view=page",
    "/stock-reports?view=page",
    "/supervisors",
    "/supervisor-assignments",
  ]) {
    const result = await service.business(actor, { path });
    assert.ok(result.ok, path);
    assert.doesNotMatch(
      JSON.stringify(result.data),
      /REAL PRIVATE|real-visit|real-admin|real-sup/
    );
  }
  assert.equal(
    (await service.business(actor, { path: "/visits/real-visit" })).ok,
    false
  );
  for (const [path, method] of [
    ["/admin/user-import/template", "GET"],
    ["/admin/user-import/preview", "POST"],
    ["/admin/user-import/commit", "POST"],
    ["/supervisor-assignments", "PUT"],
    ["/admin/sales-force/create", "POST"],
  ])
    assert.equal(
      (await service.business(actor, { path, method, body: {} })).ok,
      false
    );
  assert.equal(
    (await db.prepare("SELECT count(*) AS n FROM access_audit").first()).n,
    0
  );
  assert.equal(
    (await db.prepare("SELECT count(*) AS n FROM web_sessions").first()).n,
    0
  );
});
