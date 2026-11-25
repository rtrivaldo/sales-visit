import {
  visitDraftPayloadSchema,
  visitWizardInputSchema,
  visitQuestions,
  parseVisitAnswer,
  visitReportSchema,
  type BotActor,
  type VisitDraftPayload,
  type VisitDraftStep,
  type VisitDraftView,
  type VisitWizardResult,
} from "@sales-visit/contracts";
import { createDb } from "@sales-visit/db";

import { createVisit, OperationError, submissionId } from "../operations.ts";
import { planningBatch } from "../planning-access.ts";

const TTL = 24 * 3600000;
const active = new Set(["outlet", "time", "notes", "followUp", "review"]);
type Row = {
  userId: string;
  currentSf: string;
  key: string | null;
  salesForceId: string;
  step: VisitDraftStep;
  payload: string;
  revision: number;
  lastMessage: number;
  expiresAt: number;
  visitId: string | null;
};
function readPayload(value: string): VisitDraftPayload {
  try {
    return visitDraftPayloadSchema.parse(JSON.parse(value));
  } catch {
    throw new Error("Invalid stored draft");
  }
}
const view = (row: Row): VisitDraftView | null =>
  row.key
    ? {
        step: row.step,
        payload: readPayload(row.payload),
        expiresAt: row.expiresAt,
        visitId: row.visitId,
      }
    : null;
const success = (
  row: Row,
  notice?:
    | "stale"
    | "invalid_input"
    | "outlet_missing"
    | "link_changed"
    | "busy"
): VisitWizardResult => ({ ok: true, data: { draft: view(row), notice } });

export class VisitWizard {
  constructor(private readonly db: D1Database) {}

  private async read(actor: BotActor): Promise<Row | undefined> {
    const result = await planningBatch(this.db, actor, "own", (guard) => [
      {
        sql: `SELECT u.id AS userId, u.sales_force_id AS currentSf,
        d.submission_key AS key, d.sales_force_id AS salesForceId, d.step,
        d.payload, d.revision, d.last_message AS lastMessage,
        d.expires_at AS expiresAt, d.visit_id AS visitId
        FROM users u JOIN telegram_identities t ON t.user_id = u.id
        LEFT JOIN telegram_visit_drafts d ON d.user_id = u.id
        WHERE t.telegram_user_id = ? AND ${guard}`,
        values: [actor.telegramUserId],
      },
    ]);
    if (!result.ok) {
      if (result.code === "unavailable") throw new Error("storage");
      return undefined;
    }
    return result.data[0]?.results[0] as Row | undefined;
  }

  // Optimistic revision + per-owner private-chat message watermark. A failed CAS
  // never retries the input against a different step. Telegram duplicates can
  // repeat the current prompt, but cannot advance it again.
  private async change(
    actor: BotActor,
    row: Row,
    messageId: number,
    set: string,
    values: (string | number | null)[],
    pin = true
  ) {
    const result = await planningBatch(this.db, actor, "own", (guard) => [
      {
        sql: `UPDATE telegram_visit_drafts SET ${set}, revision = revision + 1,
        last_message = ? WHERE user_id = ? AND submission_key = ?
        AND revision = ? AND last_message < ? AND ${guard}
        ${pin ? "AND sales_force_id = (SELECT salesForceId FROM actor)" : ""}`,
        values: [
          ...values,
          messageId,
          row.userId,
          row.key,
          row.revision,
          messageId,
        ],
      },
    ]);
    if (!result.ok) {
      if (result.code === "unavailable") throw new Error("storage");
      return false;
    }
    return result.data[0]?.meta.changes === 1;
  }

  async handle(actor: BotActor, input: unknown): Promise<VisitWizardResult> {
    const parsed = visitWizardInputSchema.safeParse(input);
    if (!parsed.success) return { ok: false, code: "invalid" };
    try {
      return await this.transition(actor, parsed.data);
    } catch {
      return { ok: false, code: "unavailable" };
    }
  }

