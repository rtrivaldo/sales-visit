import * as XLSX from "@e965/xlsx";
import {
  accountRoleSchema,
  telegramIdSchema,
  webOperationIdSchema,
} from "@sales-visit/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import {
  operationRange,
  operationWriteBindings,
  operationWriteGuard,
} from "./admin-operation.ts";
import { webAdminGuard } from "./identity.ts";
import { hashToken, sessionAccount, type WebEnv } from "./web-auth.ts";

const headers = ["telegram_id", "nama", "role", "kode_sf"];
const maxRows = 50;
export type ImportRow = {
  row: number;
  telegramId: string;
  name: string;
  role: string;
  code: string;
  salesForceId: string | null;
  errors: string[];
  duplicate: boolean;
};
export function importTemplate() {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([headers]);
  sheet["!cols"] = headers.map(() => ({ wch: 26 }));
  // Blank text-formatted cells, never real sample accounts on the data sheet.
  for (let row = 2; row <= maxRows + 1; row++)
    for (const col of ["A", "D"])
      sheet[`${col}${row}`] = { t: "s", v: "", z: "@" };
  sheet["!ref"] = `A1:D${maxRows + 1}`;
  XLSX.utils.book_append_sheet(book, sheet, "Pengguna");
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      ["Petunjuk (jangan impor lembar ini)"],
      [
        "Isi lembar Pengguna. Maksimal 50 pengguna per berkas, .xlsx maksimal 256 KiB.",
      ],
      [
        "telegram_id dan kode_sf wajib berupa teks, bukan angka atau formula. Jangan hilangkan nol awal.",
      ],
      [
        "nama wajib. role: admin, supervisor, sales_force. kode_sf hanya untuk sales_force.",
      ],
      ["Contoh saja", ...headers],
      ["Contoh", "123456789", "Budi Santoso", "admin", ""],
      ["Contoh", "234567890", "Andi Pratama", "supervisor", ""],
      ["Contoh", "345678901", "Siti Rahma", "sales_force", "SF001"],
      [
        "Semua baris harus valid. Akun lama tidak pernah ditimpa. Konfirmasi khusus untuk Admin.",
      ],
    ]),
    "Petunjuk"
  );
  return XLSX.write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}
