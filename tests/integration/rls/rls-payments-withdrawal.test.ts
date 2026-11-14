/**
 * Integration tests: slice 1d DB additions (e2e project only)
 * Journey: payments-slice1d-withdrawal
 * Criteria: WD-J3-C06, WD-J7-C06, WD-J8-C01..C07
 *
 * Coverage:
 *   - private.withdrawal_deadline: 2026-2030 grid (every movable holiday, Store bededag a working
 *     day, 1 Jan, 5 Jun, 24/25/26/31 Dec, weekends), DST, information later than the start
 *   - started_at set-once through payments_sync_subscription
 *   - grants: anon/authenticated 42501 on every Worker function (begin, claim, step, pending_work,
 *     mark_consent_info_sent, record_checkout_consent); RLS select own/admin; consents append-only
 *   - payments_begin_withdrawal: ownership/status/started_at/window_expired; double begin → existing; one row per
 *     subscription (UNIQUE backstop; no two-client race test: it would need committed fixtures on the shared project)
 *   - payments_pending_work: A2 (ended contracts' confirmations left out), user null, 30 days, stamped;
 *     withdrawals with work and no live lease, the email-only ones under the mail cap, least recently
 *     updated first; argument ranges
 *   - payments_claim_withdrawal: claimed / busy / done, attempts, the lease
 *   - payments_withdrawal_step: canceled, needs_manual, ack_sent, alerted, failed (applied, already,
 *     refused, the lease kept or released); "refunded" increments amount_refunded_ore once; CHECK
 *     refund ≤ total; "no_refund_due" (paid > 0 only with consent); needs_manual → refunded once
 *     canceled_at is set (the README's manual recording)
 *   - payments_mark_consent_info_sent: first stamp wins, unknown consent, malformed arguments
 *   - my_withdrawal_status: null, the exact shapes with a withdrawal and an invoice, 42501 without auth.uid
 *   - terms system page row + reserved slug
 *
 * Fixtures: subscriptions need plan_id + last_event_created, subscription_invoices email/paid_at/
 * user_id; node-postgres returns timestamptz as Date (compared as ISO); the over-refund reaches the
 * CHECK through a refund already recorded on the invoice; the started_at case uses a second event
 * (the same event id is a duplicate that writes nothing); a retained amount needs a consent
 * (without one retention_basis is no_consent). The database's lists are shared with other suites:
 * a pending_work assertion looks only at this file's rows (dated so they sort first).
 *
 * Run: npm run test:integration:e2e-project -- tests/integration/rls/rls-payments-withdrawal.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getClient, type PoolClient } from "./helpers/db.js";
import {
  asRole,
  asServiceRole,
  expectPgError,
  seedAdmin,
  seedAuthUser,
  seedDraftPage,
  withTx,
  ANON_CLAIMS,
  ADMIN_CLAIMS,
  NON_ADMIN_CLAIMS,
} from "./helpers/roles.js";

const SKIP = !process.env.SUPABASE_E2E_REF;

// ── Namespace (prefix 0d1d = withdrawal-1d) ───────────────────────────────────

const USER_UUID   = "00000000-0000-0000-0d1d-000000000001";
const USER_EMAIL  = "e2e-pay1d-wd@alnyron-test.local";
const USER2_UUID  = "00000000-0000-0000-0d1d-000000000002";
const USER2_EMAIL = "e2e-pay1d-wd2@alnyron-test.local";
const SUB_ID      = "sub_1dintegtest001";
const SESSION_ID  = "cs_test_1dintegtest001";
const MONTHLY_PRICE_ID = "price_1Ub3CoFIgZG2PjS1sJ7VtPSS"; // from seed-e2e
const TEXT_VERSION = "2026-11-14.1";
const TEXT_SHA256_DA = "2bf84400d9b6d203cd554494a295ab53cbe92eba464220e8da9ec2ba12bd6aea";

// Started yesterday (the database clock decides the window): without a consent the deadline
// is start + 14 days + 12 months, so the window is open whenever the suite runs.
const STARTED_AT = new Date(Date.now() - 86_400_000).toISOString();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A timestamptz as node-postgres returns it (a Date) or as text, as ISO 8601 UTC. */
function iso(value: unknown): string {
  return (value instanceof Date ? value : new Date(String(value))).toISOString();
}

/** A subscription of the seeded monthly plan (as postgres), active unless `status` says otherwise. */
async function seedSubscription(
  c: PoolClient,
  userId: string,
  subId: string,
  startedAt: string | null = STARTED_AT,
  status = "active",
): Promise<void> {
  await c.query(
    `INSERT INTO public.subscriptions
       (user_id, stripe_subscription_id, stripe_customer_id, plan_id, status, started_at, cancel_at_period_end, last_event_created)
     VALUES ($1, $2, 'cus_1dtest', (SELECT id FROM public.monitor_plans WHERE stripe_price_id = $3), $5,
             $4::timestamptz, false, now())`,
    [userId, subId, MONTHLY_PRICE_ID, startedAt, status],
  );
}

/** A paid invoice of `subId` (as postgres); `refundedOre` is what earlier refunds took back. */
async function seedInvoice(c: PoolClient, subId: string, invoiceId: string, paidOre = 1000, refundedOre = 0): Promise<void> {
  await c.query(
    `INSERT INTO public.subscription_invoices
       (stripe_invoice_id, stripe_subscription_id, user_id, email, amount_total_ore, amount_tax_ore, amount_refunded_ore,
        period_start, period_end, paid_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z', now())`,
    [invoiceId, subId, USER_UUID, USER_EMAIL, paidOre, Math.round(paidOre * 0.2), refundedOre],
  );
}

/** The Checkout consent of `subId` (service_role writer). */
async function recordConsent(c: PoolClient, subId: string): Promise<Record<string, unknown>> {
  const { rows } = await c.query<{ result: Record<string, unknown> }>(
    "SELECT public.payments_record_checkout_consent($1::jsonb) AS result",
    [JSON.stringify({
      checkout_session_id: SESSION_ID, subscription_id: subId, text_version: TEXT_VERSION, text_sha256: TEXT_SHA256_DA,
      locale: "da", stripe_consent: "accepted", accepted_at: STARTED_AT,
    })],
  );
  return rows[0]!.result;
}

async function beginWithdrawal(c: PoolClient, userId: string, subId: string): Promise<Record<string, unknown>> {
  const { rows } = await c.query<{ result: Record<string, unknown> }>(
    `SELECT public.payments_begin_withdrawal($1, $2, 'Test Consumer', $3, $4, 'da') AS result`,
    [userId, subId, USER_EMAIL, TEXT_VERSION],
  );
  return rows[0]!.result;
}

/** The withdrawal id of a begin answer. */
function withdrawalId(answer: Record<string, unknown>): string {
  const withdrawal = answer["withdrawal"];
  if (typeof withdrawal !== "object" || withdrawal === null || !("id" in withdrawal) || typeof withdrawal.id !== "string") {
    throw new Error("begin answered no withdrawal id");
  }
  return withdrawal.id;
}

async function step(c: PoolClient, id: string, name: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { rows } = await c.query<{ result: Record<string, unknown> }>(
    "SELECT public.payments_withdrawal_step($1, $2, $3::jsonb) AS result",
    [id, name, JSON.stringify(data)],
  );
  return rows[0]!.result;
}

async function invoiceRefunded(c: PoolClient, invoiceId: string): Promise<number> {
  const { rows } = await c.query<{ refunded: string }>(
    "SELECT amount_refunded_ore AS refunded FROM public.subscription_invoices WHERE stripe_invoice_id = $1",
    [invoiceId],
  );
  return Number(rows[0]?.refunded);
}

type WithdrawalSeed = {
  status?: "received" | "canceled" | "completed" | "needs_manual";
  attempts?: number;
  ackSent?: boolean;
  alerted?: boolean;
  /** lease_until = now() + this many seconds (negative: an expired lease); none by default. */
  leaseSeconds?: number;
  /** updated_at (ISO); now() by default. */
  updatedAt?: string;
};

/**
 * A withdrawal of `subId` in the given state, inserted as postgres: received has no cancel,
 * canceled and needs_manual (invoice_shape) are canceled, completed refunded nothing.
 */