  private async transition(
    actor: BotActor,
    input: ReturnType<typeof visitWizardInputSchema.parse>
  ): Promise<VisitWizardResult> {
    let row = await this.read(actor);
    if (!row) return { ok: false, code: "forbidden" };
    const userId = row.userId;
    const { action, messageId } = input;
    if (action === "peek") return success(row);
    const now = Date.now();
    const expired = row.key && active.has(row.step) && row.expiresAt <= now;

    if (
      action === "start" &&
      (!row.key ||
        ["cancelled", "expired", "submitted"].includes(row.step) ||
        expired)
    ) {
      if (row.key && messageId <= row.lastMessage) return success(row, "stale");
      const key = crypto.randomUUID();
      if (row.key) {
        await this.change(
          actor,
          row,
          messageId,
          "submission_key = ?, sales_force_id = ?, step = 'outlet', payload = '{}', expires_at = ?, visit_id = NULL",
          [key, row.currentSf, now + TTL],
          false
        );
      } else {
        const result = await planningBatch(this.db, actor, "own", (guard) => [
          {
            sql: `INSERT INTO telegram_visit_drafts
            (user_id, submission_key, sales_force_id, step, payload, revision, last_message, expires_at)
            SELECT ?, ?, salesForceId, 'outlet', '{}', 0, ?, ? FROM actor
            WHERE ${guard} ON CONFLICT(user_id) DO NOTHING`,
            values: [userId, key, messageId, now + TTL],
          },
        ]);
        if (!result.ok)
          return {
            ok: false,
            code: result.code === "forbidden" ? "forbidden" : "unavailable",
          };
      }
      const latest = await this.read(actor);
      return latest ? success(latest) : { ok: false, code: "forbidden" };
    }
    if (!row.key) return success(row);

    // Confirmations are recoverable even with the original message ID after a
    // crash between Visit commit and receipt finalization. Never thaw payloads.
    if (action === "confirm" && ["submitting", "submitted"].includes(row.step))
      return this.submit(actor, row);
    if (messageId <= row.lastMessage) return success(row, "stale");
    if (row.step === "submitting") {
      if (action !== "cancel") return success(row, "busy");
      const id = await submissionId(
        { salesForceId: row.salesForceId, submissionChannel: "telegram" },
        row.key,
        "visit"
      );
      // Cancellation and the guarded Visit INSERT serialize in D1. If the
      // Visit won, cancellation cannot erase its recoverable receipt.
      const frozen = row;
      const result = await planningBatch(this.db, actor, "own", (guard) => [
        {
          sql: `UPDATE telegram_visit_drafts SET step = 'cancelled', payload = '{}',
          revision = revision + 1, last_message = ?
          WHERE user_id = ? AND submission_key = ? AND revision = ?
          AND last_message < ? AND ${guard}
          AND NOT EXISTS (SELECT 1 FROM visits WHERE id = ?)`,
          values: [
            messageId,
            frozen.userId,
            frozen.key,
            frozen.revision,
            messageId,
            id,
          ],
        },
      ]);
      if (!result.ok)
        return {
          ok: false,
          code: result.code === "forbidden" ? "forbidden" : "unavailable",
        };
      const latest = await this.read(actor);
      if (!latest) return { ok: false, code: "forbidden" };
      return latest.step === "submitting"
        ? this.submit(actor, latest)
        : success(latest);
    }
    if (action === "cancel" && active.has(row.step)) {
      await this.change(
        actor,
        row,
        messageId,
        "step = 'cancelled', payload = '{}'",
        [],
        false
      );
    } else if (expired) {
      await this.change(
        actor,
        row,
        messageId,
        "step = 'expired', payload = '{}'",
        [],
        false
      );
    } else if (row.salesForceId !== row.currentSf) {
      return success(row, "link_changed");
    } else if (action === "confirm" && row.step === "review") {
      if (!visitReportSchema.safeParse(readPayload(row.payload)).success) {
        await this.change(actor, row, messageId, "step = 'notes'", []);
        const latest = await this.read(actor);
        return latest
          ? success(latest, "invalid_input")
          : { ok: false, code: "forbidden" };
      }
      const changed = await this.change(
        actor,
        row,
        messageId,
        "step = 'submitting'",
        []
      );
      const latest = await this.read(actor);
      if (!latest) return { ok: false, code: "forbidden" };
      if (
        latest.key === row.key &&
        ["submitting", "submitted"].includes(latest.step)
      )
        return this.submit(actor, latest);
      return success(latest, changed ? undefined : "stale");
    } else if (action === "answer" && active.has(row.step)) {
      const payload = readPayload(row.payload);
      const value = input.value ?? "";
      const expected = row.step === "time" ? "time" : row.step;
      if (
        (input.field !== undefined && input.field !== expected) ||
        !value.trim()
      )
        return success(row, "invalid_input");
      let next: VisitDraftStep;
      if (row.step === "outlet") {
        // Narrow SF-only lookup for Visit entry, not Outlet management/listing.
        const id = visitDraftPayloadSchema.shape.outletId.safeParse(value);
        if (!id.success) return success(row, "invalid_input");
        const result = await planningBatch(this.db, actor, "own", (guard) => [
          {
            sql: `SELECT id, name, business_id AS businessId FROM outlets WHERE business_id = ? COLLATE NOCASE AND ${guard} LIMIT 2`,
            values: [id.data!],
          },
        ]);
        if (!result.ok)
          return {
            ok: false,
            code: result.code === "forbidden" ? "forbidden" : "unavailable",
          };
        const outlet = result.data[0]?.results[0] as
          | { id: string; name: string; businessId: string }
          | undefined;
        if (!outlet || result.data[0]?.results.length !== 1)
          return success(row, "outlet_missing");
        payload.outletId = outlet.id as string;
        // Bounded snapshot for preview; the key is exact and never truncated.
        payload.outletName = [...String(outlet.name)].slice(0, 256).join("");
        payload.outletBusinessId = outlet.businessId;
        payload.visitedAt = new Date(now).toISOString();
        // Reuse the durable draft's answer state; question position is derived
        // from missing fields, not Worker memory. Legacy steps remain readable.
        next = "notes";
      } else if (
        row.step === "notes" ||
        row.step === "time" ||
        row.step === "followUp"
      ) {
        const question = visitQuestions.find(
          ([key]) => payload[key] === undefined
        );
        if (!question) return success(row, "invalid_input");
        const answer = parseVisitAnswer(question[0], value);
        if (answer === undefined) return success(row, "invalid_input");
        Object.assign(payload, { [question[0]]: answer });
        payload.visitedAt ??= new Date(now).toISOString();
        next = visitQuestions.every(([key]) => payload[key] !== undefined)
          ? "review"
          : "notes";
      } else return success(row, "invalid_input");
      const changed = await this.change(
        actor,
        row,
        messageId,
        "step = ?, payload = ?",
        [next, JSON.stringify(visitDraftPayloadSchema.parse(payload))]
      );
      const latest = await this.read(actor);
      return latest
        ? success(latest, changed ? undefined : "stale")
        : { ok: false, code: "forbidden" };
    } else
      return success(row, action === "start" ? undefined : "invalid_input");
    row = await this.read(actor);
    return row ? success(row) : { ok: false, code: "forbidden" };
  }

