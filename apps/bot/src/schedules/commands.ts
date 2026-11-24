import {
  indonesianWeekdaySchema,
  indonesianWeekdays,
  type BotIdentityService,
  type ScheduleDetail,
  type ScheduleFilter,
} from "@sales-visit/contracts";
import type { Bot } from "grammy";

import { actor } from "../actor.ts";
import {
  args,
  decodeToken,
  displayId,
  label,
  nextPage,
  parseOrUsage,
  planningResult,
  replyBlocks,
} from "../planning/shared.ts";

export function jakartaWeekday(now = new Date()): number {
  return indonesianWeekdaySchema.parse(
    new Intl.DateTimeFormat("id-ID", {
      weekday: "long",
      timeZone: "Asia/Jakarta",
    }).format(now)
  );
}
function schedule(row: ScheduleDetail) {
  return [
    `Hari: ${indonesianWeekdays[row.weekday - 1]}\nNama Outlet: ${label(row.outletName)}\nID Outlet Bisnis: ${row.outletBusinessId === null ? "belum didata" : displayId(row.outletBusinessId)}\nNo. RS: ${row.outletNoRs === null ? "belum didata" : label(row.outletNoRs)}\nInternal ID/token (Visit): ${displayId(row.outletId)}`,
    `Sales Force: ${label(row.salesForceName)}\nSales Force ID bisnis: ${displayId(row.salesForceId)}\nTelegram ID: ${row.telegramUserId === null ? "asosiasi aktif unik belum terverifikasi" : label(row.telegramUserId)}`,
  ];
}
export function scheduleCommands(bot: Bot, api: BotIdentityService) {
  bot.command("jadwal", async (ctx) => {
    const input = await parseOrUsage(
      ctx,
      "Format: /jadwal [HARI|semua] [after=KURSOR]",
      () => {
        const tokens = args(ctx.match);
        const filter: ScheduleFilter = {};
        const day = tokens.shift();
        if (day === undefined) filter.weekday = jakartaWeekday();
        else if (day.toLowerCase() !== "semua")
          filter.weekday = indonesianWeekdaySchema.parse(day);
        if (tokens.length > 1 || (tokens[0] && !tokens[0].startsWith("after=")))
          throw new Error("args");
        if (tokens[0]) filter.after = decodeToken(tokens[0].slice(6));
        return filter;
      }
    );
    if (!input) return;
    // No identity selection is accepted here, including on follow-up pages.
    const page = await planningResult(ctx, () =>
      api.ownSchedule(actor(ctx), input)
    );
    if (!page) return;
    const day = input.weekday ? indonesianWeekdays[input.weekday - 1] : "semua";
    await replyBlocks(ctx, [
      `JADWAL SAYA — ${day}\nRencana berulang, bukan Visit selesai.`,
      ...page.items.flatMap(schedule),
      ...(!page.items.length ? ["Tidak ada jadwal."] : []),
      ...(page.next ? [nextPage(`/jadwal ${day} after=`, page.next)] : []),
    ]);
  });
  bot.command("jadwalsales", async (ctx) => {
    if (!ctx.match.trim()) {
      await ctx.reply(
        "Format: /jadwalsales kode_sf [hari]\n\nContoh:\n/jadwalsales SF001\n/jadwalsales SF001 senin"
      );
      return;
    }
    const input = await parseOrUsage(
      ctx,
      "Format: /jadwalsales kode_sf [hari]\n\nContoh:\n/jadwalsales SF001\n/jadwalsales SF001 senin",
      () => {
        const filter: ScheduleFilter = {};
        const tokens = args(ctx.match);
        if (!tokens.length || tokens.length > 3) throw new Error("args");
        filter.salesForceCode = decodeToken(tokens.shift()!);
        if (tokens[0] && !tokens[0].startsWith("after="))
          filter.weekday = indonesianWeekdaySchema.parse(tokens.shift());
        if (tokens.length) {
          if (tokens.length !== 1 || !tokens[0]!.startsWith("after="))
            throw new Error("args");
          filter.after = decodeToken(tokens[0]!.slice(6));
        }
        return filter;
      }
    );
    if (!input) return;
    const page = await planningResult(ctx, () =>
      api.listSchedules(actor(ctx), input)
    );
    if (!page) return;
    const filters = [
      displayId(input.salesForceCode!),
      input.weekday ? indonesianWeekdays[input.weekday - 1] : "",
    ]
      .filter(Boolean)
      .join(" ");
    await replyBlocks(ctx, [
      `JADWAL SALES FORCE — ${filters}\nRencana berulang, bukan Visit selesai.`,
      ...page.items.flatMap(schedule),
      ...(!page.items.length ? ["Tidak ada jadwal."] : []),
      ...(page.next
        ? [nextPage(`/jadwalsales ${filters} after=`, page.next)]
        : []),
    ]);
  });
  bot.command("tambahjadwal", async (ctx) => {
    const input = await parseOrUsage(
      ctx,
      "Format: /tambahjadwal SALES_FORCE_ID OUTLET_ID HARI",
      () => {
        const tokens = args(ctx.match);
        if (tokens.length !== 3) throw new Error("args");
        return {
          salesForceId: decodeToken(tokens[0]!),
          outletId: decodeToken(tokens[1]!),
          weekday: indonesianWeekdaySchema.parse(tokens[2]),
        };
      }
    );
    if (!input) return;
    const row = await planningResult(ctx, () =>
      api.createSchedule(actor(ctx), input)
    );
    if (row)
      await replyBlocks(ctx, [
        `Jadwal berulang berhasil dibuat — ${indonesianWeekdays[row.weekday - 1]}.\nSales Force ID: ${displayId(row.salesForceId)}\nOutlet ID: ${displayId(row.outletId)}\nIni rencana, bukan Visit selesai.`,
      ]);
  });
}
