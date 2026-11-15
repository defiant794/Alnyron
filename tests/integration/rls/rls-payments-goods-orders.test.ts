/**
 * Integration tests: slice S2 DB — orders/order_items/order_withdrawals RLS and writers
 * Journey: payments-s2-3d-purchase
 * Criteria:
 *   S2-SEC-1..6  (S2-T-RLS-SEC-01..20)
 *   S2-ADM-1..6  (S2-T-RLS-MK-01..06: "Markér afsendt" = begin_ship + captured)
 *   S2-ADM-7..10 (S2-T-RLS-AR-01..04)
 *   S2-ADM-19..20 (S2-T-RLS-SYN-01..02)
 *   S2-WD-9..12  (S2-T-RLS-WD-01..04; S2-T-RLS-WD-07: one signature, without a user id)
 *   S2-WH-1 partial: record_order idempotency (event dup + session dup; S2-T-RLS-REC-01: a
 *   session dup takes no order_number)
 *   S2-CAP-2..11 (S2-T-RLS-CAP-01..21): amendment A1, charge on dispatch
 *   S2-CAP-16..17 (S2-T-RLS-CAP-22..24): amendment A2, the durable expired_alert and a refused capture
 *   S2-SWP-6, S2-ADM-17, S2-ADM-23, S2-WD-8 (S2-T-RLS-PW-04..05, S2-T-RLS-WS-07, S2-T-RLS-WD-08):
 *   amendment A3, the offline notice's mails, the durable manual alert, a repeated notice
 *
 * Coverage:
 *   - anon SELECT on orders/order_items/order_withdrawals → 42501
 *   - other user's orders → 0 rows; own orders → visible; admin → all
 *   - authenticated (and admin) INSERT / UPDATE / DELETE on the three order tables → 42501
 *   - EXECUTE on every writer: anon → 42501; authenticated → 42501; service_role ok
 *   - payments_record_order: event dup → {outcome:'duplicate'}; session dup same; status authorized,
 *     capture_state requires_capture | succeeded (captured_at_checkout)
 *   - payments_order_begin_ship / payments_order_captured / payments_order_capture_failed:
 *     transitions, role check, already_shipped, order_closed, withdrawal_pending, order_not_found,
 *     authorization_expired → canceled
 *   - payments_approve_order_refund: role check, goods_state rules, action cancel_authorization | refund
 *   - payments_order_withdrawal_step: refunded (refund_id only), authorization_canceled,
 *     manual_alert_sent (A3-3)
 *   - payments_begin_order_withdrawal: not shipped → deadline null; shipped + conf_sent → non-null;
 *     conf never sent → 12-month extension; late accepted + flagged; existing → outcome:existing
 *     (also on a refunded or canceled order, A3-2); refunded / canceled without one → not_withdrawable
 *   - payments_sync_order_refund: monotonic; unknown_order; bounded by the captured amount
 *   - payments_order_authorization_canceled (payment_intent.canceled)
 *   - payments_pending_order_work: orders_capture_warning, orders_mail expired_alert; no ack or
 *     owner_alert for a channel admin notice (A3-1); manual_alert (A3-3);
 *     payments_order_mail_sent capture_warning, expired_alert
 *   - payments_order_capture_failed capture_refused: the capture_failed anomaly, order unchanged
 *   - the A1 CHECKs on orders and order_withdrawals
 *
 * Notes:
 *   - Writers are SECURITY INVOKER, service_role only: use asServiceRole for writer calls.
 *   - The writers take typed params (not jsonb); pass each with explicit SQL casts where needed.
 *   - node-postgres returns bigint columns as strings and timestamptz as Date: cast ::int in SQL
 *     for numeric assertions, compare timestamps in SQL.
 *   - "Markér afsendt" in the Worker: begin_ship → Stripe capture → captured. shipOrder() below
 *     stands for a successful capture.
 *   - UUID namespace: 0521 (valid hex; "s2-orders-rls").
 *
 * Run: npm run test:integration:e2e-project -- tests/integration/rls/rls-payments-goods-orders.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getClient, type PoolClient } from "./helpers/db.js";
import {
  asRole,
  asServiceRole,
  expectPgError,
  seedAdmin,
  seedAuthUser,
  withTx,
  seedRoute,
  ANON_CLAIMS,
  ADMIN_CLAIMS,
  NON_ADMIN_CLAIMS,
  ADMIN_UUID,
  OWNER_UUID,
  OWNER_EMAIL,
} from "./helpers/roles.js";

const SKIP = !process.env.SUPABASE_E2E_REF;

let client: PoolClient;
beforeAll(async () => { if (!SKIP) client = await getClient(); });
afterAll(() => client?.release());

// ── Namespace (prefix 0521 = s2-orders-rls; all valid hex) ───────────────────

const USER_UUID   = "00000000-0000-0000-0521-000000000001";
const USER_EMAIL  = "e2e-pay-s2-ord@alnyron-test.local";
const USER2_UUID  = "00000000-0000-0000-0521-000000000002";
const USER2_EMAIL = "e2e-pay-s2-ord2@alnyron-test.local";
const GOODS_TEXT_VERSION = "goods-2026-11-14.1";

// Stable ids for idempotency tests (all valid stripe-id patterns)
const CS_ID_A   = "cs_test_s2rls0000000001";
const CS_ID_B   = "cs_test_s2rls0000000002";
const PI_ID_A   = "pi_s2rls00000000000001";
const PI_ID_B   = "pi_s2rls00000000000002";
const EVT_ID_A  = "evt_s2rls0000000000001";
const EVT_ID_B  = "evt_s2rls0000000000002";
const EVT_ID_C  = "evt_s2rls0000000000003";

// ── Writer call helpers ───────────────────────────────────────────────────────
// Each function has distinct SQL types — do not use a generic jsonb-cast wrapper.

type OrderJson = Record<string, unknown>;
type RecordOrderResult = { outcome: string; order_id: string; order_number: string };
type ShipResult = { outcome: string; order?: OrderJson };
type ApproveRefundResult = { outcome: string; withdrawal?: Record<string, unknown> };
type BeginWithdrawalResult = {
  outcome: string;
  withdrawal: { id: string; deadline_at: string | null; shipped_before_notice: boolean; late: boolean; user_id: string | null; channel: string };
};
type SyncRefundResult = { outcome: string; amount_refunded_ore: string; status: string };
type PendingWork = {
  orders_mail: Array<{ order_id: string; needs: string[] }>;
  withdrawals: Array<{ withdrawal_id: string; needs: string[] }>;
  orders_capture_warning: Array<{ order_id: string; needs: string[] }>;
};

type OrderOpts = {
  csId?: string;
  piId?: string;
  userId?: string;
  captureState?: string;
  authorizationExpiresAt?: string | null;
  anomaly?: string | null;
};

function goodsOrderInput(opts: OrderOpts = {}): Record<string, unknown> {
  return {
    stripe_checkout_session_id: opts.csId ?? CS_ID_A,
    stripe_payment_intent_id:   opts.piId ?? PI_ID_A,
    stripe_customer_id:         null,
    stripe_invoice_id:          null,
    user_id:                    opts.userId ?? USER_UUID,
    email:                      USER_EMAIL,
    customer_name:              "S2 Testkøber",
    phone:                      "+4520123456",
    shipping_name:              "S2 Testkøber",
    shipping_address:           { line1: "Testvej 1", postal_code: "7860", city: "Spøttrup", country: "DK" },
    locale:                     "da",
    currency:                   "dkk",
    // Stripe's amount_subtotal includes the inclusive moms (TEST-mode probe, amendment A3-4)
    amount_subtotal_ore:        24995,
    amount_tax_ore:             4999,
    amount_total_ore:           24995,
    terms_version:              GOODS_TEXT_VERSION,
    terms_sha256:               null,
    stripe_consent:             "accepted",
    anomaly:                    opts.anomaly ?? null,
    paid_at:                    new Date().toISOString(),
    // A1: authorized at Checkout; the card's capture_before 7 days later
    capture_state:              opts.captureState ?? "requires_capture",
    authorization_expires_at:   opts.authorizationExpiresAt === undefined
      ? new Date(Date.now() + 7 * 86_400_000).toISOString()
      : opts.authorizationExpiresAt,
    lines: [{
      line_no:         1,
      item_id:         null,
      offer_kind:      "physical",
      title:           "S2 Testfigur",
      quantity:        1,
      unit_amount_ore: 24995,
      amount_total_ore: 24995,
      amount_tax_ore:  4999,
    }],
  };
}

async function recordOrder(
  c: PoolClient,
  evtId: string,
  evtType: string,
  orderOpts: OrderOpts = {},
): Promise<RecordOrderResult> {
  // Contract §1.9: p_event is the 1c eventForRpc shape {id, type, created (ISO), livemode}.
  const event = { id: evtId, type: evtType, created: new Date().toISOString(), livemode: false };
  const { rows } = await c.query<{ payments_record_order: RecordOrderResult }>(
    `SELECT payments_record_order($1::jsonb, $2::jsonb)`,
    [JSON.stringify(event), JSON.stringify(goodsOrderInput(orderOpts))],
  );
  return rows[0]!.payments_record_order;
}

async function beginShip(c: PoolClient, orderId: string, actorId: string, trackingRef: string | null): Promise<ShipResult> {
  const { rows } = await c.query<{ payments_order_begin_ship: ShipResult }>(
    `SELECT payments_order_begin_ship($1::uuid, $2::uuid, $3::text)`,
    [orderId, actorId, trackingRef],
  );
  return rows[0]!.payments_order_begin_ship;
}

async function captured(c: PoolClient, orderId: string, actorId: string): Promise<ShipResult> {
  const { rows } = await c.query<{ payments_order_captured: ShipResult }>(
    `SELECT payments_order_captured($1::uuid, $2::uuid)`,
    [orderId, actorId],
  );
  return rows[0]!.payments_order_captured;
}

async function captureFailed(c: PoolClient, orderId: string, reason: string): Promise<ShipResult> {
  const { rows } = await c.query<{ payments_order_capture_failed: ShipResult }>(
    `SELECT payments_order_capture_failed($1::uuid, $2::text)`,
    [orderId, reason],
  );
  return rows[0]!.payments_order_capture_failed;
}

/** "Markér afsendt" with a successful Stripe capture: begin_ship, then captured. */
async function shipOrder(c: PoolClient, orderId: string, actorId: string, trackingRef: string | null = null): Promise<ShipResult> {
  const begun = await beginShip(c, orderId, actorId, trackingRef);
  expect(begun.outcome).toBe("capture");
  return captured(c, orderId, actorId);
}

async function approveRefund(
  c: PoolClient,
  orderId: string,
  actorId: string,
  goodsState: string,
  deductionOre: number,
  deductionReason: string | null,
): Promise<ApproveRefundResult> {
  const { rows } = await c.query<{ payments_approve_order_refund: ApproveRefundResult }>(
    `SELECT payments_approve_order_refund($1::uuid, $2::uuid, $3::text, $4::bigint, $5::text)`,
    [orderId, actorId, goodsState, deductionOre, deductionReason],
  );
  return rows[0]!.payments_approve_order_refund;
}

async function beginWithdrawal(
  c: PoolClient,
  orderId: string,
  consumerName: string,
  channel: string,
  stmtVersion: string,
  locale: string,
): Promise<BeginWithdrawalResult> {
  const { rows } = await c.query<{ payments_begin_order_withdrawal: BeginWithdrawalResult }>(
    `SELECT payments_begin_order_withdrawal($1::uuid, $2::text, $3::text, $4::text, $5::text)`,
    [orderId, consumerName, channel, stmtVersion, locale],
  );
  return rows[0]!.payments_begin_order_withdrawal;
}

async function syncRefund(
  c: PoolClient,
  evtId: string,
  paymentIntent: string,
  amountRefunded: number,
): Promise<SyncRefundResult> {
  const event = { id: evtId, type: "charge.refunded", created: new Date().toISOString(), livemode: false };
  const { rows } = await c.query<{ payments_sync_order_refund: SyncRefundResult }>(
    `SELECT payments_sync_order_refund($1::jsonb, $2::text, $3::bigint)`,
    [JSON.stringify(event), paymentIntent, amountRefunded],
  );
  return rows[0]!.payments_sync_order_refund;
}

