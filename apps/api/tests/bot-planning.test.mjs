import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

async function bundle(path, banner = "") {
  return (
    await build({
      entryPoints: [fileURLToPath(new URL(path, import.meta.url))],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
      external: ["cloudflare:workers"],
      banner: { js: banner },
    })
  ).outputFiles[0].text;
}
const helpers = await import(
  "data:text/javascript;base64," +
    Buffer.from(await bundle("../../bot/src/planning/shared.ts")).toString(
      "base64"
    )
);
const {
  encodeToken: enc,
  decodeToken: dec,
  replyBlocks,
  planningResult,
} = helpers;

test("opaque tokens, safe message packing, and all sanitized result codes", async () => {
  for (const id of [
    "simple-01",
    " spaced ",
    " Outlet 日本😀 +/=~ ",
    "~reserved",
    "\uFEFFid",
    "a".repeat(256),
    "😀".repeat(128),
  ])
    assert.equal(dec(enc(id)), id);
  for (const token of [
    "~",
    "~Zg",
    "~Zh",
    "~wA",
    "~YQ==",
    "~IA",
    "~AA",
    "with space",
    "x".repeat(257),
    "~" + "A".repeat(1500),
  ])
    assert.throws(() => dec(token));
  const messages = [];
  const ctx = { reply: async (text) => messages.push(text) };
  await replyBlocks(ctx, ["x".repeat(4096), "y".repeat(4095), "z"]);
  assert.deepEqual(
    messages.map((s) => s.length),
    [4096, 4095, 1]
  );
  await assert.rejects(replyBlocks(ctx, ["x".repeat(4097)]));
  assert.doesNotMatch(
    helpers.nextPage("/outlets ", "x".repeat(257)),
    /Berikutnya:/
  );
  assert.match(helpers.nextPage("/outlets ", "x".repeat(257)), /batas operasi/);
  assert.ok(helpers.label("x".repeat(10000)).length <= 257);
  for (const code of [
    "invalid",
    "forbidden",
    "not_found",
    "referenced",
    "duplicate",
    "reference_not_found",
    "unavailable",
  ]) {
    assert.equal(
      await planningResult(ctx, async () => ({ ok: false, code })),
      undefined
    );
    assert.ok(messages.at(-1).length > 10);
  }
  await planningResult(ctx, async () => {
    throw new Error("sensitive SQL/token");
  });
  assert.match(messages.at(-1), /Koneksi ke API gagal/);
  assert.doesNotMatch(messages.join(""), /sensitive/);
});