// Bound ZIP expansion before parsing; do not execute formulas, links or macros.
function boundedZip(bytes: Uint8Array) {
  if (bytes.length > 262144 || bytes[0] !== 80 || bytes[1] !== 75)
    throw new Error("Berkas .xlsx maksimal 256 KiB.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let expanded = 0,
    entries = 0;
  for (let i = 0; i + 46 <= bytes.length; i++) {
    if (view.getUint32(i, true) !== 0x02014b50) continue;
    expanded += view.getUint32(i + 24, true);
    entries++;
    if (expanded > 2097152 || entries > 100 || view.getUint16(i + 8, true) & 1)
      throw new Error("Arsip terlalu besar atau terenkripsi.");
    i +=
      45 +
      view.getUint16(i + 28, true) +
      view.getUint16(i + 30, true) +
      view.getUint16(i + 32, true);
  }
  if (!entries) throw new Error("Arsip Excel tidak valid.");
}
export function parseImport(bytes: Uint8Array): ImportRow[] {
  boundedZip(bytes);
  const book = XLSX.read(bytes, {
    type: "array",
    cellFormula: true,
    cellHTML: false,
    bookVBA: false,
    sheetRows: maxRows + 3,
  });
  const sheet = book.Sheets.Pengguna;
  if (!sheet || !sheet["!ref"])
    throw new Error("Lembar Pengguna tidak ditemukan.");
  const range = XLSX.utils.decode_range(sheet["!fullref"] ?? sheet["!ref"]);
  if (range.e.r > maxRows + 1 || range.e.c > 3)
    throw new Error("Maksimal 50 baris dan empat kolom.");
  if (
    headers.some(
      (header, i) => sheet[XLSX.utils.encode_cell({ r: 0, c: i })]?.v !== header
    )
  )
    throw new Error("Kolom wajib: telegram_id, nama, role, kode_sf.");
  const rows: ImportRow[] = [];
  for (let r = 1; r <= range.e.r; r++) {
    const cells = headers.map(
      (_, c) => sheet[XLSX.utils.encode_cell({ r, c })]
    );
    if (cells.every((cell) => !cell || cell.v === "")) continue;
    const errors: string[] = [];
    if (cells.some((cell) => cell && (cell.f || cell.t !== "s")))
      errors.push(
        "Semua nilai harus teks, tanpa formula (ID angka ditolak untuk mencegah pembulatan)."
      );
    const [telegramId = "", name = "", role = "", code = ""] = cells.map(
      (cell) => (typeof cell?.v === "string" ? cell.v.trim() : "")
    );
    if (!telegramIdSchema.max(20).safeParse(telegramId).success)
      errors.push("Telegram ID tidak valid.");
    if (!name || name.length > 256 || /[\p{Cc}\p{Cf}]/u.test(name))
      errors.push("Nama wajib, maksimal 256 karakter tanpa karakter kontrol.");
    if (!accountRoleSchema.safeParse(role).success)
      errors.push("Role tidak valid.");
    if (role === "sales_force" ? !code || code.length > 256 : !!code)
      errors.push(
        "kode_sf hanya wajib untuk sales_force; kosongkan untuk role lain."
      );
    rows.push({
      row: r + 1,
      telegramId,
      name,
      role,
      code,
      salesForceId: null,
      errors,
      duplicate: false,
    });
  }
  if (!rows.length || rows.length > maxRows)
    throw new Error("Isi 1–50 baris pengguna.");
  return rows;
}
export async function validateImport(db: D1Database, rows: ImportRow[]) {
  const found = await db
    .prepare(`SELECT input.key AS idx,
    EXISTS (SELECT 1 FROM telegram_identities WHERE telegram_user_id = json_extract(input.value, '$.telegramId')) AS registered,
    (SELECT count(*) FROM sales_force WHERE id = json_extract(input.value, '$.code') COLLATE NOCASE AND demo_only = 0) AS matches,
    (SELECT id FROM sales_force WHERE id = json_extract(input.value, '$.code') COLLATE NOCASE AND demo_only = 0 LIMIT 1) AS sf
    FROM json_each(?) input`)
    .bind(JSON.stringify(rows))
    .all<{
      idx: number;
      registered: number;
      matches: number;
      sf: string | null;
    }>();
  const claims = await db
    .prepare(`SELECT sales_force_id AS id FROM users WHERE sales_force_id IN
    (SELECT id FROM sales_force WHERE id COLLATE NOCASE IN (SELECT json_extract(value, '$.code') FROM json_each(?)))`)
    .bind(JSON.stringify(rows))
    .all<{ id: string }>();
  for (const match of found.results) {
    const row = rows[match.idx]!;
    if (match.registered)
      row.errors.push(
        "Telegram ID sudah terdaftar (termasuk akun nonaktif/ditolak)."
      );
    if (row.role === "sales_force") {
      if (match.matches !== 1)
        row.errors.push("Kode Sales Force tidak ditemukan atau ambigu.");
      else {
        row.salesForceId = match.sf;
        if (claims.results.some((claim) => claim.id === match.sf))
          row.errors.push("Sales Force sudah terhubung dengan akun lain.");
      }
    }
  }
  for (const row of rows) {
    if (
      rows.filter((other) => other.telegramId === row.telegramId).length > 1 ||
      (row.salesForceId &&
        rows.filter((other) => other.salesForceId === row.salesForceId).length >
          1)
    ) {
      row.duplicate = true;
      row.errors.push(
        "Duplikat Telegram ID atau asosiasi Sales Force dalam berkas."
      );
    }
  }
  return {
    rows,
    total: rows.length,
    valid: rows.filter((row) => !row.errors.length).length,
    invalid: rows.filter((row) => row.errors.length).length,
    duplicates: rows.filter((row) => row.duplicate).length,
  };
}
export function userImportRoutes() {
  const app = new Hono<WebEnv>();
  app.use("*", async (c, next) => {
    const account = await sessionAccount(c.req.raw, c.env.DB);
    if (!account) return c.json({ error: "Unauthorized" }, 401);
    // Real Telegram-backed Admin only: demo accounts cannot import real users.
    const real = await c.env.DB.prepare(
      "SELECT 1 FROM telegram_identities WHERE user_id = ?"
    )
      .bind(account.id)
      .first();
    if (account.role !== "admin" || !real)
      return c.json({ error: "Forbidden" }, 403);
    await next();
  });
  app.use(
    "*",
    bodyLimit({
      maxSize: 400000,
      onError: (c) => c.json({ error: "Berkas terlalu besar" }, 400),
    })
  );
  app.get("/template", (c) =>
    c.json({
      content: btoa(String.fromCharCode(...new Uint8Array(importTemplate()))),
    })
  );
  for (const mode of ["preview", "commit"] as const)
    app.post("/" + mode, async (c) => {
      try {
        const input = await c.req.json<{
          filename: string;
          content: string;
          operationId?: string;
          confirm?: boolean;
          confirmAdmins?: boolean;
        }>();
        if (
          typeof input.filename !== "string" ||
          !/\.xlsx$/i.test(input.filename) ||
          typeof input.content !== "string" ||
          input.content.length > 350000
        )
          return c.json({ error: "Pilih berkas .xlsx maksimal 256 KiB." }, 400);
        const hash = await hashToken(c.req.header("Authorization")!.slice(7));
        const importHash = await hashToken(input.content);
        if (mode === "commit") {
          if (
            !webOperationIdSchema.safeParse(input.operationId).success ||
            input.confirm !== true
          )
            return c.json({ error: "Konfirmasi impor diperlukan." }, 400);
          const previous = await c.env.DB.prepare(
            `SELECT count(*) AS total, sum(CASE WHEN json_extract(after_state, '$.importHash') = ? THEN 1 ELSE 0 END) AS matching FROM access_audit WHERE id > ? AND id < ? AND actor_user_id = (SELECT user_id FROM web_sessions WHERE token_hash = ?)`
          )
            .bind(importHash, ...operationRange(input.operationId!), hash)
            .first<{ total: number; matching: number }>();
          if (previous?.total)
            return previous.matching === previous.total
              ? c.json({ imported: previous.total, replayed: true })
              : c.json(
                  { error: "ID operasi sudah dipakai untuk data lain." },
                  409
                );
        }
        const preview = await validateImport(
          c.env.DB,
          parseImport(
            Uint8Array.from(atob(input.content), (ch) => ch.charCodeAt(0))
          )
        );
        if (mode === "preview") return c.json(preview);
        if (preview.invalid)
          return c.json({ error: "Semua baris harus valid.", ...preview }, 409);
        if (
          preview.rows.some((row) => row.role === "admin") &&
          input.confirmAdmins !== true
        )
          return c.json(
            { error: "Konfirmasi khusus pembuatan akun Admin diperlukan." },
            400
          );
        const rows = preview.rows.map((row) => ({
          ...row,
          id: crypto.randomUUID(),
        }));
        const data = JSON.stringify(rows);
        // One all-or-nothing eligibility gate for the entire file, inside the write transaction.
        const gate = `${webAdminGuard} AND ${operationWriteGuard} AND NOT EXISTS (
        SELECT 1 FROM json_each(?) entry WHERE
          EXISTS (SELECT 1 FROM telegram_identities WHERE telegram_user_id = json_extract(entry.value, '$.telegramId')) OR
          (json_extract(entry.value, '$.salesForceId') IS NOT NULL AND (
            (SELECT count(*) FROM sales_force WHERE id = json_extract(entry.value, '$.salesForceId') COLLATE NOCASE AND demo_only = 0) <> 1 OR
            EXISTS (SELECT 1 FROM users WHERE sales_force_id = json_extract(entry.value, '$.salesForceId')))))`;
        const [created] = await c.env.DB.batch([
          c.env.DB.prepare(`INSERT INTO users (id, display_name, status, role, sales_force_id)
          SELECT json_extract(value, '$.id'), json_extract(value, '$.name'), 'active', json_extract(value, '$.role'), json_extract(value, '$.salesForceId') FROM json_each(?) WHERE ${gate} RETURNING id`).bind(
            data,
            hash,
            ...operationWriteBindings(input.operationId!),
            data
          ),
          c.env.DB.prepare(`INSERT INTO telegram_identities (user_id, telegram_user_id)
          SELECT u.id, json_extract(entry.value, '$.telegramId') FROM json_each(?) entry JOIN users u ON u.id = json_extract(entry.value, '$.id')`).bind(
            data
          ),
          c.env.DB.prepare(`INSERT INTO access_audit (id, actor_user_id, target_user_id, action, before_state, after_state)
          SELECT ? || ':' || u.id, (SELECT user_id FROM web_sessions WHERE token_hash = ?), u.id, 'register', 'null',
          json_object('status', u.status, 'role', u.role, 'salesForceId', u.sales_force_id, 'displayName', u.display_name, 'channel', 'excel_import', 'importHash', ?)
          FROM json_each(?) entry JOIN users u ON u.id = json_extract(entry.value, '$.id')`).bind(
            input.operationId!,
            hash,
            importHash,
            data
          ),
        ]);
        if (created!.results.length !== rows.length)
          return c.json(
            {
              error:
                "Data berubah atau operasi kedaluwarsa. Pratinjau ulang diperlukan.",
            },
            409
          );
        return c.json({ imported: rows.length, replayed: false }, 201);
      } catch (error) {
        return c.json(
          {
            error:
              error instanceof Error &&
              /^(Berkas|Arsip|Lembar|Kolom|Maksimal|Isi )/.test(error.message)
                ? error.message
                : "Impor gagal. Periksa hasil operasi sebelum mencoba kembali.",
          },
          400
        );
      }
    });
  return app;
}