async function authorizationCanceled(
  c: PoolClient,
  evtId: string,
  paymentIntent: string,
  type = "payment_intent.canceled",
): Promise<{ outcome: string; order?: OrderJson; order_id?: string }> {
  const event = { id: evtId, type, created: new Date().toISOString(), livemode: false };
  const { rows } = await c.query<{ payments_order_authorization_canceled: { outcome: string; order?: OrderJson } }>(
    `SELECT payments_order_authorization_canceled($1::jsonb, $2::text)`,
    [JSON.stringify(event), paymentIntent],
  );
  return rows[0]!.payments_order_authorization_canceled;
}

async function withdrawalStep(c: PoolClient, wdId: string, step: string, data: Record<string, unknown>): Promise<{ outcome: string }> {
  const { rows } = await c.query<{ payments_order_withdrawal_step: { outcome: string } }>(
    `SELECT payments_order_withdrawal_step($1::uuid, $2::text, $3::jsonb)`,
    [wdId, step, JSON.stringify(data)],
  );
  return rows[0]!.payments_order_withdrawal_step;
}

async function pendingWork(c: PoolClient, maxMailAttempts = 8): Promise<PendingWork> {
  const { rows } = await c.query<{ payments_pending_order_work: PendingWork }>(
    `SELECT payments_pending_order_work(50::int, $1::int)`,
    [maxMailAttempts],
  );
  return rows[0]!.payments_pending_order_work;
}

async function mailSent(c: PoolClient, orderId: string, kind: string, emailId: string): Promise<void> {
  await c.query(`SELECT payments_order_mail_sent($1::uuid, $2::text, $3::text)`, [orderId, kind, emailId]);
}

/** The order's A1 state columns (timestamps as booleans / ISO text so assertions do not depend on pg Date). */
async function orderState(c: PoolClient, orderId: string): Promise<Record<string, unknown>> {
  const { rows } = await c.query(
    `SELECT status, cancel_reason, captured_at IS NOT NULL AS captured, canceled_at IS NOT NULL AS canceled,
            shipped_at IS NOT NULL AS shipped, amount_refunded_ore::int AS refunded, anomaly, tracking_ref,
            authorization_expires_at IS NOT NULL AS expires_set
       FROM public.orders WHERE id = $1`,
    [orderId],
  );
  return rows[0] as Record<string, unknown>;
}

// ── S2-SEC-1..3 (S2-T-RLS-SEC-01..03): anon SELECT → 42501 ──────────────────

describe("S2-SEC-1 (S2-T-RLS-SEC-01..03): anon SELECT on order tables → 42501", () => {
  it.skipIf(SKIP)("anon SELECT orders → 42501", async () => {
    await withTx(client, async (c) => {
      await asRole(c, "anon", ANON_CLAIMS);
      await expectPgError(c, () => c.query("SELECT id FROM public.orders LIMIT 1"), "42501", "anon SELECT orders");
    });
  });

  it.skipIf(SKIP)("anon SELECT order_items → 42501", async () => {
    await withTx(client, async (c) => {
      await asRole(c, "anon", ANON_CLAIMS);
      await expectPgError(c, () => c.query("SELECT order_id FROM public.order_items LIMIT 1"), "42501", "anon SELECT order_items");
    });
  });

  it.skipIf(SKIP)("anon SELECT order_withdrawals → 42501", async () => {
    await withTx(client, async (c) => {
      await asRole(c, "anon", ANON_CLAIMS);
      await expectPgError(c, () => c.query("SELECT id FROM public.order_withdrawals LIMIT 1"), "42501", "anon SELECT order_withdrawals");
    });
  });
});

// ── S2-SEC-2 (S2-T-RLS-SEC-04): other user sees 0 rows ───────────────────────

describe("S2-SEC-2 (S2-T-RLS-SEC-04): authenticated sees 0 rows for another user's orders", () => {
  it.skipIf(SKIP)("user2 cannot see user1 orders", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAuthUser(c, USER2_UUID, USER2_EMAIL);
      await asServiceRole(c);
      const r = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      expect(r.outcome).toBe("recorded");
      const orderId = r.order_id;

      await c.query("RESET ROLE");
      await asRole(c, "authenticated", { sub: USER2_UUID, role: "authenticated", email: USER2_EMAIL });
      const { rows } = await c.query(`SELECT id FROM public.orders WHERE id = $1`, [orderId]);
      expect(rows).toHaveLength(0);
    });
  });
});

// ── S2-SEC-3 (S2-T-RLS-SEC-05): own orders visible ───────────────────────────

describe("S2-SEC-3 (S2-T-RLS-SEC-05): authenticated user sees own orders", () => {
  it.skipIf(SKIP)("user sees their own order row", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await asServiceRole(c);
      const r = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      const orderId = r.order_id;

      await c.query("RESET ROLE");
      await asRole(c, "authenticated", { sub: USER_UUID, role: "authenticated", email: USER_EMAIL });
      const { rows } = await c.query(`SELECT id FROM public.orders WHERE id = $1`, [orderId]);
      expect(rows).toHaveLength(1);
    });
  });
});

// ── S2-SEC-4 (S2-T-RLS-SEC-06): admin sees all ───────────────────────────────

describe("S2-SEC-4 (S2-T-RLS-SEC-06): admin sees all orders", () => {
  it.skipIf(SKIP)("admin can read another user's order", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAdmin(c);
      await asServiceRole(c);
      const r = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      const orderId = r.order_id;

      await c.query("RESET ROLE");
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      const { rows } = await c.query(`SELECT id FROM public.orders WHERE id = $1`, [orderId]);
      expect(rows).toHaveLength(1);
    });
  });
});

// ── S2-SEC-6 (S2-T-RLS-SEC-18..20): no writes by authenticated or admin ──────

/** One order with a line and a withdrawal, seeded as service_role; the ids the writes target. */
async function seedOrderWithWithdrawal(c: PoolClient): Promise<{ orderId: string }> {
  await asServiceRole(c);
  const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
  await beginWithdrawal(c, order_id, "Lars", "link", GOODS_TEXT_VERSION, "da");
  await c.query("RESET ROLE");
  return { orderId: order_id };
}

const ORDER_TABLE_WRITES: Array<{ id: string; table: string; op: string; sql: string }> = [
  {
    id: "S2-T-RLS-SEC-18", table: "orders", op: "INSERT",
    sql: `INSERT INTO public.orders
           (email, locale, currency, amount_subtotal_ore, amount_tax_ore, amount_total_ore,
            stripe_checkout_session_id, stripe_payment_intent_id, terms_version, paid_at, anomaly)
          VALUES ('${USER_EMAIL}', 'da', 'dkk', 0, 0, 24995, 'cs_test_fake1', 'pi_fake1', 'v1', now(), 'shipping_missing')`,
  },
  {
    id: "S2-T-RLS-SEC-18", table: "order_items", op: "INSERT",
    sql: `INSERT INTO public.order_items
           (order_id, line_no, offer_kind, title, quantity, unit_amount_ore, amount_total_ore, amount_tax_ore)
          VALUES ($1, 2, 'physical', 'Ekstra', 1, 100, 100, 20)`,
  },
  {
    id: "S2-T-RLS-SEC-18", table: "order_withdrawals", op: "INSERT",
    sql: `INSERT INTO public.order_withdrawals
           (order_id, consumer_name, channel, statement_version, locale, shipped_before_notice, refund_due_at)
          VALUES ($1, 'Lars', 'link', 'v1', 'da', false, now())`,
  },
  { id: "S2-T-RLS-SEC-19", table: "orders", op: "UPDATE", sql: `UPDATE public.orders SET status = 'refunded' WHERE id = $1` },
  { id: "S2-T-RLS-SEC-19", table: "order_items", op: "UPDATE", sql: `UPDATE public.order_items SET title = 'x' WHERE order_id = $1` },
  { id: "S2-T-RLS-SEC-19", table: "order_withdrawals", op: "UPDATE", sql: `UPDATE public.order_withdrawals SET status = 'approved' WHERE order_id = $1` },
  { id: "S2-T-RLS-SEC-20", table: "orders", op: "DELETE", sql: `DELETE FROM public.orders WHERE id = $1` },
  { id: "S2-T-RLS-SEC-20", table: "order_items", op: "DELETE", sql: `DELETE FROM public.order_items WHERE order_id = $1` },
  { id: "S2-T-RLS-SEC-20", table: "order_withdrawals", op: "DELETE", sql: `DELETE FROM public.order_withdrawals WHERE order_id = $1` },
];

/** The statement's parameters: the INSERT into orders takes none, every other one the order id. */
function writeParams(sql: string, orderId: string): string[] {
  return sql.includes("$1") ? [orderId] : [];
}

describe("S2-SEC-6 (S2-T-RLS-SEC-18..20): INSERT / UPDATE / DELETE on the order tables → 42501", () => {
  it.skipIf(SKIP).each(ORDER_TABLE_WRITES)("$id: the buyer (authenticated) $op on $table → 42501", async ({ table, op, sql }) => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      const { orderId } = await seedOrderWithWithdrawal(c);
      await asRole(c, "authenticated", { sub: USER_UUID, role: "authenticated", email: USER_EMAIL });
      await expectPgError(c, () => c.query(sql, writeParams(sql, orderId)), "42501", `buyer ${op} ${table}`);
    });
  });

  it.skipIf(SKIP).each(ORDER_TABLE_WRITES)("$id: an admin $op on $table → 42501", async ({ table, op, sql }) => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAdmin(c);
      const { orderId } = await seedOrderWithWithdrawal(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await expectPgError(c, () => c.query(sql, writeParams(sql, orderId)), "42501", `admin ${op} ${table}`);
    });
  });
});

// ── S2-SEC-5 (S2-T-RLS-SEC-07..17): every writer rejects anon/authenticated ──

describe("S2-SEC-5 (S2-T-RLS-SEC-07..17): every writer rejects anon/authenticated EXECUTE", () => {
  // Arguments must be valid-shaped enough for the permission check to run before type validation.
  // Using literal SQL inline — these tests assert 42501, not argument validity.
  const writers: Array<{ id: string; sql: string }> = [
    { id: "payments_goods_offer",          sql: `SELECT payments_goods_offer('00000000-0000-0000-0000-000000000001'::uuid, 'da'::text)` },
    { id: "payments_record_order",         sql: `SELECT payments_record_order('{}'::jsonb, '{}'::jsonb)` },
    { id: "payments_order_mail_sent",      sql: `SELECT payments_order_mail_sent('00000000-0000-0000-0000-000000000001'::uuid, 'confirmation'::text, 'em_test'::text)` },
    { id: "payments_order_begin_ship",     sql: `SELECT payments_order_begin_ship('00000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000000002'::uuid, null::text)` },
    { id: "payments_order_captured",       sql: `SELECT payments_order_captured('00000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000000002'::uuid)` },
    { id: "payments_order_capture_failed", sql: `SELECT payments_order_capture_failed('00000000-0000-0000-0000-000000000001'::uuid, 'authorization_expired'::text)` },
    { id: "payments_find_order",           sql: `SELECT payments_find_order(1001::bigint, 'test@test.local'::text)` },
    { id: "payments_begin_order_withdrawal", sql: `SELECT payments_begin_order_withdrawal('00000000-0000-0000-0000-000000000001'::uuid, 'Name'::text, 'link'::text, '${GOODS_TEXT_VERSION}'::text, 'da'::text)` },
    { id: "payments_approve_order_refund", sql: `SELECT payments_approve_order_refund('00000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000000002'::uuid, 'returned'::text, 0::bigint, null::text)` },
    { id: "payments_claim_order_withdrawal", sql: `SELECT payments_claim_order_withdrawal('00000000-0000-0000-0000-000000000001'::uuid, 60::int)` },
    { id: "payments_order_withdrawal_step", sql: `SELECT payments_order_withdrawal_step('00000000-0000-0000-0000-000000000001'::uuid, 'ack_sent'::text, '{"email_id":"em"}'::jsonb)` },
    { id: "payments_pending_order_work",   sql: `SELECT payments_pending_order_work(10::int, 8::int)` },
    { id: "payments_sync_order_refund",    sql: `SELECT payments_sync_order_refund('{}'::jsonb, 'pi_fake1'::text, 24995::bigint)` },
    { id: "payments_order_authorization_canceled", sql: `SELECT payments_order_authorization_canceled('{}'::jsonb, 'pi_fake1'::text)` },
  ];

  it.skipIf(SKIP).each(writers)("anon EXECUTE $id → 42501", async ({ sql }) => {
    await withTx(client, async (c) => {
      await asRole(c, "anon", ANON_CLAIMS);
      await expectPgError(c, () => c.query(sql), "42501");
    });
  });

  it.skipIf(SKIP).each(writers)("authenticated non-admin EXECUTE $id → 42501", async ({ sql }) => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await asRole(c, "authenticated", NON_ADMIN_CLAIMS);
      await expectPgError(c, () => c.query(sql), "42501");
    });
  });

  it.skipIf(SKIP)("A1: payments_order_mark_shipped no longer exists (split into begin_ship / captured / capture_failed)", async () => {
    await withTx(client, async (c) => {
      const { rows } = await c.query<{ gone: boolean }>(
        `SELECT to_regprocedure('public.payments_order_mark_shipped(uuid, uuid, text)') IS NULL AS gone`,
      );
      expect(rows[0]!.gone).toBe(true);
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-WD-07: payments_begin_order_withdrawal has one signature, without a user id (link or form: no account)", async () => {
    await withTx(client, async (c) => {
      const { rows } = await c.query<{ signature: string }>(
        `SELECT p.oid::regprocedure::text AS signature
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'payments_begin_order_withdrawal'`,
      );
      expect(rows).toEqual([{ signature: "payments_begin_order_withdrawal(uuid,text,text,text,text)" }]);
    });
  });
});

