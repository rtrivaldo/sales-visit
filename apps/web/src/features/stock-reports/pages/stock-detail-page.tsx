import { Link, useLoaderData } from "@tanstack/react-router";

import { OperationalRefresh } from "@/components/operational-state";
import { Button } from "@/components/ui/button";

import { StockReportCard } from "../components/stock-report-card";
export function StockDetailPage() {
  const report = useLoaderData({ from: "/dashboard/stock-reports/$reportId" });
  return (
    <section className="flex flex-col gap-5">
      <h1 className="text-2xl font-semibold">Detail laporan stok</h1>
      <div className="flex gap-2">
        <Button
          variant="outline"
          nativeButton={false}
          render={<Link to="/directory" search={{ kind: "stock-reports" }} />}
        >
          Riwayat stok
        </Button>
        <OperationalRefresh />
      </div>
      <StockReportCard report={report} />
      {report.visitId && (
        <Link
          to="/visits/$visitId"
          params={{ visitId: report.visitId }}
          search={{}}
          className="underline"
        >
          Lihat kunjungan terkait
        </Link>
      )}
    </section>
  );
}
