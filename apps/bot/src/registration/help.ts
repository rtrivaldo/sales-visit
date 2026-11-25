import type { Account, BotDemoResult } from "@sales-visit/contracts";

const section = (title: string, lines: string[]) =>
  [title, ...lines].join("\n");

export function helpSections(
  account: Account | null,
  demo: BotDemoResult = { ok: false, code: "disabled" }
): string[] {
  const demoEnabled = demo.ok || demo.code !== "disabled";
  // An ineligible, unexpired demo session must not expose real-account commands.
  const readOnly = demoEnabled && (!demo.ok || demo.data !== null);
  const role = readOnly
    ? demo.ok
      ? demo.data?.account.role
      : null
    : account?.status === "active"
      ? account.role
      : null;
  const sections = [
    section("👤 Umum", [
      "/start — Mulai bot.",
      "/help — Lihat perintah yang tersedia.",
      "/me — Lihat profil dan status akun.",
      ...(!account && !readOnly
        ? ["/register — Daftar dan tunggu persetujuan Admin."]
        : []),
    ]),
  ];
  if (role === "admin" || role === "supervisor")
    sections.push(
      section("📅 Monitoring", [
        "/jadwalsales kode_sf [hari] — Jadwal Sales Force.",
        "/outlet ID_OUTLET — Detail Outlet.",
        "/carioutlet q=NAMA — Cari Outlet (10 per halaman).",
      ])
    );
  if (role === "admin" && !readOnly) {
    sections.push(
      section("👥 Pengguna", [
        "/pending — Lihat permintaan registrasi.",
        "/user ID_TELEGRAM — Detail pengguna.",
        "/approve — Setujui registrasi.",
        "/reject — Tolak registrasi.",
        "/setrole — Ubah role pengguna aktif.",
        "/disable — Nonaktifkan pengguna.",
        "/enable — Aktifkan kembali pengguna.",
        "/templatepengguna — Template Excel pengguna.",
        "/importpengguna — Impor pengguna aktif.",
      ])
    );
    sections.push(
      section("🏪 Outlet & Jadwal", [
        "/tambahoutlet — Tambah Outlet.",
        "/editoutlet — Ubah Outlet.",
        "/hapusoutlet — Hapus Outlet yang belum dirujuk.",
        "/editoutletinternal — Ubah Outlet berdasarkan ID internal.",
        "/hapusoutletinternal — Hapus Outlet berdasarkan ID internal.",
        "/tambahjadwal — Tambah rencana kunjungan.",
      ])
    );
  }
  if (role === "admin" || role === "supervisor") {
    sections.push(
      section("📊 Dashboard", ["/dashboard — Ringkasan aktivitas."])
    );
    sections.push(
      section("👨‍💼 Sales Force", [
        "/detailsalesforce KODE_SF — Detail Sales Force.",
        ...(role === "admin" && !readOnly
          ? [
              "/tambahsalesforce — Tambah Sales Force.",
              "/editsalesforce — Ubah nama Sales Force.",
              "/hapussalesforce — Hapus Sales Force tanpa referensi.",
            ]
          : []),
      ])
    );
  }
  if (role === "admin")
    sections.push(
      section("🤝 Penugasan Supervisor", [
        "/supervisor ID_TELEGRAM — Detail Supervisor.",
        "/penugasan q=NAMA — Cari penugasan (5 per halaman).",
        ...(!readOnly
          ? [
              "/assignsupervisor — Tetapkan atau ganti Supervisor.",
              "/unassignsupervisor — Lepaskan penugasan.",
            ]
          : []),
      ])
    );
  if (role) {
    sections.push(
      section("📦 Produk", ["/produk q=NAMA — Cari produk (10 per halaman)."])
    );
    if (role === "sales_force")
      sections.push(
        section("🏪 Outlet", [
          "/carioutlet q=NAMA — Cari Outlet (10 per halaman).",
          "/outlet ID_OUTLET — Detail Outlet.",
        ])
      );
    sections.push(
      section("📋 Riwayat Kunjungan", [
        "/riwayatvisit outletId=ID — Riwayat sesuai akses (10 per halaman).",
        "/detailvisit ID_KUNJUNGAN — Detail kunjungan.",
      ])
    );
    sections.push(
      section("📦 Laporan Stok", [
        "/stockreport outletId=ID — Riwayat stok (10 per halaman).",
        "/detailstok ID_LAPORAN — Detail laporan stok.",
      ])
    );
  }
  if (role === "sales_force") {
    sections.push(
      section("📅 Monitoring", [
        "/jadwal — Lihat jadwal dan detail Outlet kunjungan sendiri.",
      ])
    );
    if (!readOnly)
      sections.push(
        section("📋 Kunjungan", [
          "/salesvisit — Mulai atau lanjutkan draf Visit.",
          "/konfirmasi — Simpan Visit atau cek hasilnya.",
          "/batal — Batalkan draf Visit.",
        ])
      );
  }
  if (demoEnabled)
    sections.push(
      section("🧪 Demo Mode", [
        "/demo — Daftar akun demo.",
        "/demo_login account_id — Pilih atau ganti akun demo (hanya baca).",
        "/demo_status — Lihat akun demo dan sisa sesi.",
        "/demo_logout — Keluar demo dan pulihkan akses Telegram.",
        ...(role === "admin" && !readOnly
          ? ["/tambahakundemo — Buat akun demo Web dan Bot."]
          : []),
      ])
    );
  return sections;
}
