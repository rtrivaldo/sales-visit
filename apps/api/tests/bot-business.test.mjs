import assert from "node:assert/strict";
import { test } from "node:test";

import { businessCommands } from "../../bot/src/business/commands.ts";

test("all new business commands map to shared API contracts, retain filters and require mutation confirmation", async () => {
  const commands = new Map(),
    calls = [],
    messages = [];
  const api = {
    me: async () => ({ ok: true, data: null }),
    demoStatus: async () => ({ ok: false, code: "disabled" }),
    business: async (actor, input) => {
      calls.push({ actor, ...input });
      const path = new URL(input.path, "http://internal");
      const data = path.pathname.endsWith("operations/new")
        ? {
            operationId:
              "web:9999999999999:00000000-0000-4000-8000-000000000000",
          }
        : path.pathname === "/dashboard/overview"
          ? {
              metrics: {
                visits: 1,
                outlets: 1,
                salesForce: 1,
                stockReports: 0,
              },
              dailyVisits: [{ date: "2026-06-12", count: 1 }],
              channels: [{ channel: "web", count: 1 }],
              recentVisits: [],
            }
          : path.pathname === "/sales-force/SF001"
            ? { id: "SF001", name: "Budi" }
            : path.pathname === "/visits/V001"
              ? {
                  id: "V001",
                  outletId: "O001",
                  salesForceId: "SF001",
                  visitedAt: "2026-06-12",
                  submissionChannel: "web",
                  stockReports: [],
                }
              : path.pathname === "/stock-reports"
                ? {
                    items: [
                      {
                        id: "S001",
                        outletId: "O001",
                        reporterSalesForceId: "SF001",
                        reportedAt: "2026-06-12",
                        items: [
                          {
                            productId: "P001",
                            quantity: 3,
                            product: { id: "P001", name: "Perdana" },
                          },
                        ],
                      },
                    ],
                    total: 1,
                  }
                : path.pathname === "/supervisors"
                  ? { items: [{ id: "U001", name: "Andi" }], next: "U001" }
                  : path.pathname === "/supervisor-assignments" &&
                      input.method === "GET"
                    ? {
                        items: [
                          {
                            salesForceId: "SF001",
                            salesForceName: "Budi",
                            supervisorUserId: "U001",
                            supervisorName: "Andi",
                          },
                        ],
                        next: "SF001",
                      }
                    : path.pathname === "/sales-force" ||
                        path.pathname === "/outlets" ||
                        path.pathname === "/visits"
                      ? { items: [], total: 30 }
                      : { id: "new" };
      return { ok: true, data };
    },
  };
  businessCommands(
    {
      command: (name, handler) => commands.set(name, handler),
      on() {},
      token: "fixture",
    },
    api
  );
  const run = async (command, match = "") => {
    messages.length = 0;
    await commands.get(command)({
      match,
      from: { id: 100, first_name: "Verified", username: "verified" },
      reply: async (text) => messages.push(text),
    });
    return messages.join("\n");
  };
  for (const [name, match] of [
    ["dashboard", ""],
    ["salesforce", "q=Budi offset=10"],
    ["carioutlet", "q=OUT001"],
    ["detailsalesforce", "SF001"],
    [
      "riwayatvisit",
      "salesForceId=SF001 date=2026-06-12 channel=web stock=without",
    ],
    ["detailvisit", "V001"],
    ["stockreport", "salesForceId=SF001"],
    ["supervisors", ""],
    ["penugasan", "q=Andi"],
  ])
    assert.ok((await run(name, match)).length, name);
  assert.ok(calls.every(({ actor }) => actor.telegramUserId === "100"));
  assert.match(
    await run("riwayatvisit", "channel=web date=2026-06-12 offset=10"),
    /channel=web date=2026-06-12 offset=20/
  );
  assert.match(await run("stockreport", ""), /Perdana: 3/);
  assert.match(await run("penugasan", "q=Andi"), /q=Andi after=SF001/);
  for (const [command, args] of [
    ["tambahsalesforce", "SF001 Budi"],
    ["editsalesforce", "SF001 Baru"],
    ["hapussalesforce", "SF001"],
    ["assignsupervisor", "SF001 U001"],
    ["unassignsupervisor", "SF001"],
    ["tambahakundemo", "admin Demo"],
  ]) {
    const before = calls.length;
    assert.match(await run(command, args), /Format/);
    assert.equal(calls.length, before);
    assert.ok((await run(command, args + " KONFIRMASI")).length);
  }
  const renamed = calls.find(
    (call) => call.path === "/admin/sales-force/rename"
  );
  assert.equal(renamed.body.expectedName, "Budi");
  const assigned = calls.find(
    (call) => call.path === "/supervisor-assignments" && call.method === "PUT"
  );
  assert.equal(assigned.body.supervisorUserId, "U001");
  const demo = calls.find((call) => call.path === "/admin/users/demo");
  assert.equal(demo.body.displayName, "Demo");
});
