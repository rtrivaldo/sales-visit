import type {
  ReadPage,
  Reference,
  VisitDetail,
  VisitListItem,
} from "@sales-visit/contracts";

import { api, currentAccount } from "@/features/auth/session";

import type { VisitFilters } from "./filter-visits";

export async function loadVisits(filters: VisitFilters) {
  const query = new URLSearchParams({
    view: "page",
    limit: "25",
    offset: filters.offset || "0",
  });
  for (const [key, value] of Object.entries({
    q: filters.q.trim(),
    channel: filters.channel,
    salesForceId: filters.member,
    outletId: filters.outlet,
    stock: filters.stock,
    date: filters.date,
    reportingWeek: filters.reportingWeek,
    reportingMonth: filters.reportingMonth,
    reportingYear: filters.reportingYear,
  }))
    if (value) query.set(key, value);
  const [page, members, outlets] = await Promise.all([
    api<ReadPage<VisitListItem>>(`/visits?${query}`),
    currentAccount()?.role === "sales_force"
      ? Promise.resolve({
          items: [
            {
              id: currentAccount()!.salesForceId!,
              name: currentAccount()!.name,
            },
          ],
          total: 1,
        })
      : api<ReadPage<Reference>>("/sales-force?view=page&limit=100"),
    api<ReadPage<Reference>>("/outlets?view=page&limit=100"),
  ]);
  return { ...page, members, outlets };
}
export const loadVisit = (id: string) =>
  api<VisitDetail>(`/visits/${encodeURIComponent(id)}?include=references`);
