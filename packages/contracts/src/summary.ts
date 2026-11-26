import type { ScheduleDetail } from "./planning.ts";
export interface WebSchedulePage {
  items: (ScheduleDetail & { completedToday: boolean })[];
  next: string | null;
  today: string;
  weekday: number;
}

import type { NamedVisit, Reference } from "./dashboard.ts";
import { formatRupiah } from "./visit-report.ts";

export interface OperationalSummary {
  role: "admin" | "supervisor" | "sales_force";
  name: string;
  readOnly: boolean;
  salesForceId: string | null;
  period: {
    month: number;
    year: number;
    today: string;
    timeZone: "Asia/Jakarta";
  };
  assignedOutlets: number;
  salesForce: number;
  users: {
    admin: number;
    supervisor: number;
    sales_force: number;
    pending: number;
  } | null;
  today: {
    scheduled: number;
    completed: number;
    remaining: number;
    percentage: number;
  };
  month: {
    visits: number;
    outlets: number;
    totalPurchase: number | null;
    knownPurchaseReports: number;
    missingPurchaseReports: number;
  };
  activity: { cvm: number; voice: number; digital: number; unknown: number };
  stock: { today: number; month: number };
  recentVisits: NamedVisit[];
  recentStock: {
    id: string;
    outletId: string;
    reportedAt: string;
    outlet: Reference | null;
  }[];
}
export const formatCount = (value: number) =>
  new Intl.NumberFormat("id-ID").format(value);
export const formatProgress = (value: number) =>
  `${new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 }).format(value)}%`;
export function completion(scheduled: number, completed: number) {
  const done = Math.max(0, Math.min(scheduled, completed));
  return {
    scheduled,
    completed: done,
    remaining: scheduled - done,
    percentage: scheduled ? (done / scheduled) * 100 : 0,
  };
}
export function summaryText(s: OperationalSummary): string {
  const count = formatCount;
  const title =
    s.role === "sales_force"
      ? "SALES"
      : s.role === "supervisor"
        ? "SUPERVISOR"
        : "SISTEM";
  const period = new Intl.DateTimeFormat("id-ID", {
    month: "long",
    year: "numeric",
    timeZone: "Asia/Jakarta",
  }).format(new Date(Date.UTC(s.period.year, s.period.month - 1, 15)));
  const filled = Math.round(s.today.percentage / 10);
  const name = [...s.name.replace(/[\r\n\t]/g, " ")].slice(0, 100).join("");
  return [
    `📊 RINGKASAN ${title}\n━━━━━━━━━━━━━━━━━━━━`,
    `Nama: ${name}${s.salesForceId ? `\nKode SF: ${[...s.salesForceId].slice(0, 256).join("")}` : ""}\nPeriode: ${period}`,
    ...(s.users
      ? [
          `👥 PENGGUNA\nAdmin: ${count(s.users.admin)}\nSupervisor: ${count(s.users.supervisor)}\nSales: ${count(s.users.sales_force)}\nPending: ${count(s.users.pending)}`,
        ]
      : [`👥 CAKUPAN\nSales Force: ${count(s.salesForce)}`]),
    `Outlet terjadwal: ${count(s.assignedOutlets)}`,
    `📅 KUNJUNGAN HARI INI\nJadwal: ${count(s.today.scheduled)} outlet\nSelesai: ${count(s.today.completed)} outlet\nBelum Visit: ${count(s.today.remaining)} outlet\nProgress: ${formatProgress(s.today.percentage)}\n${"█".repeat(filled)}${"░".repeat(10 - filled)}`,
    `📋 KUNJUNGAN BULAN INI\nTotal Visit: ${count(s.month.visits)}\nOutlet Visit: ${count(s.month.outlets)}\nTotal Belanja: ${s.month.totalPurchase === null ? "—" : formatRupiah(s.month.totalPurchase)}${s.month.missingPurchaseReports ? `\nBelanja belum tersedia: ${count(s.month.missingPurchaseReports)} laporan` : ""}`,
    `🏪 OUTLET AKTIF\nCVM: ${count(s.activity.cvm)} outlet\nVoice: ${count(s.activity.voice)} outlet\nDigital: ${count(s.activity.digital)} outlet\nStatus belum tersedia: ${count(s.activity.unknown)} outlet`,
    `📦 LAPORAN STOK\nHari Ini: ${count(s.stock.today)} laporan\nBulan Ini: ${count(s.stock.month)} laporan`,
    ...(s.role === "sales_force"
      ? [
          `/jadwal — Jadwal kunjungan${s.readOnly ? "" : "\n/salesvisit — Input kunjungan"}`,
        ]
      : []),
  ].join("\n\n");
}