// ── S2-WH-1: payments_record_order idempotency ───────────────────────────────

describe("S2-WH-1 (record_order): payments_record_order idempotency", () => {
  it.skipIf(SKIP)("first call → recorded; same event id again → duplicate", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await asServiceRole(c);
      const r1 = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      expect(r1.outcome).toBe("recorded");

      // Same event id, different session — stripe_events dup wins
      const r2 = await recordOrder(c, EVT_ID_A, "checkout.session.completed", { csId: CS_ID_B, piId: PI_ID_B });
      expect(r2.outcome).toBe("duplicate");
    });
  });

  it.skipIf(SKIP)("async_payment_succeeded for same session after completed → session dup", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await asServiceRole(c);
      const r1 = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      expect(r1.outcome).toBe("recorded");

      // Different event id, same CS_ID_A → session dup (order conflict)
      const r2 = await recordOrder(c, EVT_ID_B, "checkout.session.async_payment_succeeded");
      expect(r2.outcome).toBe("duplicate");
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-REC-01: a duplicate session under a new event id takes no order_number (the invoice numbers stay consecutive)", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await asServiceRole(c);
      const first = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      expect(first.outcome).toBe("recorded");

      // A replay of the same session with a new event id: the session check answers before the insert.
      expect(await recordOrder(c, EVT_ID_B, "checkout.session.completed")).toEqual({ outcome: "duplicate" });
      // The event itself is recorded (a later delivery of it is an event dup).
      const { rows: events } = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.stripe_events WHERE id = $1`,
        [EVT_ID_B],
      );
      expect(events[0]!.n).toBe(1);

      // The next session's order gets the very next number.
      const next = await recordOrder(c, EVT_ID_C, "checkout.session.completed", { csId: CS_ID_B, piId: PI_ID_B });
      expect(next.outcome).toBe("recorded");
      expect(Number(next.order_number)).toBe(Number(first.order_number) + 1);
    });
  });
});

// ── S2-ADM-1..6: "Markér afsendt" = payments_order_begin_ship + payments_order_captured ──

describe("S2-ADM-1..6 (S2-T-RLS-MK-01..06): begin_ship → (Stripe capture) → captured", () => {
  it.skipIf(SKIP)("S2-T-RLS-MK-01: owner begin_ship → {outcome:'capture'} (authorized, tracking stored); captured → {outcome:'shipped'}", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAuthUser(c, OWNER_UUID, OWNER_EMAIL, "owner");
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");

      const begun = await beginShip(c, order_id, OWNER_UUID, "  TRACK123  ");
      expect(begun.outcome).toBe("capture");
      expect(begun.order).toMatchObject({
        id: order_id,
        status: "authorized",
        captured_at: null,
        tracking_ref: "TRACK123",
        stripe_payment_intent_id: PI_ID_A,
        amount_total_ore: 24995,
      });

      const done = await captured(c, order_id, OWNER_UUID);
      expect(done.outcome).toBe("shipped");
      expect(done.order).toMatchObject({ status: "shipped", shipped_by: OWNER_UUID, tracking_ref: "TRACK123" });
      expect(await orderState(c, order_id)).toMatchObject({ status: "shipped", captured: true, shipped: true });
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-MK-02: non-owner/non-admin actor → 42501 'forbidden' (begin_ship and captured)", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      await expectPgError(c, () => beginShip(c, order_id, USER_UUID, null), "42501", "forbidden begin_ship", {
        messageIncludes: "forbidden",
      });
      await expectPgError(c, () => captured(c, order_id, USER_UUID), "42501", "forbidden captured", {
        messageIncludes: "forbidden",
      });
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-MK-03: already shipped → {outcome:'already_shipped'}; the first capture wins", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAuthUser(c, OWNER_UUID, OWNER_EMAIL, "owner");
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      await shipOrder(c, order_id, OWNER_UUID);
      const { rows: before } = await c.query(`SELECT captured_at::text AS t FROM public.orders WHERE id = $1`, [order_id]);
      expect((await beginShip(c, order_id, OWNER_UUID, null)).outcome).toBe("already_shipped");
      expect((await captured(c, order_id, OWNER_UUID)).outcome).toBe("already_shipped");
      const { rows: after } = await c.query(`SELECT captured_at::text AS t FROM public.orders WHERE id = $1`, [order_id]);
      expect(after[0]).toEqual(before[0]);
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-MK-04: refunded or canceled order → P0001 'order_closed'", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAuthUser(c, OWNER_UUID, OWNER_EMAIL, "owner");
      await asServiceRole(c);
      const refunded = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      // Force refunded (bypass business logic for setup; a refund needs a capture)
      await c.query(
        `UPDATE public.orders SET status='refunded', captured_at=now(), amount_refunded_ore=amount_total_ore WHERE id=$1`,
        [refunded.order_id],
      );
      await expectPgError(c, () => beginShip(c, refunded.order_id, OWNER_UUID, null), "P0001", "refunded", {
        messageIncludes: "order_closed",
      });
      await expectPgError(c, () => captured(c, refunded.order_id, OWNER_UUID), "P0001", "refunded captured", {
        messageIncludes: "order_closed",
      });

      const canceled = await recordOrder(c, EVT_ID_B, "checkout.session.completed", { csId: CS_ID_B, piId: PI_ID_B });
      await captureFailed(c, canceled.order_id, "authorization_expired");
      await expectPgError(c, () => beginShip(c, canceled.order_id, OWNER_UUID, null), "P0001", "canceled", {
        messageIncludes: "order_closed",
      });
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-MK-05: order with received withdrawal → P0001 'withdrawal_pending'", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAuthUser(c, OWNER_UUID, OWNER_EMAIL, "owner");
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      // Insert withdrawal directly in 'received' status
      await c.query(
        `INSERT INTO public.order_withdrawals
         (order_id, user_id, consumer_name, channel, statement_version, locale,
          shipped_before_notice, refund_due_at)
         VALUES ($1, $2, 'Testperson', 'link', $3, 'da', false, now() + interval '14 days')`,
        [order_id, USER_UUID, GOODS_TEXT_VERSION],
      );
      await expectPgError(
        c,
        () => beginShip(c, order_id, OWNER_UUID, null),
        "P0001",
        "withdrawal_pending",
        { messageIncludes: "withdrawal_pending" },
      );
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-MK-06: unknown order_id → P0002 'order_not_found' (begin_ship, captured, capture_failed)", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, OWNER_UUID, OWNER_EMAIL, "owner");
      await asServiceRole(c);
      const unknown = "00000000-0000-0000-0521-000000099999";
      for (const call of [
        () => beginShip(c, unknown, OWNER_UUID, null),
        () => captured(c, unknown, OWNER_UUID),
        () => captureFailed(c, unknown, "authorization_expired"),
      ]) {
        await expectPgError(c, call, "P0002", "order_not_found", { messageIncludes: "order_not_found" });
      }
    });
  });
});

// ── S2-ADM-7..10: payments_approve_order_refund ──────────────────────────────

describe("S2-ADM-7..10 (S2-T-RLS-AR-01..04): payments_approve_order_refund", () => {
  it.skipIf(SKIP)("S2-T-RLS-AR-01: admin approves refund on shipped returned order → {outcome:'approved'}, action refund; no notice yet → an admin-channel one (email or letter)", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAdmin(c);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      await shipOrder(c, order_id, ADMIN_UUID);
      const r = await approveRefund(c, order_id, ADMIN_UUID, "returned", 0, null);
      expect(r.outcome).toBe("approved");
      expect(r.withdrawal).toMatchObject({
        status: "approved",
        action: "refund",
        refund_ore: 24995,
        channel: "admin",
        statement_version: "admin",
        consumer_name: "S2 Testkøber",
      });
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-AR-02: non-admin actor → 42501 'forbidden'", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      await expectPgError(
        c,
        () => approveRefund(c, order_id, USER_UUID, "returned", 0, null),
        "42501",
        "forbidden approve_refund",
        { messageIncludes: "forbidden" },
      );
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-AR-03: goods_state=not_shipped on a shipped order → P0001 'order_shipped'", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAdmin(c);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      await shipOrder(c, order_id, ADMIN_UUID);
      await expectPgError(
        c,
        () => approveRefund(c, order_id, ADMIN_UUID, "not_shipped", 0, null),
        "P0001",
        "order_shipped",
        { messageIncludes: "order_shipped" },
      );
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-AR-04: goods_state=returned on an unshipped order → P0001 'order_not_shipped'", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAdmin(c);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      await expectPgError(
        c,
        () => approveRefund(c, order_id, ADMIN_UUID, "returned", 0, null),
        "P0001",
        "order_not_shipped",
        { messageIncludes: "order_not_shipped" },
      );
    });
  });
});

// ── S2-WD-9..12: payments_begin_order_withdrawal ─────────────────────────────

describe("S2-WD-9..12 (S2-T-RLS-WD-01..04): payments_begin_order_withdrawal", () => {
  it.skipIf(SKIP)("S2-T-RLS-WD-01: not-shipped order → deadline_at null, shipped_before_notice false; no account on the notice", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      const r = await beginWithdrawal(c, order_id, "Lars", "link", GOODS_TEXT_VERSION, "da");
      expect(r.outcome).toBe("created");
      expect(r.withdrawal.deadline_at).toBeNull();
      expect(r.withdrawal.shipped_before_notice).toBe(false);
      // A link or form notice carries no account, even on a signed-in buyer's order.
      expect(r.withdrawal).toMatchObject({ user_id: null, channel: "link" });
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-WD-02: shipped order with confirmation_sent_at → deadline_at non-null", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAdmin(c);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      await shipOrder(c, order_id, ADMIN_UUID);
      await mailSent(c, order_id, "confirmation", "em_test_01");
      const r = await beginWithdrawal(c, order_id, "Lars", "link", GOODS_TEXT_VERSION, "da");
      expect(r.outcome).toBe("created");
      expect(r.withdrawal.deadline_at).not.toBeNull();
      expect(r.withdrawal.shipped_before_notice).toBe(true);
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-WD-03: shipped + no confirmation_sent_at → 12-month deadline extension", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAdmin(c);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      await shipOrder(c, order_id, ADMIN_UUID);
      // No confirmation stamp → confirmation_sent_at is null
      const r = await beginWithdrawal(c, order_id, "Lars", "link", GOODS_TEXT_VERSION, "da");
      expect(r.outcome).toBe("created");
      expect(r.withdrawal.deadline_at).not.toBeNull();
      // +12 months: deadline must be more than 11 months from now
      const deadlineMs = new Date(r.withdrawal.deadline_at!).getTime();
      const elevenMonthsMs = Date.now() + 11 * 30 * 24 * 60 * 60 * 1000;
      expect(deadlineMs).toBeGreaterThan(elevenMonthsMs);
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-WD-04: late notice accepted and flagged (late = true)", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAdmin(c);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      await shipOrder(c, order_id, ADMIN_UUID);
      await mailSent(c, order_id, "confirmation", "em_test_02");
      // Set shipped far in the past so the 14+transit deadline has passed
      await c.query(
        `UPDATE public.orders
         SET shipped_at = now() - interval '60 days',
             confirmation_sent_at = now() - interval '60 days'
         WHERE id = $1`,
        [order_id],
      );
      const r = await beginWithdrawal(c, order_id, "Lars", "link", GOODS_TEXT_VERSION, "da");
      // NEVER refused for lateness — always created
      expect(r.outcome).toBe("created");
      expect(r.withdrawal.late).toBe(true);
    });
  });
});

// ── S2-ADM-19..20: payments_sync_order_refund ────────────────────────────────

describe("S2-ADM-19..20 (S2-T-RLS-SYN-01..02): payments_sync_order_refund", () => {
  it.skipIf(SKIP)("S2-T-RLS-SYN-01: monotonic — amount never decreases (greatest wins) on a captured order", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAdmin(c);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      await shipOrder(c, order_id, ADMIN_UUID);

      const r1 = await syncRefund(c, EVT_ID_B, PI_ID_A, 20000);
      expect(r1.outcome).toBe("synced");
      // bigint comes back as string from jsonb; Number() for assertion
      expect(Number(r1.amount_refunded_ore)).toBe(20000);
      expect(r1.status).toBe("shipped");

      // Lower amount → still 20000
      const r2 = await syncRefund(c, EVT_ID_C, PI_ID_A, 5000);
      expect(r2.outcome).toBe("synced");
      expect(Number(r2.amount_refunded_ore)).toBe(20000);
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-SYN-02: unknown payment_intent → {outcome:'unknown_order'}", async () => {
    await withTx(client, async (c) => {
      await asServiceRole(c);
      const r = await syncRefund(c, EVT_ID_A, "pi_unknownnotindb0001", 24995);
      expect(r.outcome).toBe("unknown_order");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Writer behaviour tests (§1.9 of the S2 contract)
// New test IDs: S2-T-RLS-GO-* (goods_offer), S2-T-RLS-FO-* (find_order),
//               S2-T-RLS-MS-* (mail_sent), S2-T-RLS-CW-* (claim_withdrawal),
//               S2-T-RLS-WS-* (withdrawal_step), S2-T-RLS-PW-* (pending_work)
//               S2-T-RLS-WD-05..06 (begin_withdrawal missing cases)
//               S2-T-RLS-AR-05..07 (approve_refund missing cases)
// Criteria mapped: S2-CHK-4 (goods_offer), S2-WD-6 (not_withdrawable),
//                  S2-WD-8 (existing), S2-ADM-7 (already_approved),
//                  S2-ADM-12 (deduction_invalid), new deduction_reason_required.
// ═══════════════════════════════════════════════════════════════════════════════

// ── Helper: seed a fully publishable models3d item with an active offer ──────

/**
 * Seeds a published models3d category + item with DA translations and slugs,
 * plus an active physical offer at the given price. Returns item_id.
 * The item satisfies private.item_is_public (published item, published category,
 * DA translations with non-empty slugs).
 */
async function seedPublishableGoodsItem(
  c: PoolClient,
  slugSuffix: string,
  priceOre = 24995,
  active = true,
): Promise<{ itemId: string; categoryId: string; sectionSlug: string; itemSlug: string }> {
  const { rows: cat } = await c.query<{ id: string }>(
    `INSERT INTO public.categories (kind, status) VALUES ('models3d', 'published') RETURNING id`,
  );
  const categoryId = cat[0]!.id;
  // category_translations has no slug column — it lives in public.routes
  await c.query(
    `INSERT INTO public.category_translations (category_id, locale, title)
     VALUES ($1, 'da', '3D-figurer') ON CONFLICT DO NOTHING`,
    [categoryId],
  );
  const sectionSlug = `s2figurer${slugSuffix}`;
  await seedRoute(c, "da", sectionSlug, { categoryId });
  const { rows: itm } = await c.query<{ id: string }>(
    `INSERT INTO public.items (category_id, status, published_at) VALUES ($1, 'published', now()) RETURNING id`,
    [categoryId],
  );
  const itemId = itm[0]!.id;
  const itemSlug = `s2figur${slugSuffix}`;
  await c.query(
    `INSERT INTO public.item_translations (item_id, locale, slug, title)
     VALUES ($1, 'da', $2, 'S2 Testfigur') ON CONFLICT DO NOTHING`,
    [itemId, itemSlug],
  );
  await c.query(
    `INSERT INTO public.item_offers (item_id, kind, price_ore, active) VALUES ($1, 'physical', $2, $3)`,
    [itemId, priceOre, active],
  );
  return { itemId, categoryId, sectionSlug, itemSlug };
}

/** Seed an approved order_withdrawal directly (bypassing business logic); action refund unless given. */
async function seedApprovedWithdrawal(
  c: PoolClient,
  orderId: string,
  actorId: string,
  opts: { leaseUntil?: string; attempts?: number; action?: "refund" | "cancel_authorization" } = {},
): Promise<string> {
  const action = opts.action ?? "refund";
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO public.order_withdrawals
     (order_id, user_id, consumer_name, channel, statement_version, locale,
      shipped_before_notice, refund_due_at, status, goods_state, action,
      approved_at, approved_by, refund_ore, lease_until, attempts)
     VALUES ($1, $2, 'Lars', 'admin', 'admin', 'da', false,
             now() + interval '14 days', 'approved',
             CASE WHEN $5 = 'refund' THEN 'returned' ELSE 'not_shipped' END, $5,
             now(), $2, CASE WHEN $5 = 'refund' THEN 24995 END, $3, $4)
     RETURNING id`,
    [orderId, actorId, opts.leaseUntil ?? null, opts.attempts ?? 0, action],
  );
  return rows[0]!.id;
}

