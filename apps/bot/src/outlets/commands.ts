import type { BotIdentityService, OutletDetail } from "@sales-visit/contracts";
import type { Bot } from "grammy";

import { actor } from "../actor.ts";
import {
  args,
  decodeToken,
  displayId,
  label,
  parseOrUsage,
  planningResult,
  replyBlocks,
} from "../planning/shared.ts";
function outlet(row: OutletDetail) {
  return `Nama Outlet: ${label(row.name)}\nID Outlet: ${row.businessId === null ? "belum didata" : displayId(row.businessId)}\nNo. RS: ${row.noRs === null ? "belum didata" : label(row.noRs)}`;
}
export function outletCommands(bot: Bot, api: BotIdentityService) {
  bot.command("outlet", async (ctx) => {
    const input = await parseOrUsage(ctx, "Format: /outlet ID_OUTLET", () => {
      const tokens = args(ctx.match);
      if (tokens.length !== 1) throw new Error("args");
      return { businessId: decodeToken(tokens[0]!) };
    });
    if (!input) return;
    const row = await planningResult(ctx, () =>
      api.getOutlet(actor(ctx), input)
    );
    if (row) await replyBlocks(ctx, ["DETAIL OUTLET", outlet(row)]);
  });
  bot.command("editoutlet", async (ctx) => {
    const input = await parseOrUsage(
      ctx,
      "Format: /editoutlet ID_OUTLET NO_RS_BARU NAMA_OUTLET_BARU",
      () => {
        const match = /^(\S+)\s+(\S+)\s+([\s\S]+)$/.exec(ctx.match.trim());
        if (!match) throw new Error("args");
        return {
          businessId: decodeToken(match[1]!),
          noRs: decodeToken(match[2]!),
          name: match[3]!,
        };
      }
    );
    if (!input) return;
    const resolved = await planningResult(ctx, () =>
      api.getOutlet(actor(ctx), { businessId: input.businessId })
    );
    if (!resolved || resolved.businessId === null) return;
    const row = await planningResult(ctx, () =>
      api.updateOutlet(actor(ctx), {
        ...input,
        businessId: resolved.businessId,
      })
    );
    if (row)
      await replyBlocks(ctx, ["Outlet berhasil diperbarui.", outlet(row)]);
  });
  bot.command("hapusoutlet", async (ctx) => {
    const input = await parseOrUsage(
      ctx,
      "Format: /hapusoutlet ID_OUTLET KONFIRMASI",
      () => {
        const tokens = args(ctx.match);
        if (tokens.length !== 2 || tokens[1] !== "KONFIRMASI")
          throw new Error("args");
        return { businessId: decodeToken(tokens[0]!) };
      }
    );
    if (!input) return;
    const resolved = await planningResult(ctx, () =>
      api.getOutlet(actor(ctx), input)
    );
    if (!resolved || resolved.businessId === null) return;
    const row = await planningResult(ctx, () =>
      api.deleteOutlet(actor(ctx), { businessId: resolved.businessId })
    );
    if (row) await replyBlocks(ctx, ["Outlet berhasil dihapus.", outlet(row)]);
  });
  bot.command("tambahoutlet", async (ctx) => {
    const input = await parseOrUsage(
      ctx,
      "Format: /tambahoutlet ID_OUTLET NO_RS NAMA_OUTLET",
      () => {
        const match = /^(\S+)\s+(\S+)\s+([\s\S]+)$/.exec(ctx.match.trim());
        if (!match) throw new Error("args");
        return {
          businessId: decodeToken(match[1]!),
          noRs: decodeToken(match[2]!),
          name: match[3]!,
        };
      }
    );
    if (!input) return;
    const row = await planningResult(ctx, () =>
      api.createOutlet(actor(ctx), input)
    );
    if (row) await replyBlocks(ctx, ["Outlet berhasil dibuat.", outlet(row)]);
  });
}