test("Telegram planning commands through actual BotIdentity binding and disposable D1", async (t) => {
  const sent = [];
  let failSend = false;
  // Deterministic instant: Sunday UTC, already Monday in Jakarta. Test-only clock,
  // never a production environment override or authorization bypass.
  const clock = `const RealDate = Date; globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : ['2026-06-07T18:00:00Z'])); } static now() { return new RealDate('2026-06-07T18:00:00Z').getTime(); } };`;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "api",
          modules: true,
          compatibilityDate: "2026-11-02",
          script: await bundle("../src/worker.ts"),
          d1Databases: { DB: "bot-planning" },
        },
        {
          name: "bot",
          modules: true,
          compatibilityDate: "2026-11-02",
          script: await bundle("../../bot/src/index.ts", clock),
          bindings: {
            TELEGRAM_BOT_TOKEN: "123:synthetic",
            TELEGRAM_WEBHOOK_SECRET: "synthetic",
          },
          serviceBindings: {
            IDENTITY: { name: "api", entrypoint: "BotIdentity" },
          },
          outboundService: async (req) => {
            assert.equal(new URL(req.url).hostname, "api.telegram.org");
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
            assert.ok(req.url.endsWith("/sendMessage"));
            const body = await req.json();
            assert.equal(body.parse_mode, undefined);
            assert.ok(body.text.length <= 4096);
            sent.push(body);
            if (failSend)
              return Response.json(
                { ok: false, error_code: 403, description: "Forbidden" },
                { status: 403 }
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
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB", "api");
  const dir = new URL("../../../packages/db/migrations/", import.meta.url);
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .toSorted()) {
    const sql = readFileSync(new URL(file, dir), "utf8").replace(
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
  const sf = " SF 日本 + ";
  await db
    .prepare(
      "INSERT INTO sales_force (id, name) VALUES (?, 'SF sintetis'), ('other', 'RAHASIA SF LAIN')"
    )
    .bind(sf)
    .run();
  for (const [id, status, role, link] of [
    [1, "active", "admin", null],
    [2, "active", "supervisor", null],
    [3, "active", "sales_force", sf],
    [4, "disabled", "admin", null],
    [5, "pending", null, null],
    [6, "rejected", null, null],
  ]) {
    await db.batch([
      db
        .prepare(
          "INSERT INTO users (id, status, role, sales_force_id) VALUES (?, ?, ?, ?)"
        )
        .bind(`u${id}`, status, role, link),
      db
        .prepare(
          "INSERT INTO telegram_identities (user_id, telegram_user_id) VALUES (?, ?)"
        )
        .bind(`u${id}`, String(id)),
    ]);
  }
  // Monitoring regression fixture has an explicit assignment, never inferred from its code.
  await db
    .prepare(
      "INSERT INTO sales_force_supervisors (sales_force_id, supervisor_user_id) VALUES (?, 'u2')"
    )
    .bind(sf)
    .run();
  const bot = await mf.getWorker("bot");
  let update = 0;
  async function command(id, text, options = {}) {
    sent.length = 0;
    const response = await bot.fetch("https://bot/", {
      method: "POST",
      headers: {
        "X-Telegram-Bot-Api-Secret-Token": "synthetic",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        update_id: ++update,
        message: {
          message_id: update,
          date: 1,
          chat: {
            id: options.chatId ?? id,
            type: options.group ? "group" : "private",
          },
          from: { id, first_name: "Synthetic", is_bot: false },
          forward_origin: {
            type: "user",
            sender_user: { id: 1, is_bot: false, first_name: "Admin" },
            date: 1,
          },
          text,
          entities: [
            {
              type: "bot_command",
              offset: 0,
              length: text.split(" ")[0].length,
            },
          ],
        },
      }),
    });
    assert.equal(response.status, 200);
    return sent.map((m) => m.text).join("\n");
  }
  const count = async (table) =>
    (await db.prepare(`SELECT count(*) AS n FROM ${table}`).first()).n;

  await t.test(
    "roles, inactive users, private chats and spoofed identity",
    async () => {
      for (const id of [4, 5, 6, 999]) {
        assert.match(await command(id, "/outlet missing"), /Akses ditolak/);
        assert.match(await command(id, "/outlet absent"), /Akses ditolak/);
        assert.match(
          await command(id, `/jadwalsales ${enc(sf)}`),
          /Akses ditolak/
        );
      }
      assert.match(await command(1, "/outlet missing"), /tidak ditemukan/);
      assert.match(await command(2, "/outlet missing"), /tidak ditemukan/);
      assert.match(
        await command(2, "/tambahoutlet denied 001 Forbidden"),
        /Akses ditolak/
      );
      assert.match(
        await command(3, "/tambahoutlet spoof 001 Spoof", { chatId: 1 }),
        /Akses ditolak/
      );
      assert.match(
        await command(1, "/tambahoutlet group 001 Group", { group: true }),
        /chat pribadi/
      );
      assert.equal(await count("outlets"), 0);
      for (const id of [1, 2, 4, 5, 6, 999])
        assert.match(await command(id, "/jadwal"), /Akses ditolak/);
      assert.match(await command(3, "/jadwal"), /Tidak ada jadwal/);
      assert.match(await command(3, "/outlet missing"), /tidak ditemukan/);
      assert.match(await command(3, "/outlet absent"), /tidak ditemukan/);
      assert.match(
        await command(3, `/jadwalsales ${enc(sf)}`),
        /Akses ditolak/
      );
    }
  );
  await t.test("Outlet CRUD, opaque lookup and guarded delete", async () => {
    assert.match(
      await command(1, "/tambahoutlet 001 0002 Toko <b>& *sintetis*"),
      /berhasil dibuat/
    );
    assert.match(
      await command(1, "/tambahoutlet 001 0002 Duplicate"),
      /sudah ada/
    );
    assert.match(
      await command(1, "/tambahoutlet 002 0002 Toko <b>& *sintetis*"),
      /berhasil dibuat/
    );
    assert.equal(await count("outlets"), 2);
    const row = await db
      .prepare("SELECT id, business_id AS businessId FROM outlets LIMIT 1")
      .first();
    assert.match(
      await command(2, `/outlet ${row.businessId}`),
      /<b>& \*sintetis\*/
    );
    assert.match(
      await command(2, `/editoutlet ${row.businessId} 0003 Baru`),
      /Akses ditolak/
    );
    assert.match(
      await command(1, `/editoutlet ${row.businessId} 0003 Nama dengan spasi`),
      /Nama dengan spasi/
    );
    assert.match(
      await command(1, `/hapusoutlet ${row.businessId}`),
      /KONFIRMASI/
    );
    assert.match(
      await command(1, `/hapusoutlet ${row.businessId} ya`),
      /KONFIRMASI/
    );
    assert.match(
      await command(2, `/hapusoutlet ${row.businessId} KONFIRMASI`),
      /Akses ditolak/
    );
    assert.match(
      await command(1, `/hapusoutlet ${row.businessId} KONFIRMASI`),
      /berhasil dihapus/
    );
    assert.match(
      await command(1, `/outlet ${row.businessId}`),
      /tidak ditemukan/
    );
    await db
      .prepare(
        "INSERT INTO outlets (id, name, business_id) VALUES (?, ?, 'OUT001')"
      )
      .bind(" outlet 😀 + ", "Unicode Outlet")
      .run();
    assert.match(await command(2, "/outlet out001"), /Unicode Outlet/);
    for (const text of [
      "/outlet",
      "/outlet ~bad=",
      "/outlet a b",
      "/editoutlet simple",
      "/tambahoutlet",
      "/tambahoutlet " + "x".repeat(257),
    ])
      assert.match(await command(1, text), /Format|Parameter/);
  });
  await t.test(
    "weekly creation, Jakarta today, weekday parsing and monitoring filters",
    async () => {
      const create = `/tambahjadwal ${enc(sf)} ${enc(" outlet 😀 + ")} SeNiN`;
      for (const id of [2, 3, 4])
        assert.match(await command(id, create), /Akses ditolak/);
      assert.match(await command(1, create), /berhasil dibuat — senin/);
      assert.match(await command(1, create), /sudah ada/);
      assert.match(
        await command(1, "/tambahjadwal absent absent selasa"),
        /tidak ditemukan/
      );
      assert.match(
        await command(1, "/tambahjadwal other absent invalid"),
        /Format/
      );
      assert.match(
        await command(1, "/hapusoutlet OUT001 KONFIRMASI"),
        /masih dirujuk/
      );
      assert.match(await command(3, "/jadwal"), /JADWAL SAYA — senin/);
      assert.match(await command(3, "/jadwal"), /Unicode Outlet/);
      for (const day of ["selasa", "rabu", "kamis", "jumat", "sabtu", "minggu"])
        assert.match(await command(3, `/jadwal ${day}`), /Tidak ada jadwal/);
      for (const id of [1, 2]) {
        assert.match(
          await command(id, `/jadwalsales ${enc(sf)} senin`),
          /Unicode Outlet/
        );
        assert.match(
          await command(id, `/jadwalsales ${enc(sf)} selasa`),
          /Tidak ada jadwal/
        );
      }
      for (const text of [
        "/jadwal sf=other",
        "/jadwal semua sf=other",
        "/jadwal senin after=~invalid=",
        "/jadwalsales hari=senin hari=selasa",
        "/jadwalsales who=other",
      ])
        assert.match(await command(3, text), /Format/);
      assert.match(await command(3, "/help"), /\/jadwal/);
      assert.doesNotMatch(
        await command(3, "/help"),
        /\/jadwalsales|\/tambahoutlet/
      );
      assert.match(await command(2, "/help"), /\/jadwalsales/);
      assert.doesNotMatch(await command(2, "/help"), /\/tambahoutlet/);
      assert.match(await command(1, "/help"), /\/tambahjadwal/);
      assert.doesNotMatch(await command(4, "/help"), /\/outlets/);
    }
  );
  await t.test(
    "mandatory business code, optional case-insensitive weekday and rejected legacy filters",
    async () => {
      for (const by of [1, 2]) {
        assert.match(
          await command(by, "/jadwalsales"),
          /Format: \/jadwalsales kode_sf \[hari\]/
        );
        for (const query of [enc(sf), `${enc(sf)} SeNiN`])
          assert.match(
            await command(by, `/jadwalsales ${query}`),
            /Unicode Outlet/
          );
        assert.match(
          await command(by, `/jadwalsales ${enc(sf)} SELASA`),
          /Tidak ada jadwal/
        );
        for (const query of [
          "sf=other",
          "hari=senin",
          "3 hari=senin",
          "3 sf=other",
          "3 senin selasa",
          "3 senin after=x after=y",
        ])
          assert.match(await command(by, `/jadwalsales ${query}`), /Format/);
        assert.match(await command(by, "/jadwalsales 999"), /tidak ditemukan/);
        assert.match(await command(by, "/jadwalsales 3"), /tidak ditemukan/);
      }
      assert.match(
        await command(3, `/jadwalsales ${enc(sf)} senin`),
        /Akses ditolak/
      );
    }
  );
  await t.test(
    "multiple pages preserve exact cursors and filters without crossing own SF scope",
    async () => {
      const rows = [];
      for (let i = 0; i < 52; i++) {
        const id = ` page-${String(i).padStart(3, "0")} 日本 `;
        rows.push(
          db
            .prepare("INSERT INTO outlets (id, name) VALUES (?, ?)")
            .bind(id, "<unsafe>&" + "😀".repeat(120))
        );
        rows.push(
          db
            .prepare(
              "INSERT INTO visit_schedules (id, sales_force_id, outlet_id, weekday, created_at, updated_at) VALUES (?, ?, ?, 1, 1, 1)"
            )
            .bind(id, sf, id)
        );
      }
      rows.push(
        db
          .prepare(
            "INSERT INTO visit_schedules (id, sales_force_id, outlet_id, weekday, created_at, updated_at) VALUES (' other-private ', 'other', ?, 1, 1, 1)"
          )
          .bind(" outlet 😀 + ")
      );
      await db.batch(rows);
      let result, next;
      for (const [id, initial] of [
        [3, "/jadwal"],
        [2, `/jadwalsales ${enc(sf)} senin`],
        [2, `/jadwalsales ${enc(sf)} SeNiN`],
      ]) {
        result = await command(id, initial);
        assert.doesNotMatch(result, /RAHASIA SF LAIN/);
        next = result.match(/Berikutnya: (\/[^\n]+)/)[1];
        assert.match(
          next,
          id === 3 ? /\/jadwal senin after=/ : /\/jadwalsales \S+ senin after=/
        );
        result = await command(id, next);
        assert.doesNotMatch(result, /RAHASIA SF LAIN|Berikutnya/);
      }
      result = await command(
        3,
        `/jadwal semua after=${enc(" other-private ")}`
      );
      assert.doesNotMatch(result, /RAHASIA SF LAIN/);
    }
  );
  await t.test(
    "maximum Unicode IDs and legacy names remain bounded plain text",
    async () => {
      const longSf = "界".repeat(256);
      const longOutlet = "語".repeat(256);
      await db
        .prepare("INSERT INTO sales_force (id, name) VALUES (?, ?)")
        .bind(longSf, "<unsafe>".repeat(1000))
        .run();
      await db
        .prepare(
          "INSERT INTO outlets (id, name, business_id, no_rs) VALUES (?, ?, ?, ?)"
        )
        .bind(
          longOutlet,
          "😀".repeat(10000),
          "業".repeat(256),
          "参".repeat(256)
        )
        .run();
      assert.match(
        await command(
          1,
          `/tambahjadwal ${enc(longSf)} ${enc(longOutlet)} minggu`
        ),
        /berhasil dibuat/
      );
      await db
        .prepare(
          "INSERT INTO sales_force_supervisors (sales_force_id, supervisor_user_id) VALUES (?, 'u2')"
        )
        .bind(longSf)
        .run();
      const text = await command(2, `/jadwalsales ${enc(longSf)}`);
      assert.ok(text.includes(enc(longSf)) && text.includes(enc(longOutlet)));
      assert.ok(sent.length <= 2);
      assert.match(text, /…/);
    }
  );
  await t.test(
    "API unavailable, delivery failure acknowledgement and registration regression",
    async () => {
      failSend = true;
      await command(
        1,
        "/tambahoutlet delivery 0002 Delivery failed but committed"
      );
      failSend = false;
      assert.equal(
        (
          await db
            .prepare(
              "SELECT count(*) AS n FROM outlets WHERE name = 'Delivery failed but committed'"
            )
            .first()
        ).n,
        1
      );
      // Same users + telegram_identities architecture used by the Excel importer.
      await db
        .prepare(
          "INSERT INTO users(id,status,role,display_name) VALUES ('pre-registered','active','supervisor','Imported Name')"
        )
        .run();
      await db
        .prepare(
          "INSERT INTO telegram_identities(user_id,telegram_user_id) VALUES ('pre-registered','699')"
        )
        .run();
      const welcome = await command(699, "/start");
      assert.match(welcome, /aktif dengan role supervisor/);
      assert.doesNotMatch(welcome, /Gunakan \/register|menunggu persetujuan/);
      const importedProfile = await command(699, "/me");
      assert.match(importedProfile, /Synthetic/);
      assert.match(importedProfile, /Role: supervisor/);
      assert.match(
        await command(699, "/register"),
        /aktif dengan role supervisor/
      );
      assert.equal(
        (
          await db
            .prepare(
              "SELECT count(*) AS n FROM telegram_identities WHERE telegram_user_id = '699'"
            )
            .first()
        ).n,
        1
      );
      assert.match(await command(700, "/register"), /pending/);
      assert.match(await command(1, "/pending"), /700/);
      assert.match(
        await command(1, "/approve 700 supervisor"),
        /berhasil disetujui/
      );
      assert.match(await command(700, "/me"), /supervisor/);
      await command(701, "/register");
      assert.match(await command(1, "/reject 701"), /berhasil ditolak/);
      await db.prepare("DROP TABLE visit_schedules").run();
      assert.match(
        await command(3, "/jadwal semua"),
        /Layanan data belum tersedia/
      );
    }
  );
});
