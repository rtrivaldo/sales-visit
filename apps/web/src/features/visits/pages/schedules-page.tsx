import {
  Link,
  useLoaderData,
  useSearch,
  useNavigate,
} from "@tanstack/react-router";

import { OperationalRefresh } from "@/components/operational-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";

import { EntrySelect } from "../components/entry-select";
const days = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu", "Minggu"];
export function SchedulesPage() {
  const page = useLoaderData({ from: "/dashboard/schedules" }),
    search = useSearch({ from: "/dashboard/schedules" }),
    navigate = useNavigate({ from: "/schedules" });
  return (
    <section className="flex flex-col gap-5">
      <header>
        <h1 className="text-2xl font-semibold">Jadwal kunjungan</h1>
        <p className="text-muted-foreground">
          {page.today} WIB · Status selesai dihitung per Outlet terjadwal hari
          ini.
        </p>
      </header>
      <OperationalRefresh />
      <EntrySelect
        id="schedule-day"
        label="Tampilan jadwal"
        value={search.weekday || "today"}
        options={[
          { value: "today", label: "Hari ini" },
          { value: "all", label: "Semua hari" },
          ...days.map((label, i) => ({ value: String(i + 1), label })),
        ]}
        onChange={(weekday) =>
          void navigate({ search: { weekday, after: "" } })
        }
      />
      {!page.items.length && (
        <p>Belum ada jadwal pada hari ini atau filter yang dipilih.</p>
      )}
      {days.map((day, index) => {
        const rows = page.items.filter((r) => r.weekday === index + 1);
        return rows.length ? (
          <Card key={day}>
            <CardHeader>
              <CardTitle>{day}</CardTitle>
              <CardDescription>
                {rows.length} target pada halaman ini.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col gap-4">
                {rows.map((r) => (
                  <li
                    key={r.id}
                    className="flex flex-wrap items-center justify-between gap-3"
                  >
                    <div>
                      <Link
                        to="/outlets/$outletId"
                        params={{ outletId: r.outletId }}
                        search={{}}
                        className="font-medium underline"
                      >
                        {r.outletName}
                      </Link>
                      <p className="text-muted-foreground text-sm">
                        {r.outletBusinessId ?? "ID belum tersedia"}
                      </p>
                    </div>
                    <Badge variant={r.completedToday ? "secondary" : "outline"}>
                      {r.weekday !== page.weekday
                        ? "Rencana mingguan"
                        : r.completedToday
                          ? "Selesai"
                          : "Belum Visit"}
                    </Badge>
                    <Button
                      nativeButton={false}
                      variant="outline"
                      render={
                        <Link
                          to="/visits/new"
                          search={{ outlet: r.outletId }}
                        />
                      }
                    >
                      Input kunjungan
                    </Button>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ) : null;
      })}
      <div className="flex gap-2">
        {search.after && (
          <Button
            variant="outline"
            onClick={() => void navigate({ search: { ...search, after: "" } })}
          >
            Halaman awal
          </Button>
        )}
        {page.next && (
          <Button
            variant="outline"
            onClick={() =>
              void navigate({ search: { ...search, after: page.next! } })
            }
          >
            Berikutnya
          </Button>
        )}
      </div>
    </section>
  );
}
