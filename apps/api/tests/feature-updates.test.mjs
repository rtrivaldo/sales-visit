import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import * as XLSX from "@e965/xlsx";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

import { createApp } from "../src/index.ts";
const serviceBundle = await build({
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
    Buffer.from(serviceBundle.outputFiles[0].text).toString("base64")
);
import { importTemplate, parseImport } from "../src/user-import.ts";
import { hashToken, liveAccount } from "../src/web-auth.ts";

function buildWorkbook(
  rows,
  header = ["telegram_id", "nama", "role", "kode_sf"]
) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([header, ...rows]),
    "Pengguna"
  );
  return {
    filename: "users.xlsx",
    content: Buffer.from(
      XLSX.write(book, { type: "buffer", bookType: "xlsx" })
    ).toString("base64"),
  };
}
async function setup(t) {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      compatibilityDate: "2026-11-02",
      script: 'export default { fetch() { return new Response("fixture") } }',
      d1Databases: { DB: "feature-updates" },
    })
  );
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
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
  await db
    .prepare(
      "INSERT INTO sales_force(id,name) VALUES ('SF001','Budi Santoso'),('SF002','Siti Rahma'),('SF003','Rina'),('SF004','Budi Hartono')"
    )
    .run();
  await db
    .prepare(
      "INSERT INTO users(id,status,role,display_name) VALUES ('admin','active','admin','Admin'),('sup1','active','supervisor','Andi Pratama'),('sup2','active','supervisor','Dimas Putra'),('sup3','active','supervisor','Supervisor Kosong')"
    )
    .run();
  await db
    .prepare(
      "INSERT INTO telegram_identities(user_id,telegram_user_id) VALUES ('admin','100'),('sup1','200'),('sup2','300')"
    )
    .run();
  await db
    .prepare(
      "INSERT INTO sales_force_supervisors(sales_force_id,supervisor_user_id) VALUES ('SF001','sup1'),('SF002','sup1'),('SF004','sup2')"
    )
    .run();
  const token = "a".repeat(64),
    supervisor = "b".repeat(64);
  for (const [credential, user] of [
    [token, "admin"],
    [supervisor, "sup1"],
  ])
    await db
      .prepare(
        "INSERT INTO web_sessions(token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)"
      )
      .bind(await hashToken(credential), user, Date.now(), Date.now() + 3600000)
      .run();
  const env = { DB: db },
    app = createApp(),
    api = botService(env);
  const request = (path, body, credential = token) =>
    app.request(
      path,
      {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${credential}`,
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      env
    );
  const preview = (rows) =>
    request("/admin/user-import/preview", buildWorkbook(rows));
  const operation = async () =>
    (await (await request("/admin/users/operations/new")).json()).operationId;
  return { db, api, request, workbook: buildWorkbook, preview, operation };
}

test("Excel template is empty, text-formatted, documented; invalid formats and numeric identities are rejected", async (t) => {
  const { preview, workbook, request } = await setup(t);
  const template = XLSX.read(importTemplate(), {
    type: "array",
    cellStyles: true,
  });
  assert.deepEqual(template.SheetNames, ["Pengguna", "Petunjuk"]);
  assert.throws(() => parseImport(new Uint8Array(importTemplate())), /Isi/);
  assert.equal(template.Sheets.Pengguna.A2.z, "@");
  for (const rows of [
    [[123456789, "A", "admin", ""]],
    [["123", "", "admin", ""]],
    [["123", "A", "sales", ""]],
    [["123", "A", "sales_force", ""]],
    [["123", "A", "sales_force", "unknown"]],
    [["123", "A", "admin", "SF001"]],
  ]) {
    const result = await (await preview(rows)).json();
    assert.ok(result.invalid > 0);
  }
  const duplicate = await (
    await preview([
      ["500", "A", "admin", ""],
      ["500", "B", "admin", ""],
    ])
  ).json();
  assert.equal(duplicate.duplicates, 2);
  const duplicateSf = await (
    await preview([
      ["501", "A", "sales_force", "sf001"],
      ["502", "B", "sales_force", "SF001"],
    ])
  ).json();
  assert.equal(duplicateSf.duplicates, 2);
  const existing = await (await preview([["100", "A", "admin", ""]])).json();
  assert.equal(existing.invalid, 1);
  assert.equal(
    (
      await request(
        "/admin/user-import/preview",
        workbook([["600", "A", "admin", ""]], ["wrong"])
      )
    ).status,
    400
  );
  assert.equal(
    (
      await request(
        "/admin/user-import/preview",
        workbook([["600", "A", "admin", ""]]),
        "b".repeat(64)
      )
    ).status,
    403
  );
});

test("atomic pre-registration, explicit Admin confirmation, audit receipt replay, immediate Telegram/Web identity", async (t) => {
  const { db, api, request, workbook, operation } = await setup(t);
  const file = workbook([
    ["500", "Imported Admin", "admin", ""],
    ["501", "Imported SF", "sales_force", "sf001"],
    ["502", "Imported Supervisor", "supervisor", ""],
  ]);
  const operationId = await operation();
  const input = { ...file, operationId, confirm: true };
  assert.equal((await request("/admin/user-import/commit", input)).status, 400);
  assert.equal(
    (await db.prepare("SELECT count(*) AS n FROM users").first()).n,
    4
  );
  const result = await request("/admin/user-import/commit", {
    ...input,
    confirmAdmins: true,
  });
  assert.equal(result.status, 201, await result.clone().text());
  assert.equal((await result.json()).imported, 3);
  const repeated = await (
    await request("/admin/user-import/commit", {
      ...input,
      confirmAdmins: true,
    })
  ).json();
  assert.equal(repeated.replayed, true);
  assert.equal(
    (await db.prepare("SELECT count(*) AS n FROM access_audit").first()).n,
    3
  );
  assert.equal(
    (
      await db
        .prepare(
          "SELECT count(*) AS n FROM telegram_identities WHERE telegram_user_id IN ('500','501','502')"
        )
        .first()
    ).n,
    3
  );
  const importedIdentity = await db
    .prepare(
      "SELECT user_id AS id FROM telegram_identities WHERE telegram_user_id = '501'"
    )
    .first();
  const webAccount = await liveAccount(db, importedIdentity.id);
  assert.equal(webAccount.name, "Imported SF");
  assert.equal(webAccount.role, "sales_force");
  const me = await api.me({
    telegramUserId: "501",
    firstName: "Verified",
    username: "verified",
  });
  assert.ok(me.ok);
  assert.equal(me.data.status, "active");
  assert.equal(me.data.role, "sales_force");
  assert.equal(me.data.salesForceId, "SF001");
  assert.equal(me.data.firstName, "Verified");
  await api.me({ telegramUserId: "501", firstName: "Replacement" });
  assert.equal(
    (await api.me({ telegramUserId: "501" })).data.firstName,
    "Verified"
  );
  assert.ok(
    (
      await api.business(
        { telegramUserId: "501" },
        { path: "/visits?view=page" }
      )
    ).ok
  );
  assert.equal(
    (await api.register({ telegramUserId: "503" })).data.status,
    "pending"
  );
  const invalid = {
    ...workbook([
      ["504", "Valid", "supervisor", ""],
      ["505", "Invalid", "sales_force", "SF001"],
    ]),
    operationId: await operation(),
    confirm: true,
  };
  assert.equal(
    (await request("/admin/user-import/commit", invalid)).status,
    409
  );
  assert.equal(
    await db
      .prepare(
        "SELECT 1 FROM telegram_identities WHERE telegram_user_id = '504'"
      )
      .first(),
    null
  );
  assert.equal(
    (
      await api.business(
        { telegramUserId: "200" },
        { path: "/admin/user-import/template" }
      )
    ).ok,
    false
  );
});

test("concurrent imports cannot duplicate a Telegram identity or Sales Force claim", async (t) => {
  const { db, request, workbook, operation } = await setup(t);
  const firstId = await operation(),
    secondId = await operation();
  const file = workbook([["800", "Concurrent", "sales_force", "SF001"]]);
  const results = await Promise.all(
    [firstId, secondId].map((operationId) =>
      request("/admin/user-import/commit", {
        ...file,
        operationId,
        confirm: true,
      })
    )
  );
  assert.deepEqual(
    results.map((result) => result.status).toSorted(),
    [201, 409]
  );
  assert.equal(
    (
      await db
        .prepare(
          "SELECT count(*) AS n FROM telegram_identities WHERE telegram_user_id = '800'"
        )
        .first()
    ).n,
    1
  );
  assert.equal(
    (
      await db
        .prepare(
          "SELECT count(*) AS n FROM users WHERE sales_force_id = 'SF001'"
        )
        .first()
    ).n,
    1
  );
  assert.equal(
    (await db.prepare("SELECT count(*) AS n FROM access_audit").first()).n,
    1
  );
});

test("formulas, unsafe numeric identifiers, oversized files and reserved inactive accounts fail validation", async (t) => {
  const { db, request, workbook } = await setup(t);
  await db
    .prepare("UPDATE users SET status = 'disabled' WHERE id = 'sup1'")
    .run();
  await db
    .prepare(
      "INSERT INTO users(id,status,role,sales_force_id) VALUES ('reserved','disabled','sales_force','SF001')"
    )
    .run();
  for (const rows of [
    [[{ t: "s", v: "900", f: "1+1" }, "Formula", "admin", ""]],
    [[9007199254740992, "Rounded", "admin", ""]],
    [["200", "Disabled identity", "supervisor", ""]],
    [["901", "Reserved SF", "sales_force", "SF001"]],
  ]) {
    const response = await request(
      "/admin/user-import/preview",
      workbook(rows)
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).invalid, 1);
  }
  assert.equal(
    (
      await request("/admin/user-import/preview", {
        filename: "users.xls",
        content: "",
      })
    ).status,
    400
  );
  assert.equal(
    (
      await request("/admin/user-import/preview", {
        filename: "users.xlsx",
        content: "A".repeat(350001),
      })
    ).status,
    400
  );
});

test("failed audit rolls back all account and identity creation", async (t) => {
  const { db, request, workbook, operation } = await setup(t);
  await db.exec(
    "CREATE TRIGGER fail_import_audit BEFORE INSERT ON access_audit BEGIN SELECT RAISE(ABORT, 'fixture'); END;"
  );
  const result = await request("/admin/user-import/commit", {
    ...workbook([["700", "New", "supervisor", ""]]),
    operationId: await operation(),
    confirm: true,
  });
  assert.equal(result.status, 400);
  assert.equal(
    await db
      .prepare(
        "SELECT 1 FROM telegram_identities WHERE telegram_user_id = '700'"
      )
      .first(),
    null
  );
  assert.equal(
    await db.prepare("SELECT 1 FROM users WHERE display_name = 'New'").first(),
    null
  );
});

test("Supervisor-ID grouping, empty/unassigned teams and full-dataset normalized search", async (t) => {
  const { db, request } = await setup(t);
  const groups = async (q = "", after = "") =>
    await (
      await request(
        `/supervisor-assignment-groups?q=${encodeURIComponent(q)}&after=${encodeURIComponent(after)}`
      )
    ).json();
  let result = await groups();
  assert.equal(
    result.items.find((group) => group.supervisorUserId === null).members[0]
      .salesForceId,
    "SF003"
  );
  assert.equal(
    result.items.find((group) => group.supervisorUserId === "sup3").total,
    0
  );
  result = await groups("  aNdI  ");
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].members.length, 2);
  result = await groups("bUdI");
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].members.length, 1);
  assert.equal(result.items[1].members.length, 1);
  assert.equal((await groups("not found")).items.length, 0);
  // More than a full legacy page, and a second group with exactly the same name.
  await db
    .prepare("UPDATE users SET display_name = 'Andi Pratama' WHERE id = 'sup2'")
    .run();
  await db.batch(
    Array.from({ length: 105 }, (_, i) =>
      db
        .prepare("INSERT INTO sales_force(id,name) VALUES (?,?)")
        .bind(
          `ZZ${i.toString().padStart(3, "0")}`,
          i === 104 ? "Needle SF" : "Other"
        )
    )
  );
  await db
    .prepare(
      "INSERT INTO sales_force_supervisors(sales_force_id,supervisor_user_id) SELECT id,'sup1' FROM sales_force WHERE id LIKE 'ZZ%'"
    )
    .run();
  result = await groups("Needle");
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].members[0].salesForceName, "Needle SF");
  result = await groups("Andi");
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].total, 107);
  assert.equal(result.items[0].members.length, 100);
  assert.ok(result.items[0].next);
  const members = await (
    await request(
      `/supervisor-assignments?group=sup1&q=Andi&after=${encodeURIComponent(result.items[0].next)}&limit=100`
    )
  ).json();
  assert.equal(members.items.length, 7);
});

test("business RPC reuses Web role guards, assignment audit and protected master rules", async (t) => {
  const { db, api } = await setup(t);
  const actor = { telegramUserId: "100" },
    sup = { telegramUserId: "200" };
  for (const path of [
    "/dashboard/overview",
    "/sales-force?view=page",
    "/visits?view=page",
    "/stock-reports?view=page",
    "/supervisors",
    "/supervisor-assignments",
  ])
    assert.ok((await api.business(actor, { path })).ok, path);
  const team = await api.business(sup, { path: "/sales-force?view=page" });
  assert.equal(team.data.total, 2);
  assert.equal(
    (await api.business(sup, { path: "/sales-force/SF004" })).ok,
    false
  );
  assert.equal(
    (await api.business(sup, { path: "/supervisor-assignments" })).ok,
    false
  );
  assert.equal(
    (
      await api.business(actor, {
        path: "/auth/demo/login",
        method: "POST",
        body: {},
      })
    ).ok,
    false
  );
  const changed = await api.business(actor, {
    path: "/supervisor-assignments",
    method: "PUT",
    body: { salesForceId: "SF001", supervisorUserId: "sup2" },
  });
  assert.ok(changed.ok);
  assert.equal(
    (
      await db
        .prepare("SELECT count(*) AS n FROM supervisor_assignment_audit")
        .first()
    ).n,
    1
  );
  const newTeam = await api.business(sup, { path: "/sales-force?view=page" });
  assert.equal(newTeam.data.total, 1);
  // No private adapter credentials remain after either success or rejection.
  assert.equal(
    (await db.prepare("SELECT count(*) AS n FROM web_sessions").first()).n,
    2
  );
});

test("case-insensitive outlet and SF code lookups preserve strings and reject collisions and out-of-team records", async (t) => {
  const { db, api } = await setup(t);
  await db
    .prepare(
      "INSERT INTO outlets(id,name,business_id) VALUES ('internal','Outlet','OUT001')"
    )
    .run();
  for (const code of ["OUT001", "out001", "Out001"]) {
    const result = await api.getOutlet(
      { telegramUserId: "100" },
      { businessId: code }
    );
    assert.ok(result.ok);
    assert.equal(result.data.businessId, "OUT001");
  }
  assert.equal(
    (await api.getOutlet({ telegramUserId: "100" }, { businessId: "internal" }))
      .code,
    "not_found"
  );
  await db
    .prepare(
      "INSERT INTO outlets(id,name,business_id) VALUES ('other','Collision','out001')"
    )
    .run();
  assert.equal(
    (await api.getOutlet({ telegramUserId: "100" }, { businessId: "OUT001" }))
      .code,
    "ambiguous"
  );
  assert.ok(
    (
      await api.listSchedules(
        { telegramUserId: "100" },
        { salesForceCode: "sf001" }
      )
    ).ok
  );
  assert.equal(
    (
      await api.listSchedules(
        { telegramUserId: "200" },
        { salesForceCode: "SF004" }
      )
    ).code,
    "reference_not_found"
  );
  await db
    .prepare("INSERT INTO sales_force(id,name) VALUES ('sf001','Collision')")
    .run();
  assert.equal(
    (
      await api.listSchedules(
        { telegramUserId: "100" },
        { salesForceCode: "SF001" }
      )
    ).code,
    "ambiguous"
  );
});
