import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { visitQuestions } from "@sales-visit/contracts";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

import { visitReport } from "../../../packages/contracts/tests/visit-fixture.mjs";
import { createApp } from "../src/index.ts";
import { submissionId } from "../src/operations.ts";
import { hashToken } from "../src/web-auth.ts";

async function bundle(path) {
  return (
    await build({
      entryPoints: [fileURLToPath(new URL(path, import.meta.url))],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
      external: ["cloudflare:workers"],
    })
  ).outputFiles[0].text;
}
const apiScript = await bundle("../src/worker.ts"),
  botScript = await bundle("../../bot/src/index.ts"),
  guardScript = await bundle("./visit-guard-worker.ts");

test("new Visit workflow: real webhook/RPC, durable D1, Web parity and Stock Report regression", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "visit-report-"));
  let mf,
    failedDelivery = false;
  const sent = [];
  async function boot() {
    mf = new Miniflare(
      convertV4MiniflareOptions({
        resourcePersistencePath: dir,
        workers: [
          {
            name: "api",
            modules: true,
            compatibilityDate: "2026-11-02",
            script: apiScript,
            d1Databases: { DB: "visit-report" },
          },
          {
            name: "guard",
            modules: true,
            compatibilityDate: "2026-11-02",
            script: guardScript,
            d1Databases: { DB: "visit-report" },
          },
          {
            name: "caller",
            modules: true,
            compatibilityDate: "2026-11-02",
            script: `export default { async fetch(r,e) { const {actor,input}=await r.json(); return Response.json(await e.IDENTITY.visitWizard(actor,input)); } }`,
            serviceBindings: {
              IDENTITY: { name: "api", entrypoint: "BotIdentity" },
            },
          },
          {
            name: "bot",
            modules: true,
            compatibilityDate: "2026-11-02",
            script: botScript,
            bindings: {
              TELEGRAM_BOT_TOKEN: "123:synthetic",
              TELEGRAM_WEBHOOK_SECRET: "synthetic",
            },
            serviceBindings: {
              IDENTITY: { name: "api", entrypoint: "BotIdentity" },
            },
            outboundService: async (req) => {
              if (req.url.endsWith("/getMe"))
                return Response.json({
                  ok: true,
                  result: {
                    id: 123,
                    is_bot: true,
                    first_name: "Test",
                    username: "test_bot",
                  },
                });
              const body = await req.json();
              assert.ok(body.text.length <= 4096);
              sent.push(body.text);
              if (failedDelivery)
                return Response.json(
                  { ok: false, error_code: 500, description: "synthetic" },
                  { status: 500 }
                );
              return Response.json({
                ok: true,
                result: {
                  message_id: sent.length,
                  date: 1,
                  chat: { id: body.chat_id, type: "private" },
                  text: body.text,
                },
              });
            },
          },
        ],
      })
    );
  }
  await boot();
  t.after(async () => {
    await mf?.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  let db = await mf.getD1Database("DB", "api");
  const migrations = new URL(
    "../../../packages/db/migrations/",
    import.meta.url
  );
  for (const file of readdirSync(migrations)
    .filter((f) => f.endsWith(".sql"))
    .toSorted()) {
    const sql = readFileSync(new URL(file, migrations), "utf8").replace(
      /^\s*--.*$/gm,
      ""
    );
    await db.batch(
      sql
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => db.prepare(s))
    );
  }
  await db.exec(
    "INSERT INTO sales_force(id,name) VALUES ('sf','SF'),('other','Other'); INSERT INTO outlets(id,name,business_id) VALUES ('opaque','ASDA CELL','000aBc'),('second','Other','002'); INSERT INTO products(id,name) VALUES ('p','Product');"
  );
  for (const [id, role, status, sf] of [
    [1, "admin", "active", null],
    [2, "supervisor", "active", null],
    [3, "sales_force", "active", "sf"],
    [4, null, "pending", null],
    [5, "sales_force", "disabled", null],
    [8, "sales_force", "active", "other"],
  ]) {
    await db.batch([
      db
        .prepare(
          "INSERT INTO users(id,role,status,sales_force_id) VALUES (?,?,?,?)"
        )
        .bind(`u${id}`, role, status, sf),
      db
        .prepare(
          "INSERT INTO telegram_identities(user_id,telegram_user_id) VALUES (?,?)"
        )
        .bind(`u${id}`, String(id)),
    ]);
  }
  let seq = 0;
  const update = (id, text) => {
    const n = ++seq;
    return {
      update_id: n,
      message: {
        message_id: n,
        date: 1,
        chat: { id, type: "private" },
        from: { id, is_bot: false, first_name: "Test" },
        text,
        ...(text.startsWith("/")
          ? {
              entities: [
                {
                  type: "bot_command",
                  offset: 0,
                  length: text.split(" ")[0].length,
                },
              ],
            }
          : {}),
      },
    };
  };
  async function deliver(body) {
    return (await mf.getWorker("bot")).fetch("https://bot/", {
      method: "POST",
      headers: {
        "X-Telegram-Bot-Api-Secret-Token": "synthetic",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }
  async function command(id, text) {
    sent.length = 0;
    assert.equal((await deliver(update(id, text))).status, 200, text);
    return sent.join("\n");
  }
  async function rpc(id, input) {
    return (
      await (
        await mf.getWorker("caller")
      ).fetch("https://rpc/", {
        method: "POST",
        body: JSON.stringify({
          actor: { telegramUserId: String(id) },
          input: { messageId: ++seq, ...input },
        }),
      })
    ).json();
  }
  const draft = () =>
    db
      .prepare("SELECT * FROM telegram_visit_drafts WHERE user_id='u3'")
      .first();
  const count = async () =>
    (await db.prepare("SELECT count(*) AS n FROM visits").first()).n;
  async function review() {
    await command(3, "/salesvisit");
    await command(3, "000ABC");
    for (const [key] of visitQuestions)
      await command(
        3,
        typeof visitReport[key] === "boolean"
          ? visitReport[key]
            ? "Ya"
            : "Tidak"
          : String(visitReport[key])
      );
    assert.equal((await draft()).step, "review");
  }
  await t.test(
    "authorization, unknown outlet, case-insensitive business ID and explicit choices",
    async () => {
      for (const id of [1, 2, 4, 5, 99])
        assert.equal((await rpc(id, { action: "start" })).ok, false);
      await command(3, "ordinary text");
      assert.equal(await draft(), null);
      assert.match(await command(3, "/salesvisit"), /Masukkan ID Outlet/);
      for (const id of ["missing", "opaque"])
        assert.match(await command(3, id), /tidak ditemukan/);
      assert.match(
        await command(3, "000ABC"),
        /ID Outlet: 000aBc[\s\S]*ASDA CELL[\s\S]*Minggu ke-4/
      );
      assert.equal(JSON.parse((await draft()).payload).outletId, "opaque");
      for (const value of ["0", "5", "1.5", "abc"])
        assert.match(await command(3, value), /tidak valid/);
      await command(3, "4");
      await command(3, "Rp. 1.000.000");
      for (const value of ["-1", "1.5", "1e6", "9007199254740992"])
        assert.match(await command(3, value), /tidak valid/);
      assert.equal(JSON.parse((await draft()).payload).digiposBalance, 1000000);
      const zero = update(3, "0");
      await deliver(zero);
      await deliver(zero);
      assert.equal(JSON.parse((await draft()).payload).perdanaSaStock, 0);
      assert.equal(
        JSON.parse((await draft()).payload).perdanaSaSelling,
        undefined
      );
      const key = (await draft()).submission_key;
      await mf.dispose();
      await boot();
      db = await mf.getD1Database("DB", "api");
      assert.equal((await draft()).submission_key, key);
      assert.match(await command(3, "/salesvisit"), /Perdana SA — Selling/);
      assert.equal(await count(), 0);
      await command(3, "/batal");
      assert.equal((await draft()).step, "cancelled");
    }
  );
  await t.test(
    "review before saving; transport failure, restart, duplicate confirmations and receipt recovery",
    async () => {
      await review();
      assert.equal(await count(), 0);
      assert.match(await command(3, "maybe"), /Ketik Y/);
      const confirmation = update(3, "Y");
      failedDelivery = true;
      assert.equal((await deliver(confirmation)).status, 500);
      failedDelivery = false;
      assert.equal(await count(), 1);
      await mf.dispose();
      await boot();
      db = await mf.getD1Database("DB", "api");
      await deliver(confirmation);
      assert.match(await command(3, "/konfirmasi"), /berhasil disimpan/);
      assert.equal(await count(), 1);
      const row = await db.prepare("SELECT * FROM visits").first();
      assert.equal(row.is_cvm_active, 0);
      assert.equal(row.perdana_sa_stock, 0);
      assert.equal(row.digipos_balance, 1000000);
      assert.equal(row.reporting_week, 1);
      assert.ok(row.reporting_month >= 1 && row.reporting_month <= 12);
    }
  );
  await t.test(
    "N cancellation, expiry, legacy review recovery and transactional guard",
    async () => {
      await review();
      await command(3, "N");
      assert.equal((await draft()).step, "cancelled");
      assert.equal(await count(), 1);
      await command(3, "/salesvisit");
      await db
        .prepare(
          "UPDATE telegram_visit_drafts SET expires_at=0 WHERE user_id='u3'"
        )
        .run();
      await command(3, "000abc");
      assert.equal((await draft()).step, "expired");
      await review();
      const payload = JSON.parse((await draft()).payload);
      delete payload.reportingWeek;
      await db
        .prepare(
          "UPDATE telegram_visit_drafts SET payload=? WHERE user_id='u3'"
        )
        .bind(JSON.stringify(payload))
        .run();
      await command(3, "/konfirmasi");
      assert.equal((await draft()).step, "notes");
      await command(3, "1");
      assert.equal((await draft()).step, "review");
      await db
        .prepare(
          "UPDATE telegram_visit_drafts SET step='submitting' WHERE user_id='u3'"
        )
        .run();
      assert.equal(
        (await (await mf.getWorker("guard")).fetch("https://guard/")).status,
        401
      );
      assert.equal(await count(), 1);
      await db.prepare("UPDATE users SET status='active' WHERE id='u3'").run();
      await command(3, "/batal");
    }
  );
  await t.test(
    "Web submission uses same records, idempotency, scopes and safe historical reads",
    async () => {
      const token = "a".repeat(64);
      await db
        .prepare(
          "INSERT INTO web_sessions(token_hash,user_id,created_at,expires_at) VALUES (?,'u3',?,?)"
        )
        .bind(await hashToken(token), Date.now(), Date.now() + 60000)
        .run();
      const app = createApp(),
        env = { DB: db },
        headers = {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        };
      const data = {
        ...visitReport,
        outletId: "opaque",
        visitedAt: "2026-11-30T18:00:00Z",
        stockReport: {
          reportedAt: "2026-11-30T18:00:00Z",
          items: [{ productId: "p", quantity: 0 }],
        },
      };
      const post = (body = data) =>
        app.request(
          "/visits",
          { method: "POST", headers, body: JSON.stringify(body) },
          env
        );
      const response = await post();
      assert.equal(response.status, 201);
      const saved = await response.json();
      assert.equal(saved.reportingMonth, 12);
      assert.equal(saved.reportingYear, 2026);
      assert.equal(saved.stockReports.length, 1);
      assert.equal(saved.stockReports[0].items[0].quantity, 0);
      assert.match(
        await command(3, `/detailvisit ${saved.id}`),
        /Saldo Digipos: Rp 1.000.000/
      );
      assert.match(
        await command(8, `/detailvisit ${saved.id}`),
        /tidak ditemukan/
      );
      assert.match(
        await command(3, `/detailstok ${saved.stockReports[0].id}`),
        /LAPORAN STOK/
      );
      assert.match(
        await command(8, `/detailstok ${saved.stockReports[0].id}`),
        /tidak ditemukan/
      );
      assert.match(await command(3, "/outlet"), /Format: \/outlet/);
      assert.match(await command(3, "/outlet 000ABC"), /ASDA CELL/);
      assert.match(await command(3, "/outlet missing"), /tidak ditemukan/);
      assert.equal((await post()).status, 200);
      assert.equal((await post({ ...data, totalPurchase: 2 })).status, 409);
      assert.equal(
        (await post({ ...data, isCvmActive: undefined })).status,
        400
      );
      const detail = await app.request(
        `/visits/${saved.id}?include=references`,
        { headers },
        env
      );
      assert.equal((await detail.json()).digiposBalance, 1000000);
      await db
        .prepare(
          "INSERT INTO visits(id,outlet_id,sales_force_id,visited_at,submission_channel) VALUES ('legacy','opaque','sf',1,'web')"
        )
        .run();
      const historical = await (
        await app.request("/visits/legacy", { headers }, env)
      ).json();
      assert.equal(historical.digiposBalance, undefined);
      const filtered = await (
        await app.request(
          "/visits?view=page&reportingWeek=1&reportingMonth=12&reportingYear=2026",
          { headers },
          env
        )
      ).json();
      assert.deepEqual(
        filtered.items.map((item) => item.id),
        [saved.id]
      );
      assert.equal(
        (await app.request("/visits?reportingWeek=5", { headers }, env)).status,
        400
      );
      await db
        .prepare("UPDATE users SET status='disabled' WHERE id='u3'")
        .run();
      assert.equal((await post()).status, 401);
      await db.prepare("UPDATE users SET status='active' WHERE id='u3'").run();
    }
  );
  await t.test(
    "independent and linked stock submissions/history/detail remain unchanged",
    async () => {
      const app = createApp(async () => ({
        salesForceId: "sf",
        submissionChannel: "web",
      }));
      for (const visitId of [undefined, "legacy"]) {
        const response = await app.request(
          "/stock-reports",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": crypto.randomUUID(),
            },
            body: JSON.stringify({
              outletId: "opaque",
              visitId,
              reportedAt: new Date().toISOString(),
              items: [{ productId: "p", quantity: 0 }],
            }),
          },
          { DB: db }
        );
        assert.equal(response.status, 201);
        const saved = await response.json();
        assert.equal(saved.items[0].quantity, 0);
        const token = "a".repeat(64),
          headers = { Authorization: `Bearer ${token}` };
        const detail = await createApp().request(
          `/stock-reports/${saved.id}`,
          { headers },
          { DB: db }
        );
        assert.equal(detail.status, 200);
        assert.equal((await detail.json()).id, saved.id);
        assert.equal(
          (
            await createApp().request(
              "/stock-reports?view=page&limit=10",
              { headers },
              { DB: db }
            )
          ).status,
          200
        );
      }
    }
  );
  await t.test(
    "failed receipt finalization, concurrent confirmation and legacy committed receipt recovery",
    async () => {
      await review();
      const before = await count();
      await db.exec(
        "CREATE TRIGGER fail_receipt BEFORE UPDATE OF step ON telegram_visit_drafts WHEN NEW.step='submitted' BEGIN SELECT RAISE(ABORT,'synthetic'); END;"
      );
      assert.equal((await deliver(update(3, "Y"))).status, 500);
      assert.equal(await count(), before + 1);
      assert.equal((await draft()).step, "submitting");
      await db.exec("DROP TRIGGER fail_receipt");
      await mf.dispose();
      await boot();
      db = await mf.getD1Database("DB", "api");
      await Promise.all([
        deliver(update(3, "/konfirmasi")),
        deliver(update(3, "/konfirmasi")),
      ]);
      assert.equal(await count(), before + 1);
      assert.equal((await draft()).step, "submitted");
      await review();
      const row = await draft();
      const payload = JSON.parse(row.payload);
      const id = await submissionId(
        { salesForceId: "sf", submissionChannel: "telegram" },
        row.submission_key,
        "visit"
      );
      await db
        .prepare(
          "INSERT INTO visits(id,outlet_id,sales_force_id,visited_at,submission_channel) VALUES (?,'opaque','sf',1,'telegram')"
        )
        .bind(id)
        .run();
      for (const [field] of visitQuestions) delete payload[field];
      await db
        .prepare(
          "UPDATE telegram_visit_drafts SET step='submitting',payload=? WHERE user_id='u3'"
        )
        .bind(JSON.stringify(payload))
        .run();
      assert.match(await command(3, "/konfirmasi"), /berhasil disimpan/);
      assert.equal((await draft()).visit_id, id);
      assert.equal(
        (
          await db
            .prepare("SELECT digipos_balance FROM visits WHERE id=?")
            .bind(id)
            .first()
        ).digipos_balance,
        null
      );
    }
  );
});
