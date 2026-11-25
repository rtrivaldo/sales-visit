import {
  visitQuestions,
  visitReportSummary,
  reportingCalendar,
  type BotIdentityService,
  type VisitWizardInput,
  type VisitWizardResult,
} from "@sales-visit/contracts";
import type { Bot, Context } from "grammy";

import { actor as actorFromContext } from "../actor.ts";
import { replyBlocks } from "../planning/shared.ts";

async function render(ctx: Context, result: VisitWizardResult) {
  if (!result.ok) {
    if (result.code === "unavailable")
      throw new Error("Visit service unavailable");
    await ctx.reply(
      result.code === "forbidden"
        ? "Akses ditolak. Hanya Sales Force aktif dapat melaporkan. Periksa /me."
        : "Parameter tidak valid. Periksa /help."
    );
    return;
  }
  const { draft, notice } = result.data;
  const blocks: string[] = [];
  if (notice)
    blocks.push(
      notice === "outlet_missing"
        ? "Outlet tidak ditemukan atau tidak dapat diakses. Masukkan ID Outlet lain."
        : notice === "invalid_input"
          ? "Jawaban tidak valid. Jawaban sebelumnya tetap tersimpan; coba lagi."
          : notice === "link_changed"
            ? "Tautan Sales Force berubah. Gunakan /batal lalu /salesvisit."
            : notice === "busy"
              ? "Pengiriman masih diproses. Periksa /konfirmasi."
              : "Pesan lama tidak diterapkan. Periksa langkah terbaru di bawah."
    );
  if (!draft) blocks.push("Mulai laporan dengan /salesvisit.");
  else if (draft.step === "submitted")
    blocks.push(`Kunjungan berhasil disimpan. ID: ${draft.visitId}`);
  else if (draft.step === "cancelled" || draft.step === "expired")
    blocks.push("Draf dibatalkan atau kedaluwarsa. Mulai lagi: /salesvisit.");
  else if (draft.step === "submitting")
    blocks.push(
      "Pengiriman sedang diproses. /konfirmasi untuk memeriksa hasil dengan aman."
    );
  else if (draft.step === "outlet") blocks.push("Masukkan ID Outlet:");
  else if (draft.step === "review")
    blocks.push(
      `📋 KONFIRMASI KUNJUNGAN SALES\n\nOutlet ID: ${draft.payload.outletBusinessId ?? draft.payload.outletId}\nNama Outlet: ${draft.payload.outletName}\n${visitReportSummary({ ...draft.payload, ...reportingCalendar(draft.payload.visitedAt!) })}\n\nApakah data sudah benar?\nKetik Y untuk menyimpan atau N untuk membatalkan.`
    );
  else {
    const question = visitQuestions.find(
      ([key]) => draft.payload[key] === undefined
    );
    if (question) {
      if (question[0] === "reportingWeek")
        blocks.push(
          `Outlet ditemukan.\n\nID Outlet: ${draft.payload.outletBusinessId ?? draft.payload.outletId}\nNama Outlet: ${draft.payload.outletName}`
        );
      blocks.push(
        question[2] === "week"
          ? "Pilih periode kunjungan:\n\n1. Minggu ke-1\n2. Minggu ke-2\n3. Minggu ke-3\n4. Minggu ke-4\n\nMasukkan angka 1–4."
          : `${question[1]}:\n${question[2] === "boolean" ? "Ketik Y atau N." : question[2] === "currency" ? "Masukkan Rupiah bulat, misalnya Rp 1.000.000. Nol diperbolehkan." : "Masukkan bilangan bulat nol atau lebih."}`
      );
    }
  }
  await replyBlocks(ctx, blocks);
}
export function visitCommands(bot: Bot, api: BotIdentityService) {
  const call = async (
    ctx: Context,
    input: Omit<VisitWizardInput, "messageId">
  ) => {
    const actor = actorFromContext(ctx);
    if (!actor || !ctx.message) return;
    await render(
      ctx,
      await api.visitWizard(actor, {
        ...input,
        messageId: ctx.message.message_id,
      })
    );
  };
  bot.command("salesvisit", (ctx) => call(ctx, { action: "start" }));
  bot.command("konfirmasi", (ctx) => call(ctx, { action: "confirm" }));
  bot.command("batal", (ctx) => call(ctx, { action: "cancel" }));
  bot.on("message:text", async (ctx, next) => {
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return next();
    const actor = actorFromContext(ctx);
    if (!actor) return next();
    // Read the durable state without consuming this message. Never keep sessions
    // in process memory: each webhook may execute on a different Worker.
    const state = await api.visitWizard(actor, {
      action: "peek",
      messageId: ctx.message.message_id,
    });
    if (
      !state.ok ||
      !state.data.draft ||
      ["submitted", "cancelled", "expired"].includes(state.data.draft.step)
    )
      return next();
    if (state.data.draft.step === "review") {
      if (/^y$/i.test(text)) return call(ctx, { action: "confirm" });
      if (/^n$/i.test(text)) return call(ctx, { action: "cancel" });
      await ctx.reply("Ketik Y untuk menyimpan atau N untuk membatalkan.");
      return;
    }
    await call(ctx, { action: "answer", value: text });
  });
}
