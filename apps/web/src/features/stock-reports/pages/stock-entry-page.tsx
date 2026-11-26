import {
  createStockReportSchema,
  parseQuantity,
  type StockReport,
  type CreateStockReport,
  type Reference,
} from "@sales-visit/contracts";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Field,
  FieldLabel,
  FieldGroup,
  FieldError,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/features/auth/session";
import { EntrySelect } from "@/features/visits/components/entry-select";
import type { StockRow } from "@/features/visits/lib/visit-entry";

import { StockReportFields } from "../components/stock-report-fields";

export function StockEntryPage() {
  const [allowed, setAllowed] = useState<boolean | null>(null),
    [q, setQ] = useState(""),
    [productQ, setProductQ] = useState(""),
    [outlets, setOutlets] = useState<Reference[]>([]),
    [catalog, setCatalog] = useState<Reference[]>([]),
    [outletId, setOutletId] = useState(""),
    [visitId, setVisitId] = useState("");
  const [rows, setRows] = useState<StockRow[]>([]),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [error, setError] = useState(""),
    [pending, setPending] = useState(false),
    [saved, setSaved] = useState("");
  const busy = useRef(false),
    key = useRef(crypto.randomUUID()),
    frozen = useRef<CreateStockReport | null>(null);
  useEffect(() => {
    let active = true;
    void api<{ allowed: boolean }>("/visits/entry-permission")
      .then((r) => {
        if (active) setAllowed(r.allowed);
      })
      .catch(() => {
        if (active) setError("Izin pelaporan belum dapat diperiksa.");
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      const a = new URLSearchParams({
          view: "page",
          limit: "20",
          ...(q.trim() ? { q: q.trim() } : {}),
        }),
        b = new URLSearchParams({
          view: "page",
          limit: "100",
          ...(productQ.trim() ? { q: productQ.trim() } : {}),
        });
      void Promise.all([
        api<{ items: Reference[] }>(`/outlets?${a}`),
        api<{ items: Reference[] }>(`/products?${b}`),
      ])
        .then(([o, p]) => {
          if (active) {
            setOutlets((old) => [
              ...old.filter(
                (r) => r.id === outletId && !o.items.some((n) => n.id === r.id)
              ),
              ...o.items,
            ]);
            setCatalog((old) => [
              ...old.filter(
                (r) =>
                  rows.some((s) => s.productId === r.id) &&
                  !p.items.some((n) => n.id === r.id)
              ),
              ...p.items,
            ]);
          }
        })
        .catch(() => {
          if (active)
            setError("Pencarian gagal. Ubah pencarian untuk mencoba lagi.");
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [q, productQ, outletId, rows]);
  async function submit() {
    if (busy.current) return;
    const next: Record<string, string> = {};
    const seen = new Set<string>();
    for (const row of rows) {
      if (!row.productId || seen.has(row.productId))
        next[`${row.id}.product`] = "Pilih produk yang berbeda.";
      seen.add(row.productId);
      if (parseQuantity(row.quantity) === undefined)
        next[`${row.id}.quantity`] = "Isi bilangan bulat nol atau lebih.";
    }
    if (!rows.length) next.rows = "Tambahkan minimal satu produk.";
    const parsed = createStockReportSchema.safeParse({
      outletId,
      visitId: visitId || undefined,
      reportedAt: new Date().toISOString(),
      items: rows.map((r) => ({
        productId: r.productId,
        quantity: parseQuantity(r.quantity),
      })),
    });
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        next[String(issue.path[0])] = "Isi nilai yang valid.";
    setErrors(next);
    if (!frozen.current && (!parsed.success || Object.keys(next).length))
      return;
    if (!allowed) {
      setError(
        "Pratinjau valid. Demo Mode hanya baca; laporan tidak disimpan."
      );
      return;
    }
    const data = frozen.current ?? (parsed.success ? parsed.data : null);
    if (!data) return;
    frozen.current = data;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      const result = await api<StockReport>("/stock-reports", {
        method: "POST",
        headers: { "Idempotency-Key": key.current },
        body: JSON.stringify(data),
      });
      setSaved(result.id);
    } catch (cause) {
      if (cause instanceof ApiError && [400, 403, 404].includes(cause.status)) {
        frozen.current = null;
        key.current = crypto.randomUUID();
      }
      setError(
        "Laporan belum tersimpan atau hasil belum dapat dipastikan. Jawaban tetap tersedia; coba lagi."
      );
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  if (saved)
    return (
      <section>
        <p role="status">Laporan stok berhasil disimpan.</p>
        <Button
          nativeButton={false}
          render={
            <Link to="/stock-reports/$reportId" params={{ reportId: saved }} />
          }
        >
          Lihat laporan stok
        </Button>
      </section>
    );
  return (
    <section className="flex max-w-3xl flex-col gap-5">
      <h1 className="text-2xl font-semibold">Input laporan stok</h1>
      {allowed === false && (
        <p>Demo Mode hanya baca. Formulir dapat dicoba tanpa menyimpan.</p>
      )}
      {error && <p role="alert">{error}</p>}
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <FieldGroup>
          <fieldset
            disabled={pending || !!frozen.current}
            className="flex min-w-0 flex-col gap-5"
          >
            <Field>
              <FieldLabel htmlFor="stock-outlet-search">
                Cari ID atau Nama Outlet
              </FieldLabel>
              <Input
                id="stock-outlet-search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </Field>
            <EntrySelect
              id="stock-outlet"
              label="Outlet"
              value={outletId}
              error={errors.outletId}
              options={outlets.map((o) => ({
                value: o.id,
                label: `${o.businessId ?? o.id} — ${o.name}`,
              }))}
              onChange={setOutletId}
            />
            <Field data-invalid={!!errors.visitId}>
              <FieldLabel htmlFor="stock-visit">
                ID kunjungan terkait (opsional)
              </FieldLabel>
              <Input
                id="stock-visit"
                value={visitId}
                aria-invalid={!!errors.visitId}
                onChange={(e) => setVisitId(e.target.value)}
              />
              {errors.visitId && <FieldError>{errors.visitId}</FieldError>}
            </Field>
            <Field>
              <FieldLabel htmlFor="stock-product-search">
                Cari produk (maksimal 100 hasil)
              </FieldLabel>
              <Input
                id="stock-product-search"
                value={productQ}
                onChange={(e) => setProductQ(e.target.value)}
              />
            </Field>
            <StockReportFields
              standalone
              catalog={catalog}
              enabled
              rows={rows}
              errors={errors}
              onToggle={() => {}}
              onChange={setRows}
            />
          </fieldset>
          <Button type="submit" disabled={pending || allowed === null}>
            {pending
              ? "Menyimpan…"
              : allowed
                ? "Simpan laporan stok"
                : "Periksa formulir demo"}
          </Button>
        </FieldGroup>
      </form>
    </section>
  );
}