// ── payments_goods_offer (S2-T-RLS-GO-01..03) ────────────────────────────────

describe("payments_goods_offer (S2-T-RLS-GO-01..03): purchasable snapshot or null", () => {
  it.skipIf(SKIP)("S2-T-RLS-GO-01: published item with active physical offer → exact snapshot shape", async () => {
    await withTx(client, async (c) => {
      const { itemId, sectionSlug, itemSlug } = await seedPublishableGoodsItem(c, "go01");
      await asServiceRole(c);
      const { rows } = await c.query<{ payments_goods_offer: Record<string, unknown> | null }>(
        `SELECT payments_goods_offer($1::uuid, 'da'::text)`, [itemId],
      );
      const snap = rows[0]!.payments_goods_offer;
      expect(snap).not.toBeNull();
      expect(snap!.item_id).toBe(itemId);
      expect(Number(snap!.price_ore)).toBe(24995);
      expect(snap!.locale).toBe("da");
      expect(snap!.section_slug).toBe(sectionSlug);
      expect(snap!.item_slug).toBe(itemSlug);
      expect(typeof snap!.title).toBe("string");
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-GO-02: inactive offer → null", async () => {
    await withTx(client, async (c) => {
      const { itemId } = await seedPublishableGoodsItem(c, "go02", 24995, false);
      await asServiceRole(c);
      const { rows } = await c.query<{ payments_goods_offer: unknown }>(
        `SELECT payments_goods_offer($1::uuid, 'da'::text)`, [itemId],
      );
      expect(rows[0]!.payments_goods_offer).toBeNull();
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-GO-03: draft item → null", async () => {
    await withTx(client, async (c) => {
      // Seed a draft item (not published)
      const { rows: cat } = await c.query<{ id: string }>(
        `INSERT INTO public.categories (kind, status) VALUES ('models3d', 'published') RETURNING id`,
      );
      const categoryId = cat[0]!.id;
      const { rows: itm } = await c.query<{ id: string }>(
        `INSERT INTO public.items (category_id, status) VALUES ($1, 'draft') RETURNING id`,
        [categoryId],
      );
      const itemId = itm[0]!.id;
      await c.query(
        `INSERT INTO public.item_offers (item_id, kind, price_ore, active) VALUES ($1, 'physical', 24995, true)`,
        [itemId],
      );
      await asServiceRole(c);
      const { rows } = await c.query<{ payments_goods_offer: unknown }>(
        `SELECT payments_goods_offer($1::uuid, 'da'::text)`, [itemId],
      );
      expect(rows[0]!.payments_goods_offer).toBeNull();
    });
  });
});

// ── payments_find_order (S2-T-RLS-FO-01..04) ─────────────────────────────────

describe("payments_find_order (S2-T-RLS-FO-01..04): found/not-found/wrong-email", () => {
  it.skipIf(SKIP)("S2-T-RLS-FO-01: matching number + email → {order_id: UUID}", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await asServiceRole(c);
      const r = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      const { rows } = await c.query<{ payments_find_order: { order_id: string | null } }>(
        `SELECT payments_find_order($1::bigint, $2::text)`,
        [r.order_number, USER_EMAIL],
      );
      expect(rows[0]!.payments_find_order.order_id).toBe(r.order_id);
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-FO-02: matching number + email (case-insensitive) → found", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await asServiceRole(c);
      const r = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      const { rows } = await c.query<{ payments_find_order: { order_id: string | null } }>(
        `SELECT payments_find_order($1::bigint, $2::text)`,
        [r.order_number, USER_EMAIL.toUpperCase()],
      );
      expect(rows[0]!.payments_find_order.order_id).toBe(r.order_id);
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-FO-03: wrong email → {order_id: null}", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await asServiceRole(c);
      const r = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      const { rows } = await c.query<{ payments_find_order: { order_id: string | null } }>(
        `SELECT payments_find_order($1::bigint, 'wrong@email.local'::text)`,
        [r.order_number],
      );
      expect(rows[0]!.payments_find_order.order_id).toBeNull();
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-FO-04: wrong order number → {order_id: null}", async () => {
    await withTx(client, async (c) => {
      await asServiceRole(c);
      const { rows } = await c.query<{ payments_find_order: { order_id: string | null } }>(
        `SELECT payments_find_order(999999::bigint, $1::text)`, [USER_EMAIL],
      );
      expect(rows[0]!.payments_find_order.order_id).toBeNull();
    });
  });
});

// ── payments_order_mail_sent (S2-T-RLS-MS-01..03) ────────────────────────────

describe("payments_order_mail_sent (S2-T-RLS-MS-01..03): stamp + first-wins + failed increments", () => {
  it.skipIf(SKIP)("S2-T-RLS-MS-01: confirmation kind stamps confirmation_sent_at once", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      await mailSent(c, order_id, "confirmation", "em_first");
      // Verify first stamp
      const { rows: r1 } = await c.query<{ confirmation_email_id: string }>(
        `SELECT confirmation_email_id FROM public.orders WHERE id = $1`, [order_id],
      );
      expect(r1[0]!.confirmation_email_id).toBe("em_first");
      // Second stamp for same kind must NOT overwrite (first-wins)
      await mailSent(c, order_id, "confirmation", "em_second");
      const { rows: r2 } = await c.query<{ confirmation_email_id: string }>(
        `SELECT confirmation_email_id FROM public.orders WHERE id = $1`, [order_id],
      );
      expect(r2[0]!.confirmation_email_id).toBe("em_first");
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-MS-02: owner kind stamps owner_notified_at and owner_email_id", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      await mailSent(c, order_id, "owner", "em_owner_01");
      const { rows } = await c.query<{ owner_email_id: string | null; owner_notified_at: unknown }>(
        `SELECT owner_email_id, owner_notified_at FROM public.orders WHERE id = $1`, [order_id],
      );
      expect(rows[0]!.owner_email_id).toBe("em_owner_01");
      expect(rows[0]!.owner_notified_at).not.toBeNull();
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-MS-03: kind='failed' increments mail_attempts (not a stamp)", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      await mailSent(c, order_id, "failed", "");
      await mailSent(c, order_id, "failed", "");
      const { rows } = await c.query<{ mail_attempts: number }>(
        `SELECT mail_attempts::int FROM public.orders WHERE id = $1`, [order_id],
      );
      expect(rows[0]!.mail_attempts).toBe(2);
    });
  });
});

// ── payments_begin_order_withdrawal missing cases (S2-T-RLS-WD-05..06) ────────

