import {
  formatCount,
  formatProgress,
  formatRupiah,
} from "@sales-visit/contracts";
import { useLoaderData, Link } from "@tanstack/react-router";

import { OperationalRefresh } from "@/components/operational-state";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { formatTime } from "@/lib/formatters";

export function WorkspacePage() {
  const s = useLoaderData({ from: "/dashboard/workspace" });
  const metrics = [
    ["Outlet terjadwal", formatCount(s.assignedOutlets)],
    ["Jadwal hari ini", formatCount(s.today.scheduled)],
    ["Selesai hari ini", formatCount(s.today.completed)],
    ["Belum Visit", formatCount(s.today.remaining)],
    ["Progress hari ini", formatProgress(s.today.percentage)],
    ["Kunjungan bulan ini", formatCount(s.month.visits)],
    [
      "Total Belanja bulan ini",
      s.month.totalPurchase === null
        ? "Belum tersedia"
        : formatRupiah(s.month.totalPurchase),
    ],
    [
      "Outlet aktif CVM / Voice / Digital",
      `${s.activity.cvm} / ${s.activity.voice} / ${s.activity.digital}`,
    ],
  ];
  return (
    <section className="flex flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Ringkasan Sales</h1>
          <p className="text-muted-foreground">
            {s.name} · {s.salesForceId} · {s.period.today} WIB
          </p>
        </div>
        <OperationalRefresh />
      </header>
      <div className="flex flex-wrap gap-2">
        <Button
          nativeButton={false}
          render={<Link to="/visits/new" search={{}} />}
        >
          Input kunjungan
        </Button>
        <Button
          variant="outline"
          nativeButton={false}
          render={<Link to="/schedules" search={{}} />}
        >
          Jadwal hari ini
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map(([title, value]) => (
          <Card key={title}>
            <CardHeader>
              <CardTitle>{title}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xl font-semibold">{value}</p>
            </CardContent>
          </Card>
        ))}
      </div>
      {!!s.month.missingPurchaseReports && (
        <p className="text-muted-foreground">
          Belanja belum tersedia pada {s.month.missingPurchaseReports} laporan
          lama. Total hanya mencakup nilai yang dilaporkan.
        </p>
      )}
      {!!s.activity.unknown && (
        <p className="text-muted-foreground">
          Status aktivitas belum tersedia untuk {s.activity.unknown} outlet.
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Kunjungan terbaru</CardTitle>
            <CardDescription>
              Laporan Web dan Telegram milik Anda.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {s.recentVisits.length ? (
              <ul className="flex flex-col gap-3">
                {s.recentVisits.map((v) => (
                  <li key={v.id}>
                    <Link
                      to="/visits/$visitId"
                      params={{ visitId: v.id }}
                      search={{}}
                      className="underline"
                    >
                      {v.outlet?.name ?? v.outletId}
                    </Link>
                    <p className="text-muted-foreground text-sm">
                      {formatTime(v.visitedAt)} WIB · {v.submissionChannel}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p>Belum ada kunjungan.</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Laporan stok terbaru</CardTitle>
            <CardDescription>
              {s.stock.today} hari ini · {s.stock.month} bulan ini.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {s.recentStock.length ? (
              <ul className="flex flex-col gap-3">
                {s.recentStock.map((r) => (
                  <li key={r.id}>
                    <Link
                      to="/stock-reports/$reportId"
                      params={{ reportId: r.id }}
                      className="underline"
                    >
                      {r.outlet?.name ?? r.outletId}
                    </Link>
                    <p className="text-muted-foreground text-sm">
                      {formatTime(r.reportedAt)} WIB
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p>Belum ada laporan stok.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
