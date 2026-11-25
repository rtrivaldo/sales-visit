import {
  createVisitSchema,
  parseVisitAnswer,
  reportingCalendar,
  visitQuestions,
  visitReportSummary,
  parseQuantity,
  type CreateVisit,
  type Visit,
  type OutletReadDetail,
} from "@sales-visit/contracts";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldLegend,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { api, useAccount, ApiError } from "@/features/auth/session";
import { StockReportFields } from "@/features/stock-reports/components/stock-report-fields";

import { EntrySelect } from "../components/entry-select";
import { RupiahInput } from "../components/rupiah-input";
import type { StockRow } from "../lib/visit-entry";

type Outlet = Pick<OutletReadDetail, "id" | "name" | "businessId">;
const sections = [
  "Saldo Digipos",
  "Perdana SA",
  "VF Data",
  "VF Voice",
  "Outlet Aktif",
  "Total Belanja",
];
export function NewVisitPage() {
  const account = useAccount();
  const [search, setSearch] = useState("");
  const [options, setOptions] = useState<Outlet[]>([]);
  const [selected, setSelected] = useState<Outlet | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [searchError, setSearchError] = useState("");
  const [review, setReview] = useState<CreateVisit | null>(null);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState("");
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [includeStock, setIncludeStock] = useState(false);
  const [rows, setRows] = useState<StockRow[]>([]);
  const [catalog, setCatalog] = useState<{ id: string; name: string }[]>([]);
  const [productSearch, setProductSearch] = useState("");
  const [productError, setProductError] = useState("");
  useEffect(() => {
    if (!includeStock) return;
    let active = true;
    const timer = setTimeout(() => {
      const query = new URLSearchParams({
        view: "page",
        limit: "100",
        ...(productSearch.trim() ? { q: productSearch.trim() } : {}),
      });
      void api<{ items: { id: string; name: string }[] }>(`/products?${query}`)
        .then((page) => {
          if (active) {
            setCatalog((previous) => [
              ...previous.filter(
                (p) =>
                  rows.some((r) => r.productId === p.id) &&
                  !page.items.some((n) => n.id === p.id)
              ),
              ...page.items,
            ]);
            setProductError("");
          }
        })
        .catch(() => {
          if (active)
            setProductError(
              "Pencarian produk gagal. Ubah pencarian untuk mencoba lagi."
            );
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [includeStock, productSearch, rows]);
  useEffect(() => {
    let active = true;
    void api<{ allowed: boolean }>("/visits/entry-permission")
      .then((result) => {
        if (active) setAllowed(result.allowed);
      })
      .catch(() => {
        if (active)
          setError(
            "Izin pelaporan belum dapat diperiksa. Muat ulang untuk mencoba lagi."
          );
      });
    return () => {
      active = false;
    };
  }, []);
  const request = useRef(false);
  const key = useRef(crypto.randomUUID());
  const frozen = useRef(false);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      const query = new URLSearchParams({
        view: "page",
        limit: "20",
        ...(search.trim() ? { q: search.trim() } : {}),
      });
      void api<{ items: Outlet[] }>(`/outlets?${query}`)
        .then((page) => {
          if (active) {
            setOptions(page.items);
            setSearchError("");
          }
        })
        .catch(() => {
          if (active)
            setSearchError(
              "Pencarian Outlet gagal. Ubah pencarian untuk mencoba lagi."
            );
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [search]);
  const update = (field: string, value: string) =>
    setValues((old) => ({ ...old, [field]: value }));
  const input = (question: (typeof visitQuestions)[number]) => {
    const [field, label, kind] = question;
    if (kind === "week" || kind === "boolean")
      return (
        <EntrySelect
          key={field}
          id={field}
          label={label}
          value={values[field] ?? ""}
          error={errors[field]}
          onChange={(value) => update(field, value)}
          options={
            kind === "week"
              ? [1, 2, 3, 4].map((week) => ({
                  value: String(week),
                  label: `Minggu ke-${week}`,
                }))
              : [
                  { value: "Y", label: "Y" },
                  { value: "N", label: "N" },
                ]
          }
        />
      );
    return (
      <Field key={field} data-invalid={!!errors[field]}>
        <FieldLabel htmlFor={field}>
          {label} {kind === "currency" ? "(Rp)" : ""} (wajib)
        </FieldLabel>
        {kind === "currency" ? (
          <RupiahInput
            id={field}
            value={values[field] ?? ""}
            aria-invalid={!!errors[field]}
            aria-describedby={errors[field] ? `${field}-error` : undefined}
            onValueChange={(value) => update(field, value)}
          />
        ) : (
          <Input
            id={field}
            inputMode="numeric"
            value={values[field] ?? ""}
            aria-invalid={!!errors[field]}
            aria-describedby={errors[field] ? `${field}-error` : undefined}
            onChange={(event) => update(field, event.target.value)}
          />
        )}
        {errors[field] && (
          <FieldError id={`${field}-error`}>{errors[field]}</FieldError>
        )}
      </Field>
    );
  };
  function prepare() {
    const data: Record<string, unknown> = {
      outletId: selected?.id,
      visitedAt: new Date().toISOString(),
    };
    for (const [field] of visitQuestions)
      data[field] = parseVisitAnswer(field, values[field] ?? "");
    if (includeStock) {
      const stockErrors: Record<string, string> = {};
      const seen = new Set<string>();
      for (const row of rows) {
        if (
          !row.productId ||
          !catalog.some((p) => p.id === row.productId) ||
          seen.has(row.productId)
        )
          stockErrors[`${row.id}.product`] =
            "Pilih satu produk yang berbeda untuk setiap baris.";
        seen.add(row.productId);
        if (parseQuantity(row.quantity) === undefined)
          stockErrors[`${row.id}.quantity`] =
            "Isi bilangan bulat nol atau lebih.";
      }
      if (!rows.length) stockErrors.rows = "Tambahkan minimal satu produk.";
      if (Object.keys(stockErrors).length) {
        setErrors(stockErrors);
        return;
      }
      data.stockReport = {
        reportedAt: data.visitedAt,
        items: rows.map((row) => ({
          productId: row.productId,
          quantity: parseQuantity(row.quantity),
        })),
      };
    }
    const parsed = createVisitSchema.safeParse(data);
    if (!parsed.success) {
      setErrors(
        Object.fromEntries(
          parsed.error.issues.map((issue) => [
            String(issue.path[0]),
            "Wajib diisi dengan nilai yang valid.",
          ])
        )
      );
      return;
    }
    setErrors({});
    setError("");
    setReview(parsed.data);
  }
  async function save() {
    if (!review || request.current) return;
    request.current = true;
    frozen.current = true;
    setPending(true);
    setError("");
    try {
      const visit = await api<Visit>("/visits", {
        method: "POST",
        headers: { "Idempotency-Key": key.current },
        body: JSON.stringify(review),
      });
      setSaved(visit.id);
    } catch (cause) {
      if (cause instanceof ApiError && [400, 403, 404].includes(cause.status)) {
        frozen.current = false;
        key.current = crypto.randomUUID();
        setError(
          "Data atau izin pelaporan tidak valid. Jawaban tetap tersimpan; periksa sebelum mencoba lagi."
        );
      } else
        setError(
          "Penyimpanan belum dapat dipastikan. Coba simpan lagi dengan data yang sama; tidak akan membuat duplikat."
        );
    } finally {
      request.current = false;
      setPending(false);
    }
  }
  if (account?.role !== "sales_force")
    return <p>Pelaporan hanya tersedia untuk Sales Force.</p>;
  if (allowed === null)
    return <p role="status">{error || "Memeriksa izin pelaporan…"}</p>;
  if (!allowed)
    return (
      <p>
        Demo Mode hanya baca. Pelaporan memerlukan akun Sales Force Telegram
        aktif.
      </p>
    );
  if (saved)
    return (
      <div role="status">
        Kunjungan berhasil disimpan. ID: {saved}
        <br />
        <Button
          onClick={() => {
            setSaved("");
            setReview(null);
            setValues({});
            setIncludeStock(false);
            setRows([]);
            setSelected(null);
            key.current = crypto.randomUUID();
            frozen.current = false;
          }}
        >
          Laporan baru
        </Button>
      </div>
    );
  return (
    <section className="flex max-w-3xl flex-col gap-6">
      <h1 className="text-2xl font-semibold">Laporan kunjungan sales</h1>
      {error && <p role="alert">{error}</p>}
      {review ? (
        <>
          <h2>Konfirmasi kunjungan</h2>
          <p>
            Outlet ID: {selected?.businessId ?? selected?.id}
            <br />
            Nama Outlet: {selected?.name}
          </p>
          <p className="whitespace-pre-wrap">
            {visitReportSummary({
              ...review,
              ...reportingCalendar(review.visitedAt),
            })}
          </p>
          {review.stockReport && (
            <section>
              <h3>Laporan Stok terpisah (terkait kunjungan)</h3>
              <ul>
                {review.stockReport.items.map((item) => (
                  <li key={item.productId}>
                    {catalog.find((p) => p.id === item.productId)?.name ??
                      item.productId}
                    : {item.quantity}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <Button disabled={pending} onClick={() => void save()}>
            {pending ? "Menyimpan…" : "Konfirmasi dan simpan"}
          </Button>
          <Button
            variant="outline"
            disabled={pending || frozen.current}
            onClick={() => setReview(null)}
          >
            Ubah jawaban
          </Button>
        </>
      ) : (
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            prepare();
          }}
        >
          <FieldGroup>
            <FieldSet>
              <FieldLegend>Informasi Outlet</FieldLegend>
              <Field>
                <FieldLabel htmlFor="outlet-search">
                  Cari ID atau Nama Outlet
                </FieldLabel>
                <Input
                  id="outlet-search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                {searchError && <FieldError>{searchError}</FieldError>}
              </Field>
              <EntrySelect
                id="outlet"
                label="Outlet"
                value={selected?.id ?? ""}
                error={errors.outletId}
                onChange={(id) =>
                  setSelected(options.find((o) => o.id === id) ?? selected)
                }
                options={[
                  ...(selected && !options.some((o) => o.id === selected.id)
                    ? [selected]
                    : []),
                  ...options,
                ].map((o) => ({
                  value: o.id,
                  label: `${o.businessId ?? o.id} — ${o.name}`,
                }))}
              />
              <p className="text-muted-foreground text-sm">
                Maksimal 20 hasil. Persempit pencarian jika Outlet belum
                terlihat.
              </p>
              {selected && (
                <p>
                  ID Outlet: {selected.businessId ?? selected.id}
                  <br />
                  Nama Outlet: {selected.name}
                </p>
              )}
              {input(visitQuestions[0])}
            </FieldSet>
            {sections.map((section) => (
              <FieldSet key={section}>
                <FieldLegend>{section}</FieldLegend>
                <FieldGroup className="sm:flex-row">
                  {visitQuestions
                    .filter(([, label]) =>
                      label.toLowerCase().startsWith(section.toLowerCase())
                    )
                    .map(input)}
                </FieldGroup>
              </FieldSet>
            ))}
            <StockReportFields
              catalog={catalog}
              enabled={includeStock}
              rows={rows}
              errors={errors}
              onToggle={() => setIncludeStock((value) => !value)}
              onChange={setRows}
            />
            {includeStock && (
              <Field>
                <FieldLabel htmlFor="product-search">
                  Cari produk laporan stok (maksimal 100 hasil)
                </FieldLabel>
                <Input
                  id="product-search"
                  value={productSearch}
                  onChange={(event) => setProductSearch(event.target.value)}
                />
                {productError && <FieldError>{productError}</FieldError>}
              </Field>
            )}
            <Button type="submit">Tinjau laporan</Button>
          </FieldGroup>
        </form>
      )}
    </section>
  );
}