  private async submit(actor: BotActor, row: Row): Promise<VisitWizardResult> {
    if (row.salesForceId !== row.currentSf) return success(row, "link_changed");
    if (row.step === "submitted" && row.visitId) return success(row);
    const payload = readPayload(row.payload);
    try {
      const report = visitReportSchema.safeParse(payload);
      let visitId: string;
      if (!report.success) {
        // Recover receipts committed by the pre-upgrade wizard without
        // fabricating financial fields or replaying a now-invalid old write.
        const id = await submissionId(
          { salesForceId: row.currentSf, submissionChannel: "telegram" },
          row.key,
          "visit"
        );
        const existing = await planningBatch(this.db, actor, "own", (guard) => [
          {
            sql: `SELECT id FROM visits WHERE id = ? AND sales_force_id = (SELECT salesForceId FROM actor) AND ${guard}`,
            values: [id],
          },
        ]);
        if (!existing.ok)
          return {
            ok: false,
            code: existing.code === "forbidden" ? "forbidden" : "unavailable",
          };
        if (!existing.data[0]?.results.length)
          return success(row, "invalid_input");
        visitId = id;
      } else {
        const result = await createVisit(
          createDb(this.db),
          {
            salesForceId: row.currentSf,
            submissionChannel: "telegram",
          },
          row.key,
          {
            ...report.data,
            outletId: payload.outletId,
            visitedAt: payload.visitedAt,
            notes: payload.notes,
            followUp: payload.followUp,
          },
          {
            telegramUserId: actor.telegramUserId,
            userId: row.userId,
            draftKey: row.key!,
          }
        );
        visitId = result.data.id;
      }
      // Separate recoverable finalization. A failed write leaves submitting and
      // the immutable UUID/payload; the next confirmation replays createVisit.
      const final = await planningBatch(this.db, actor, "own", (guard) => [
        {
          sql: `UPDATE telegram_visit_drafts SET step = 'submitted', visit_id = ?, revision = revision + 1
          WHERE user_id = ? AND submission_key = ? AND step = 'submitting'
          AND sales_force_id = (SELECT salesForceId FROM actor) AND ${guard}`,
          values: [visitId, row.userId, row.key],
        },
      ]);
      if (!final.ok)
        return {
          ok: false,
          code: final.code === "forbidden" ? "forbidden" : "unavailable",
        };
      return success({ ...row, step: "submitted", visitId });
    } catch (error) {
      if (error instanceof OperationError) {
        if (error.status === 401) return { ok: false, code: "forbidden" };
        if (error.status === 404) return success(row, "outlet_missing");
      }
      throw error;
    }
  }
}
