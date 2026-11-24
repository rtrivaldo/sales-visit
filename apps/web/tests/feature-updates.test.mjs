import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { Window } from "happy-dom";
const window = new Window({ url: "http://localhost" });
for (const key of [
  "window",
  "document",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "MouseEvent",
  "MutationObserver",
  "ResizeObserver",
  "File",
  "FileReader",
  "Blob",
  "HTMLInputElement",
])
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value:
      key === "window"
        ? window
        : key === "document"
          ? window.document
          : window[key],
  });
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const require = createRequire(import.meta.url);
const state = {
  api: async () => {
    throw new Error("missing fixture");
  },
  invalidations: 0,
};
globalThis.browserFixture = state;
async function component(path, exported) {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL(path, import.meta.url))],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    jsx: "automatic",
    external: ["react", "react/*", "react-dom", "react-dom/*"],
    tsconfig: fileURLToPath(new URL("../tsconfig.app.json", import.meta.url)),
    plugins: [
      {
        name: "test-boundaries",
        setup(builder) {
          builder.onResolve({ filter: /^@\/features\/auth\/session$/ }, () => ({
            path: "session",
            namespace: "fixture",
          }));
          builder.onResolve({ filter: /^@tanstack\/react-router$/ }, () => ({
            path: "router",
            namespace: "fixture",
          }));
          builder.onLoad(
            { filter: /.*/, namespace: "fixture" },
            ({ path: fixture }) => ({
              contents:
                fixture === "session"
                  ? "export const useAccount = () => ({role:'admin'}); export const api = (...args) => globalThis.browserFixture.api(...args); export class ApiError extends Error {}"
                  : "import {createElement} from 'react'; export const Link = ({children,...props}) => createElement('a',props,children); export const useRouter = () => ({invalidate: async () => {globalThis.browserFixture.invalidations++}});",
              loader: "js",
            })
          );
        },
      },
    ],
  });
  const module = { exports: {} };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(
    require,
    module,
    module.exports
  );
  return module.exports[exported];
}
const AssignmentsPage = await component(
  "../src/features/supervisor-assignments/pages/assignments-page.tsx",
  "AssignmentsPage"
);
const ImportUsersDialog = await component(
  "../src/features/user-management/import-dialog.tsx",
  "ImportUsersDialog"
);
const tick = async (delay = 20) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, delay));
  });
};
const mount = async (Component) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(Component));
  });
  return {
    container,
    root,
    dispose: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
};
const member = (
  id,
  name,
  supervisorUserId = "sup1",
  supervisorName = "Andi Pratama"
) => ({
  salesForceId: id,
  salesForceName: name,
  supervisorUserId,
  supervisorName,
  supervisorStatus: "active",
  supervisorRole: "supervisor",
});
const group = (id, name, members) => ({
  cursor: id ? "1" + id : "0",
  supervisorUserId: id,
  supervisorName: name,
  supervisorStatus: "active",
  supervisorRole: "supervisor",
  total: members.length,
  members,
  next: null,
});
const click = async (button) => {
  assert.ok(button);
  await act(async () => {
    button.click();
  });
};
const input = async (element, value) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    ).set.call(element, value);
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
};

test("Supervisor grouped UI loading, full-team/SF search, empty/error and restoration", async () => {
  let release;
  const calls = [];
  const all = [
    group("sup1", "Andi Pratama", [
      member("SF001", "Budi"),
      member("SF002", "Siti"),
    ]),
    group(null, "Belum Ditugaskan", [member("SF003", "Rina", null, null)]),
    group("sup2", "Supervisor Kosong", []),
  ];
  state.api = async (path) => {
    calls.push(path);
    if (path.startsWith("/supervisors?"))
      return { items: [{ id: "sup1", name: "Andi Pratama" }], next: null };
    const q = new URL(path, "http://localhost").searchParams.get("q");
    if (!release && q === "")
      return new Promise((resolve) => {
        release = () => resolve({ items: all, next: null });
      });
    if (q === "error") throw new Error("Gagal memuat penugasan.");
    return {
      items:
        q === "Budi"
          ? [group("sup1", "Andi Pratama", [member("SF001", "Budi")])]
          : q === "none"
            ? []
            : all,
      next: null,
    };
  };
  const view = await mount(AssignmentsPage);
  assert.match(view.container.textContent, /Memuat penugasan/);
  await act(async () => release());
  await tick();
  assert.match(view.container.textContent, /Supervisor: Andi Pratama/);
  assert.match(view.container.textContent, /Total Sales Force: 2/);
  assert.match(view.container.textContent, /Belum Ditugaskan/);
  assert.match(view.container.textContent, /Belum ada Sales Force/);
  const search = view.container.querySelector(
    'input[placeholder="Cari nama Supervisor atau Sales Force..."]'
  );
  await input(search, "  Andi  ");
  await tick(300);
  assert.ok(calls.some((path) => path.includes("q=Andi")));
  assert.match(view.container.textContent, /Budi/);
  assert.match(view.container.textContent, /Siti/);
  await input(search, "Budi");
  await tick(300);
  assert.match(view.container.textContent, /Budi/);
  assert.doesNotMatch(view.container.textContent, /Siti/);
  await input(search, "none");
  await tick(300);
  assert.match(view.container.textContent, /Tidak ada hasil pencarian/);
  await input(search, "error");
  await tick(300);
  assert.match(
    view.container.querySelector('[role="alert"]').textContent,
    /Gagal/
  );
  await input(search, "");
  await tick(300);
  assert.match(view.container.textContent, /Siti/);
  await view.dispose();
});

test("imported display names appear immediately before Telegram profile metadata exists", async () => {
  const accountName = await component(
    "../src/features/user-management/data.ts",
    "accountName"
  );
  assert.equal(
    accountName({
      telegramUserId: "500",
      displayName: "Imported Name",
      firstName: null,
      lastName: null,
    }),
    "Imported Name"
  );
  assert.equal(
    accountName({
      telegramUserId: "500",
      displayName: "Imported Name",
      firstName: "Telegram",
      lastName: "Profile",
    }),
    "Imported Name"
  );
  assert.equal(
    accountName({
      telegramUserId: "500",
      displayName: null,
      firstName: "Telegram",
      lastName: "Profile",
    }),
    "Telegram Profile"
  );
});

test("User import dialog has accessible instructions, file limits and template action", async () => {
  const view = await mount(ImportUsersDialog);
  await click(
    [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Import Pengguna"
    )
  );
  await tick();
  const dialog = document.querySelector('[role="dialog"]');
  assert.ok(dialog);
  assert.match(dialog.textContent, /50 baris/);
  assert.match(dialog.textContent, /Contoh hanya ada di lembar Petunjuk/);
  assert.equal(dialog.querySelector('input[type="file"]').accept, ".xlsx");
  assert.ok(
    [...dialog.querySelectorAll("button")].some(
      (button) => button.textContent === "Download Template Excel"
    )
  );
  await view.dispose();
});
