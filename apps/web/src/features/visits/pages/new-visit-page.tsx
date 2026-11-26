import {
  createVisitSchema,
  parseVisitAnswer,
  visitQuestions,
  parseQuantity,
  type CreateVisit,
  type Visit,
  type OutletReadDetail,
} from "@sales-visit/contracts";
import { useSearch, Link } from "@tanstack/react-router";
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
  const account = useAccount(),
    initial = useSearch({ from: "/dashboard/visits/new" }).outlet;
  const [search, setSearch] = useState(""),
    [options, setOptions] = useState<Outlet[]>([]),
    [selected, setSelected] = useState<Outlet | null>(null);
  const [values, setValues] = useState<Record<string, string>>({}),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [error, setError] = useState(""),
    [searchError, setSearchError] = useState("");
  const [allowed, setAllowed] = useState<boolean | null>(null),
    [pending, setPending] = useState(false),
    [saved, setSaved] = useState("");
  const [includeStock, setIncludeStock] = useState(false),
    [rows, setRows] = useState<StockRow[]>([]),
    [catalog, setCatalog] = useState<{ id: string; name: string }[]>([]),
    [productSearch, setProductSearch] = useState(""),
    [productError, setProductError] = useState("");
  const sending = useRef(false),
    key = useRef(crypto.randomUUID()),
    frozen = useRef<CreateVisit | null>(null);
  useEffect(() => {
    let active = true;
    void api<{ allowed: boolean }>("/visits/entry-permission")
      .then((r) => {
        if (active) setAllowed(r.allowed);
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
  useEffect(() => {
    if (!initial) return;
    let active = true;
    void api<OutletReadDetail>(`/outlets/${encodeURIComponent(initial)}`)
      .then((r) => {
        if (active) setSelected(r);
      })
      .catch(() => {
        if (active)
          setSearchError(
            "Outlet dari jadwal tidak dapat diakses. Pilih Outlet lain."
          );
      });
    return () => {
      active = false;
    };
  }, [initial]);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      const q = new URLSearchParams({
        view: "page",
        limit: "20",
        ...(search.trim() ? { q: search.trim() } : {}),
      });
      void api<{ items: Outlet[] }>(`/outlets?${q}`)
        .then((r) => {
          if (active) {
            setOptions(r.items);
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
  useEffect(() => {
    if (!includeStock) return;
    let active = true;
    const timer = setTimeout(() => {
      const q = new URLSearchParams({
        view: "page",
        limit: "100",
        ...(productSearch.trim() ? { q: productSearch.trim() } : {}),
      });
      void api<{ items: { id: string; name: string }[] }>(`/products?${q}`)
        .then((r) => {
          if (active) {
            setCatalog((old) => [
              ...old.filter(
                (p) =>
                  rows.some((row) => row.productId === p.id) &&
                  !r.items.some((n) => n.id === p.id)
              ),
              ...r.items,
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
    const props = {
      id: field,
      value: values[field] ?? "",
      "aria-invalid": !!errors[field],
      "aria-describedby": errors[field] ? `${field}-error` : undefined,
    };
    return (
      <Field key={field} data-invalid={!!errors[field]}>
        <FieldLabel htmlFor={field}>{label} (wajib)</FieldLabel>
        {kind === "currency" ? (
          <RupiahInput
            {...props}
            onValueChange={(value) => update(field, value)}
          />
        ) : (
          <Input
            {...props}
            inputMode="numeric"
            onChange={(e) => update(field, e.target.value)}
          />
        )}
        {errors[field] && (
          <FieldError id={`${field}-error`}>{errors[field]}</FieldError>
        )}
      </Field>
    );
  };
  function validate(): CreateVisit | undefined {
    const data: Record<string, unknown> = {
      outletId: selected?.id,
      visitedAt: new Date().toISOString(),
    };
    for (const [field] of visitQuestions)
      data[field] = parseVisitAnswer(field, values[field] ?? "");
    const nextErrors: Record<string, string> = {};
    if (includeStock) {
      const seen = new Set<string>();
      for (const row of rows) {
        if (
          !catalog.some((p) => p.id === row.productId) ||
          seen.has(row.productId)
        )
          nextErrors[`${row.id}.product`] =
            "Pilih produk yang berbeda untuk setiap baris.";
        seen.add(row.productId);
        if (parseQuantity(row.quantity) === undefined)
          nextErrors[`${row.id}.quantity`] =
            "Isi bilangan bulat nol atau lebih.";
      }
      if (!rows.length) nextErrors.rows = "Tambahkan minimal satu produk.";
      data.stockReport = {
        reportedAt: data.visitedAt,
        items: rows.map((r) => ({
          productId: r.productId,
          quantity: parseQuantity(r.quantity),
        })),
      };
    }
    const parsed = createVisitSchema.safeParse(data);
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        nextErrors[String(issue.path[0])] =
          "Wajib diisi dengan nilai yang valid.";
    setErrors(nextErrors);
    setError("");
    return !Object.keys(nextErrors).length && parsed.success
      ? parsed.data
      : undefined;
  }
  async function submit(data: CreateVisit) {
    if (sending.current) return;
    if (!allowed) {
      setError(
        "Pratinjau valid. Demo Mode hanya baca; tidak ada data disimpan."
      );
      return;
    }
    sending.current = true;
    frozen.current = data;
    setPending(true);
    setError("");
    try {
      const visit = await api<Visit>("/visits", {
        method: "POST",
        headers: { "Idempotency-Key": key.current },
        body: JSON.stringify(data),
      });
      setSaved(visit.id);
    } catch (cause) {
      if (cause instanceof ApiError && [400, 403, 404].includes(cause.status)) {
        frozen.current = null;
        key.current = crypto.randomUUID();
        setError(
          "Data atau izin tidak valid. Jawaban tetap tersimpan; periksa lalu coba lagi."
        );
      } else
        setError(
          "Hasil penyimpanan belum dapat dipastikan. Coba simpan lagi dengan data yang sama; duplikat dicegah."
        );
    } finally {
      sending.current = false;
      setPending(false);
    }
  }
  if (account?.role !== "sales_force")
    return <p>Pelaporan hanya tersedia untuk Sales Force.</p>;
  if (allowed === null)
    return <p role="status">{error || "Memeriksa izin pelaporan…"}</p>;
  if (saved)
    return (
      <section className="flex flex-col gap-4">
        <p role="status">Kunjungan berhasil disimpan. ID: {saved}</p>
        <Button
          nativeButton={false}
          render={
            <Link
              to="/visits/$visitId"
              params={{ visitId: saved }}
              search={{}}
            />
          }
        >
          Lihat laporan
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            setSaved("");
            setValues({});
            setRows([]);
            setIncludeStock(false);
            frozen.current = null;
            key.current = crypto.randomUUID();
          }}
        >
          Laporan baru
        </Button>
      </section>
    );
  return (
    <section className="flex max-w-3xl flex-col gap-5">
      <h1 className="text-2xl font-semibold">Laporan kunjungan sales</h1>
      {!allowed && (
        <p role="status">
          Demo Mode hanya baca. Anda dapat mencoba formulir tanpa menyimpan.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const data = frozen.current ?? validate();
          if (data) void submit(data);
        }}
      >
        <FieldGroup>
          <fieldset
            disabled={pending || !!frozen.current}
            className="flex min-w-0 flex-col gap-6"
          >
            <FieldSet>
              <FieldLegend>Informasi Outlet</FieldLegend>
              <Field>
                <FieldLabel htmlFor="outlet-search">
                  Cari ID atau Nama Outlet
                </FieldLabel>
                <Input
                  id="outlet-search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
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
              onToggle={() => setIncludeStock((v) => !v)}
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
                  onChange={(e) => setProductSearch(e.target.value)}
                />
                {productError && <FieldError>{productError}</FieldError>}
              </Field>
            )}
          </fieldset>
          <Button type="submit" disabled={pending}>
            {pending
              ? "Menyimpan…"
              : allowed
                ? "Simpan laporan kunjungan"
                : "Periksa formulir demo"}
          </Button>
        </FieldGroup>
      </form>
    </section>
  );
}
