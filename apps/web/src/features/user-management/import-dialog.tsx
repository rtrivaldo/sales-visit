import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { api, ApiError } from "@/features/auth/session";

type Preview = {
  total: number;
  valid: number;
  invalid: number;
  duplicates: number;
  rows: {
    row: number;
    telegramId: string;
    name: string;
    role: string;
    code: string;
    errors: string[];
  }[];
};
async function download() {
  const result = await api<{ content: string }>("/admin/user-import/template");
  const url = URL.createObjectURL(
    new Blob([Uint8Array.from(atob(result.content), (c) => c.charCodeAt(0))], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    })
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "template-pengguna.xlsx";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function ImportUsersDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false);
  const [file, setFile] = useState<{
    filename: string;
    content: string;
  } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [admins, setAdmins] = useState(false),
    [message, setMessage] = useState("");
  const [operationId, setOperationId] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setMessage("");
    try {
      await task();
    } catch (error) {
      const details =
        error instanceof ApiError &&
        error.details &&
        typeof error.details === "object" &&
        "error" in error.details
          ? error.details
          : null;
      setMessage(
        details && typeof details.error === "string"
          ? details.error
          : "Operasi gagal. Jika penyimpanan terputus, periksa hasil operasi sebelum mencoba kembali."
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) setOpen(value);
      }}
    >
      <DialogTrigger render={<Button variant="outline" />}>
        Import Pengguna
      </DialogTrigger>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-4xl"
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle>Import Pengguna</DialogTitle>
          <DialogDescription>
            Isi lembar Pengguna pada template .xlsx (maksimal 256 KiB, 50
            baris). ID harus teks. Semua baris harus valid; akun dibuat aktif
            tanpa persetujuan Telegram tambahan. Contoh hanya ada di lembar
            Petunjuk.
          </DialogDescription>
        </DialogHeader>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void run(download)}
        >
          Download Template Excel
        </Button>
        <Field>
          <FieldLabel htmlFor="import-users-file">Berkas Excel</FieldLabel>
          <Input
            id="import-users-file"
            type="file"
            accept=".xlsx"
            disabled={busy || uncertain}
            onChange={(event) => {
              const selected = event.target.files?.[0];
              setPreview(null);
              setFile(null);
              setAdmins(false);
              setOperationId(null);
              if (!selected) return;
              if (!/\.xlsx$/i.test(selected.name) || selected.size > 262144) {
                setMessage("Pilih .xlsx maksimal 256 KiB.");
                return;
              }
              void run(async () => {
                const bytes = new Uint8Array(await selected.arrayBuffer());
                let binary = "";
                for (const byte of bytes) binary += String.fromCharCode(byte);
                const input = {
                  filename: selected.name,
                  content: btoa(binary),
                };
                const result = await api<Preview>(
                  "/admin/user-import/preview",
                  { method: "POST", body: JSON.stringify(input) }
                );
                setFile(input);
                setPreview(result);
              });
            }}
          />
        </Field>
        {preview && (
          <>
            <p role="status">
              Total: {preview.total} · Valid: {preview.valid} · Tidak valid:{" "}
              {preview.invalid} · Duplikat: {preview.duplicates}
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  {[
                    "Baris",
                    "Telegram ID",
                    "Nama",
                    "Role",
                    "Kode SF",
                    "Validasi",
                  ].map((title) => (
                    <TableHead key={title}>{title}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.rows.map((row) => (
                  <TableRow key={row.row}>
                    <TableCell>{row.row}</TableCell>
                    <TableCell>{row.telegramId}</TableCell>
                    <TableCell>{row.name}</TableCell>
                    <TableCell>{row.role}</TableCell>
                    <TableCell>{row.code || "—"}</TableCell>
                    <TableCell>{row.errors.join(" ") || "Valid"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {preview.rows.some((row) => row.role === "admin") && (
              <Field orientation="horizontal">
                <Input
                  id="confirm-import-admins"
                  type="checkbox"
                  className="size-4"
                  checked={admins}
                  disabled={busy || uncertain}
                  onChange={(e) => setAdmins(e.target.checked)}
                />
                <FieldLabel htmlFor="confirm-import-admins">
                  Saya mengonfirmasi pembuatan akun dengan akses Admin.
                </FieldLabel>
              </Field>
            )}
            <Button
              disabled={
                busy ||
                uncertain ||
                !!preview.invalid ||
                (preview.rows.some((row) => row.role === "admin") && !admins)
              }
              onClick={() =>
                void run(async () => {
                  const op =
                    operationId ??
                    (
                      await api<{ operationId: string }>(
                        "/admin/users/operations/new"
                      )
                    ).operationId;
                  setOperationId(op);
                  setUncertain(true);
                  const result = await api<{ imported: number }>(
                    "/admin/user-import/commit",
                    {
                      method: "POST",
                      body: JSON.stringify({
                        ...file,
                        operationId: op,
                        confirm: true,
                        confirmAdmins: admins,
                      }),
                    }
                  );
                  setUncertain(false);
                  setMessage(
                    `${result.imported} pengguna berhasil diimpor. Akun Telegram langsung aktif.`
                  );
                  setPreview(null);
                  setFile(null);
                  await router.invalidate();
                })
              }
            >
              {busy ? "Memproses…" : "Konfirmasi Import Pengguna"}
            </Button>
          </>
        )}
        {uncertain && operationId && (
          <Button
            disabled={busy}
            variant="outline"
            onClick={() =>
              void run(async () => {
                const outcome = await api<{ status: string }>(
                  `/admin/users/operations/${encodeURIComponent(operationId)}`
                );
                if (outcome.status === "committed") {
                  setUncertain(false);
                  setPreview(null);
                  setFile(null);
                  setMessage("Impor berhasil disimpan.");
                  await router.invalidate();
                } else if (outcome.status === "not_committed") {
                  setUncertain(false);
                  setOperationId(null);
                  setMessage(
                    "Tidak ada perubahan tersimpan. Unggah ulang untuk validasi terbaru."
                  );
                  setPreview(null);
                } else
                  setMessage(
                    "Hasil masih diproses. Periksa kembali setelah 30 detik."
                  );
              })
            }
          >
            Periksa hasil impor
          </Button>
        )}
        {message && (
          <p role="status" aria-live="polite">
            {message}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
