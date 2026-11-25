import { visitReportSummary } from "@sales-visit/contracts";
import type {
  BotIdentityService,
  DashboardOverview,
  VisitDetail,
  VisitListItem,
  ReadPage,
  Reference,
  NamedStockReport,
} from "@sales-visit/contracts";
import { InputFile, type Bot, type Context } from "grammy";

import { actor } from "../actor.ts";
import {
  args,
  decodeToken,
  displayId,
  label,
  parseOrUsage,
  replyBlocks,
} from "../planning/shared.ts";

type Row = Record<string, unknown>;
const names: Record<string, string> = {
  id: "Kode/ID",
  name: "Nama",
  salesForceId: "Kode SF",
  salesForceName: "Sales Force",
  supervisorUserId: "ID Supervisor",
  supervisorName: "Supervisor",
  supervisorStatus: "Status Supervisor",
  supervisorRole: "Role Supervisor",
  accountStatus: "Status akun",
  references: "Referensi penghapusan",
  createdAt: "Dibuat",
  telegramId: "Telegram ID",
  role: "Role",
  code: "Kode SF",
  row: "Baris",
  errors: "Validasi",
};
function record(row: Row): string {
  return Object.entries(row)
    .filter(([key]) => key !== "salesForceId" || row.salesForceName)
    .map(
      ([key, value]) =>
        `${names[key] ?? key}: ${label(Array.isArray(value) ? value.join(", ") || "—" : String(value ?? "—"))}`
    )
    .join("\n");
}
function parameters(match: string, allowed: string[]) {
  const params = new URLSearchParams();
  for (const token of args(match)) {
    const split = token.indexOf("=");
    const key = token.slice(0, split),
      value = token.slice(split + 1);
    if (split < 1 || !allowed.includes(key) || params.has(key))
      throw new Error("args");
    params.set(key, decodeToken(value));
  }
  return params;
}
function continuation(
  command: string,
  params: URLSearchParams,
  key: string,
  value: string
) {
  const next = new URLSearchParams(params);
  next.set(key, value);
  return `Berikutnya: /${command} ${[...next].map(([k, v]) => `${k}=${displayId(v)}`).join(" ")}`;
}
function stock(report: NamedStockReport): string[] {
  return [
    `LAPORAN STOK ${displayId(report.id)}\nOutlet: ${displayId(report.outletId)}\nPelapor: ${label(report.reporter?.name ?? report.reporterSalesForceId)}\n${report.reportedAt}\nVisit: ${report.visitId ? displayId(report.visitId) : "—"}`,
    ...report.items.map(
      (item) =>
        `${label(item.product?.name ?? item.productId)}: ${item.quantity}`
    ),
  ];
}
export function businessCommands(bot: Bot, api: BotIdentityService) {
  async function call<T>(
    ctx: Context,
    path: string,
    method = "GET",
    body?: unknown
  ): Promise<T | undefined> {
    const result = await api.business(actor(ctx), {
      path,
      method,
      ...(body === undefined ? {} : { body }),
    });
    if (!result.ok) {
      await ctx.reply(result.error);
      return;
    }
    return result.data as T;
  }
  bot.command("dashboard", async (ctx) => {
    if (ctx.match.trim()) return ctx.reply("Format: /dashboard");
    const data = await call<DashboardOverview>(ctx, "/dashboard/overview");
    if (data)
      await replyBlocks(ctx, [
        "RINGKASAN AKTIVITAS — 14 hari (WIB)",
        `Visit: ${data.metrics.visits}\nOutlet dikunjungi: ${data.metrics.outlets}\nSales Force: ${data.metrics.salesForce}\nLaporan stok: ${data.metrics.stockReports}`,
        ...data.channels.map((row) => `${row.channel}: ${row.count} Visit`),
        ...data.dailyVisits.map((row) => `${row.date}: ${row.count} Visit`),
        "Visit terbaru:",
        ...data.recentVisits.map(
          (row) =>
            `${displayId(row.id)} — ${label(row.member?.name ?? row.salesForceId)} → ${label(row.outlet?.name ?? row.outletId)}\n${row.visitedAt}`
        ),
      ]);
  });
  for (const [command, path, filters] of [
    ["carioutlet", "/outlets", ["q", "offset"]],
    ["produk", "/products", ["q", "offset"]],
    [
      "riwayatvisit",
      "/visits",
      [
        "q",
        "offset",
        "salesForceId",
        "outletId",
        "channel",
        "stock",
        "date",
        "reportingWeek",
        "reportingMonth",
        "reportingYear",
      ],
    ],
  ] as const)
    bot.command(command, async (ctx) => {
      const params = await parseOrUsage(
        ctx,
        `Format: /${command} ${filters
          .filter((key) => key !== "offset")
          .map((key) => key + "=NILAI")
          .join(
            " | "
          )} [offset=ANGKA]\nIsi minimal satu filter. Nilai dengan spasi: salin token dari bot.`,
        () => {
          const search = parameters(ctx.match, [...filters]);
          if (![...search.keys()].some((key) => key !== "offset"))
            throw new Error("filter required");
          return search;
        }
      );
      if (!params) return;
      const query = new URLSearchParams(params);
      query.set("view", "page");
      query.set("limit", "10");
      const page = await call<ReadPage<Reference | VisitListItem>>(
        ctx,
        `${path}?${query}`
      );
      if (!page) return;
      await replyBlocks(ctx, [
        `${command.toUpperCase()} — Total: ${page.total}`,
        ...page.items.map((row) =>
          "visitedAt" in row
            ? `${displayId(row.id)}\n${label(row.member?.name ?? row.salesForceId)} → ${label(row.outlet?.name ?? row.outletId)}\n${row.visitedAt} · ${row.submissionChannel}\n${label(row.notes ?? "—")}\nLaporan stok: ${row.stockReportCount}`
            : `${label(row.name)} — ${displayId(row.id)}`
        ),
        ...(!page.items.length ? ["Tidak ada data sesuai pencarian."] : []),
        ...(Number(params.get("offset") ?? 0) + page.items.length < page.total
          ? [
              continuation(
                command,
                params,
                "offset",
                String(Number(params.get("offset") ?? 0) + 10)
              ),
            ]
          : []),
      ]);
    });
  bot.command("detailsalesforce", async (ctx) => {
    const id = await parseOrUsage(
      ctx,
      "Format: /detailsalesforce kode_sf",
      () => {
        const tokens = args(ctx.match);
        if (tokens.length !== 1) throw new Error("args");
        return decodeToken(tokens[0]!);
      }
    );
    if (!id) return;
    const profile = await api.me(actor(ctx));
    const demo = await api.demoStatus(actor(ctx));
    if (
      profile.ok &&
      profile.data?.status === "active" &&
      profile.data.role === "admin" &&
      (!demo.ok ? demo.code === "disabled" : demo.data === null)
    ) {
      const page = await call<{ items: Row[] }>(
        ctx,
        `/admin/sales-force?id=${encodeURIComponent(id)}&limit=1`
      );
      if (page)
        await ctx.reply(
          page.items[0] ? record(page.items[0]) : "Sales Force tidak ditemukan."
        );
      return;
    }
    const row = await call<Reference>(
      ctx,
      `/sales-force/${encodeURIComponent(id)}`
    );
    await ctx.reply(
      row
        ? `${label(row.name)} — ${displayId(row.id)}`
        : "Sales Force tidak ditemukan dalam cakupan akses."
    );
  });
  bot.command("detailvisit", async (ctx) => {
    const id = await parseOrUsage(ctx, "Format: /detailvisit visit_id", () => {
      const tokens = args(ctx.match);
      if (tokens.length !== 1) throw new Error("args");
      return decodeToken(tokens[0]!);
    });
    if (!id) return;
    const visit = await call<VisitDetail>(
      ctx,
      `/visits/${encodeURIComponent(id)}?include=references`
    );
    if (visit)
      await replyBlocks(ctx, [
        `DETAIL VISIT ${displayId(visit.id)}\nSales Force: ${label(visit.member?.name ?? visit.salesForceId)}\nOutlet ID: ${label(visit.outlet?.businessId ?? visit.outletId)}\nNama Outlet: ${label(visit.outlet?.name ?? visit.outletId)}\nWaktu: ${visit.visitedAt}\nKanal: ${visit.submissionChannel}\nCatatan: ${label(visit.notes ?? "—")}\nTindak lanjut: ${label(visit.followUp ?? "—")}`,
        visitReportSummary(visit),
        `Laporan stok terkait: ${visit.stockReports.length}${visit.stockReports.length === 100 ? "+" : ""}`,
        ...visit.stockReports
          .slice(0, 5)
          .map(
            (report) =>
              `${displayId(report.id)} · ${report.items.length} produk\nDetail: /detailstok ${displayId(report.id)}`
          ),
        ...(visit.stockReports.length > 5
          ? [
              `Lihat riwayat: /stockreport outletId=${displayId(visit.outletId)}`,
            ]
          : []),
      ]);
  });
  bot.command("stockreport", async (ctx) => {
    const params = await parseOrUsage(
      ctx,
      "Format: /stockreport outletId=ID atau salesForceId=KODE [offset=ANGKA]",
      () => {
        const search = parameters(ctx.match, [
          "salesForceId",
          "outletId",
          "offset",
        ]);
        if (!search.has("salesForceId") && !search.has("outletId"))
          throw new Error("filter required");
        return search;
      }
    );
    if (!params) return;
    const query = new URLSearchParams(params);
    query.set("limit", "10");
    query.set("view", "page");
    const page = await call<ReadPage<NamedStockReport>>(
      ctx,
      `/stock-reports?${query}`
    );
    if (page)
      await replyBlocks(ctx, [
        `LAPORAN STOK — Total: ${page.total}`,
        ...page.items.map(
          (report) =>
            `${displayId(report.id)} · ${report.reportedAt}\nOutlet: ${displayId(report.outletId)} · ${report.items.length} produk\nDetail: /detailstok ${displayId(report.id)}`
        ),
        ...(!page.items.length ? ["Tidak ada laporan stok."] : []),
        ...(Number(params.get("offset") ?? 0) + page.items.length < page.total
          ? [
              continuation(
                "stockreport",
                params,
                "offset",
                String(Number(params.get("offset") ?? 0) + 10)
              ),
            ]
          : []),
      ]);
  });
  bot.command("supervisor", async (ctx) => {
    const id = ctx.match.trim();
    if (!/^[1-9][0-9]{0,19}$/.test(id))
      return ctx.reply("Penggunaan: /supervisor ID_TELEGRAM");
    const page = await call<{ items: Row[] }>(
      ctx,
      `/supervisors?telegramId=${id}`
    );
    if (page)
      await replyBlocks(
        ctx,
        page.items.length
          ? page.items.map(record)
          : ["Supervisor tidak ditemukan."]
      );
  });
  bot.command("detailstok", async (ctx) => {
    const id = await parseOrUsage(
      ctx,
      "Penggunaan: /detailstok ID_LAPORAN",
      () => {
        const tokens = args(ctx.match);
        if (tokens.length !== 1) throw new Error("args");
        return decodeToken(tokens[0]!);
      }
    );
    if (!id) return;
    const report = await call<NamedStockReport>(
      ctx,
      `/stock-reports/${encodeURIComponent(id)}`
    );
    if (report) await replyBlocks(ctx, stock(report));
  });
  for (const [command, path] of [
    ["penugasan", "/supervisor-assignments"],
  ] as const)
    bot.command(command, async (ctx) => {
      const params = await parseOrUsage(
        ctx,
        `Format: /${command} q=NAMA [after=KURSOR]`,
        () => {
          const search = parameters(ctx.match, ["after", "q"]);
          if (!search.has("q")) throw new Error("filter required");
          return search;
        }
      );
      if (!params) return;
      const page = await call<{ items: Row[]; next: string | null }>(
        ctx,
        `${path}?${params}&limit=5`
      );
      if (page)
        await replyBlocks(ctx, [
          command.toUpperCase(),
          ...page.items.map(record),
          ...(!page.items.length ? ["Tidak ada data."] : []),
          ...(page.next
            ? [continuation(command, params, "after", page.next)]
            : []),
        ]);
    });
  for (const command of ["assignsupervisor", "unassignsupervisor"] as const)
    bot.command(command, async (ctx) => {
      const input = await parseOrUsage(
        ctx,
        `Format: /${command} kode_sf ${command === "assignsupervisor" ? "supervisor_user_id " : ""}KONFIRMASI`,
        () => {
          const tokens = args(ctx.match);
          if (
            tokens.length !== (command === "assignsupervisor" ? 3 : 2) ||
            tokens.at(-1) !== "KONFIRMASI"
          )
            throw new Error("args");
          return {
            salesForceId: decodeToken(tokens[0]!),
            supervisorUserId:
              command === "assignsupervisor" ? decodeToken(tokens[1]!) : null,
          };
        }
      );
      if (!input) return;
      const row = await call<Row>(ctx, "/supervisor-assignments", "PUT", input);
      if (row) await ctx.reply(`Penugasan disimpan.\n${record(row)}`);
    });
  for (const [command, action] of [
    ["tambahsalesforce", "create"],
    ["editsalesforce", "rename"],
    ["hapussalesforce", "delete"],
  ] as const)
    bot.command(command, async (ctx) => {
      const input = await parseOrUsage(
        ctx,
        `Format: /${command} kode_sf ${action !== "delete" ? "nama " : ""}KONFIRMASI\nKode bisnis dipertahankan; hanya nama dapat diubah.`,
        () => {
          const tokens = args(ctx.match);
          if (
            tokens.pop() !== "KONFIRMASI" ||
            tokens.length < (action === "delete" ? 1 : 2) ||
            (action === "delete" && tokens.length !== 1)
          )
            throw new Error("args");
          const id = decodeToken(tokens.shift()!);
          return {
            id,
            ...(action === "delete" ? {} : { name: tokens.join(" ") }),
          };
        }
      );
      if (!input) return;
      let expectedName: string | undefined;
      if (action === "rename") {
        const current = await call<Reference>(
          ctx,
          `/sales-force/${encodeURIComponent(input.id)}`
        );
        if (!current) return;
        expectedName = current.name;
        if (expectedName === undefined)
          return ctx.reply("Sales Force tidak ditemukan.");
      }
      const op = await call<{ operationId: string }>(
        ctx,
        "/admin/sales-force/operations/new"
      );
      if (!op) return;
      const row = await call<unknown>(
        ctx,
        `/admin/sales-force/${action}`,
        "POST",
        {
          ...input,
          ...(expectedName === undefined ? {} : { expectedName }),
          operationId: op.operationId,
        }
      );
      if (row !== undefined)
        await ctx.reply(
          `Perubahan Sales Force disimpan. Periksa /salesforce.\nOperasi: ${op.operationId}`
        );
    });
  bot.command("tambahakundemo", async (ctx) => {
    const input = await parseOrUsage(
      ctx,
      "Format: /tambahakundemo admin|supervisor|sales_force TOKEN_NAMA [kode_sf] KONFIRMASI\nNama dengan spasi memakai token ~base64url. Hanya lingkungan demo yang diaktifkan.",
      () => {
        const tokens = args(ctx.match);
        if (
          tokens.pop() !== "KONFIRMASI" ||
          tokens.length < 2 ||
          tokens.length > 3
        )
          throw new Error("args");
        const [role, name, code] = tokens;
        if (
          !["admin", "supervisor", "sales_force"].includes(role!) ||
          (role === "sales_force" ? !code : !!code)
        )
          throw new Error("args");
        return {
          role,
          displayName: decodeToken(name!),
          ...(code ? { salesForceId: decodeToken(code) } : {}),
        };
      }
    );
    if (!input) return;
    const op = await call<{ operationId: string }>(
      ctx,
      "/admin/users/operations/new"
    );
    if (!op) return;
    const created = await call<{ id: string }>(
      ctx,
      "/admin/users/demo",
      "POST",
      { ...input, operationId: op.operationId }
    );
    if (created)
      await ctx.reply(
        `Akun demo dibuat: ${displayId(created.id)}. Tidak ada identitas Telegram yang ditautkan.`
      );
  });
  bot.command("templatepengguna", async (ctx) => {
    const result = await call<{ content: string }>(
      ctx,
      "/admin/user-import/template"
    );
    if (result)
      await ctx.replyWithDocument(
        new InputFile(
          Uint8Array.from(atob(result.content), (c) => c.charCodeAt(0)),
          "template-pengguna.xlsx"
        )
      );
  });
  bot.command("importpengguna", (ctx) =>
    ctx.reply(
      "Kirim dokumen .xlsx (maksimal 256 KiB, 50 baris) dengan caption /importpengguna untuk pratinjau. Setelah memeriksa, kirim kembali dokumen dengan caption /importpengguna KONFIRMASI; tambah ADMIN jika ada role Admin. Unduh /templatepengguna."
    )
  );
  bot.on("message:document", async (ctx) => {
    const caption = ctx.message.caption ?? "";
    if (!/^\/importpengguna(?:@\w+)?(?:\s|$)/.test(caption)) return;
    const doc = ctx.message.document;
    if (
      !doc.file_name?.toLowerCase().endsWith(".xlsx") ||
      !doc.file_size ||
      doc.file_size > 262144
    )
      return ctx.reply("Gunakan .xlsx maksimal 256 KiB.");
    const flags = args(caption).slice(1);
    if (
      flags.join(" ") !== "" &&
      flags.join(" ") !== "KONFIRMASI" &&
      flags.join(" ") !== "KONFIRMASI ADMIN"
    )
      return ctx.reply("Caption: /importpengguna [KONFIRMASI [ADMIN]]");
    // Authorize before downloading Telegram content.
    const permitted = await call(ctx, "/admin/user-import/template");
    if (!permitted) return;
    const file = await ctx.api.getFile(doc.file_id);
    if (!file.file_path || file.file_path.includes("..")) return;
    const response = await fetch(
      `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`
    );
    if (!response.ok || Number(response.headers.get("Content-Length")) > 262144)
      return ctx.reply("Berkas tidak dapat diunduh.");
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 262144) {
        await reader.cancel();
        return ctx.reply("Berkas terlalu besar.");
      }
      chunks.push(value);
    }
    let binary = "";
    for (const chunk of chunks)
      for (const byte of chunk) binary += String.fromCharCode(byte);
    const input = { filename: doc.file_name, content: btoa(binary) };
    if (!flags.length) {
      const preview = await call<{
        total: number;
        valid: number;
        invalid: number;
        duplicates: number;
        rows: Row[];
      }>(ctx, "/admin/user-import/preview", "POST", input);
      if (preview)
        await replyBlocks(ctx, [
          `PRATINJAU — Total ${preview.total}; valid ${preview.valid}; tidak valid ${preview.invalid}; duplikat ${preview.duplicates}`,
          ...preview.rows.map((row) =>
            record({
              row: row.row,
              telegramId: row.telegramId,
              name: row.name,
              role: row.role,
              code: row.code,
              errors: row.errors,
            })
          ),
          "Belum disimpan. Periksa lalu kirim ulang dengan caption /importpengguna KONFIRMASI (tambahkan ADMIN jika ada akun Admin).",
        ]);
    } else {
      const op = await call<{ operationId: string }>(
        ctx,
        "/admin/users/operations/new"
      );
      if (!op) return;
      const result = await call<{ imported: number }>(
        ctx,
        "/admin/user-import/commit",
        "POST",
        {
          ...input,
          operationId: op.operationId,
          confirm: true,
          confirmAdmins: flags[1] === "ADMIN",
        }
      );
      if (result)
        await ctx.reply(
          `${result.imported} pengguna diimpor dan langsung aktif.`
        );
    }
  });
}