describe("payments_begin_order_withdrawal missing cases (S2-T-RLS-WD-05..06)", () => {
  it.skipIf(SKIP)("S2-T-RLS-WD-05 (S2-WD-6): refunded order → {outcome:'not_withdrawable'}", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      await c.query(
        `UPDATE public.orders SET status='refunded', captured_at=now(), amount_refunded_ore=amount_total_ore WHERE id=$1`,
        [order_id],
      );
      const r = await beginWithdrawal(c, order_id, "Lars", "link", GOODS_TEXT_VERSION, "da");
      expect(r.outcome).toBe("not_withdrawable");
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-WD-06 (S2-WD-8): existing withdrawal → {outcome:'existing', withdrawal}", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      // First call creates it
      const r1 = await beginWithdrawal(c, order_id, "Lars", "link", GOODS_TEXT_VERSION, "da");
      expect(r1.outcome).toBe("created");
      expect(r1.withdrawal.id).toEqual(expect.any(String));
      // Second call returns existing
      const r2 = await beginWithdrawal(c, order_id, "Lars", "link", GOODS_TEXT_VERSION, "da");
      expect(r2).toMatchObject({
        outcome: "existing",
        withdrawal: { id: r1.withdrawal.id, status: "received", channel: "link" },
      });
      const { rows } = await c.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM public.order_withdrawals WHERE order_id = $1`,
        [order_id],
      );
      expect(rows[0]!.count).toBe(1);
    });
  });
});

// ── payments_approve_order_refund missing cases (S2-T-RLS-AR-05..07) ─────────

describe("payments_approve_order_refund missing cases (S2-T-RLS-AR-05..07)", () => {
  it.skipIf(SKIP)("S2-T-RLS-AR-05 (S2-ADM-7): already_approved → {outcome:'already_approved'}", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAdmin(c);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      await shipOrder(c, order_id, ADMIN_UUID);
      await approveRefund(c, order_id, ADMIN_UUID, "returned", 0, null);
      // Second approve on same order
      const r2 = await approveRefund(c, order_id, ADMIN_UUID, "returned", 0, null);
      expect(r2.outcome).toBe("already_approved");
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-AR-06 (S2-ADM-12): deduction leaves refund_ore < 1 → 22023 deduction_invalid", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAdmin(c);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      await shipOrder(c, order_id, ADMIN_UUID);
      // deduction = amount_total_ore = 24995 → refund_ore = 0 < 1 → invalid
      await expectPgError(
        c,
        () => approveRefund(c, order_id, ADMIN_UUID, "returned", 24995, "Full deduction"),
        "22023",
        "deduction_invalid",
        { messageIncludes: "deduction_invalid" },
      );
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-AR-07: deduction > 0 without reason → 22023 deduction_reason_required", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAdmin(c);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      await shipOrder(c, order_id, ADMIN_UUID);
      // deduction = 5000 (valid), but no reason provided
      await expectPgError(
        c,
        () => approveRefund(c, order_id, ADMIN_UUID, "returned", 5000, null),
        "22023",
        "deduction_reason_required",
        { messageIncludes: "deduction_reason_required" },
      );
    });
  });
});

// ── payments_claim_order_withdrawal (S2-T-RLS-CW-01..03) ─────────────────────

describe("payments_claim_order_withdrawal (S2-T-RLS-CW-01..03): lease pattern", () => {
  it.skipIf(SKIP)("S2-T-RLS-CW-01: approved + free lease → claimed:true, attempts incremented, order returned", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAdmin(c);
      await asServiceRole(c);
      const { order_id, order_number } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      const wdId = await seedApprovedWithdrawal(c, order_id, ADMIN_UUID);
      const { rows } = await c.query<{ payments_claim_order_withdrawal: Record<string, unknown> }>(
        `SELECT payments_claim_order_withdrawal($1::uuid, 60::int)`, [wdId],
      );
      const result = rows[0]!.payments_claim_order_withdrawal;
      expect(result.claimed).toBe(true);
      // attempts incremented from 0 → 1; the action travels with the withdrawal
      const withdrawal = result.withdrawal as Record<string, unknown>;
      expect(Number(withdrawal.attempts)).toBe(1);
      expect(withdrawal.action).toBe("refund");
      // order fields returned (incl. what the Worker needs to refund or release)
      const ord = result.order as Record<string, unknown>;
      expect(ord.id).toBe(order_id);
      expect(Number(ord.order_number)).toBe(Number(order_number));
      expect(ord).toMatchObject({ stripe_payment_intent_id: PI_ID_A, captured_at: null, status: "authorized" });
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-CW-02: approved + active lease → claimed:false", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAdmin(c);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      // Seed with an active lease (far future)
      const wdId = await seedApprovedWithdrawal(c, order_id, ADMIN_UUID, {
        leaseUntil: new Date(Date.now() + 3_600_000).toISOString(),
      });
      const { rows } = await c.query<{ payments_claim_order_withdrawal: Record<string, unknown> }>(
        `SELECT payments_claim_order_withdrawal($1::uuid, 60::int)`, [wdId],
      );
      expect(rows[0]!.payments_claim_order_withdrawal.claimed).toBe(false);
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-CW-03: status=received (not approved) → claimed:false", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      // A received withdrawal (not yet approved)
      const r = await beginWithdrawal(c, order_id, "Lars", "link", GOODS_TEXT_VERSION, "da");
      expect(r.outcome).toBe("created");
      const wdRow = r.withdrawal as Record<string, unknown>;
      const { rows } = await c.query<{ payments_claim_order_withdrawal: Record<string, unknown> }>(
        `SELECT payments_claim_order_withdrawal($1::uuid, 60::int)`, [wdRow.id],
      );
      expect(rows[0]!.payments_claim_order_withdrawal.claimed).toBe(false);
    });
  });
});

// ── payments_order_withdrawal_step (S2-T-RLS-WS-01..05) ──────────────────────

describe("payments_order_withdrawal_step (S2-T-RLS-WS-01..05): steps, first-wins, illegal_step", () => {
  it.skipIf(SKIP)("S2-T-RLS-WS-01: ack_sent stamps ack_sent_at and ack_email_id (first-wins)", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      const r = await beginWithdrawal(c, order_id, "Lars", "link", GOODS_TEXT_VERSION, "da");
      const wdId = (r.withdrawal as Record<string, unknown>).id as string;
      await withdrawalStep(c, wdId, "ack_sent", { email_id: "em_ack_01" });
      const { rows: r1 } = await c.query<{ ack_email_id: string | null }>(
        `SELECT ack_email_id FROM public.order_withdrawals WHERE id = $1`, [wdId],
      );
      expect(r1[0]!.ack_email_id).toBe("em_ack_01");
      // Second call must not overwrite (first-wins)
      await withdrawalStep(c, wdId, "ack_sent", { email_id: "em_ack_02" });
      const { rows: r2 } = await c.query<{ ack_email_id: string | null }>(
        `SELECT ack_email_id FROM public.order_withdrawals WHERE id = $1`, [wdId],
      );
      expect(r2[0]!.ack_email_id).toBe("em_ack_01");
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-WS-02: needs_manual step → status=needs_manual + manual_reason stored", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAdmin(c);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      const wdId = await seedApprovedWithdrawal(c, order_id, ADMIN_UUID);
      await withdrawalStep(c, wdId, "needs_manual", { reason: "stripe_refused" });
      const { rows } = await c.query<{ status: string; manual_reason: string }>(
        `SELECT status, manual_reason FROM public.order_withdrawals WHERE id = $1`, [wdId],
      );
      expect(rows[0]!.status).toBe("needs_manual");
      expect(rows[0]!.manual_reason).toBe("stripe_refused");
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-WS-03: attempt_failed releases lease and stores last_error", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAdmin(c);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      const wdId = await seedApprovedWithdrawal(c, order_id, ADMIN_UUID, {
        leaseUntil: new Date(Date.now() + 3_600_000).toISOString(),
      });
      await withdrawalStep(c, wdId, "attempt_failed", { error: "stripe_timeout" });
      const { rows } = await c.query<{ lease_until: unknown; last_error: string }>(
        `SELECT lease_until, last_error FROM public.order_withdrawals WHERE id = $1`, [wdId],
      );
      expect(rows[0]!.lease_until).toBeNull(); // lease released
      expect(rows[0]!.last_error).toBe("stripe_timeout");
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-WS-04: refunded step → status=completed, refunded_at set, order amount updated + refunded", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAdmin(c);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      await shipOrder(c, order_id, ADMIN_UUID); // only captured money is refunded
      const wdId = await seedApprovedWithdrawal(c, order_id, ADMIN_UUID);
      await withdrawalStep(c, wdId, "refunded", { refund_id: "re_test123", refund_tax_ore: 4999 });
      const { rows: wdRows } = await c.query<{ status: string; refunded_at: unknown; stripe_refund_id: string }>(
        `SELECT status, refunded_at, stripe_refund_id FROM public.order_withdrawals WHERE id = $1`, [wdId],
      );
      expect(wdRows[0]!.status).toBe("completed");
      expect(wdRows[0]!.refunded_at).not.toBeNull();
      expect(wdRows[0]!.stripe_refund_id).toBe("re_test123");
      expect(await orderState(c, order_id)).toMatchObject({ status: "refunded", refunded: 24995 });
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-WS-05 (illegal_step): P0001 for a step that cannot apply to current status", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      const r = await beginWithdrawal(c, order_id, "Lars", "link", GOODS_TEXT_VERSION, "da");
      const wdId = (r.withdrawal as Record<string, unknown>).id as string;
      // 'refunded' and 'authorization_canceled' require status=approved; a received withdrawal raises illegal_step
      for (const [step, data] of [
        ["refunded", { refund_id: "re_x", refund_tax_ore: 0 }],
        ["authorization_canceled", {}],
      ] as const) {
        await expectPgError(c, () => withdrawalStep(c, wdId, step, data), "P0001", step, { messageIncludes: "illegal_step" });
      }
    });
  });
});

// ── payments_pending_order_work (S2-T-RLS-PW-01..03) ─────────────────────────

describe("payments_pending_order_work (S2-T-RLS-PW-01..03): pending mail and withdrawal lists", () => {
  it.skipIf(SKIP)("S2-T-RLS-PW-01: order without confirmation/owner stamps → both in needs", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      // No confirmation or owner mail stamps → both should appear as pending
      const result = await pendingWork(c);
      const myOrder = result.orders_mail.find((o) => o.order_id === order_id);
      expect(myOrder).toBeDefined();
      expect(myOrder!.needs).toContain("confirmation");
      expect(myOrder!.needs).toContain("owner");
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-PW-02: order with mail_attempts >= max → excluded from results", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      // Bump mail_attempts to max (1)
      await c.query(`UPDATE public.orders SET mail_attempts = 1 WHERE id = $1`, [order_id]);
      const result = await pendingWork(c, 1); // max_mail_attempts=1
      const found = result.orders_mail.some((o) => o.order_id === order_id);
      expect(found).toBe(false); // excluded because mail_attempts >= max
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-PW-03: approved withdrawal (lease free) → withdrawal appears with 'refund' need", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAdmin(c);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      const wdId = await seedApprovedWithdrawal(c, order_id, ADMIN_UUID);
      const result = await pendingWork(c);
      const myWd = result.withdrawals.find((w) => w.withdrawal_id === wdId);
      expect(myWd).toBeDefined();
      expect(myWd!.needs).toContain("refund");
    });
  });
});

// ── S2-T-RLS-WS-06: refunded step vs charge.refunded sync — no double count ──
// Spike: every refund also fires charge.refunded with Stripe's cumulative amount, in either
// order relative to the Worker's refunded step. The step therefore sets the order to
// total − deduction (never adding refund_ore on top of what the sync recorded); deviation from
// the contract's "+= refund_ore", reported by the developer.

describe("payments_order_withdrawal_step refunded vs payments_sync_order_refund (S2-T-RLS-WS-06): no double count", () => {
  it.skipIf(SKIP).each([
    { label: "charge.refunded sync first, then the refunded step", syncFirst: true },
    { label: "refunded step first, then charge.refunded sync", syncFirst: false },
  ])("$label → amount_refunded_ore = total − deduction, status refunded", async ({ syncFirst }) => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAdmin(c);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      await shipOrder(c, order_id, ADMIN_UUID);
      // 24995 total − 5000 deduction → refund_ore 19995 (Stripe refund), tax 3999.
      const approved = await approveRefund(c, order_id, ADMIN_UUID, "returned", 5000, "Ridser i lakken");
      const wdId = approved.withdrawal!.id as string;
      const refundedStep = () => withdrawalStep(c, wdId, "refunded", { refund_id: "re_s2rls0000000001", refund_tax_ore: 3999 });
      if (syncFirst) {
        await syncRefund(c, EVT_ID_B, PI_ID_A, 19995);
        await refundedStep();
      } else {
        await refundedStep();
        await syncRefund(c, EVT_ID_B, PI_ID_A, 19995);
      }
      const { rows } = await c.query<{ amount_refunded_ore: number; status: string }>(
        `SELECT amount_refunded_ore::int AS amount_refunded_ore, status FROM public.orders WHERE id = $1`,
        [order_id],
      );
      expect(rows[0]).toEqual({ amount_refunded_ore: 19995, status: "refunded" });
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Amendment A1 — charge on dispatch (S2-CAP-2..11, S2-T-RLS-CAP-01..20)
// ═══════════════════════════════════════════════════════════════════════════════

describe("S2-CAP-2 (S2-T-RLS-CAP-01..03): payments_record_order records an authorized order", () => {
  it.skipIf(SKIP)("S2-T-RLS-CAP-01: capture_state requires_capture → status authorized, authorization_expires_at kept, not captured", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await asServiceRole(c);
      const expiresAt = "2026-11-21T10:00:00.000Z";
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed", { authorizationExpiresAt: expiresAt });
      const { rows } = await c.query(
        `SELECT status, captured_at, canceled_at, anomaly, amount_refunded_ore::int AS refunded,
                authorization_expires_at = $2::timestamptz AS expires_kept
           FROM public.orders WHERE id = $1`,
        [order_id, expiresAt],
      );
      expect(rows[0]).toEqual({
        status: "authorized",
        captured_at: null,
        canceled_at: null,
        anomaly: null,
        refunded: 0,
        expires_kept: true,
      });
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-CAP-02: capture_state succeeded → authorized with captured_at = paid_at, captured_at_checkout added once, no expiry", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await asServiceRole(c);
      const a = await recordOrder(c, EVT_ID_A, "checkout.session.completed", { captureState: "succeeded", anomaly: "tax_mismatch" });
      const b = await recordOrder(c, EVT_ID_B, "checkout.session.completed", {
        csId: CS_ID_B,
        piId: PI_ID_B,
        captureState: "succeeded",
        anomaly: "captured_at_checkout",
        authorizationExpiresAt: null,
      });
      const { rows } = await c.query(
        `SELECT status, anomaly, captured_at = paid_at AS captured_at_paid, authorization_expires_at
           FROM public.orders WHERE id = ANY($1::uuid[]) ORDER BY order_number`,
        [[a.order_id, b.order_id]],
      );
      expect(rows).toEqual([
        { status: "authorized", anomaly: "tax_mismatch,captured_at_checkout", captured_at_paid: true, authorization_expires_at: null },
        { status: "authorized", anomaly: "captured_at_checkout", captured_at_paid: true, authorization_expires_at: null },
      ]);
    });
  });

  it.skipIf(SKIP).each([
    { label: "capture_state missing", patch: { capture_state: undefined } },
    { label: "capture_state 'paid'", patch: { capture_state: "paid" } },
    { label: "authorization_expires_at not a timestamp", patch: { authorization_expires_at: "next week" } },
    { label: "authorization_expires_at a number", patch: { authorization_expires_at: 1_800_000_000 } },
  ])("S2-T-RLS-CAP-03: $label → 22023 invalid_payload", async ({ patch }) => {
    await withTx(client, async (c) => {
      await asServiceRole(c);
      const event = { id: EVT_ID_A, type: "checkout.session.completed", created: new Date().toISOString(), livemode: false };
      const order = { ...goodsOrderInput(), ...patch };
      await expectPgError(
        c,
        () => c.query(`SELECT payments_record_order($1::jsonb, $2::jsonb)`, [JSON.stringify(event), JSON.stringify(order)]),
        "22023",
        "record_order",
        { messageIncludes: "invalid_payload" },
      );
    });
  });
});

describe("S2-CAP-3 (S2-T-RLS-CAP-04..06): captured and capture_failed", () => {
  it.skipIf(SKIP)("S2-T-RLS-CAP-04: captured at Checkout → begin_ship answers captured_at set; captured keeps it (first capture wins)", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAdmin(c);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed", { captureState: "succeeded" });
      const begun = await beginShip(c, order_id, ADMIN_UUID, null);
      expect(begun.outcome).toBe("capture");
      expect(begun.order!.captured_at).not.toBeNull();
      expect((await captured(c, order_id, ADMIN_UUID)).outcome).toBe("shipped");
      const { rows } = await c.query(`SELECT status, captured_at = paid_at AS kept FROM public.orders WHERE id = $1`, [order_id]);
      expect(rows[0]).toEqual({ status: "shipped", kept: true });
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-CAP-05: capture_failed authorization_expired → canceled (authorization_expired), replay → canceled", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAdmin(c);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      await beginShip(c, order_id, ADMIN_UUID, "TRACK");
      const r1 = await captureFailed(c, order_id, "authorization_expired");
      expect(r1.outcome).toBe("canceled");
      expect(r1.order).toMatchObject({ status: "canceled", cancel_reason: "authorization_expired", captured_at: null, shipped_at: null });
      expect((await captureFailed(c, order_id, "authorization_expired")).outcome).toBe("canceled");
      expect(await orderState(c, order_id)).toMatchObject({ status: "canceled", canceled: true, captured: false, shipped: false });
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-CAP-06: capture_failed for any other reason, or on a captured order → unchanged; malformed reason → 22023", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAdmin(c);
      await asServiceRole(c);
      const authorized = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      expect((await captureFailed(c, authorized.order_id, "stripe_unavailable")).outcome).toBe("unchanged");
      expect(await orderState(c, authorized.order_id)).toMatchObject({ status: "authorized", canceled: false });

      const shipped = await recordOrder(c, EVT_ID_B, "checkout.session.completed", { csId: CS_ID_B, piId: PI_ID_B });
      await shipOrder(c, shipped.order_id, ADMIN_UUID);
      expect((await captureFailed(c, shipped.order_id, "authorization_expired")).outcome).toBe("unchanged");
      expect(await orderState(c, shipped.order_id)).toMatchObject({ status: "shipped" });

      await expectPgError(c, () => captureFailed(c, authorized.order_id, "Not A Reason"), "22023", "reason", {
        messageIncludes: "invalid_payload",
      });
    });
  });
});

describe("S2-CAP-4 (S2-T-RLS-CAP-07..09): approve picks the action", () => {
  it.skipIf(SKIP)("S2-T-RLS-CAP-07: not_shipped on an uncaptured order → action cancel_authorization, no refund_ore", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAdmin(c);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      await beginWithdrawal(c, order_id, "Lars", "link", GOODS_TEXT_VERSION, "da");
      const r = await approveRefund(c, order_id, ADMIN_UUID, "not_shipped", 0, null);
      expect(r.outcome).toBe("approved");
      expect(r.withdrawal).toMatchObject({
        status: "approved",
        goods_state: "not_shipped",
        action: "cancel_authorization",
        refund_ore: null,
        deduction_ore: 0,
      });
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-CAP-08: not_shipped with a deduction → 22023 deduction_invalid", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAdmin(c);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      await expectPgError(
        c,
        () => approveRefund(c, order_id, ADMIN_UUID, "not_shipped", 100, "Ridser"),
        "22023",
        "deduction on cancel",
        { messageIncludes: "deduction_invalid" },
      );
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-CAP-09: not_shipped on an order captured at Checkout → action refund of the whole amount", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAdmin(c);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed", { captureState: "succeeded" });
      const r = await approveRefund(c, order_id, ADMIN_UUID, "not_shipped", 0, null);
      expect(r.withdrawal).toMatchObject({ action: "refund", refund_ore: 24995, goods_state: "not_shipped" });
      // The refund completes it: the order becomes refunded although it never shipped
      await withdrawalStep(c, r.withdrawal!.id as string, "refunded", { refund_id: "re_s2rlscap09", refund_tax_ore: 4999 });
      expect(await orderState(c, order_id)).toMatchObject({ status: "refunded", refunded: 24995, shipped: false });
    });
  });
});

describe("S2-CAP-5 (S2-T-RLS-CAP-10..13): the authorization_canceled step and refund-only refunded step", () => {
  it.skipIf(SKIP)("S2-T-RLS-CAP-10: authorization_canceled → withdrawal completed, order canceled (withdrawn); replay → already", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAdmin(c);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      await beginWithdrawal(c, order_id, "Lars", "link", GOODS_TEXT_VERSION, "da");
      const approved = await approveRefund(c, order_id, ADMIN_UUID, "not_shipped", 0, null);
      const wdId = approved.withdrawal!.id as string;
      expect((await withdrawalStep(c, wdId, "authorization_canceled", {})).outcome).toBe("applied");
      const { rows } = await c.query(
        `SELECT status, authorization_canceled_at IS NOT NULL AS released, refunded_at, stripe_refund_id
           FROM public.order_withdrawals WHERE id = $1`,
        [wdId],
      );
      expect(rows[0]).toEqual({ status: "completed", released: true, refunded_at: null, stripe_refund_id: null });
      expect(await orderState(c, order_id)).toMatchObject({
        status: "canceled",
        cancel_reason: "withdrawn",
        canceled: true,
        captured: false,
        refunded: 0,
      });
      expect((await withdrawalStep(c, wdId, "authorization_canceled", {})).outcome).toBe("already");
      // A completed release takes its receipt
      expect((await withdrawalStep(c, wdId, "receipt_sent", { email_id: "em_cancel_receipt" })).outcome).toBe("applied");
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-CAP-11: the authorization lapsed first → the release completes, the order keeps authorization_expired", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAdmin(c);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      await beginWithdrawal(c, order_id, "Lars", "link", GOODS_TEXT_VERSION, "da");
      await captureFailed(c, order_id, "authorization_expired");
      // The owner can still approve the received withdrawal of a canceled order: nothing to release but the record
      const approved = await approveRefund(c, order_id, ADMIN_UUID, "not_shipped", 0, null);
      expect(approved.withdrawal).toMatchObject({ action: "cancel_authorization" });
      await withdrawalStep(c, approved.withdrawal!.id as string, "authorization_canceled", {});
      expect(await orderState(c, order_id)).toMatchObject({ status: "canceled", cancel_reason: "authorization_expired" });
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-CAP-12: steps must match the action: refunded on a release / authorization_canceled on a refund → illegal_step", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAdmin(c);
      await asServiceRole(c);
      const release = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      const releaseWd = await seedApprovedWithdrawal(c, release.order_id, ADMIN_UUID, { action: "cancel_authorization" });
      await expectPgError(c, () => withdrawalStep(c, releaseWd, "refunded", { refund_id: "re_x1", refund_tax_ore: 0 }), "P0001", "refund on release", {
        messageIncludes: "illegal_step",
      });

      const refund = await recordOrder(c, EVT_ID_B, "checkout.session.completed", { csId: CS_ID_B, piId: PI_ID_B });
      await shipOrder(c, refund.order_id, ADMIN_UUID);
      const refundWd = await seedApprovedWithdrawal(c, refund.order_id, ADMIN_UUID);
      await expectPgError(c, () => withdrawalStep(c, refundWd, "authorization_canceled", {}), "P0001", "release on refund", {
        messageIncludes: "illegal_step",
      });
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-CAP-13: refunded takes a refund_id only: a credit_note_id key or no refund_id → 22023", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAdmin(c);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      const wdId = await seedApprovedWithdrawal(c, order_id, ADMIN_UUID);
      for (const data of [
        { credit_note_id: "cn_s2rls0000000001", refund_tax_ore: 4999 },
        { credit_note_id: null, refund_id: "re_s2rls0000000001", refund_tax_ore: 4999 },
        { refund_tax_ore: 4999 },
      ]) {
        await expectPgError(c, () => withdrawalStep(c, wdId, "refunded", data), "22023", JSON.stringify(data), {
          messageIncludes: "invalid_payload",
        });
      }
    });
  });
});

describe("S2-CAP-6 (S2-T-RLS-CAP-14..15): payments_order_authorization_canceled (payment_intent.canceled)", () => {
  it.skipIf(SKIP)("S2-T-RLS-CAP-14: unknown PI → unknown_order (no event row); authorized → canceled authorization_expired; duplicate; shipped → ignored", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAdmin(c);
      await asServiceRole(c);
      expect((await authorizationCanceled(c, EVT_ID_C, "pi_unknownnotindb0001")).outcome).toBe("unknown_order");
      const { rows: none } = await c.query(`SELECT 1 FROM public.stripe_events WHERE id = $1`, [EVT_ID_C]);
      expect(none).toHaveLength(0);

      const lapsed = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      const r = await authorizationCanceled(c, "evt_s2rlscap14a", PI_ID_A);
      expect(r.outcome).toBe("canceled");
      expect(r.order).toMatchObject({ id: lapsed.order_id, status: "canceled", cancel_reason: "authorization_expired" });
      expect((await authorizationCanceled(c, "evt_s2rlscap14a", PI_ID_A)).outcome).toBe("duplicate");

      const shipped = await recordOrder(c, EVT_ID_B, "checkout.session.completed", { csId: CS_ID_B, piId: PI_ID_B });
      await shipOrder(c, shipped.order_id, ADMIN_UUID);
      expect((await authorizationCanceled(c, "evt_s2rlscap14b", PI_ID_B)).outcome).toBe("ignored");
      expect(await orderState(c, shipped.order_id)).toMatchObject({ status: "shipped" });
      const { rows: recorded } = await c.query(`SELECT 1 FROM public.stripe_events WHERE id = 'evt_s2rlscap14b'`);
      expect(recorded).toHaveLength(1);

      await expectPgError(c, () => authorizationCanceled(c, "evt_s2rlscap14c", PI_ID_A, "charge.refunded"), "22023", "type", {
        messageIncludes: "invalid_payload",
      });
    });
  });

  it.skipIf(SKIP)("S2-T-RLS-CAP-15: the Worker's own release of an approved withdrawal fires it → cancel_reason withdrawn", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAdmin(c);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      const wdId = await seedApprovedWithdrawal(c, order_id, ADMIN_UUID, { action: "cancel_authorization" });
      const r = await authorizationCanceled(c, "evt_s2rlscap15", PI_ID_A);
      expect(r.order).toMatchObject({ status: "canceled", cancel_reason: "withdrawn" });
      // The withdrawal still completes afterwards
      expect((await withdrawalStep(c, wdId, "authorization_canceled", {})).outcome).toBe("applied");
    });
  });
});

describe("S2-CAP-7 (S2-T-RLS-CAP-16..17): capture warnings", () => {
  it.skipIf(SKIP)("S2-T-RLS-CAP-16: an authorized order whose reservation lapses within 48 h is listed once; the stamp removes it", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await asServiceRole(c);
      const due = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      const later = await recordOrder(c, EVT_ID_B, "checkout.session.completed", { csId: CS_ID_B, piId: PI_ID_B });
      await c.query(`UPDATE public.orders SET authorization_expires_at = now() + interval '24 hours' WHERE id = $1`, [due.order_id]);
      await c.query(`UPDATE public.orders SET authorization_expires_at = now() + interval '72 hours' WHERE id = $1`, [later.order_id]);

      const work = await pendingWork(c);
      expect(work.orders_capture_warning.filter((o) => [due.order_id, later.order_id].includes(o.order_id))).toEqual([
        { order_id: due.order_id, needs: ["capture_warning"] },
      ]);

      await mailSent(c, due.order_id, "capture_warning", "em_warn_01");
      const { rows } = await c.query(
        `SELECT capture_warning_email_id, capture_warning_sent_at IS NOT NULL AS stamped FROM public.orders WHERE id = $1`,
        [due.order_id],
      );
      expect(rows[0]).toEqual({ capture_warning_email_id: "em_warn_01", stamped: true });
      expect((await pendingWork(c)).orders_capture_warning.some((o) => o.order_id === due.order_id)).toBe(false);
    });
  });

  it.skipIf(SKIP).each([
    { label: "a withdrawal exists", setup: "withdrawal" },
    { label: "already lapsed", setup: "lapsed" },
    { label: "no expiry (not a card)", setup: "no_expiry" },
    { label: "already captured", setup: "captured" },
    { label: "mail_attempts at the cap", setup: "mail_cap" },
  ])("S2-T-RLS-CAP-17: not listed when $label", async ({ setup }) => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      await c.query(`UPDATE public.orders SET authorization_expires_at = now() + interval '24 hours' WHERE id = $1`, [order_id]);
      if (setup === "withdrawal") await beginWithdrawal(c, order_id, "Lars", "link", GOODS_TEXT_VERSION, "da");
      if (setup === "lapsed") await c.query(`UPDATE public.orders SET authorization_expires_at = now() - interval '1 hour' WHERE id = $1`, [order_id]);
      if (setup === "no_expiry") await c.query(`UPDATE public.orders SET authorization_expires_at = null WHERE id = $1`, [order_id]);
      if (setup === "captured") await c.query(`UPDATE public.orders SET captured_at = now() WHERE id = $1`, [order_id]);
      if (setup === "mail_cap") await c.query(`UPDATE public.orders SET mail_attempts = 8 WHERE id = $1`, [order_id]);
      expect((await pendingWork(c)).orders_capture_warning.some((o) => o.order_id === order_id)).toBe(false);
    });
  });
});

describe("S2-CAP-8 (S2-T-RLS-CAP-18): payments_sync_order_refund is bounded by the captured amount", () => {
  it.skipIf(SKIP)("S2-T-RLS-CAP-18: charge.refunded on an uncaptured (released) authorization moves nothing", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await asServiceRole(c);
      const authorized = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      const r1 = await syncRefund(c, EVT_ID_B, PI_ID_A, 24995);
      expect(r1).toMatchObject({ outcome: "synced", status: "authorized" });
      expect(Number(r1.amount_refunded_ore)).toBe(0);

      const canceled = await recordOrder(c, "evt_s2rlscap18a", "checkout.session.completed", { csId: CS_ID_B, piId: PI_ID_B });
      await captureFailed(c, canceled.order_id, "authorization_expired");
      const r2 = await syncRefund(c, EVT_ID_C, PI_ID_B, 24995);
      expect(r2).toMatchObject({ outcome: "synced", status: "canceled" });
      expect(Number(r2.amount_refunded_ore)).toBe(0);
      expect(await orderState(c, authorized.order_id)).toMatchObject({ status: "authorized", refunded: 0 });
    });
  });
});

describe("S2-CAP-9 (S2-T-RLS-CAP-19): a canceled order is not withdrawable", () => {
  it.skipIf(SKIP)("S2-T-RLS-CAP-19: begin_order_withdrawal on a canceled order → not_withdrawable", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      await captureFailed(c, order_id, "authorization_expired");
      const r = await beginWithdrawal(c, order_id, "Lars", "link", GOODS_TEXT_VERSION, "da");
      expect(r.outcome).toBe("not_withdrawable");
    });
  });
});

describe("S2-CAP-10 (S2-T-RLS-CAP-20): the A1 CHECKs hold even against direct writes", () => {
  // Every case is 23514: the constraint name in the message proves which A1 CHECK fired.
  it.skipIf(SKIP).each([
    { label: "shipped without captured_at", constraint: "orders_captured", sql: `UPDATE public.orders SET status = 'shipped', shipped_at = now() WHERE id = $1` },
    { label: "refunded money that was never captured", constraint: "orders_captured", sql: `UPDATE public.orders SET amount_refunded_ore = 100 WHERE id = $1` },
    { label: "canceled without canceled_at", constraint: "orders_canceled", sql: `UPDATE public.orders SET status = 'canceled', cancel_reason = 'owner' WHERE id = $1` },
    { label: "canceled after a capture", constraint: "orders_canceled", sql: `UPDATE public.orders SET status = 'canceled', canceled_at = now(), cancel_reason = 'owner', captured_at = now() WHERE id = $1` },
    { label: "status paid (pre-A1)", constraint: "orders_status_check", sql: `UPDATE public.orders SET status = 'paid' WHERE id = $1` },
    {
      label: "a release with a refund amount",
      constraint: "order_withdrawals_action",
      sql: `INSERT INTO public.order_withdrawals (order_id, consumer_name, channel, statement_version, locale, shipped_before_notice,
              refund_due_at, status, goods_state, action, approved_at, refund_ore)
            VALUES ($1, 'Lars', 'admin', 'admin', 'da', false, now(), 'approved', 'not_shipped', 'cancel_authorization', now(), 100)`,
    },
    {
      label: "an approved withdrawal without an action",
      constraint: "order_withdrawals_approved",
      sql: `INSERT INTO public.order_withdrawals (order_id, consumer_name, channel, statement_version, locale, shipped_before_notice,
              refund_due_at, status, goods_state, approved_at)
            VALUES ($1, 'Lars', 'admin', 'admin', 'da', false, now(), 'approved', 'not_shipped', now())`,
    },
  ])("S2-T-RLS-CAP-20: $label → 23514 $constraint", async ({ sql, constraint }) => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      await expectPgError(c, () => c.query(sql, [order_id]), "23514", constraint, { messageIncludes: `"${constraint}"` });
    });
  });
});

// Captured at Checkout, never shipped: the refund's charge.refunded sync may land before the
// refunded step while the order is still authorized. The bound is the capture, not the status.
describe("S2-CAP-4 (S2-T-RLS-CAP-21): captured at Checkout + not_shipped refund vs charge.refunded sync — no 23514, no double count", () => {
  it.skipIf(SKIP).each([
    { label: "charge.refunded sync first, then the refunded step", syncFirst: true },
    { label: "refunded step first, then charge.refunded sync", syncFirst: false },
  ])("S2-T-RLS-CAP-21: $label → amount_refunded_ore = total, status refunded", async ({ syncFirst }) => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAdmin(c);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed", { captureState: "succeeded" });
      const approved = await approveRefund(c, order_id, ADMIN_UUID, "not_shipped", 0, null);
      expect(approved.withdrawal).toMatchObject({ action: "refund", refund_ore: 24995 });
      const wdId = approved.withdrawal!.id as string;
      const refundedStep = () => withdrawalStep(c, wdId, "refunded", { refund_id: "re_s2rlscap21", refund_tax_ore: 4999 });
      if (syncFirst) {
        const synced = await syncRefund(c, EVT_ID_B, PI_ID_A, 24995);
        expect(synced).toMatchObject({ outcome: "synced", status: "refunded" });
        expect((await refundedStep()).outcome).toBe("applied");
      } else {
        await refundedStep();
        await syncRefund(c, EVT_ID_B, PI_ID_A, 24995);
      }
      expect(await orderState(c, order_id)).toMatchObject({ status: "refunded", refunded: 24995, shipped: false });
    });
  });
});

describe("S2-CAP-17 (S2-T-RLS-CAP-22): capture_failed capture_refused (amendment A2-3)", () => {
  it.skipIf(SKIP)("S2-T-RLS-CAP-22: an authorized order stays authorized and unshipped and gains the capture_failed anomaly once; unchanged", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAdmin(c);
      await asServiceRole(c);
      const flagged = await recordOrder(c, EVT_ID_A, "checkout.session.completed", { anomaly: "consent_missing" });
      await beginShip(c, flagged.order_id, ADMIN_UUID, "TRACK");
      const r1 = await captureFailed(c, flagged.order_id, "capture_refused");
      expect(r1.outcome).toBe("unchanged");
      expect(r1.order).toMatchObject({
        status: "authorized",
        anomaly: "consent_missing,capture_failed",
        captured_at: null,
        shipped_at: null,
        canceled_at: null,
        cancel_reason: null,
      });
      // A second refusal adds nothing
      expect((await captureFailed(c, flagged.order_id, "capture_refused")).outcome).toBe("unchanged");
      expect(await orderState(c, flagged.order_id)).toMatchObject({
        status: "authorized",
        anomaly: "consent_missing,capture_failed",
        captured: false,
        shipped: false,
        canceled: false,
      });

      // Without an earlier anomaly it is exactly capture_failed; once the payment is resolved the
      // owner can still mark the order shipped.
      const clean = await recordOrder(c, EVT_ID_B, "checkout.session.completed", { csId: CS_ID_B, piId: PI_ID_B });
      expect((await captureFailed(c, clean.order_id, "capture_refused")).order).toMatchObject({ anomaly: "capture_failed" });
      expect((await shipOrder(c, clean.order_id, ADMIN_UUID)).outcome).toBe("shipped");

      // A shipped (captured) order is not flagged by a late refusal
      const shipped = await recordOrder(c, EVT_ID_C, "checkout.session.completed", {
        csId: "cs_test_s2rls0000000003",
        piId: "pi_s2rls00000000000003",
      });
      await shipOrder(c, shipped.order_id, ADMIN_UUID);
      expect((await captureFailed(c, shipped.order_id, "capture_refused")).outcome).toBe("unchanged");
      expect(await orderState(c, shipped.order_id)).toMatchObject({ status: "shipped", anomaly: null });
    });
  });
});

describe("S2-CAP-16 (S2-T-RLS-CAP-23..24): the owner's expired_alert is durable (amendment A2-2)", () => {
  /** Stamp the confirmation and owner mails, so only an expired_alert need can list the order. */
  async function stampNewOrderMails(c: PoolClient, orderId: string): Promise<void> {
    await mailSent(c, orderId, "confirmation", "em_conf_cap23");
    await mailSent(c, orderId, "owner", "em_owner_cap23");
  }

  it.skipIf(SKIP)("S2-T-RLS-CAP-23: an order canceled because its authorization lapsed (refused capture or payment_intent.canceled) needs expired_alert until stamped", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await asServiceRole(c);
      const viaCapture = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      const viaWebhook = await recordOrder(c, EVT_ID_B, "checkout.session.completed", { csId: CS_ID_B, piId: PI_ID_B });
      const ids = [viaCapture.order_id, viaWebhook.order_id];
      for (const id of ids) await stampNewOrderMails(c, id);
      const listed = async (maxMailAttempts = 8) =>
        (await pendingWork(c, maxMailAttempts)).orders_mail.filter((o) => ids.includes(o.order_id));
      expect(await listed()).toEqual([]); // authorized: nothing to send

      expect((await captureFailed(c, viaCapture.order_id, "authorization_expired")).outcome).toBe("canceled");
      expect((await authorizationCanceled(c, "evt_s2rlscap23", PI_ID_B)).order).toMatchObject({
        cancel_reason: "authorization_expired",
      });
      const due = await listed();
      expect(due).toHaveLength(2);
      expect(due).toEqual(
        expect.arrayContaining([
          { order_id: viaCapture.order_id, needs: ["expired_alert"] },
          { order_id: viaWebhook.order_id, needs: ["expired_alert"] },
        ]),
      );

      // The stamp: the first wins and removes the order from the list
      await mailSent(c, viaCapture.order_id, "expired_alert", "em_expired_01");
      await mailSent(c, viaCapture.order_id, "expired_alert", "em_expired_02");
      const { rows } = await c.query(
        `SELECT expired_alert_email_id, expired_alert_sent_at IS NOT NULL AS stamped FROM public.orders WHERE id = $1`,
        [viaCapture.order_id],
      );
      expect(rows[0]).toEqual({ expired_alert_email_id: "em_expired_01", stamped: true });
      expect(await listed()).toEqual([{ order_id: viaWebhook.order_id, needs: ["expired_alert"] }]);

      // A failed send counts toward the mail cap and the order stays listed below it
      await mailSent(c, viaWebhook.order_id, "failed", "");
      expect(await listed()).toEqual([{ order_id: viaWebhook.order_id, needs: ["expired_alert"] }]);
      expect(await listed(1)).toEqual([]);
    });
  });

  it.skipIf(SKIP).each([
    { label: "the authorization was released for a withdrawal (cancel_reason withdrawn)", setup: "withdrawn" },
    { label: "the capture was refused for another reason (still authorized)", setup: "capture_refused" },
    { label: "the alert is stamped", setup: "stamped" },
    { label: "mail_attempts at the cap", setup: "mail_cap" },
  ])("S2-T-RLS-CAP-24: no expired_alert need when $label", async ({ setup }) => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAdmin(c);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      await stampNewOrderMails(c, order_id);
      if (setup === "withdrawn") {
        const wdId = await seedApprovedWithdrawal(c, order_id, ADMIN_UUID, { action: "cancel_authorization" });
        await withdrawalStep(c, wdId, "authorization_canceled", {});
        expect(await orderState(c, order_id)).toMatchObject({ status: "canceled", cancel_reason: "withdrawn" });
      } else if (setup === "capture_refused") {
        await captureFailed(c, order_id, "capture_refused");
      } else {
        await captureFailed(c, order_id, "authorization_expired");
        if (setup === "stamped") await mailSent(c, order_id, "expired_alert", "em_expired_cap24");
        if (setup === "mail_cap") await c.query(`UPDATE public.orders SET mail_attempts = 8 WHERE id = $1`, [order_id]);
      }
      expect((await pendingWork(c)).orders_mail.some((o) => o.order_id === order_id)).toBe(false);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Amendment A3 — code review round 2 (S2-T-RLS-PW-04..05, S2-T-RLS-WS-07, S2-T-RLS-WD-08)
// ═══════════════════════════════════════════════════════════════════════════════

/** The pending-work entry of withdrawal `wdId`, or undefined when it is not listed. */
async function listedWithdrawal(
  c: PoolClient,
  wdId: string,
  maxMailAttempts = 8,
): Promise<{ withdrawal_id: string; needs: string[] } | undefined> {
  return (await pendingWork(c, maxMailAttempts)).withdrawals.find((w) => w.withdrawal_id === wdId);
}

describe("S2-SWP-6 (S2-T-RLS-PW-04): an offline notice the owner recorded gets no ack and no owner alert (amendment A3-1)", () => {
  it.skipIf(SKIP)("S2-T-RLS-PW-04: approving with no notice (channel admin) never lists ack or owner_alert, through approval, release and receipt; a link notice lists both", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAdmin(c);
      await asServiceRole(c);
      // An online notice (personal link) needs the buyer's receipt and the owner's alert
      const online = await recordOrder(c, EVT_ID_B, "checkout.session.completed", { csId: CS_ID_B, piId: PI_ID_B });
      const begun = await beginWithdrawal(c, online.order_id, "Lars", "link", GOODS_TEXT_VERSION, "da");
      const onlineWd = (begun.withdrawal as Record<string, unknown>).id as string;
      expect(await listedWithdrawal(c, onlineWd)).toEqual({ withdrawal_id: onlineWd, needs: ["ack", "owner_alert"] });

      // "Registrér fortrydelse": the approval of an order without a notice creates a channel admin withdrawal
      const offline = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      const approved = await approveRefund(c, offline.order_id, ADMIN_UUID, "not_shipped", 0, null);
      expect(approved.withdrawal).toMatchObject({ channel: "admin", status: "approved", ack_sent_at: null, owner_alerted_at: null });
      const wdId = approved.withdrawal!.id as string;
      expect(await listedWithdrawal(c, wdId)).toEqual({ withdrawal_id: wdId, needs: ["refund"] });

      // Released: only the credit note is due, then nothing
      await withdrawalStep(c, wdId, "authorization_canceled", {});
      expect(await listedWithdrawal(c, wdId)).toEqual({ withdrawal_id: wdId, needs: ["receipt"] });
      await withdrawalStep(c, wdId, "receipt_sent", { email_id: "em_pw04_receipt" });
      expect(await listedWithdrawal(c, wdId)).toBeUndefined();

      // No stamp was written in their place
      const { rows } = await c.query(
        `SELECT ack_sent_at IS NULL AS no_ack, owner_alerted_at IS NULL AS no_alert FROM public.order_withdrawals WHERE id = $1`,
        [wdId],
      );
      expect(rows[0]).toEqual({ no_ack: true, no_alert: true });
    });
  });
});

describe("S2-ADM-17, S2-SWP-6 (S2-T-RLS-PW-05): a needs_manual withdrawal needs the owner's manual alert until stamped (amendment A3-3)", () => {
  it.skipIf(SKIP)("S2-T-RLS-PW-05: needs_manual → manual_alert; a failed send keeps it listed below the mail cap; the stamp removes it", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAdmin(c);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      const wdId = await seedApprovedWithdrawal(c, order_id, ADMIN_UUID, { action: "cancel_authorization" });
      expect(await listedWithdrawal(c, wdId)).toEqual({ withdrawal_id: wdId, needs: ["refund"] });

      await withdrawalStep(c, wdId, "needs_manual", { reason: "stripe_refused" });
      expect(await listedWithdrawal(c, wdId)).toEqual({ withdrawal_id: wdId, needs: ["manual_alert"] });

      await withdrawalStep(c, wdId, "mail_failed", {});
      expect(await listedWithdrawal(c, wdId)).toEqual({ withdrawal_id: wdId, needs: ["manual_alert"] });
      expect(await listedWithdrawal(c, wdId, 1)).toBeUndefined();

      expect((await withdrawalStep(c, wdId, "manual_alert_sent", { email_id: "em_pw05_manual" })).outcome).toBe("applied");
      expect(await listedWithdrawal(c, wdId)).toBeUndefined();
    });
  });
});

describe("S2-ADM-23 (S2-T-RLS-WS-07): the manual_alert_sent step (amendment A3-3)", () => {
  it.skipIf(SKIP)("S2-T-RLS-WS-07: stamps manual_alert_sent_at and manual_alert_email_id once (first wins), needs_manual only; no email_id → 22023", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAdmin(c);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      const wdId = await seedApprovedWithdrawal(c, order_id, ADMIN_UUID);
      await expectPgError(c, () => withdrawalStep(c, wdId, "manual_alert_sent", { email_id: "em_ws07_early" }), "P0001", "approved", {
        messageIncludes: "illegal_step",
      });
      for (const data of [{}, { email_id: "" }, { email_id: 7 }]) {
        await expectPgError(c, () => withdrawalStep(c, wdId, "manual_alert_sent", data), "22023", JSON.stringify(data), {
          messageIncludes: "invalid_payload",
        });
      }

      await withdrawalStep(c, wdId, "needs_manual", { reason: "retries_exhausted" });
      expect((await withdrawalStep(c, wdId, "manual_alert_sent", { email_id: "em_ws07_first" })).outcome).toBe("applied");
      expect((await withdrawalStep(c, wdId, "manual_alert_sent", { email_id: "em_ws07_second" })).outcome).toBe("already");
      const { rows } = await c.query(
        `SELECT status, manual_reason, manual_alert_email_id, manual_alert_sent_at IS NOT NULL AS stamped
           FROM public.order_withdrawals WHERE id = $1`,
        [wdId],
      );
      expect(rows[0]).toEqual({ status: "needs_manual", manual_reason: "retries_exhausted", manual_alert_email_id: "em_ws07_first", stamped: true });
    });
  });
});

describe("S2-WD-8 (S2-T-RLS-WD-08): a repeated notice on a closed order answers the existing withdrawal (amendment A3-2)", () => {
  it.skipIf(SKIP).each([
    { label: "the release recorded (authorization_canceled step)", closing: "release", orderStatus: "canceled", withdrawalStatus: "completed" },
    { label: "payment_intent.canceled after the approval", closing: "webhook", orderStatus: "canceled", withdrawalStatus: "approved" },
    { label: "the refund completed", closing: "refund", orderStatus: "refunded", withdrawalStatus: "completed" },
  ])("S2-T-RLS-WD-08: after $label → existing (link and form), no second row", async ({ closing, orderStatus, withdrawalStatus }) => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, USER_UUID, USER_EMAIL);
      await seedAdmin(c);
      await asServiceRole(c);
      const { order_id } = await recordOrder(c, EVT_ID_A, "checkout.session.completed");
      if (closing === "refund") await shipOrder(c, order_id, ADMIN_UUID);
      const first = await beginWithdrawal(c, order_id, "Lars", "link", GOODS_TEXT_VERSION, "da");
      expect(first.outcome).toBe("created");
      const wdId = (first.withdrawal as Record<string, unknown>).id as string;
      const approved = await approveRefund(c, order_id, ADMIN_UUID, closing === "refund" ? "returned" : "not_shipped", 0, null);
      expect(approved.withdrawal).toMatchObject({ id: wdId, status: "approved" });
      if (closing === "release") await withdrawalStep(c, wdId, "authorization_canceled", {});
      if (closing === "webhook") expect((await authorizationCanceled(c, "evt_s2rlswd08", PI_ID_A)).outcome).toBe("canceled");
      if (closing === "refund") await withdrawalStep(c, wdId, "refunded", { refund_id: "re_s2rlswd08", refund_tax_ore: 4999 });
      expect(await orderState(c, order_id)).toMatchObject({ status: orderStatus });

      for (const channel of ["link", "form"]) {
        const again = await beginWithdrawal(c, order_id, "Lars Andersen", channel, GOODS_TEXT_VERSION, "en");
        expect(again).toMatchObject({
          outcome: "existing",
          withdrawal: { id: wdId, status: withdrawalStatus, channel: "link", consumer_name: "Lars", locale: "da" },
          order: { id: order_id, status: orderStatus },
        });
      }
      const { rows } = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.order_withdrawals WHERE order_id = $1`, [order_id]);
      expect(rows[0]!.n).toBe(1);
    });
  });
});
