/**
 * Integration tests: Stripe-shaped 2026 fixtures → mappers → 1a writers
 * Proves normalizeSubscription/toSubscriptionPayload/normalizeInvoice/eventForRpc
 * output is accepted end-to-end by payments_sync_subscription and
 * payments_record_subscription_invoice — rolled-back transactions.
 * Journey: payments-slice1c-webhook
 * Criteria: WH-AC32a..WH-AC32f
 *
 * Pattern mirrors tests/integration/rls/rls-payments-sync.test.ts:
 * - pg via getClient(), each test wrapped in withTx (BEGIN…ROLLBACK)
 * - asServiceRole before writer calls; RESET ROLE before postgres-side reads
 * - writers receive jsonb payloads; result read via `AS result` → rows[0].result
 * - monitors have status column ('active'|'paused'), not a boolean
 * - profiles.monitor_limit set explicitly for lapse tests
 * - COUNT(*)::int (pg returns bigint as string)
 *
 * Test price IDs from supabase/seed-e2e/monitor-plans-test.sql:
 *   monitor_plus_year  = 'price_1Ub3CoFIgZG2PjS1HuHKEvrB'  (20 monitors, year)
 *   monitor_plus_month = 'price_1Ub3CoFIgZG2PjS1sJ7VtPSS'  (20 monitors, month)
 *
 * Run: npm run test:integration:e2e-project -- tests/integration/payments/webhook-writers-db.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getClient, type PoolClient } from "../../integration/rls/helpers/db.js";
import { asRole, asServiceRole, expectPgError, seedAuthUser, withTx } from "../../integration/rls/helpers/roles.js";
import {
  normalizeSubscription,
  normalizeInvoice,
  eventForRpc,
  toSubscriptionPayload,
} from "@/lib/payments/webhook-mapping";

// ── Fixture constants ─────────────────────────────────────────────────────────

// Prefix 0c01 = payments-slice1c-writers-db test namespace
const USER_UUID  = "00000000-0000-0000-0c01-000000000001";
const USER_EMAIL = "e2e-pay1c-db@alnyron-test.local";

// From supabase/seed-e2e/monitor-plans-test.sql (test-mode prices, e2e project only)
const MONTHLY_PRICE_ID = "price_1Ub3CoFIgZG2PjS1sJ7VtPSS"; // monitor_plus_month

// Fixed unix timestamps (seconds): T1 < T2 so stale/newer tests are deterministic
// Derived from Date.UTC so the values are verifiably correct (not hand-computed).
const T1_UNIX = Math.floor(Date.UTC(2026, 0, 1) / 1000); // 2026-01-01T00:00:00Z
const T2_UNIX = Math.floor(Date.UTC(2026, 0, 2) / 1000); // 2026-01-02T00:00:00Z

// ── Stripe-shaped raw object builders (2026-10-28.endive schema) ──────────────

/**
 * Raw Stripe event object (the shape webhook.ts receives and passes to eventForRpc).
 * `created` is unix seconds, as Stripe sends.
 */
function rawEvent(id: string, type: string, createdUnix: number): unknown {
  return { id, type, created: createdUnix, livemode: false };
}

/**
 * Raw Stripe subscription object matching the 2026-10-28.endive schema.
 * `items.data[0].current_period_end` is an integer unix timestamp (the 2026 basil+ shape).
 * `created` is unix seconds.
 */
function rawSub(opts: {
  id: string;
  customerId: string;
  userId?: string | null;
  priceId?: string;
  status?: string;
  currentPeriodEndUnix?: number | null;
  cancelAtPeriodEnd?: boolean;
  createdUnix?: number;
}): unknown {
  const userId = opts.userId !== undefined ? opts.userId : USER_UUID;
  return {
    id: opts.id,
    customer: opts.customerId,
    status: opts.status ?? "active",
    cancel_at_period_end: opts.cancelAtPeriodEnd ?? false,
    created: opts.createdUnix ?? T1_UNIX,
    metadata: userId
      ? { kind: "monitor_subscription", user_id: userId, plan_id: "plan_test", locale: "da" }
      : {},
    items: {
      data: [{
        price: { id: opts.priceId ?? MONTHLY_PRICE_ID },
        current_period_end: opts.currentPeriodEndUnix ?? T2_UNIX,
      }],
    },
    latest_invoice: "in_wdblast",
  };
}

/**
 * Raw Stripe invoice object matching the 2026-10-28.endive schema.
 * - parent.type = "subscription_details" with nested subscription id
 * - total_taxes[] with integer øre amounts
 * - lines.data[].period with start/end unix seconds
 * - status_transitions.paid_at as unix seconds
 * No `charge` or `payment_intent` at top level (basil+ removed those fields).
 */
