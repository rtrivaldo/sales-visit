import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { helpSections } from "../../bot/src/registration/help.ts";
const bundle = await build({
  entryPoints: [
    fileURLToPath(new URL("../../bot/src/commands.ts", import.meta.url)),
  ],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
});
const { installCommands } = await import(
  "data:text/javascript;base64," +
    Buffer.from(bundle.outputFiles[0].text).toString("base64")
);
const handlers = new Set();
installCommands(
  {
    use() {},
    on() {},
    command(name) {
      handlers.add(name);
    },
  },
  {}
);
const general = ["start", "help", "me"];
const monitor = [
  "jadwalsales",
  "outlets",
  "outlet",
  "carioutlet",
  "dashboard",
  "salesforce",
  "detailsalesforce",
];
const reports = ["riwayatvisit", "detailvisit", "stockreport", "produk"];
const assignments = ["supervisors", "penugasan"];
const writes = [
  "pending",
  "users",
  "approve",
  "reject",
  "setrole",
  "disable",
  "enable",
  "templatepengguna",
  "importpengguna",
  "tambahoutlet",
  "editoutlet",
  "hapusoutlet",
  "editoutletinternal",
  "hapusoutletinternal",
  "tambahjadwal",
  "tambahsalesforce",
  "editsalesforce",
  "hapussalesforce",
  "assignsupervisor",
  "unassignsupervisor",
];
const visit = ["salesvisit", "konfirmasi", "batal"];
const demoCommands = ["demo", "demo_login", "demo_status", "demo_logout"];
const account = (role, status = "active") => ({
  id: "u",
  telegramUserId: "900",
  role,
  status,
  salesForceId: role === "sales_force" ? "sf" : null,
  username: null,
  firstName: "Test",
  lastName: null,
  createdAt: 1,
});
function check(profile, demo, expected) {
  const sections = helpSections(profile, demo),
    text = sections.join("\n\n");
  assert.ok(text.length > 0 && text.length < 4096);
  assert.match(text, /^👤 Umum\n/);
  const commands = [...text.matchAll(/^\/(\w+)(?: [^—\n]+)? — .+$/gm)].map(
    (match) => match[1]
  );
  assert.deepEqual(commands.toSorted(), expected.toSorted());
  for (const name of commands) assert.ok(handlers.has(name), name);
  assert.doesNotMatch(
    text,
    /^\/outletinternal —|Notasi|default:|Alternatif:|Format:|Contoh:|APP_ENV|DEMO_AUTH_ENABLED|hari=|after=|TELEGRAM_ID|KURSOR/
  );
}
test("minimal help lists only registered handlers authorized for each effective role/status", () => {
  assert.ok(!handlers.has("outletinternal"));
  assert.ok(handlers.has("editoutletinternal"));
  assert.ok(handlers.has("hapusoutletinternal"));
  check(null, undefined, [...general, "register"]);
  for (const status of ["pending", "disabled", "rejected"])
    check(account("admin", status), undefined, general);
  check(account("admin"), undefined, [
    ...general,
    ...monitor,
    ...reports,
    ...assignments,
    ...writes,
  ]);
  check(account("supervisor"), undefined, [...general, ...monitor, ...reports]);
  check(account("sales_force"), undefined, [
    ...general,
    "jadwal",
    "outlets",
    "carioutlet",
    "outlet",
    ...reports,
    ...visit,
  ]);
});
test("Demo role overrides real Admin and hides every write", () => {
  check(account("admin"), { ok: true, data: null }, [
    ...general,
    ...monitor,
    ...reports,
    ...assignments,
    ...writes,
    ...demoCommands,
    "tambahakundemo",
  ]);
  for (const role of ["admin", "supervisor", "sales_force"]) {
    const selected = {
      ok: true,
      data: {
        account: { id: "selected", name: "Demo", role, salesForceId: "sf" },
        expiresAt: Date.now() + 3600000,
      },
    };
    const expected = [
      ...general,
      ...demoCommands,
      ...reports,
      ...(role === "sales_force"
        ? ["jadwal", "outlets", "carioutlet", "outlet"]
        : monitor),
      ...(role === "admin" ? assignments : []),
    ];
    check(account("admin"), selected, expected);
    check(null, selected, expected);
  }
  check(account("admin"), { ok: false, code: "expired" }, [
    ...general,
    ...demoCommands,
  ]);
});
