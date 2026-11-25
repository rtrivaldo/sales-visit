import type { StockReport, Visit } from "@sales-visit/contracts";
import type { stockReportItems, stockReports, visits } from "@sales-visit/db";

export function toVisit(row: typeof visits.$inferSelect): Visit {
  return {
    id: row.id,
    reportingWeek: row.reportingWeek ?? undefined,
    reportingMonth: row.reportingMonth ?? undefined,
    reportingYear: row.reportingYear ?? undefined,
    digiposBalance: row.digiposBalance ?? undefined,
    perdanaSaStock: row.perdanaSaStock ?? undefined,
    perdanaSaSelling: row.perdanaSaSelling ?? undefined,
    perdanaSaSellout: row.perdanaSaSellout ?? undefined,
    vfDataStock: row.vfDataStock ?? undefined,
    vfDataSelling: row.vfDataSelling ?? undefined,
    vfDataSellout: row.vfDataSellout ?? undefined,
    vfVoiceStock: row.vfVoiceStock ?? undefined,
    vfVoiceSelling: row.vfVoiceSelling ?? undefined,
    vfVoiceSellout: row.vfVoiceSellout ?? undefined,
    isCvmActive: row.isCvmActive ?? undefined,
    isVoiceActive: row.isVoiceActive ?? undefined,
    isDigitalActive: row.isDigitalActive ?? undefined,
    totalPurchase: row.totalPurchase ?? undefined,
    outletId: row.outletId,
    salesForceId: row.salesForceId,
    visitedAt: row.visitedAt.toISOString(),
    submissionChannel: row.submissionChannel,
    notes: row.notes ?? undefined,
    followUp: row.followUp ?? undefined,
  };
}

export function toStockReport(
  row: typeof stockReports.$inferSelect & {
    items: (typeof stockReportItems.$inferSelect)[];
  }
): StockReport {
  return {
    id: row.id,
    outletId: row.outletId,
    reporterSalesForceId: row.reporterSalesForceId,
    visitId: row.visitId ?? undefined,
    reportedAt: row.reportedAt.toISOString(),
    submissionChannel: row.submissionChannel,
    items: row.items.map(({ productId, quantity }) => ({
      productId,
      quantity,
    })),
  };
}