function rawInvoice(opts: {
  id: string;
  subscriptionId: string;
  amountPaid?: number;
  taxAmount?: number;
  paidAtUnix?: number;
  periodStartUnix?: number;
  periodEndUnix?: number;
}): unknown {
  return {
    id: opts.id,
    customer_email: USER_EMAIL,
    amount_paid: opts.amountPaid ?? 1000,
    total_taxes: [{ amount: opts.taxAmount ?? 250 }],
    parent: {
      type: "subscription_details",
      subscription_details: { subscription: opts.subscriptionId },
    },
    lines: {
      data: [{
        period: {
          start: opts.periodStartUnix ?? T1_UNIX,
          end: opts.periodEndUnix ?? T2_UNIX,
        },
      }],
    },
    status_transitions: { paid_at: opts.paidAtUnix ?? T1_UNIX + 1 },
  };
}

// ── Mapper + writer call helpers ──────────────────────────────────────────────

/**
 * Run rawEvent through eventForRpc, rawSub through normalizeSubscription +
 * toSubscriptionPayload, then call payments_sync_subscription.
 * Uses the same `AS result` pattern as rls-payments-sync.test.ts.
 */
async function callSync(
  c: PoolClient,
  event: unknown,
  sub: unknown,
): Promise<{ outcome: string; paused: number }> {
  const n = normalizeSubscription(sub);
  if (!n) throw new Error(`normalizeSubscription returned null for: ${JSON.stringify(sub)}`);
  const e = eventForRpc(event as Parameters<typeof eventForRpc>[0]);
  const { rows } = await c.query<{ result: { outcome: string; paused: number } }>(
    "SELECT public.payments_sync_subscription($1::jsonb, $2::jsonb) AS result",
    [JSON.stringify(e), JSON.stringify(toSubscriptionPayload(n))],
  );
  return rows[0]!.result;
}

/**
 * Run mappers on all three objects, then call payments_record_subscription_invoice.
 */
async function callRecord(
  c: PoolClient,
  event: unknown,
  sub: unknown,
  inv: unknown,
): Promise<{ outcome: string; paused: number }> {
  const n = normalizeSubscription(sub);
  if (!n) throw new Error(`normalizeSubscription returned null for: ${JSON.stringify(sub)}`);
  const ni = normalizeInvoice(inv);
  if (!ni) throw new Error(`normalizeInvoice returned null for: ${JSON.stringify(inv)}`);
  const e = eventForRpc(event as Parameters<typeof eventForRpc>[0]);
  const { rows } = await c.query<{ result: { outcome: string; paused: number } }>(
    "SELECT public.payments_record_subscription_invoice($1::jsonb, $2::jsonb, $3::jsonb) AS result",
    [JSON.stringify(e), JSON.stringify(toSubscriptionPayload(n)), JSON.stringify(ni)],
  );
  return rows[0]!.result;
}

