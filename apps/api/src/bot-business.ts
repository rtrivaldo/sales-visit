import { botActorSchema, type BotActor } from "@sales-visit/contracts";

import { demoEligibility } from "./demo-auth.ts";
import { createApp } from "./index.ts";
import { TelegramDemo } from "./telegram-demo.ts";
import { hashToken } from "./web-auth.ts";

// Private RPC adapter, NOT an HTTP proxy. Only these business routes are callable.
// Credentials are generated and consumed entirely inside this Worker; never returned
// to Telegram or RPC callers. Web handlers remain the single source of business rules.
const reads = new Set([
  "/dashboard/overview",
  "/sales-force",
  "/outlets",
  "/products",
  "/visits",
  "/stock-reports",
  "/supervisors",
  "/supervisor-assignments",
  "/admin/sales-force",
  "/admin/users/operations/new",
  "/admin/sales-force/operations/new",
  "/admin/outlets/operations/new",
  "/admin/user-import/template",
  "/admin/users",
]);
const writes = new Set([
  "/admin/sales-force/create",
  "/admin/sales-force/rename",
  "/admin/sales-force/delete",
  "/supervisor-assignments",
  "/admin/user-import/preview",
  "/admin/user-import/commit",
  "/admin/users/demo",
]);
export type BusinessResponse =
  | { ok: true; data: unknown }
  | { ok: false; error: string };
export async function botBusiness(
  env: ApiBindings,
  actor: BotActor,
  input: unknown
): Promise<BusinessResponse> {
  if (
    !botActorSchema.safeParse(actor).success ||
    !input ||
    typeof input !== "object"
  )
    return { ok: false, error: "Parameter tidak valid." };
  const {
    path,
    method = "GET",
    body,
  } = input as { path?: unknown; method?: unknown; body?: unknown };
  if (
    typeof path !== "string" ||
    path.length > 400000 ||
    !["GET", "POST", "PUT"].includes(String(method))
  )
    return { ok: false, error: "Parameter tidak valid." };
  const url = new URL(path, "https://internal.invalid");
  if (
    url.origin !== "https://internal.invalid" ||
    !path.startsWith("/") ||
    url.hash
  )
    return { ok: false, error: "Parameter tidak valid." };
  const reading = method === "GET";
  if (
    !(reading
      ? reads.has(url.pathname) ||
        /^\/(visits|sales-force)\/[^/]+$/.test(url.pathname) ||
        /^\/admin\/(users|sales-force|outlets)\/operations\/web:[^/]+$/.test(
          url.pathname
        )
      : writes.has(url.pathname))
  )
    return { ok: false, error: "Operasi tidak tersedia." };
  const demo = new TelegramDemo(env);
  const inDemo = await demo.active(actor);
  if (inDemo && (!reading || url.pathname.startsWith("/admin/")))
    return { ok: false, error: "Demo Mode hanya baca." };
  let demoUser: string | null = null;
  if (inDemo) {
    const selected = await demo.status(actor);
    if (!selected.ok || !selected.data)
      return { ok: false, error: "Sesi demo tidak tersedia." };
    demoUser = selected.data.account.id;
  }
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
  const hash = await hashToken(token),
    now = Date.now();
  // Recheck identity and demo eligibility in the session INSERT itself. The Web
  // session and every route guard still recheck the live role/status at use time.
  const issued =
    await env.DB.prepare(`INSERT INTO web_sessions (token_hash, user_id, created_at, expires_at)
    SELECT ?, u.id, ?, ? FROM users u WHERE u.status = 'active' AND
    ${inDemo ? `u.id = ? AND ${demoEligibility} AND EXISTS (SELECT 1 FROM telegram_demo_sessions WHERE telegram_user_id = ? AND user_id = u.id AND expires_at > ?)` : `EXISTS (SELECT 1 FROM telegram_identities WHERE user_id = u.id AND telegram_user_id = ?)`}
    RETURNING user_id`)
      .bind(
        hash,
        now,
        now + 30000,
        ...(inDemo
          ? [demoUser, actor.telegramUserId, now]
          : [actor.telegramUserId])
      )
      .first();
  if (!issued)
    return { ok: false, error: "Akses ditolak. Periksa akun melalui /me." };
  try {
    const response = await createApp().fetch(
      new Request(url, {
        method: String(method),
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      env
    );
    const data: unknown = await response.json();
    return response.ok
      ? { ok: true, data }
      : {
          ok: false,
          error:
            response.status === 403 || response.status === 401
              ? "Akses ditolak sesuai role atau cakupan penugasan."
              : response.status === 404
                ? "Data tidak ditemukan."
                : "Parameter, konflik data, atau operasi kedaluwarsa. Periksa data sebelum mencoba kembali.",
        };
  } finally {
    await env.DB.prepare("DELETE FROM web_sessions WHERE token_hash = ?")
      .bind(hash)
      .run();
  }
}