async function seedWithdrawal(c: PoolClient, subId: string, seed: WithdrawalSeed = {}): Promise<string> {
  const status = seed.status ?? "received";
  const completed = status === "completed";
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO public.subscription_withdrawals
       (stripe_subscription_id, user_id, consumer_name, ack_email, statement_version, locale, deadline_at, retention_basis,
        status, manual_reason, canceled_at, paid_ore, retained_ore, refund_ore, refund_tax_ore, calc_version,
        ack_sent_at, alerted_at, attempts, lease_until, updated_at)
     VALUES ($1, $2, 'Test Consumer', $3, $4, 'da', now() + interval '14 days', 'no_consent',
             $5, $6, $7::timestamptz, $8::bigint, $8::bigint, $8::bigint, $8::bigint, $9,
             $10::timestamptz, $11::timestamptz, $12,
             CASE WHEN $13::integer IS NULL THEN NULL ELSE now() + make_interval(secs => $13::integer) END,
             coalesce($14::timestamptz, now()))
     RETURNING id`,
    [
      subId, USER_UUID, USER_EMAIL, TEXT_VERSION, status,
      status === "needs_manual" ? "invoice_shape" : null,
      status === "received" ? null : "2026-11-14T00:00:00Z",
      completed ? 0 : null,
      completed ? "wd-refund-1" : null,
      seed.ackSent === true ? "2026-11-14T01:00:00Z" : null,
      seed.alerted === true ? "2026-11-14T01:00:01Z" : null,
      seed.attempts ?? 0,
      seed.leaseSeconds ?? null,
      seed.updatedAt ?? null,
    ],
  );
  return rows[0]!.id;
}

type ConsentSeed = { userId?: string | null; acceptedDaysAgo?: number; sent?: boolean };

/** A Checkout consent of `subId` (as postgres): accepted 29 days ago, of USER_UUID, unsent, unless told otherwise. */
async function seedConsent(c: PoolClient, subId: string, session: string, seed: ConsentSeed = {}): Promise<void> {
  await c.query(
    `INSERT INTO public.subscription_consents
       (stripe_checkout_session_id, stripe_subscription_id, user_id, text_version, text_sha256, locale, stripe_consent,
        accepted_at, info_sent_at, info_email_id)
     VALUES ($1, $2, $3, $4, $5, 'da', 'accepted', now() - make_interval(days => $6::integer),
             CASE WHEN $7::boolean THEN now() END, CASE WHEN $7::boolean THEN 'email_seeded' END)`,
    [session, subId, seed.userId === undefined ? USER_UUID : seed.userId, TEXT_VERSION, TEXT_SHA256_DA, seed.acceptedDaysAgo ?? 29, seed.sent === true],
  );
}

type PendingWork = { withdrawals: string[]; consents: { checkout_session_id: string }[] };

/** `payments_pending_work(limit, maxMailAttempts)` as the current role. */
async function pendingWork(c: PoolClient, limit = 50, maxMailAttempts = 24): Promise<PendingWork> {
  const { rows } = await c.query<{ result: PendingWork }>("SELECT public.payments_pending_work($1, $2) AS result", [limit, maxMailAttempts]);
  return rows[0]!.result;
}

/** `payments_claim_withdrawal` as the current role: its outcome and the withdrawal's attempts. */
async function claim(c: PoolClient, id: string, leaseSeconds = 120): Promise<[string, number]> {
  const { rows } = await c.query<{ outcome: string; attempts: number }>(
    `SELECT r ->> 'outcome' AS outcome, (r -> 'withdrawal' ->> 'attempts')::integer AS attempts
       FROM (SELECT public.payments_claim_withdrawal($1, $2) AS r) q`,
    [id, leaseSeconds],
  );
  return [rows[0]!.outcome, rows[0]!.attempts];
}

/** A step answer as [outcome, status, manual_reason, canceled_at (ISO or null)]. */
function summary(answer: Record<string, unknown>): unknown[] {
  const withdrawal = answer["withdrawal"];
  if (typeof withdrawal !== "object" || withdrawal === null) throw new Error("step answered no withdrawal");
  const record: Record<string, unknown> = { ...withdrawal };
  return [answer["outcome"], record["status"], record["manual_reason"], record["canceled_at"] === null ? null : iso(record["canceled_at"])];
}

/** The caller's `my_withdrawal_status()` (as the current role). */
async function myWithdrawalStatus(c: PoolClient): Promise<unknown> {
  const { rows } = await c.query<{ result: unknown }>("SELECT public.my_withdrawal_status() AS result");
  return rows[0]?.result;
}

const TIMESTAMP_KEYS: Record<string, true> = {
  started_at: true, deadline_at: true, requested_at: true, refunded_at: true, period_start: true, period_end: true,
};

/** `value` with every non-null timestamp field (jsonb text with an offset) as ISO 8601 UTC. */
function withIsoTimestamps(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withIsoTimestamps);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [
      key,
      TIMESTAMP_KEYS[key] === true && typeof field === "string" ? iso(field) : withIsoTimestamps(field),
    ]),
  );
}

// ── describe ──────────────────────────────────────────────────────────────────

describe.skipIf(SKIP)("slice 1d DB integration — rolled-back transactions", () => {
  let client: PoolClient;

  beforeAll(async () => { client = await getClient(); });
  afterAll(async () => { client.release(); });

  // ── Grant checks: anon + authenticated raise 42501 on every writer ──────────

  it("WD-T-DB-grants: anon CANNOT execute payments_begin_withdrawal (42501)", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedSubscription(c, USER_UUID, SUB_ID);
      await asRole(c, "anon", ANON_CLAIMS);
      await expectPgError(c, () => beginWithdrawal(c, USER_UUID, SUB_ID), "42501", "anon begin");
    });
  }, 15_000);

  it("WD-T-DB-grants: authenticated CANNOT execute payments_begin_withdrawal (42501)", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedSubscription(c, USER_UUID, SUB_ID);
      await asRole(c, "authenticated", { ...NON_ADMIN_CLAIMS, sub: USER_UUID });
      await expectPgError(c, () => beginWithdrawal(c, USER_UUID, SUB_ID), "42501", "authenticated begin");
    });
  }, 15_000);

  it("WD-T-DB-grants: anon CANNOT execute payments_record_checkout_consent (42501)", async () => {
    await withTx(client, async (c) => {
      await asRole(c, "anon", ANON_CLAIMS);
      await expectPgError(
        c,
        () => c.query(`SELECT public.payments_record_checkout_consent($1::jsonb)`, [
          JSON.stringify({ checkout_session_id: SESSION_ID, subscription_id: SUB_ID, text_version: TEXT_VERSION, text_sha256: "a".repeat(64), locale: "da", stripe_consent: "accepted", accepted_at: "2026-11-14T00:00:00Z" }),
        ]),
        "42501",
        "anon record_consent",
      );
    });
  }, 15_000);

  // ── RLS: select own/admin ───────────────────────────────────────────────────

  it("WD-T-DB-rls: authenticated user sees only own withdrawal rows", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAuthUser(c, USER2_UUID, USER2_EMAIL);
      await seedSubscription(c, USER_UUID, SUB_ID);
      await asServiceRole(c);
      await beginWithdrawal(c, USER_UUID, SUB_ID);
      const visible = async () =>
        (await c.query<{ id: string }>("SELECT id FROM public.subscription_withdrawals WHERE stripe_subscription_id = $1", [SUB_ID])).rows;
      await asRole(c, "authenticated", { role: "authenticated", sub: USER2_UUID });
      expect(await visible()).toHaveLength(0); // USER2 cannot see USER1's withdrawal
      await asRole(c, "authenticated", { role: "authenticated", sub: USER_UUID });
      expect(await visible()).toHaveLength(1); // the owner sees it
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      expect(await visible()).toHaveLength(1); // an admin sees it
    });
  }, 20_000);

  // ── started_at set-once ─────────────────────────────────────────────────────

  it("WD-T-DB-started_at: started_at set-once; second sync with different value is ignored", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      const sub = {
        id: SUB_ID, customer: "cus_1dtest", user_id: USER_UUID, price_id: MONTHLY_PRICE_ID,
        status: "active", current_period_end: null, cancel_at_period_end: false,
        start_date: "2026-11-14T00:00:00Z",
      };
      await asServiceRole(c);
      const sync = async (eventId: string, created: string, payload: Record<string, unknown>) =>
        (await c.query<{ result: { outcome: string } }>(
          "SELECT public.payments_sync_subscription($1::jsonb, $2::jsonb) AS result",
          [JSON.stringify({ id: eventId, type: "customer.subscription.updated", created, livemode: false }), JSON.stringify(payload)],
        )).rows[0]!.result.outcome;
      expect(await sync("evt_1d001", "2026-11-14T00:00:00Z", sub)).toBe("applied");
      // A later event with a different start_date is applied but must not overwrite started_at.
      expect(await sync("evt_1d002", "2026-11-14T01:00:00Z", { ...sub, start_date: "2027-01-01T00:00:00Z" })).toBe("applied");
      await c.query("RESET ROLE");
      const { rows } = await c.query<{ started_at: unknown }>(
        "SELECT started_at FROM public.subscriptions WHERE stripe_subscription_id = $1",
        [SUB_ID],
      );
      expect(rows[0]?.started_at).not.toBeNull();
      // started_at should still be the FIRST value
      expect(iso(rows[0]!.started_at)).toBe("2026-11-14T00:00:00.000Z");
    });
  }, 20_000);

  // ── begin_withdrawal: ownership / status / started_at / window ─────────────

  it("WD-T-DB-begin-ownership: begin_withdrawal with wrong user_id raises P0001 not_withdrawable", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAuthUser(c, USER2_UUID, USER2_EMAIL);
      await seedSubscription(c, USER_UUID, SUB_ID);
      await asServiceRole(c);
      await expectPgError(
        c,
        () => c.query(
          `SELECT public.payments_begin_withdrawal($1, $2, 'Test', $3, '2026-11-14.1', 'da')`,
          [USER2_UUID, SUB_ID, USER2_EMAIL],
        ),
        "P0001",
        "wrong user begin",
        { messageIncludes: "not_withdrawable" },
      );
    });
  }, 15_000);

  it("WD-T-DB-begin-window-expired: begin_withdrawal with past started_at raises P0001 window_expired", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      // started 2025-01-01, no consent: the deadline (start + 14 days + 12 months) passed in January 2026
      await seedSubscription(c, USER_UUID, SUB_ID, "2025-01-01T00:00:00Z");
      await asServiceRole(c);
      await expectPgError(
        c,
        () => c.query(
          `SELECT public.payments_begin_withdrawal($1, $2, 'Test', $3, '2026-11-14.1', 'da')`,
          [USER_UUID, SUB_ID, USER_EMAIL],
        ),
        "P0001",
        "window expired begin",
        { messageIncludes: "window_expired" },
      );
    });
  }, 15_000);

  it("WD-T-DB-begin-no-startedAt: begin_withdrawal with null started_at raises P0001 not_withdrawable", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedSubscription(c, USER_UUID, SUB_ID, null);
      await asServiceRole(c);
      await expectPgError(
        c,
        () => c.query(
          `SELECT public.payments_begin_withdrawal($1, $2, 'Test', $3, '2026-11-14.1', 'da')`,
          [USER_UUID, SUB_ID, USER_EMAIL],
        ),
        "P0001",
        "null started_at begin",
        { messageIncludes: "not_withdrawable" },
      );
    });
  }, 15_000);

  it("WD-T-DB-double-begin: second begin for same subscription returns existing row", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedSubscription(c, USER_UUID, SUB_ID);
      await asServiceRole(c);
      const r1 = await beginWithdrawal(c, USER_UUID, SUB_ID);
      const r2 = await beginWithdrawal(c, USER_UUID, SUB_ID);
      expect(r1["outcome"]).toBe("created");
      expect(r2["outcome"]).toBe("existing");
      expect(withdrawalId(r1)).toBe(withdrawalId(r2));
    });
  }, 20_000);

  // ── refunded step: increments amount_refunded_ore once; CHECK ──────────────

  it("WD-T-DB-refunded-once: refunded step increments amount_refunded_ore exactly once; replay is idempotent", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedSubscription(c, USER_UUID, SUB_ID);
      await seedInvoice(c, SUB_ID, "in_1dtest001", 1000);
      await asServiceRole(c);
      // A consent makes the basis `consent`, so part of the payment may be retained (33 / 967).
      await recordConsent(c, SUB_ID);
      const wId = withdrawalId(await beginWithdrawal(c, USER_UUID, SUB_ID));
      await step(c, wId, "canceled", { canceled_at: new Date().toISOString() });
      const refundedData = {
        stripe_invoice_id: "in_1dtest001", service_start_at: "2026-11-01T00:00:00Z",
        period_end_at: "2026-12-01T00:00:00Z",
        paid_ore: 1000, retained_ore: 33, refund_ore: 967, refund_tax_ore: 193,
        calc_version: "wd-refund-1", stripe_credit_note_id: "cn_1dtest001", stripe_refund_id: "re_1dtest001",
      };
      expect((await step(c, wId, "refunded", refundedData))["outcome"]).toBe("applied");
      expect(await invoiceRefunded(c, "in_1dtest001")).toBe(967);
      // Replay: same data → already; amount_refunded_ore stays at 967 (not doubled)
      expect((await step(c, wId, "refunded", refundedData))["outcome"]).toBe("already");
      expect(await invoiceRefunded(c, "in_1dtest001")).toBe(967);
    });
  }, 30_000);

  it("WD-T-DB-refund-check: refund > amount_total_ore rejected by CHECK constraint", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedSubscription(c, USER_UUID, SUB_ID);
      // 500 of the 1000 were refunded before (e.g. by hand), so a full 1000 refund would take back 1500.
      await seedInvoice(c, SUB_ID, "in_1dcheck001", 1000, 500);
      await asServiceRole(c);
      const wId = withdrawalId(await beginWithdrawal(c, USER_UUID, SUB_ID));
      await step(c, wId, "canceled", { canceled_at: new Date().toISOString() });
      const overRefund = {
        stripe_invoice_id: "in_1dcheck001", service_start_at: "2026-11-01T00:00:00Z",
        period_end_at: "2026-12-01T00:00:00Z",
        paid_ore: 1000, retained_ore: 0, refund_ore: 1000, refund_tax_ore: 200,
        calc_version: "wd-refund-1", stripe_credit_note_id: "cn_1dcheck001", stripe_refund_id: "re_1dcheck001",
      };
      await expectPgError(
        c,
        () => step(c, wId, "refunded", overRefund),
        "23514", // check_violation: subscription_invoices_refund_le_total
        "refund > total",
        { messageIncludes: "subscription_invoices_refund_le_total" },
      );
      expect(await invoiceRefunded(c, "in_1dcheck001")).toBe(500);
    });
  }, 20_000);

  // ── no_refund_due (A11) ─────────────────────────────────────────────────────

  it("WD-T-DB-A11a: no_refund_due with paid_ore > 0 and retention_basis no_consent → P0001 invalid_transition", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedSubscription(c, USER_UUID, SUB_ID);
      await asServiceRole(c);
      const wId = withdrawalId(await beginWithdrawal(c, USER_UUID, SUB_ID));
      await step(c, wId, "canceled", { canceled_at: new Date().toISOString() });
      await expectPgError(
        c,
        () => step(c, wId, "no_refund_due", { stripe_invoice_id: "in_1da11001", paid_ore: 1000, calc_version: "wd-refund-1" }),
        "P0001",
        "no_consent keeps a paid amount",
        { messageIncludes: "invalid_transition" },
      );
      // paid 0 completes without a refund
      const done = await step(c, wId, "no_refund_due", { stripe_invoice_id: null, paid_ore: 0, calc_version: "wd-refund-1" });
      expect(done["withdrawal"]).toMatchObject({ status: "completed", paid_ore: 0, retained_ore: 0, refund_ore: 0 });
    });
  }, 20_000);

  it("WD-T-DB-A11b: no_refund_due with paid_ore > 0 and a consent → completed, retained = paid, refund 0", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedSubscription(c, USER_UUID, SUB_ID);
      await asServiceRole(c);
      await recordConsent(c, SUB_ID);
      const wId = withdrawalId(await beginWithdrawal(c, USER_UUID, SUB_ID));
      await step(c, wId, "canceled", { canceled_at: new Date().toISOString() });
      const data = { stripe_invoice_id: "in_1da11002", paid_ore: 1000, calc_version: "wd-refund-1" };
      const done = await step(c, wId, "no_refund_due", data);
      expect(done).toMatchObject({
        outcome: "applied",
        withdrawal: { status: "completed", retention_basis: "consent", paid_ore: 1000, retained_ore: 1000, refund_ore: 0 },
      });
      expect((await step(c, wId, "no_refund_due", data))["outcome"]).toBe("already");
    });
  }, 20_000);

  // ── Manual handling: recording a refund made by hand (README runbook) ──────

  it("WD-T-DB-manual-refund: needs_manual → refunded refused until canceled_at; after the cancel step completed, invoice counted once", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedSubscription(c, USER_UUID, SUB_ID);
      await seedInvoice(c, SUB_ID, "in_1dmanual001", 1000);
      await asServiceRole(c);
      const wId = withdrawalId(await beginWithdrawal(c, USER_UUID, SUB_ID));
      // subscription_mismatch leaves the subscription running: no canceled_at.
      expect((await step(c, wId, "needs_manual", { reason: "subscription_mismatch" }))["withdrawal"]).toMatchObject({
        status: "needs_manual", canceled_at: null,
      });
      const refunded = {
        stripe_invoice_id: "in_1dmanual001", service_start_at: "2026-11-01T00:00:00Z",
        period_end_at: "2026-12-01T00:00:00Z",
        paid_ore: 1000, retained_ore: 0, refund_ore: 1000, refund_tax_ore: 200,
        calc_version: "wd-refund-1", stripe_credit_note_id: "cn_1dmanual001", stripe_refund_id: "re_1dmanual001",
      };
      await expectPgError(c, () => step(c, wId, "refunded", refunded), "P0001", "refund before the cancel", {
        messageIncludes: "invalid_transition",
      });
      // The owner canceled it in Stripe: the cancel is recorded and the status stays needs_manual.
      expect((await step(c, wId, "canceled", { canceled_at: new Date().toISOString() }))["withdrawal"]).toMatchObject({
        status: "needs_manual",
      });
      expect(await step(c, wId, "refunded", refunded)).toMatchObject({
        outcome: "applied",
        withdrawal: { status: "completed", manual_reason: "subscription_mismatch", refund_ore: 1000, stripe_credit_note_id: "cn_1dmanual001" },
      });
      expect((await step(c, wId, "refunded", refunded))["outcome"]).toBe("already");
      expect(await invoiceRefunded(c, "in_1dmanual001")).toBe(1000);
    });
  }, 20_000);

  // ── One withdrawal per subscription; consents append-only ────────────────────

  it("WD-T-DB-one-row: a second withdrawal row for the same subscription violates the UNIQUE constraint", async () => {
    // The writer-level half (a second begin resumes the first) is WD-T-DB-double-begin; begin locks
    // the subscription row FOR UPDATE first, and the UNIQUE key is the backstop for concurrent begins.
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedSubscription(c, USER_UUID, SUB_ID);
      await asServiceRole(c);
      await beginWithdrawal(c, USER_UUID, SUB_ID);
      await expectPgError(
        c,
        () => c.query(
          `INSERT INTO public.subscription_withdrawals
             (stripe_subscription_id, user_id, consumer_name, ack_email, statement_version, locale, deadline_at, retention_basis)
           VALUES ($1, $2, 'Second', $3, $4, 'da', now() + interval '1 day', 'no_consent')`,
          [SUB_ID, USER_UUID, USER_EMAIL, TEXT_VERSION],
        ),
        "23505",
        "second withdrawal row",
      );
    });
  }, 15_000);

  it("WD-T-DB-consent-append-only: a second record (other session, other locale) answers duplicate and changes nothing", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedSubscription(c, USER_UUID, SUB_ID);
      await asServiceRole(c);
      expect((await recordConsent(c, SUB_ID))["outcome"]).toBe("recorded");
      const { rows: second } = await c.query<{ result: Record<string, unknown> }>(
        "SELECT public.payments_record_checkout_consent($1::jsonb) AS result",
        [JSON.stringify({
          checkout_session_id: "cs_test_1dintegtest002", subscription_id: SUB_ID, text_version: TEXT_VERSION,
          text_sha256: "b".repeat(64), locale: "en", stripe_consent: "accepted", accepted_at: new Date().toISOString(),
        })],
      );
      expect(second[0]!.result["outcome"]).toBe("duplicate");
      await c.query("RESET ROLE");
      const { rows } = await c.query<{ stripe_checkout_session_id: string; locale: string; text_sha256: string }>(
        "SELECT stripe_checkout_session_id, locale, text_sha256 FROM public.subscription_consents WHERE stripe_subscription_id = $1",
        [SUB_ID],
      );
      expect(rows).toEqual([{ stripe_checkout_session_id: SESSION_ID, locale: "da", text_sha256: TEXT_SHA256_DA }]);
    });
  }, 15_000);

  // ── my_withdrawal_status ────────────────────────────────────────────────────

  it("WD-T-DB-mywd: my_withdrawal_status returns null for user with no entitling subscription", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await asRole(c, "authenticated", { role: "authenticated", sub: USER_UUID });
      const { rows } = await c.query<{ result: unknown }>(
        "SELECT public.my_withdrawal_status() AS result",
      );
      expect(rows[0]?.result).toBeNull();
    });
  }, 15_000);

  it("WD-T-DB-mywd-42501: my_withdrawal_status raises 42501 without auth.uid() (anon)", async () => {
    await withTx(client, async (c) => {
      await asRole(c, "anon", ANON_CLAIMS);
      await expectPgError(
        c,
        () => c.query("SELECT public.my_withdrawal_status()"),
        "42501",
        "anon my_withdrawal_status",
      );
    });
  }, 15_000);

  it("WD-T-DB-mywd-window: my_withdrawal_status window_open=true when within deadline", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedSubscription(c, USER_UUID, SUB_ID, STARTED_AT);
      await asRole(c, "authenticated", { role: "authenticated", sub: USER_UUID });
      const { rows } = await c.query<{ result: Record<string, unknown> }>(
        "SELECT public.my_withdrawal_status() AS result",
      );
      const result = rows[0]?.result;
      expect(result?.["subscription_id"]).toBe(SUB_ID);
      expect(result?.["window_open"]).toBe(true);
      expect(result).toMatchObject({ status: "active", has_consent: false, withdrawal: null, invoice: null });
    });
  }, 15_000);

  it("WD-T-DB-mywd-shapes: a recorded withdrawal and the newest paid invoice, exactly; then the completed amounts", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedSubscription(c, USER_UUID, SUB_ID);
      await seedInvoice(c, SUB_ID, "in_1dmywd001", 1000);
      await asServiceRole(c);
      await recordConsent(c, SUB_ID);
      await c.query("SELECT public.payments_mark_consent_info_sent($1, 'email_1')", [SESSION_ID]);
      const wId = withdrawalId(await beginWithdrawal(c, USER_UUID, SUB_ID));
      await c.query("RESET ROLE");
      const { rows: stored } = await c.query<{ requested_at: unknown; deadline_at: unknown; now: unknown }>(
        "SELECT requested_at, deadline_at, now() AS now FROM public.subscription_withdrawals WHERE id = $1",
        [wId],
      );
      const { requested_at: requestedAt, deadline_at: deadlineAt, now } = stored[0]!;
      const expected = {
        subscription_id: SUB_ID,
        status: "active",
        started_at: iso(STARTED_AT),
        deadline_at: iso(deadlineAt),
        window_open: false,
        has_consent: true,
        withdrawal: {
          id: wId, status: "received", requested_at: iso(requestedAt),
          paid_ore: null, retained_ore: null, refund_ore: null, refunded_at: null,
        },
        invoice: {
          stripe_invoice_id: "in_1dmywd001", amount_total_ore: 1000,
          period_start: "2026-11-01T00:00:00.000Z", period_end: "2026-12-01T00:00:00.000Z",
        },
      };
      await asRole(c, "authenticated", { role: "authenticated", sub: USER_UUID });
      expect(withIsoTimestamps(await myWithdrawalStatus(c))).toEqual(expected);

      await c.query("RESET ROLE");
      await asServiceRole(c);
      await step(c, wId, "canceled", { canceled_at: iso(now) });
      await step(c, wId, "refunded", {
        stripe_invoice_id: "in_1dmywd001", service_start_at: "2026-11-01T00:00:00Z", period_end_at: "2026-12-01T00:00:00Z",
        paid_ore: 1000, retained_ore: 33, refund_ore: 967, refund_tax_ore: 193,
        calc_version: "wd-refund-1", stripe_credit_note_id: "cn_1dmywd001", stripe_refund_id: "re_1dmywd001",
      });
      await asRole(c, "authenticated", { role: "authenticated", sub: USER_UUID });
      expect(withIsoTimestamps(await myWithdrawalStatus(c))).toEqual({
        ...expected,
        withdrawal: { ...expected.withdrawal, status: "completed", paid_ore: 1000, retained_ore: 33, refund_ore: 967, refunded_at: iso(now) },
      });
    });
  }, 30_000);

  // ── payments_pending_work ───────────────────────────────────────────────────

  it("WD-J7-C06 (WD-T-WK-19): pending_work lists the unsent confirmations of live contracts only (A2), with a user, accepted in the last 30 days", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      const cases: readonly (readonly [sub: string, status: string, session: string, opts: ConsentSeed])[] = [
        ["sub_1dpendA", "active", "cs_test_1dpendA", {}],
        ["sub_1dpendB", "canceled", "cs_test_1dpendB", {}],
        ["sub_1dpendC", "incomplete_expired", "cs_test_1dpendC", {}],
        ["sub_1dpendD", "active", "cs_test_1dpendD", { userId: null }],
        ["sub_1dpendE", "active", "cs_test_1dpendE", { acceptedDaysAgo: 31 }],
        ["sub_1dpendF", "trialing", "cs_test_1dpendF", { sent: true }],
        ["sub_1dpendG", "past_due", "cs_test_1dpendG", {}],
      ];
      for (const [sub, status, session, opts] of cases) {
        await seedSubscription(c, USER_UUID, sub, STARTED_AT, status);
        await seedConsent(c, sub, session, opts);
      }
      await asServiceRole(c);
      const consents = (await pendingWork(c)).consents.filter((mail) => mail.checkout_session_id.startsWith("cs_test_1dpend"));
      expect(consents.map((mail) => mail.checkout_session_id)).toEqual(["cs_test_1dpendA", "cs_test_1dpendG"]);
      expect(consents[0]).toMatchObject({ subscription_id: "sub_1dpendA", user_id: USER_UUID, locale: "da", text_version: TEXT_VERSION });
    });
  }, 30_000);

  it("WD-T-DB-pending-withdrawals: work left and no live lease, an email-only one under the mail cap; least recently updated first, a failed pass to the back", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      const seeds: readonly (readonly [key: string, seed: WithdrawalSeed])[] = [
        ["received", { status: "received", attempts: 30, updatedAt: "2000-01-01T00:00:05Z" }],
        ["canceled", { status: "canceled", attempts: 30, updatedAt: "2000-01-01T00:00:04Z" }],
        ["receiptUnderCap", { status: "completed", attempts: 23, updatedAt: "2000-01-01T00:00:03Z" }],
        ["receiptAtCap", { status: "completed", attempts: 24, updatedAt: "2000-01-01T00:00:00Z" }],
        ["alertUnderCap", { status: "needs_manual", ackSent: true, attempts: 2, updatedAt: "2000-01-01T00:00:02Z" }],
        ["alertAtCap", { status: "needs_manual", ackSent: true, attempts: 24, updatedAt: "2000-01-01T00:00:00Z" }],
        ["done", { status: "completed", ackSent: true, updatedAt: "2000-01-01T00:00:00Z" }],
        ["manualDone", { status: "needs_manual", ackSent: true, alerted: true, updatedAt: "2000-01-01T00:00:00Z" }],
        ["leased", { status: "received", leaseSeconds: 60, updatedAt: "2000-01-01T00:00:00Z" }],
        ["leaseExpired", { status: "received", leaseSeconds: -1, updatedAt: "2000-01-01T00:00:01Z" }],
      ];
      const keyOf = new Map<string, string>();
      const idOf = new Map<string, string>();
      for (const [i, [key, seed]] of seeds.entries()) {
        const sub = `sub_1dwork${i}`;
        await seedSubscription(c, USER_UUID, sub);
        const id = await seedWithdrawal(c, sub, seed);
        keyOf.set(id, key);
        idOf.set(key, id);
      }
      await asServiceRole(c);
      const listed = async (limit = 50) => (await pendingWork(c, limit)).withdrawals.flatMap((id) => keyOf.get(id) ?? []);
      expect(await listed()).toEqual(["leaseExpired", "alertUnderCap", "receiptUnderCap", "canceled", "received"]);
      expect(await listed(2)).toEqual(["leaseExpired", "alertUnderCap"]);
      // A pass claims it (leased: not listed), then fails: the step sets updated_at, so it goes to the back.
      const id = idOf.get("leaseExpired")!;
      await c.query("SELECT public.payments_claim_withdrawal($1, 120)", [id]);
      expect(await listed()).toEqual(["alertUnderCap", "receiptUnderCap", "canceled", "received"]);
      await step(c, id, "failed", { code: "stripe_unavailable" });
      expect(await listed()).toEqual(["alertUnderCap", "receiptUnderCap", "canceled", "received", "leaseExpired"]);
    });
  }, 30_000);

  it("WD-T-DB-pending-args: p_limit 1 to 50 and p_max_mail_attempts 1 to 1000, else 22023 invalid_payload", async () => {
    await withTx(client, async (c) => {
      await asServiceRole(c);
      for (const [limit, cap] of [[0, 24], [51, 24], [20, 0], [20, 1001]] as const) {
        await expectPgError(c, () => pendingWork(c, limit, cap), "22023", `pending_work(${limit}, ${cap})`, {
          messageIncludes: "invalid_payload",
        });
      }
    });
  }, 15_000);

  // ── payments_claim_withdrawal ──────────────────────────────────────────────

  it("WD-T-DB-claim: claimed (attempts + 1, lease = now() + p_lease_seconds), busy while leased, done without work, claimed again once the lease expired", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      for (const sub of ["sub_1dclaim1", "sub_1dclaim2", "sub_1dclaim3"]) await seedSubscription(c, USER_UUID, sub);
      const work = await seedWithdrawal(c, "sub_1dclaim1", { status: "received", attempts: 3 });
      const done = await seedWithdrawal(c, "sub_1dclaim2", { status: "completed", ackSent: true, attempts: 5 });
      const alertLeft = await seedWithdrawal(c, "sub_1dclaim3", { status: "needs_manual", ackSent: true, attempts: 1, leaseSeconds: -1 });
      await asServiceRole(c);
      expect(await claim(c, work)).toEqual(["claimed", 4]);
      expect(await claim(c, work)).toEqual(["busy", 4]);
      expect(await claim(c, done)).toEqual(["done", 5]);
      expect(await claim(c, alertLeft)).toEqual(["claimed", 2]);
      const { rows } = await c.query<{ leased: boolean }>(
        "SELECT lease_until = now() + interval '120 seconds' AS leased FROM public.subscription_withdrawals WHERE id = $1",
        [work],
      );
      expect(rows[0]?.leased).toBe(true);
      await expectPgError(c, () => claim(c, "00000000-0000-0000-0d1d-00000000dead"), "P0001", "unknown withdrawal", {
        messageIncludes: "unknown_withdrawal",
      });
      await expectPgError(c, () => claim(c, work, 0), "22023", "lease 0", { messageIncludes: "invalid_payload" });
      await expectPgError(c, () => claim(c, work, 601), "22023", "lease 601", { messageIncludes: "invalid_payload" });
    });
  }, 20_000);

  // ── payments_withdrawal_step: canceled, needs_manual, ack_sent, alerted, failed ──

  it("WD-T-DB-steps: each applied once, then already; alerted only for needs_manual; the lease kept while work is left and released when none is", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedSubscription(c, USER_UUID, SUB_ID);
      const id = await seedWithdrawal(c, SUB_ID, { status: "received" });
      await asServiceRole(c);
      await c.query("SELECT public.payments_claim_withdrawal($1, 120)", [id]);
      const row = async () =>
        (await c.query<{ lease_until: unknown; ack_email_id: string | null; last_error: string | null }>(
          "SELECT lease_until, ack_email_id, last_error FROM public.subscription_withdrawals WHERE id = $1",
          [id],
        )).rows[0]!;
      const canceledAt = "2026-11-14T12:00:00.000Z";

      await expectPgError(c, () => step(c, id, "alerted", {}), "P0001", "alerted while received", { messageIncludes: "invalid_transition" });
      expect(summary(await step(c, id, "canceled", { canceled_at: canceledAt }))).toEqual(["applied", "canceled", null, canceledAt]);
      expect(summary(await step(c, id, "canceled", { canceled_at: "2026-11-14T13:00:00Z" }))).toEqual(["already", "canceled", null, canceledAt]);
      expect(summary(await step(c, id, "needs_manual", { reason: "stripe_refused" }))).toEqual(["applied", "needs_manual", "stripe_refused", canceledAt]);
      expect(summary(await step(c, id, "needs_manual", { reason: "invoice_shape" }))).toEqual(["already", "needs_manual", "stripe_refused", canceledAt]);
      expect(summary(await step(c, id, "ack_sent", { email_id: "email_1" }))).toEqual(["applied", "needs_manual", "stripe_refused", canceledAt]);
      expect(summary(await step(c, id, "ack_sent", { email_id: "email_2" }))).toEqual(["already", "needs_manual", "stripe_refused", canceledAt]);
      expect((await row()).ack_email_id).toBe("email_1");
      // The owner alert is the last work left: the lease is still held.
      expect((await row()).lease_until).not.toBeNull();
      expect(summary(await step(c, id, "alerted", {}))).toEqual(["applied", "needs_manual", "stripe_refused", canceledAt]);
      expect((await row()).lease_until).toBeNull();
      expect(summary(await step(c, id, "alerted", {}))).toEqual(["already", "needs_manual", "stripe_refused", canceledAt]);
      expect(summary(await step(c, id, "failed", { code: "mail_transient" }))[0]).toBe("applied");
      expect((await row()).last_error).toBe("mail_transient");

      await expectPgError(c, () => step(c, id, "failed", { code: "Free text!" }), "22023", "failed free text", { messageIncludes: "invalid_payload" });
      await expectPgError(c, () => step(c, id, "needs_manual", { reason: "other" }), "22023", "unknown reason", { messageIncludes: "invalid_payload" });
      await expectPgError(c, () => step(c, id, "settled", {}), "22023", "unknown step", { messageIncludes: "invalid_payload" });
      await expectPgError(c, () => step(c, "00000000-0000-0000-0d1d-00000000dead", "failed", { code: "x" }), "P0001", "unknown withdrawal", {
        messageIncludes: "unknown_withdrawal",
      });
    });
  }, 30_000);

  it("WD-T-DB-steps-failed-lease: a failed step releases a live lease although work is left", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedSubscription(c, USER_UUID, SUB_ID);
      const id = await seedWithdrawal(c, SUB_ID, { status: "received" });
      await asServiceRole(c);
      expect(await claim(c, id)).toEqual(["claimed", 1]);
      await step(c, id, "failed", { code: "stripe_unavailable" });
      expect(await claim(c, id)).toEqual(["claimed", 2]);
    });
  }, 15_000);

  // ── payments_mark_consent_info_sent ────────────────────────────────────────

  it("WD-T-DB-mark-info: stamps the order confirmation once (the first email id wins); unknown session P0001; malformed 22023", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedSubscription(c, USER_UUID, SUB_ID);
      await seedConsent(c, SUB_ID, SESSION_ID);
      await asServiceRole(c);
      const mark = async (session: string, emailId: string) =>
        (await c.query<{ result: unknown }>("SELECT public.payments_mark_consent_info_sent($1, $2) AS result", [session, emailId]))
          .rows[0]?.result;
      expect(await mark(SESSION_ID, "email_1")).toEqual({ outcome: "stamped" });
      expect(await mark(SESSION_ID, "email_2")).toEqual({ outcome: "already" });
      const { rows } = await c.query<{ info_email_id: string; stamped_now: boolean }>(
        "SELECT info_email_id, info_sent_at = now() AS stamped_now FROM public.subscription_consents WHERE stripe_checkout_session_id = $1",
        [SESSION_ID],
      );
      expect(rows).toEqual([{ info_email_id: "email_1", stamped_now: true }]);
      await expectPgError(c, () => mark("cs_test_1dnoconsent001", "email_1"), "P0001", "unknown session", {
        messageIncludes: "unknown_consent",
      });
      for (const [session, emailId] of [["not_a_session", "email_1"], [SESSION_ID, ""], [SESSION_ID, "x".repeat(201)]] as const) {
        await expectPgError(c, () => mark(session, emailId), "22023", `mark(${session}, ${emailId.length})`, {
          messageIncludes: "invalid_payload",
        });
      }
    });
  }, 20_000);

  // ── Grants: the Worker's functions are service_role only ────────────────────

  it.each([
    ["anon", ANON_CLAIMS],
    ["authenticated", { ...NON_ADMIN_CLAIMS, sub: USER_UUID }],
  ] as const)("WD-T-DB-grants: %s CANNOT execute claim, step, pending_work, mark_consent_info_sent or record_checkout_consent (42501)", async (role, claims) => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedSubscription(c, USER_UUID, SUB_ID);
      const id = await seedWithdrawal(c, SUB_ID);
      await seedConsent(c, SUB_ID, SESSION_ID);
      await asRole(c, role, claims);
      const calls: readonly (readonly [label: string, call: () => Promise<unknown>])[] = [
        ["claim", () => c.query("SELECT public.payments_claim_withdrawal($1, 120)", [id])],
        ["step", () => c.query(`SELECT public.payments_withdrawal_step($1, 'failed', '{"code": "x"}'::jsonb)`, [id])],
        ["pending_work", () => c.query("SELECT public.payments_pending_work(20, 24)")],
        ["mark_consent_info_sent", () => c.query("SELECT public.payments_mark_consent_info_sent($1, 'email_1')", [SESSION_ID])],
        ["record_checkout_consent", () => recordConsent(c, SUB_ID)],
      ];
      for (const [label, call] of calls) await expectPgError(c, call, "42501", `${role} ${label}`);
    });
  }, 20_000);

  // ── terms system page + reserved slug ──────────────────────────────────────

  it("WD-T-DB-01: terms system page row: published, DA title 'Handelsbetingelser'", async () => {
    await withTx(client, async (c) => {
      const { rows } = await c.query<{ title: string; status: string; show_in_nav: boolean }>(
        `SELECT pt.title, p.status, p.show_in_nav
           FROM public.pages p
           JOIN public.page_translations pt ON pt.page_id = p.id AND pt.locale = 'da'
          WHERE p.system_key = 'terms'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.title).toBe("Handelsbetingelser");
      expect(rows[0]?.status).toBe("published");
      expect(rows[0]?.show_in_nav).toBe(false);
    });
  }, 15_000);

  it("WD-T-DB-01b: slug 'terms' in routes_slug_reserved CHECK constraint (insert blocked)", async () => {
    await withTx(client, async (c) => {
      // A custom page: routes_guard refuses every route of a system page before the CHECK runs.
      const pageId = await seedDraftPage(c);
      await expectPgError(
        c,
        () => c.query(`INSERT INTO public.routes (locale, slug, page_id) VALUES ('da', 'terms', $1)`, [pageId]),
        "23514", // check_violation for reserved slug
        "terms slug reserved",
        { messageIncludes: "routes_slug_reserved" },
      );
    });
  }, 15_000);

  // ── withdrawal_deadline: 2026-2030 holiday table ───────────────────────────

  async function deadline(c: PoolClient, startedAt: string | null, infoSentAt: string | null): Promise<string | null> {
    const { rows } = await c.query<{ deadline: unknown }>(
      `SELECT private.withdrawal_deadline($1::timestamptz, $2::timestamptz) AS deadline`,
      [startedAt, infoSentAt],
    );
    const value = rows[0]?.deadline;
    return value === null || value === undefined ? null : iso(value);
  }

  it("WD-J8-C01 (WD-T-DB-02): pinned example: start 2026-11-14 + info same day → 2026-11-30T23:00:00Z", async () => {
    await withTx(client, async (c) => {
      // last = 28 Nov (Sat) → 29 Nov (Sun) → 30 Nov (Mon working) → deadline = 1 Dec 00:00 CET = 30 Nov 23:00 UTC
      expect(await deadline(c, "2026-11-14T00:00:00Z", "2026-11-14T00:00:00Z")).toBe("2026-11-30T23:00:00.000Z");
    });
  }, 15_000);

  it("WD-J8-C02 (WD-T-DB-03): info_sent_at null → +12 months from start_day+14", async () => {
    await withTx(client, async (c) => {
      // 14 days from start = 28 Nov 2026, then +12 months = Sun 28 Nov 2027 → Mon 29 Nov → 30 Nov 00:00 CET
      expect(await deadline(c, "2026-11-14T00:00:00Z", null)).toBe("2027-11-29T23:00:00.000Z");
    });
  }, 15_000);

  it("WD-J8-C06 (WD-T-DB-13): withdrawal_deadline(null, ...) returns null", async () => {
    await withTx(client, async (c) => {
      expect(await deadline(c, null, null)).toBeNull();
    });
  }, 15_000);

  // Easter 2027: 28 March → Maundy Thu 25 Mar, Good Fri 26 Mar, Easter Mon 29 Mar
  it("WD-J8-C07 (WD-T-DB-14..19): 2026-2030 Easter-shifted holidays roll forward", async () => {
    type EasterRow = { year: number; easter: string };
    await withTx(client, async (c) => {
      // Check that dk_easter_sunday gives known dates for 2026-2030
      const { rows } = await c.query<EasterRow>(
        `SELECT y AS year, private.dk_easter_sunday(y)::text AS easter
           FROM generate_series(2026, 2030) AS y`,
      );
      const known: Record<number, string> = {
        2026: "2026-04-05",
        2027: "2027-03-28",
        2028: "2028-04-16",
        2029: "2029-04-01",
        2030: "2030-04-21",
      };
      expect(rows).toHaveLength(5);
      for (const { year, easter } of rows) {
        expect(easter, `Easter ${year}`).toBe(known[year]);
      }
      // Start Thu 11 Mar 2027 + info → last = Thu 25 Mar (Maundy Thursday) → Good Friday → Sat → Sun
      // → Easter Monday 29 Mar → Tue 30 Mar → deadline 31 Mar 00:00 CEST = 30 Mar 22:00 UTC.
      expect(await deadline(c, "2027-03-11T12:00:00Z", "2027-03-11T12:00:00Z")).toBe("2027-03-30T22:00:00.000Z");
    });
  }, 20_000);

  it("WD-J8-C03 (WD-T-DB-04): 25 Dec 2026 is a non-working day; 26 Dec 2026 too", async () => {
    await withTx(client, async (c) => {
      const { rows } = await c.query<{ d: string; nwd: boolean }>(
        `SELECT d::text, private.dk_non_working_day(d::date) AS nwd
           FROM (VALUES ('2026-12-25'::date), ('2026-12-26'::date), ('2026-12-24'::date), ('2026-12-31'::date)) AS t(d)`,
      );
      expect(rows).toHaveLength(4);
      for (const row of rows) {
        expect(row.nwd, `${row.d} should be non-working`).toBe(true);
      }
    });
  }, 15_000);

  it("WD-J8-C03: 5 Jun 2026 (Constitution Day) is a non-working day", async () => {
    await withTx(client, async (c) => {
      const { rows } = await c.query<{ nwd: boolean }>(
        `SELECT private.dk_non_working_day('2026-06-05'::date) AS nwd`,
      );
      expect(rows[0]?.nwd).toBe(true);
    });
  }, 15_000);

  it("WD-J8-C04 (WD-T-DB-11): DST boundary — deadline crosses UTC offset change correctly", async () => {
    await withTx(client, async (c) => {
      // Clocks go BACK in Copenhagen on Sun 25 Oct 2026 (CEST UTC+2 → CET UTC+1).
      // Start 2026-10-15 (CEST), info same day → last = 2026-10-29 (Thu, working day) →
      // deadline = 30 Oct 00:00 CET = 29 Oct 23:00 UTC (CEST would wrongly give 22:00).
      expect(await deadline(c, "2026-10-15T00:00:00Z", "2026-10-15T00:00:00Z")).toBe("2026-10-29T23:00:00.000Z");
    });
  }, 15_000);

  it("WD-J8-C05 (WD-T-DB-12): info later than start → d0 = info_day, 14 days from info", async () => {
    await withTx(client, async (c) => {
      // Start 2026-11-01, info 2026-11-10 → d0 = 10 Nov → last = 24 Nov (Tue, working) → 25 Nov 00:00 CET
      expect(await deadline(c, "2026-11-01T00:00:00Z", "2026-11-10T00:00:00Z")).toBe("2026-11-24T23:00:00.000Z");
    });
  }, 15_000);

  // Each last day with the information sent 14 days before it (start = info, 12:00 UTC): the day it
  // rolls forward to past Saturdays, Sundays, public holidays, 5 June, 24 and 31 December, and the
  // deadline, the next Copenhagen midnight (UTC+2 in summer, UTC+1 in winter). Worked out from the
  // known Easter dates and the fl. § 19 stk. 6 day rules, independently of the SQL.
  const DEADLINE_GRID: readonly (readonly [label: string, lastDay: string, rolledTo: string, deadline: string])[] = [
    ["Maundy Thursday", "2026-04-02", "2026-04-07", "2026-04-07T22:00:00.000Z"],
    ["Good Friday", "2026-04-03", "2026-04-07", "2026-04-07T22:00:00.000Z"],
    ["Easter Sunday", "2026-04-05", "2026-04-07", "2026-04-07T22:00:00.000Z"],
    ["Easter Monday", "2026-04-06", "2026-04-07", "2026-04-07T22:00:00.000Z"],
    ["Ascension", "2026-05-14", "2026-05-15", "2026-05-15T22:00:00.000Z"],
    ["Whit Sunday", "2026-05-24", "2026-05-26", "2026-05-26T22:00:00.000Z"],
    ["Whit Monday", "2026-05-25", "2026-05-26", "2026-05-26T22:00:00.000Z"],
    ["Store bededag", "2026-05-01", "2026-05-01", "2026-05-01T22:00:00.000Z"],
    ["1 Jan", "2026-01-01", "2026-01-02", "2026-01-02T23:00:00.000Z"],
    ["5 Jun", "2026-06-05", "2026-06-08", "2026-06-08T22:00:00.000Z"],
    ["24 Dec", "2026-12-24", "2026-12-28", "2026-12-28T23:00:00.000Z"],
    ["25 Dec", "2026-12-25", "2026-12-28", "2026-12-28T23:00:00.000Z"],
    ["26 Dec", "2026-12-26", "2026-12-28", "2026-12-28T23:00:00.000Z"],
    ["31 Dec", "2026-12-31", "2027-01-04", "2027-01-04T23:00:00.000Z"],
    ["Maundy Thursday", "2027-03-25", "2027-03-30", "2027-03-30T22:00:00.000Z"],
    ["Good Friday", "2027-03-26", "2027-03-30", "2027-03-30T22:00:00.000Z"],
    ["Easter Sunday", "2027-03-28", "2027-03-30", "2027-03-30T22:00:00.000Z"],
    ["Easter Monday", "2027-03-29", "2027-03-30", "2027-03-30T22:00:00.000Z"],
    ["Ascension", "2027-05-06", "2027-05-07", "2027-05-07T22:00:00.000Z"],
    ["Whit Sunday", "2027-05-16", "2027-05-18", "2027-05-18T22:00:00.000Z"],
    ["Whit Monday", "2027-05-17", "2027-05-18", "2027-05-18T22:00:00.000Z"],
    ["Store bededag", "2027-04-23", "2027-04-23", "2027-04-23T22:00:00.000Z"],
    ["1 Jan", "2027-01-01", "2027-01-04", "2027-01-04T23:00:00.000Z"],
    ["5 Jun", "2027-06-05", "2027-06-07", "2027-06-07T22:00:00.000Z"],
    ["24 Dec", "2027-12-24", "2027-12-27", "2027-12-27T23:00:00.000Z"],
    ["25 Dec", "2027-12-25", "2027-12-27", "2027-12-27T23:00:00.000Z"],
    ["26 Dec", "2027-12-26", "2027-12-27", "2027-12-27T23:00:00.000Z"],
    ["31 Dec", "2027-12-31", "2028-01-03", "2028-01-03T23:00:00.000Z"],
    ["Maundy Thursday", "2028-04-13", "2028-04-18", "2028-04-18T22:00:00.000Z"],
    ["Good Friday", "2028-04-14", "2028-04-18", "2028-04-18T22:00:00.000Z"],
    ["Easter Sunday", "2028-04-16", "2028-04-18", "2028-04-18T22:00:00.000Z"],
    ["Easter Monday", "2028-04-17", "2028-04-18", "2028-04-18T22:00:00.000Z"],
    ["Ascension", "2028-05-25", "2028-05-26", "2028-05-26T22:00:00.000Z"],
    ["Whit Sunday", "2028-06-04", "2028-06-06", "2028-06-06T22:00:00.000Z"],
    ["Whit Monday", "2028-06-05", "2028-06-06", "2028-06-06T22:00:00.000Z"],
    ["Store bededag", "2028-05-12", "2028-05-12", "2028-05-12T22:00:00.000Z"],
    ["1 Jan", "2028-01-01", "2028-01-03", "2028-01-03T23:00:00.000Z"],
    ["5 Jun", "2028-06-05", "2028-06-06", "2028-06-06T22:00:00.000Z"],
    ["24 Dec", "2028-12-24", "2028-12-27", "2028-12-27T23:00:00.000Z"],
    ["25 Dec", "2028-12-25", "2028-12-27", "2028-12-27T23:00:00.000Z"],
    ["26 Dec", "2028-12-26", "2028-12-27", "2028-12-27T23:00:00.000Z"],
    ["31 Dec", "2028-12-31", "2029-01-02", "2029-01-02T23:00:00.000Z"],
    ["Maundy Thursday", "2029-03-29", "2029-04-03", "2029-04-03T22:00:00.000Z"],
    ["Good Friday", "2029-03-30", "2029-04-03", "2029-04-03T22:00:00.000Z"],
    ["Easter Sunday", "2029-04-01", "2029-04-03", "2029-04-03T22:00:00.000Z"],
    ["Easter Monday", "2029-04-02", "2029-04-03", "2029-04-03T22:00:00.000Z"],
    ["Ascension", "2029-05-10", "2029-05-11", "2029-05-11T22:00:00.000Z"],
    ["Whit Sunday", "2029-05-20", "2029-05-22", "2029-05-22T22:00:00.000Z"],
    ["Whit Monday", "2029-05-21", "2029-05-22", "2029-05-22T22:00:00.000Z"],
    ["Store bededag", "2029-04-27", "2029-04-27", "2029-04-27T22:00:00.000Z"],
    ["1 Jan", "2029-01-01", "2029-01-02", "2029-01-02T23:00:00.000Z"],
    ["5 Jun", "2029-06-05", "2029-06-06", "2029-06-06T22:00:00.000Z"],
    ["24 Dec", "2029-12-24", "2029-12-27", "2029-12-27T23:00:00.000Z"],
    ["25 Dec", "2029-12-25", "2029-12-27", "2029-12-27T23:00:00.000Z"],
    ["26 Dec", "2029-12-26", "2029-12-27", "2029-12-27T23:00:00.000Z"],
    ["31 Dec", "2029-12-31", "2030-01-02", "2030-01-02T23:00:00.000Z"],
    ["Maundy Thursday", "2030-04-18", "2030-04-23", "2030-04-23T22:00:00.000Z"],
    ["Good Friday", "2030-04-19", "2030-04-23", "2030-04-23T22:00:00.000Z"],
    ["Easter Sunday", "2030-04-21", "2030-04-23", "2030-04-23T22:00:00.000Z"],
    ["Easter Monday", "2030-04-22", "2030-04-23", "2030-04-23T22:00:00.000Z"],
    ["Ascension", "2030-05-30", "2030-05-31", "2030-05-31T22:00:00.000Z"],
    ["Whit Sunday", "2030-06-09", "2030-06-11", "2030-06-11T22:00:00.000Z"],
    ["Whit Monday", "2030-06-10", "2030-06-11", "2030-06-11T22:00:00.000Z"],
    ["Store bededag", "2030-05-17", "2030-05-17", "2030-05-17T22:00:00.000Z"],
    ["1 Jan", "2030-01-01", "2030-01-02", "2030-01-02T23:00:00.000Z"],
    ["5 Jun", "2030-06-05", "2030-06-06", "2030-06-06T22:00:00.000Z"],
    ["24 Dec", "2030-12-24", "2030-12-27", "2030-12-27T23:00:00.000Z"],
    ["25 Dec", "2030-12-25", "2030-12-27", "2030-12-27T23:00:00.000Z"],
    ["26 Dec", "2030-12-26", "2030-12-27", "2030-12-27T23:00:00.000Z"],
    ["31 Dec", "2030-12-31", "2031-01-02", "2031-01-02T23:00:00.000Z"],
  ];

  it("WD-J8-C07 (WD-T-DB-14..19): 2026-2030 grid: every movable holiday, 1 Jan, 5 Jun and 24 to 31 Dec as the last day roll to the next working day", async () => {
    await withTx(client, async (c) => {
      // Start = information = the last day minus 14 days, at 12:00 UTC (the same Copenhagen date).
      const starts = DEADLINE_GRID.map(([, lastDay]) => {
        const [y, m, d] = lastDay.split("-").map(Number);
        return new Date(Date.UTC(y!, m! - 1, d! - 14, 12)).toISOString();
      });
      const { rows } = await c.query<{ deadline: unknown }>(
        `SELECT private.withdrawal_deadline(s::timestamptz, s::timestamptz) AS deadline
           FROM unnest($1::text[]) WITH ORDINALITY AS t(s, n)
          ORDER BY n`,
        [starts],
      );
      expect(DEADLINE_GRID.map(([label, lastDay], i) => [label, lastDay, iso(rows[i]?.deadline)])).toEqual(
        DEADLINE_GRID.map(([label, lastDay, , deadline]) => [label, lastDay, deadline]),
      );
    });
  }, 20_000);

  it("WD-J8-C07 (WD-T-DB-14..19): the rolled-to days are working days, the movable holidays are not, and Store bededag (Easter + 26) is a working day", async () => {
    await withTx(client, async (c) => {
      const days = DEADLINE_GRID.flatMap(([label, lastDay, rolledTo]) => [
        { day: lastDay, nonWorking: label !== "Store bededag" },
        { day: rolledTo, nonWorking: false },
      ]);
      const { rows } = await c.query<{ nwd: boolean }>(
        `SELECT private.dk_non_working_day(d::date) AS nwd FROM unnest($1::text[]) WITH ORDINALITY AS t(d, n) ORDER BY n`,
        [days.map(({ day }) => day)],
      );
      expect(days.map(({ day }, i) => [day, rows[i]?.nwd])).toEqual(days.map(({ day, nonWorking }) => [day, nonWorking]));
    });
  }, 20_000);
});