/** Insert a monitor as postgres (bypasses RLS); returns its id. */
async function insertMonitorSql(c: PoolClient, userId: string, url: string, createdAt: string): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO public.monitors (user_id, url, interval_minutes, status, created_at)
     VALUES ($1, $2, 30, 'active', $3::timestamptz) RETURNING id`,
    [userId, url, createdAt],
  );
  return rows[0]!.id;
}

// ── describe ──────────────────────────────────────────────────────────────────

describe.skipIf(!process.env.SUPABASE_E2E_REF)(
  "WH-AC32 — webhook writers DB integration: Stripe-shaped fixtures → mappers → writers (rolled-back txns)",
  () => {
    let client: PoolClient;

    beforeAll(async () => {
      client = await getClient();
    });

    afterAll(async () => {
      client.release();
    });

    // ── WH-AC32a: subscription.created → active, effective_monitor_limit = 20 ─

    it("WH-AC32a: Stripe sub object → normalizeSubscription → sync writer → status='active', effective_monitor_limit=20", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        await asServiceRole(c);

        const result = await callSync(
          c,
          rawEvent("evt_wdbcre01", "customer.subscription.created", T1_UNIX),
          rawSub({ id: "sub_wdbcre01", customerId: "cus_wdbc01" }),
        );
        expect(result.outcome).toBe("applied");

        await c.query("RESET ROLE");

        const { rows: sub } = await c.query<{ status: string }>(
          "SELECT status FROM public.subscriptions WHERE stripe_subscription_id = $1",
          ["sub_wdbcre01"],
        );
        expect(sub[0]!.status).toBe("active");

        const { rows: lim } = await c.query<{ lim: number }>(
          "SELECT private.effective_monitor_limit($1::uuid) AS lim",
          [USER_UUID],
        );
        expect(lim[0]!.lim).toBe(20);
      });
    }, 30_000);

    // ── WH-AC32b: subscription.deleted → canceled + monitors paused ──────────

    it("WH-AC32b: Stripe canceled sub → sync writer → status='canceled', 2 newest monitors paused", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);

        // Set monitor_limit = NULL first so the base cap comes from the DB default (NULL = use plan),
        // then set it to 2 so lapse pauses exactly 4 − 2 = 2 monitors (the 2 newest).
        await c.query("RESET ROLE");
        await c.query("UPDATE public.profiles SET monitor_limit = NULL WHERE user_id = $1", [USER_UUID]);

        await asServiceRole(c);
        await callSync(
          c,
          rawEvent("evt_wdbdelcre", "customer.subscription.created", T1_UNIX),
          rawSub({ id: "sub_wdbdel01", customerId: "cus_wdbd01", status: "active" }),
        );

        // Seed 4 monitors while entitled (plan limit = 20)
        await c.query("RESET ROLE");
        const mon1 = await insertMonitorSql(c, USER_UUID, "https://wdb-del-m1.example.com", "2026-01-01T10:00:00Z");
        const mon2 = await insertMonitorSql(c, USER_UUID, "https://wdb-del-m2.example.com", "2026-01-01T11:00:00Z");
        const mon3 = await insertMonitorSql(c, USER_UUID, "https://wdb-del-m3.example.com", "2026-01-01T12:00:00Z");
        const mon4 = await insertMonitorSql(c, USER_UUID, "https://wdb-del-m4.example.com", "2026-01-01T13:00:00Z");
        // Set base cap = 2 so lapse pauses exactly 4 − 2 = 2 monitors
        await c.query("UPDATE public.profiles SET monitor_limit = 2 WHERE user_id = $1", [USER_UUID]);

        await asServiceRole(c);
        const result = await callSync(
          c,
          rawEvent("evt_wdbdel02", "customer.subscription.deleted", T2_UNIX),
          rawSub({ id: "sub_wdbdel01", customerId: "cus_wdbd01", status: "canceled" }),
        );
        expect(result.outcome).toBe("applied");
        expect(result.paused).toBe(2);

        await c.query("RESET ROLE");

        const { rows: subRow } = await c.query<{ status: string }>(
          "SELECT status FROM public.subscriptions WHERE stripe_subscription_id = $1",
          ["sub_wdbdel01"],
        );
        expect(subRow[0]!.status).toBe("canceled");

        // Oldest 2 kept active; newest 2 paused (status column, not boolean)
        const { rows: mons } = await c.query<{ id: string; status: string }>(
          "SELECT id, status FROM public.monitors WHERE user_id = $1 ORDER BY created_at ASC",
          [USER_UUID],
        );
        expect(mons).toEqual([
          { id: mon1, status: "active" },
          { id: mon2, status: "active" },
          { id: mon3, status: "paused" },
          { id: mon4, status: "paused" },
        ]);
      });
    }, 30_000);

    // ── WH-AC32c: invoice.payment_failed → past_due, limit still 20 ──────────

    it("WH-AC32c: Stripe past_due sub → sync writer → status='past_due', effective_monitor_limit=20", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        await asServiceRole(c);

        await callSync(
          c,
          rawEvent("evt_wdbpdcre", "customer.subscription.created", T1_UNIX),
          rawSub({ id: "sub_wdbpd01", customerId: "cus_wdbp01", status: "active" }),
        );

        const result = await callSync(
          c,
          rawEvent("evt_wdbpd02", "invoice.payment_failed", T2_UNIX),
          rawSub({ id: "sub_wdbpd01", customerId: "cus_wdbp01", status: "past_due" }),
        );
        expect(result.outcome).toBe("applied");

        await c.query("RESET ROLE");

        const { rows } = await c.query<{ status: string }>(
          "SELECT status FROM public.subscriptions WHERE stripe_subscription_id = $1",
          ["sub_wdbpd01"],
        );
        expect(rows[0]!.status).toBe("past_due");

        // past_due is entitling — monitor limit still 20
        const { rows: lim } = await c.query<{ lim: number }>(
          "SELECT private.effective_monitor_limit($1::uuid) AS lim",
          [USER_UUID],
        );
        expect(lim[0]!.lim).toBe(20);
      });
    }, 30_000);

    // ── WH-AC32d: invoice.paid → subscription_invoices row in øre ────────────

    it("WH-AC32d: Stripe invoice object → normalizeInvoice → record writer → subscription_invoices row in øre", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        await asServiceRole(c);

        await callSync(
          c,
          rawEvent("evt_wdbinvcre", "customer.subscription.created", T1_UNIX),
          rawSub({ id: "sub_wdbinv01", customerId: "cus_wdbi01", status: "active" }),
        );

        const result = await callRecord(
          c,
          rawEvent("evt_wdbinv02", "invoice.paid", T2_UNIX),
          rawSub({ id: "sub_wdbinv01", customerId: "cus_wdbi01", status: "active" }),
          rawInvoice({
            id: "in_wdbinv01",
            subscriptionId: "sub_wdbinv01",
            amountPaid: 1000,
            taxAmount: 250,
            paidAtUnix: T2_UNIX,
            periodStartUnix: T1_UNIX,
            periodEndUnix: T2_UNIX,
          }),
        );
        expect(result.outcome).toBe("applied");

        await c.query("RESET ROLE");

        const { rows } = await c.query<{ amount_total_ore: number; amount_tax_ore: number }>(
          // bigint columns come back from pg as strings: cast to int for number equality.
          "SELECT amount_total_ore::int AS amount_total_ore, amount_tax_ore::int AS amount_tax_ore FROM public.subscription_invoices WHERE stripe_invoice_id = $1",
          ["in_wdbinv01"],
        );
        expect(rows).toHaveLength(1);
        // Verify mapper preserved integer øre amounts unchanged
        expect(rows[0]!.amount_total_ore).toBe(1000);
        expect(rows[0]!.amount_tax_ore).toBe(250);

        // Verify period round-trips via epoch comparison (pg timestamptz::text uses space not T separator).
        const { rows: invEpoch } = await c.query<{ ps: number; pe: number }>(
          `SELECT extract(epoch from period_start)::int AS ps,
                  extract(epoch from period_end)::int AS pe
           FROM public.subscription_invoices WHERE stripe_invoice_id = $1`,
          ["in_wdbinv01"],
        );
        expect(invEpoch).toHaveLength(1);
        expect(invEpoch[0]!.ps).toBe(T1_UNIX);
        expect(invEpoch[0]!.pe).toBe(T2_UNIX);
      });
    }, 30_000);

    // ── WH-AC32e: same event twice → one stripe_events row, second = duplicate ─

    it("WH-AC32e: same Stripe event id delivered twice → one stripe_events row, second outcome='duplicate'", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        await asServiceRole(c);

        const event = rawEvent("evt_wdbdup01", "customer.subscription.created", T1_UNIX);
        const sub   = rawSub({ id: "sub_wdbdup01", customerId: "cus_wdbdp1" });

        const first = await callSync(c, event, sub);
        expect(first.outcome).toBe("applied");

        const second = await callSync(c, event, sub);
        expect(second.outcome).toBe("duplicate");

        await c.query("RESET ROLE");

        // COUNT(*)::int — pg returns bigint as string without the cast
        const { rows } = await c.query<{ cnt: number }>(
          "SELECT COUNT(*)::int AS cnt FROM public.stripe_events WHERE id = $1",
          ["evt_wdbdup01"],
        );
        expect(rows[0]!.cnt).toBe(1);
      });
    }, 30_000);

    // ── WH-AC32f: authenticated cannot execute grant-revoked writer → 42501 ──

    it("WH-AC32f: authenticated role cannot execute payments_sync_subscription (revoked) → 42501", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        // Switch to authenticated with the fixture user's JWT claims.
        await asRole(c, "authenticated", {
          sub: USER_UUID,
          role: "authenticated",
          email: USER_EMAIL,
        });
        // payments_sync_subscription is REVOKE'd from public, anon, authenticated
        // per 20261112000100_payments_foundation.sql.
        // Direct EXECUTE must raise 42501, not silently return 0 rows.
        await expectPgError(
          c,
          () => c.query(
            "SELECT public.payments_sync_subscription($1::jsonb, $2::jsonb) AS result",
            [
              JSON.stringify({ id: "evt_42501", type: "t", created: "2026-01-01T00:00:00.000Z", livemode: false }),
              JSON.stringify({ id: "sub_42501", customer: "cus_42501", user_id: null, price_id: "price_42501", status: "active", current_period_end: null, cancel_at_period_end: false }),
            ],
          ),
          "42501",
        );
      });
    }, 30_000);
  },
);
