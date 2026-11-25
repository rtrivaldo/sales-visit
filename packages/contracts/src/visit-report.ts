import { z } from "zod";

export const nonNegativeIntegerSchema = z.number().int().nonnegative().safe();

/** Strict integer Rupiah syntax; never strip arbitrary characters. */
export function parseRupiah(input: string): number | undefined {
  const value = input.trim().replace(/^rp\.?\s*/i, "");
  if (
    !/^(?:[0-9]+|[0-9]{1,3}(?:\.[0-9]{3})+|[0-9]{1,3}(?: [0-9]{3})+)$/.test(
      value
    )
  )
    return undefined;
  const amount = Number(value.replace(/[. ]/g, ""));
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : undefined;
}
export function parseQuantity(input: string): number | undefined {
  const text = input.trim();
  if (!/^[0-9]+$/.test(text)) return undefined;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : undefined;
}
export function parseYesNo(input: string): boolean | undefined {
  const value = input.trim().toLowerCase();
  if (["y", "yes", "ya"].includes(value)) return true;
  if (["n", "no", "tidak"].includes(value)) return false;
  return undefined;
}
export function formatRupiah(value: number): string {
  nonNegativeIntegerSchema.parse(value);
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  })
    .format(value)
    .replace(/\u00a0/g, " ");
}
export function reportingCalendar(visitedAt: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "numeric",
  }).formatToParts(new Date(visitedAt));
  return {
    reportingMonth: Number(parts.find((p) => p.type === "month")!.value),
    reportingYear: Number(parts.find((p) => p.type === "year")!.value),
  };
}
export const visitReportSchema = z.object({
  reportingWeek: z.number().int().min(1).max(4),
  digiposBalance: nonNegativeIntegerSchema,
  perdanaSaStock: nonNegativeIntegerSchema,
  perdanaSaSelling: nonNegativeIntegerSchema,
  perdanaSaSellout: nonNegativeIntegerSchema,
  vfDataStock: nonNegativeIntegerSchema,
  vfDataSelling: nonNegativeIntegerSchema,
  vfDataSellout: nonNegativeIntegerSchema,
  vfVoiceStock: nonNegativeIntegerSchema,
  vfVoiceSelling: nonNegativeIntegerSchema,
  vfVoiceSellout: nonNegativeIntegerSchema,
  isCvmActive: z.boolean(),
  isVoiceActive: z.boolean(),
  isDigitalActive: z.boolean(),
  totalPurchase: nonNegativeIntegerSchema,
});
export const reportingCalendarSchema = z.object({
  reportingMonth: z.number().int().min(1).max(12),
  reportingYear: z.number().int().min(1).max(9999),
});
export type VisitReport = z.infer<typeof visitReportSchema>;
export const visitQuestions = [
  ["reportingWeek", "Periode", "week"],
  ["digiposBalance", "Saldo Digipos", "currency"],
  ["perdanaSaStock", "Perdana SA — Stok", "quantity"],
  ["perdanaSaSelling", "Perdana SA — Selling", "quantity"],
  ["perdanaSaSellout", "Perdana SA — Sellout", "quantity"],
  ["vfDataStock", "VF Data — Stok", "quantity"],
  ["vfDataSelling", "VF Data — Selling", "quantity"],
  ["vfDataSellout", "VF Data — Sellout", "quantity"],
  ["vfVoiceStock", "VF Voice — Stok", "quantity"],
  ["vfVoiceSelling", "VF Voice — Selling", "quantity"],
  ["vfVoiceSellout", "VF Voice — Sellout", "quantity"],
  ["isCvmActive", "Outlet Aktif — CVM", "boolean"],
  ["isVoiceActive", "Outlet Aktif — Voice", "boolean"],
  ["isDigitalActive", "Outlet Aktif — Digital", "boolean"],
  ["totalPurchase", "Total Belanja", "currency"],
] as const;
export function parseVisitAnswer(key: keyof VisitReport, value: string) {
  const kind = visitQuestions.find(([field]) => field === key)![2];
  const parsed =
    kind === "boolean"
      ? parseYesNo(value)
      : kind === "currency"
        ? parseRupiah(value)
        : parseQuantity(value);
  const result = visitReportSchema.shape[key].safeParse(parsed);
  return result.success ? result.data : undefined;
}
const number = (value: number | undefined) =>
  value === undefined ? "—" : String(value);
const money = (value: number | undefined) =>
  value === undefined ? "—" : formatRupiah(value);
const bool = (value: boolean | undefined) =>
  value === undefined ? "—" : value ? "Y" : "N";
/** Used for review and details in both channels; missing historical data is not zero. */
export function visitReportSummary(
  p: Partial<VisitReport> & { reportingMonth?: number; reportingYear?: number }
): string {
  const month =
    p.reportingMonth && p.reportingYear
      ? new Intl.DateTimeFormat("id-ID", {
          month: "long",
          year: "numeric",
          timeZone: "Asia/Jakarta",
        }).format(new Date(Date.UTC(p.reportingYear, p.reportingMonth - 1, 15)))
      : "—";
  return `Periode: ${p.reportingWeek === undefined ? "—" : `Minggu ke-${p.reportingWeek}`}\nBulan: ${month}\n\nSaldo Digipos: ${money(p.digiposBalance)}\n\n📦 Perdana SA\nStok: ${number(p.perdanaSaStock)}\nSelling: ${number(p.perdanaSaSelling)}\nSellout: ${number(p.perdanaSaSellout)}\n\n📦 VF Data\nStok: ${number(p.vfDataStock)}\nSelling: ${number(p.vfDataSelling)}\nSellout: ${number(p.vfDataSellout)}\n\n📦 VF Voice\nStok: ${number(p.vfVoiceStock)}\nSelling: ${number(p.vfVoiceSelling)}\nSellout: ${number(p.vfVoiceSellout)}\n\n🏪 Outlet Aktif\nCVM: ${bool(p.isCvmActive)}\nVoice: ${bool(p.isVoiceActive)}\nDigital: ${bool(p.isDigitalActive)}\n\n💰 Total Belanja: ${money(p.totalPurchase)}`;
}
