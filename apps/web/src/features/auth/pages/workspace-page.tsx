import { Link } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";

export function WorkspacePage() {
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Ruang kerja Sales Force</h1>
      <p>Laporkan kunjungan melalui Web atau Telegram Bot.</p>
      <Button
        nativeButton={false}
        render={<Link to="/visits/new" search={{}} />}
      >
        Laporan kunjungan baru
      </Button>
      <Button
        nativeButton={false}
        variant="outline"
        render={<Link to="/visits" search={{}} />}
      >
        Riwayat kunjungan
      </Button>
    </section>
  );
}
