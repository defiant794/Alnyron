/**
 * Integration tests — payments_sync_subscription and
 * payments_record_subscription_invoice (PAY1-AC3).
 * Journey: payments-slice1-foundation
 *
 * Guard: e2e project only (SUPABASE_E2E_REF). Requires the payments foundation
 * migration (20261112000100_payments_foundation.sql) to be applied to the target.
 *
 * Run:
 *   npm run test:integration:e2e-project -- tests/integration/rls/rls-payments-sync.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getClient, type PoolClient } from "./helpers/db.js";
import {
  asServiceRole,
  expectPgError,
  seedAuthUser,
  withTx,
} from "./helpers/roles.js";

// ── Fixture UUIDs/emails (prefix 0a35 = pay1-sync) ───────────────────────────

const USER_UUID  = "00000000-0000-0000-0a35-000000000001";
const USER_EMAIL = "e2e-pay1-sync@alnyron-test.local";

const USER2_UUID  = "00000000-0000-0000-0a35-000000000002";
const USER2_EMAIL = "e2e-pay1-sync2@alnyron-test.local";

// No-profile user for PAY1-AC3e unknown_user tests (prefix 0a35)
const NOPRFL_UUID  = "00000000-0000-0000-0a35-000000000003";
const NOPRFL_EMAIL = "e2e-pay1-sync-noprfl@alnyron-test.local";
// No-account user for PAY1-AC3e (UUID with no auth.users row at all)
const NOACC_UUID = "00000000-0000-0000-0a35-000000000004";

// Fixed past timestamps: T1 < T2 so stale/newer tests are deterministic.
const EVT_T1 = "2026-01-01T00:00:00Z";
const EVT_T2 = "2026-01-02T00:00:00Z";
// 1 s after T1 — used by PAY1-AC3j "newer created" terminal-status tests.
const EVT_T1_PLUS_1S = "2026-01-01T00:00:01Z";

// ── Seed helpers ──────────────────────────────────────────────────────────────

async function seedPlan(c: PoolClient, priceId: string, limit = 20): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO public.monitor_plans
       (stripe_price_id, monitor_limit, billing_interval, amount_ore, active)
     VALUES ($1, $2, 'month', 1000, true)
     RETURNING id`,
    [priceId, limit],
  );
  return rows[0]!.id;
}

function pEvent(id: string, created: string = EVT_T1): string {
  return JSON.stringify({ id, type: "customer.subscription.updated", created, livemode: false });
}

function pSub(opts: {
  id: string;
  customerId: string;
  userId: string | null;
  priceId: string;
  status?: string;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
}): string {
  return JSON.stringify({
    id: opts.id,
    customer: opts.customerId,
    user_id: opts.userId,
    price_id: opts.priceId,
    status: opts.status ?? "active",
    current_period_end: opts.currentPeriodEnd ?? null,
    cancel_at_period_end: opts.cancelAtPeriodEnd ?? false,
  });
}

function pInvoice(opts: {
  id: string;
  subscriptionId: string;
  email?: string;
  paidAt?: string;
  amountTotalOre?: number;
  amountTaxOre?: number;
  periodStart?: string | null;
  periodEnd?: string | null;
}): string {
  return JSON.stringify({
    id: opts.id,
    subscription_id: opts.subscriptionId,
    email: opts.email ?? USER_EMAIL,
    amount_total_ore: opts.amountTotalOre ?? 1000,
    amount_tax_ore: opts.amountTaxOre ?? 200,
    period_start: opts.periodStart ?? null,
    period_end: opts.periodEnd ?? null,
    paid_at: opts.paidAt ?? EVT_T1,
  });
}

async function callSync(
  c: PoolClient,
  eventJson: string,
  subJson: string,
): Promise<{ outcome: string; paused: number }> {
  const { rows } = await c.query<{ result: { outcome: string; paused: number } }>(
    "SELECT public.payments_sync_subscription($1::jsonb, $2::jsonb) AS result",
    [eventJson, subJson],
  );
  return rows[0]!.result;
}

async function callRecord(
  c: PoolClient,
  eventJson: string,
  subJson: string,
  invoiceJson: string,
): Promise<{ outcome: string; paused: number }> {
  const { rows } = await c.query<{ result: { outcome: string; paused: number } }>(
    "SELECT public.payments_record_subscription_invoice($1::jsonb, $2::jsonb, $3::jsonb) AS result",
    [eventJson, subJson, invoiceJson],
  );
  return rows[0]!.result;
}

/** Insert a monitor as postgres (bypasses RLS); returns its id. */
async function insertMonitorSql(
  c: PoolClient,
  userId: string,
  url: string,
  createdAt: string,
): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO public.monitors (user_id, url, interval_minutes, status, created_at)
     VALUES ($1, $2, 30, 'active', $3::timestamptz) RETURNING id`,
    [userId, url, createdAt],
  );
  return rows[0]!.id;
}

// ── describe ──────────────────────────────────────────────────────────────────

describe.skipIf(!process.env.SUPABASE_E2E_REF)(
  "PAY1-AC3 — payments_sync_subscription and payments_record_subscription_invoice",
  () => {
    let client: PoolClient;

    beforeAll(async () => {
      client = await getClient();
    });

    afterAll(async () => {
      client.release();
    });

    // ── PAY1-AC3a: duplicate event ────────────────────────────────────────────

    it("PAY1-AC3a: same event id called twice → second call returns outcome duplicate, subscription row unchanged", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        const priceId = "price_sync_dup";
        await seedPlan(c, priceId);

        const evtJson = pEvent("evt_sync_dup_1", EVT_T1);
        const subJsonFirst  = pSub({ id: "sub_sync_dup", customerId: "cus_sync_dup", userId: USER_UUID, priceId, status: "active" });
        // Second payload: same event id but a different status — must be ignored (duplicate)
        const subJsonSecond = pSub({ id: "sub_sync_dup", customerId: "cus_sync_dup", userId: USER_UUID, priceId, status: "past_due" });

        await asServiceRole(c);
        const first = await callSync(c, evtJson, subJsonFirst);
        expect(first.outcome).toBe("applied");

        // As postgres: set updated_at to a sentinel so we can prove the duplicate call
        // does not touch the row even within the same transaction (where now() is constant).
        await c.query("SET LOCAL ROLE postgres");
        await c.query(
          "UPDATE public.subscriptions SET updated_at = '2000-01-01T00:00:00Z'::timestamptz WHERE stripe_subscription_id = $1",
          ["sub_sync_dup"],
        );

        await asServiceRole(c);
        const second = await callSync(c, evtJson, subJsonSecond);
        expect(second.outcome).toBe("duplicate");

        // The subscription row must be entirely unchanged — use SQL booleans to avoid
        // timezone-dependent text formatting of timestamptz values.
        const { rows } = await c.query<{ status: string; sentinel_kept: boolean; evt_kept: boolean }>(
          `SELECT status,
                  updated_at = '2000-01-01T00:00:00Z'::timestamptz AS sentinel_kept,
                  last_event_created = $2::timestamptz AS evt_kept
             FROM public.subscriptions WHERE stripe_subscription_id = $1`,
          ["sub_sync_dup", EVT_T1],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]!.status).toBe("active");
        expect(rows[0]!.sentinel_kept).toBe(true);
        expect(rows[0]!.evt_kept).toBe(true);
      });
    }, 20_000);

    // ── PAY1-AC3b: stale event ─────────────────────────────────────────────────

    it("PAY1-AC3b: event older than last_event_created → outcome stale, row untouched", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        const priceId = "price_sync_stale";
        await seedPlan(c, priceId);

        // Apply a newer event first
        await asServiceRole(c);
        const setup1 = await callSync(
          c,
          pEvent("evt_sync_newer", EVT_T2),
          pSub({ id: "sub_sync_stale", customerId: "cus_sync_stale", userId: USER_UUID, priceId, status: "active" }),
        );
        expect(setup1.outcome).toBe("applied");

        // Now send an older event (EVT_T1 < EVT_T2)
        const result = await callSync(
          c,
          pEvent("evt_sync_older", EVT_T1),
          pSub({ id: "sub_sync_stale", customerId: "cus_sync_stale", userId: USER_UUID, priceId, status: "canceled" }),
        );
        expect(result.outcome).toBe("stale");

        // Status should remain "active" (not changed to "canceled" by the stale event)
        const { rows } = await c.query<{ status: string }>(
          "SELECT status FROM public.subscriptions WHERE stripe_subscription_id = $1",
          ["sub_sync_stale"],
        );
        expect(rows[0]!.status).toBe("active");
      });
    }, 20_000);

    it("PAY1-AC3b-event-recorded: stale event still records the stripe_events row", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        const priceId = "price_sync_stale_evt";
        await seedPlan(c, priceId);

        await asServiceRole(c);
        const setup2 = await callSync(
          c,
          pEvent("evt_sync_stale_newer", EVT_T2),
          pSub({ id: "sub_sync_stale_evt", customerId: "cus_sync_stale_e", userId: USER_UUID, priceId }),
        );
        expect(setup2.outcome).toBe("applied");
        const staleCall = await callSync(
          c,
          pEvent("evt_sync_stale_older", EVT_T1),
          pSub({ id: "sub_sync_stale_evt", customerId: "cus_sync_stale_e", userId: USER_UUID, priceId }),
        );
        expect(staleCall.outcome).toBe("stale");

        const { rows } = await c.query<{ id: string }>(
          "SELECT id FROM public.stripe_events WHERE id = $1",
          ["evt_sync_stale_older"],
        );
        expect(rows).toHaveLength(1);
      });
    }, 20_000);

    // ── PAY1-AC3c: new event applied ──────────────────────────────────────────

    it("PAY1-AC3c: new event → outcome applied, subscription row upserted with all persisted columns", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        const priceId = "price_sync_new";
        const planId  = await seedPlan(c, priceId);
        // Use explicit offsets to assert timezone normalisation via SQL equality, not string match.
        const CPE     = "2026-06-01T12:00:00+01:00"; // summer-time offset for current_period_end
        const EVT_NEW = "2026-07-01T12:00:00+02:00"; // +02:00 offset for last_event_created

        await asServiceRole(c);
        const result = await callSync(
          c,
          pEvent("evt_sync_new", EVT_NEW),
          pSub({ id: "sub_sync_new", customerId: "cus_sync_new", userId: USER_UUID, priceId,
                 currentPeriodEnd: CPE, cancelAtPeriodEnd: true }),
        );
        expect(result.outcome).toBe("applied");

        const { rows } = await c.query<{
          user_id: string;
          status: string;
          plan_id: string;
          stripe_customer_id: string;
          cancel_at_period_end: boolean;
          cpe_ok: boolean;
          lec_ok: boolean;
        }>(
          `SELECT user_id, status, plan_id, stripe_customer_id, cancel_at_period_end,
                  current_period_end = $2::timestamptz AS cpe_ok,
                  last_event_created = $3::timestamptz AS lec_ok
           FROM public.subscriptions WHERE stripe_subscription_id = $1`,
          ["sub_sync_new", CPE, EVT_NEW],
        );
        expect(rows[0]).toMatchObject({
          user_id: USER_UUID,
          status: "active",
          plan_id: planId,
          stripe_customer_id: "cus_sync_new",
          cancel_at_period_end: true,
          cpe_ok: true,
          lec_ok: true,
        });
      });
    }, 20_000);

    // ── PAY1-AC3d: unknown plan ───────────────────────────────────────────────

    it("PAY1-AC3d: price_id matches no monitor_plans row → 22023 unknown_plan", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);

        await asServiceRole(c);
        await expectPgError(
          c,
          () =>
            callSync(
              c,
              pEvent("evt_sync_noplan", EVT_T1),
              pSub({ id: "sub_sync_noplan", customerId: "cus_sync_np", userId: USER_UUID, priceId: "price_does_not_exist" }),
            ),
          "22023",
          "unknown plan",
          { messageIncludes: "unknown_plan" },
        );
      });
    }, 15_000);

    // ── PAY1-AC3e: unknown user ───────────────────────────────────────────────

    it("PAY1-AC3e: user_id null and no billing_customers/subscriptions row → 22023 unknown_user", async () => {
      await withTx(client, async (c) => {
        const priceId = "price_sync_nouser";
        await seedPlan(c, priceId);

        await asServiceRole(c);
        await expectPgError(
          c,
          () =>
            callSync(
              c,
              pEvent("evt_sync_nouser", EVT_T1),
              // user_id = null and no existing billing_customers/subscriptions for cus_no_user
              pSub({ id: "sub_sync_nouser", customerId: "cus_no_user_x", userId: null, priceId }),
            ),
          "22023",
          "unknown user",
          { messageIncludes: "unknown_user" },
        );
      });
    }, 15_000);

    // ── PAY1-AC3f: customer_user_mismatch ─────────────────────────────────────

    it("PAY1-AC3f: billing_customers maps customer to different user → 22023 customer_user_mismatch, nothing written", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        await seedAuthUser(c, USER2_UUID, USER2_EMAIL);
        const priceId = "price_sync_mismatch";
        await seedPlan(c, priceId);

        // billing_customers maps "cus_mismatch" to USER_UUID
        await c.query(
          "INSERT INTO public.billing_customers (user_id, stripe_customer_id) VALUES ($1, $2)",
          [USER_UUID, "cus_mismatch"],
        );

        await asServiceRole(c);
        await expectPgError(
          c,
          () =>
            callSync(
              c,
              pEvent("evt_sync_mismatch", EVT_T1),
              // Payload says user_id = USER2_UUID but billing_customers says USER_UUID
              pSub({ id: "sub_sync_mismatch", customerId: "cus_mismatch", userId: USER2_UUID, priceId }),
            ),
          "22023",
          "customer user mismatch",
          { messageIncludes: "customer_user_mismatch" },
        );

        // No subscription row should have been written
        const { rows } = await c.query(
          "SELECT 1 FROM public.subscriptions WHERE stripe_subscription_id = $1",
          ["sub_sync_mismatch"],
        );
        expect(rows).toHaveLength(0);
      });
    }, 15_000);

    // ── PAY1-AC3g: invalid payload ────────────────────────────────────────────

    it("PAY1-AC3g: missing required event field → 22023 invalid_payload", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        const priceId = "price_sync_badpay";
        await seedPlan(c, priceId);

        await asServiceRole(c);
        // p_event missing "livemode"
        await expectPgError(
          c,
          () =>
            callSync(
              c,
              JSON.stringify({ id: "evt_bad", type: "x", created: EVT_T1 }), // missing livemode
              pSub({ id: "sub_bad", customerId: "cus_bad", userId: USER_UUID, priceId }),
            ),
          "22023",
          "invalid payload missing livemode",
          { messageIncludes: "invalid_payload" },
        );
      });
    }, 15_000);

    it("PAY1-AC3g-status: unknown status value → 22023 invalid_payload", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        const priceId = "price_sync_badstatus";
        await seedPlan(c, priceId);

        await asServiceRole(c);
        await expectPgError(
          c,
          () =>
            callSync(
              c,
              pEvent("evt_badstatus", EVT_T1),
              pSub({ id: "sub_badstatus", customerId: "cus_badstatus", userId: USER_UUID, priceId, status: "unknown_xyz" }),
            ),
          "22023",
          "invalid status",
          { messageIncludes: "invalid_payload" },
        );
      });
    }, 15_000);

    it("PAY1-AC3g-ore: non-integer amount_ore in invoice → 22023 invalid_payload", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        const priceId = "price_sync_badore";
        await seedPlan(c, priceId);

        await asServiceRole(c);
        await expectPgError(
          c,
          () =>
            callRecord(
              c,
              pEvent("evt_badore", EVT_T1),
              pSub({ id: "sub_badore", customerId: "cus_badore", userId: USER_UUID, priceId }),
              JSON.stringify({
                id: "inv_badore",
                subscription_id: "sub_badore",
                email: USER_EMAIL,
                amount_total_ore: "not-a-number",
                amount_tax_ore: 0,
                period_start: null,
                period_end: null,
                paid_at: EVT_T1,
              }),
            ),
          "22023",
          "invalid invoice ore",
          { messageIncludes: "invalid_payload" },
        );
      });
    }, 15_000);

    // ── PAY1-AC3g: amount_tax_ore validation (string / negative / fractional / over-bigint) ──

    describe("PAY1-AC3g: invalid amount_tax_ore values → 22023 invalid_payload", () => {
      it.each([
        { label: "string",          value: `"not-a-number"`,                   priceId: "price_taxore_str"  },
        { label: "negative (-1)",   value: "-1",                               priceId: "price_taxore_neg"  },
        { label: "fractional (0.5)",value: "0.5",                              priceId: "price_taxore_frac" },
        { label: "over bigint max", value: "9223372036854775808",               priceId: "price_taxore_obi"  },
      ])("PAY1-AC3g: amount_tax_ore = $label → 22023 invalid_payload", async ({ value, priceId }) => {
        await withTx(client, async (c) => {
          await seedAuthUser(c, USER_UUID, USER_EMAIL);
          await seedPlan(c, priceId);

          await asServiceRole(c);
          // Build invoice JSON with the bad amount_tax_ore value as a raw JSON fragment
          const invoiceJson = `{"id":"inv_taxore_${priceId}","subscription_id":"sub_taxore_${priceId}","email":"${USER_EMAIL}","amount_total_ore":1000,"amount_tax_ore":${value},"period_start":null,"period_end":null,"paid_at":"${EVT_T1}"}`;
          await expectPgError(
            c,
            () =>
              callRecord(
                c,
                pEvent(`evt_taxore_${priceId}`, EVT_T1),
                pSub({ id: `sub_taxore_${priceId}`, customerId: `cus_taxore_${priceId}`, userId: USER_UUID, priceId }),
                invoiceJson,
              ),
            "22023",
            `invalid amount_tax_ore (${value})`,
            { messageIncludes: "invalid_payload" },
          );
        });
      }, 15_000);
    });

    // ── PAY1-AC3h: invoice before subscription event ──────────────────────────

    it("PAY1-AC3h: invoice can arrive before any subscription event; persists stripe_subscription_id = sub_invfirst and amount_total_ore = 1000", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        const priceId = "price_sync_invfirst";
        await seedPlan(c, priceId);

        // Use explicit offsets so we can assert via SQL equality, not string formatting.
        const PAID_AT      = "2026-03-15T10:00:00+01:00";
        const PERIOD_START = "2026-02-01T00:00:00+01:00";
        const PERIOD_END   = "2026-03-01T00:00:00+01:00";

        await asServiceRole(c);
        const result = await callRecord(
          c,
          pEvent("evt_invfirst", EVT_T1),
          pSub({ id: "sub_invfirst", customerId: "cus_invfirst", userId: USER_UUID, priceId }),
          pInvoice({ id: "inv_invfirst", subscriptionId: "sub_invfirst",
                     paidAt: PAID_AT, periodStart: PERIOD_START, periodEnd: PERIOD_END, amountTaxOre: 150 }),
        );
        expect(result.outcome).toBe("applied");

        // Both the subscription and the invoice row should now exist
        const { rows: subRows } = await c.query(
          "SELECT 1 FROM public.subscriptions WHERE stripe_subscription_id = $1",
          ["sub_invfirst"],
        );
        expect(subRows).toHaveLength(1);

        // Assert key invoice columns (bigint → string from pg; timestamps via SQL equality)
        const { rows: invRows } = await c.query<{
          user_id: string;
          email: string;
          stripe_subscription_id: string;
          amount_total_ore: string;
          amount_tax_ore: string;
          paid_ok: boolean;
          ps_ok: boolean;
          pe_ok: boolean;
        }>(
          `SELECT user_id, email, stripe_subscription_id,
                  amount_total_ore::text, amount_tax_ore::text,
                  paid_at       = $2::timestamptz AS paid_ok,
                  period_start  = $3::timestamptz AS ps_ok,
                  period_end    = $4::timestamptz AS pe_ok
           FROM public.subscription_invoices WHERE stripe_invoice_id = $1`,
          ["inv_invfirst", PAID_AT, PERIOD_START, PERIOD_END],
        );
        expect(invRows).toHaveLength(1);
        expect(invRows[0]).toMatchObject({
          user_id: USER_UUID,
          email: USER_EMAIL,
          stripe_subscription_id: "sub_invfirst",
          amount_total_ore: "1000",
          amount_tax_ore: "150",
          paid_ok: true,
          ps_ok: true,
          pe_ok: true,
        });
      });
    }, 20_000);

    it("PAY1-AC3h-stale-sub: stale subscription payload with invoice → invoice still recorded", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        const priceId = "price_sync_invstale";
        await seedPlan(c, priceId);

        await asServiceRole(c);
        // Apply a newer subscription event first
        const setup3 = await callSync(
          c,
          pEvent("evt_invstale_newer", EVT_T2),
          pSub({ id: "sub_invstale", customerId: "cus_invstale", userId: USER_UUID, priceId }),
        );
        expect(setup3.outcome).toBe("applied");

        // Now record invoice with a stale subscription payload (older event)
        const result = await callRecord(
          c,
          pEvent("evt_invstale_inv", EVT_T1),
          pSub({ id: "sub_invstale", customerId: "cus_invstale", userId: null, priceId, status: "canceled" }),
          pInvoice({ id: "inv_invstale", subscriptionId: "sub_invstale" }),
        );
        expect(result.outcome).toBe("applied");

        // Subscription row should not have been downgraded to "canceled" (stale sub payload)
        const { rows } = await c.query<{ status: string }>(
          "SELECT status FROM public.subscriptions WHERE stripe_subscription_id = $1",
          ["sub_invstale"],
        );
        expect(rows[0]!.status).toBe("active");

        // Invoice should exist and carry the correct user_id (the stored user, not the stale payload)
        const { rows: invRows } = await c.query<{ user_id: string }>(
          "SELECT user_id FROM public.subscription_invoices WHERE stripe_invoice_id = $1",
          ["inv_invstale"],
        );
        expect(invRows).toHaveLength(1);
        expect(invRows[0]!.user_id).toBe(USER_UUID);
      });
    }, 20_000);

    // ── PAY1-AC3f-b/c: remaining customer_user_mismatch cases ────────────────

    it("PAY1-AC3f-b: user already has a different stripe_customer_id → 22023 customer_user_mismatch", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        const priceId = "price_sync_mismatch_b";
        await seedPlan(c, priceId);

        // USER_UUID already maps to "cus_existing_b" in billing_customers.
        await c.query(
          "INSERT INTO public.billing_customers (user_id, stripe_customer_id) VALUES ($1, $2)",
          [USER_UUID, "cus_existing_b"],
        );

        await asServiceRole(c);
        // Payload claims user_id = USER_UUID but presents a different customer id "cus_new_b";
        // the existing billing_customers row maps USER_UUID → "cus_existing_b" → mismatch (case b).
        await expectPgError(
          c,
          () =>
            callSync(
              c,
              pEvent("evt_sync_mismatch_b", EVT_T1),
              pSub({ id: "sub_sync_mismatch_b", customerId: "cus_new_b", userId: USER_UUID, priceId }),
            ),
          "22023",
          "user already has different stripe_customer_id",
          { messageIncludes: "customer_user_mismatch" },
        );

        // No subscription row should have been written.
        const { rows } = await c.query(
          "SELECT 1 FROM public.subscriptions WHERE stripe_subscription_id = $1",
          ["sub_sync_mismatch_b"],
        );
        expect(rows).toHaveLength(0);
      });
    }, 15_000);

    it("PAY1-AC3f-c: existing subscriptions row has different non-null user_id → 22023 customer_user_mismatch", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        await seedAuthUser(c, USER2_UUID, USER2_EMAIL);
        const priceId = "price_sync_mismatch_c";
        const planId  = await seedPlan(c, priceId);

        // Pre-existing subscription row already owned by USER_UUID.
        await c.query(
          `INSERT INTO public.subscriptions
             (stripe_subscription_id, user_id, stripe_customer_id, plan_id, status, last_event_created)
           VALUES ('sub_sync_mismatch_c', $1, 'cus_mismatch_c', $2, 'active', $3::timestamptz)`,
          [USER_UUID, planId, EVT_T1],
        );

        await asServiceRole(c);
        // Payload claims user_id = USER2_UUID but existing sub row has USER_UUID → mismatch (case c).
        await expectPgError(
          c,
          () =>
            callSync(
              c,
              pEvent("evt_sync_mismatch_c", EVT_T2),
              pSub({ id: "sub_sync_mismatch_c", customerId: "cus_mismatch_c", userId: USER2_UUID, priceId }),
            ),
          "22023",
          "subscriptions row has different non-null user_id",
          { messageIncludes: "customer_user_mismatch" },
        );

        // Subscription row keeps user_id = USER_UUID; mismatch check wrote nothing.
        const { rows: subAfter } = await c.query<{ user_id: string }>(
          "SELECT user_id FROM public.subscriptions WHERE stripe_subscription_id = $1",
          ["sub_sync_mismatch_c"],
        );
        expect(subAfter).toHaveLength(1);
        expect(subAfter[0]!.user_id).toBe(USER_UUID);

        // No billing_customers row was written for cus_mismatch_c
        const { rows: bcRows } = await c.query(
          "SELECT 1 FROM public.billing_customers WHERE stripe_customer_id = $1",
          ["cus_mismatch_c"],
        );
        expect(bcRows).toHaveLength(0);

        // No stripe_events row was written
        const { rows: evtRows } = await c.query(
          "SELECT 1 FROM public.stripe_events WHERE id = $1",
          ["evt_sync_mismatch_c"],
        );
        expect(evtRows).toHaveLength(0);
      });
    }, 15_000);

    it.each(["canceled", "incomplete_expired"] as const)(
      "PAY1-AC3f-c-ended-%s: existing terminal-status subscriptions row has non-null user_id different from payload user_id → 22023 customer_user_mismatch, row unchanged, nothing written",
      async (terminalStatus) => {
        const slug = terminalStatus === "canceled" ? "ce" : "cie";
        await withTx(client, async (c) => {
          await seedAuthUser(c, USER_UUID, USER_EMAIL);
          await seedAuthUser(c, USER2_UUID, USER2_EMAIL);
          const priceId = `price_ac3f_${slug}`;
          const planId  = await seedPlan(c, priceId);

          // Pre-existing terminal subscription owned by USER_UUID with a distinct customer.
          await c.query(
            `INSERT INTO public.subscriptions
               (stripe_subscription_id, user_id, stripe_customer_id, plan_id, status, last_event_created)
             VALUES ($1, $2, $3, $4, $5, $6::timestamptz)`,
            [`sub_ac3f_${slug}`, USER_UUID, `cus_ac3f_${slug}_1`, planId, terminalStatus, EVT_T1],
          );

          await asServiceRole(c);
          // Payload uses USER2_UUID and a distinct customer; existing row is owned by USER_UUID.
          // Terminal-status guard fires, then user_id mismatch check raises (PAY1-AC3f case c, ended).
          await expectPgError(
            c,
            () =>
              callSync(
                c,
                pEvent(`evt_ac3f_${slug}`, EVT_T1),
                pSub({ id: `sub_ac3f_${slug}`, customerId: `cus_ac3f_${slug}_2`, userId: USER2_UUID, priceId }),
              ),
            "22023",
            `${terminalStatus} row with different user_id → mismatch`,
            { messageIncludes: "customer_user_mismatch" },
          );

          // Nothing written: stripe_events savepoint-rolled-back, billing_customers payload customer absent.
          const { rows: evtRows } = await c.query(
            "SELECT 1 FROM public.stripe_events WHERE id = $1",
            [`evt_ac3f_${slug}`],
          );
          expect(evtRows).toHaveLength(0);

          const { rows: bcRows } = await c.query(
            "SELECT 1 FROM public.billing_customers WHERE stripe_customer_id = $1",
            [`cus_ac3f_${slug}_2`],
          );
          expect(bcRows).toHaveLength(0);

          // Subscription row keeps user_id = USER_UUID, terminalStatus, stripe_customer_id cus_ac3f_${slug}_1, last_event_created = T.
          const { rows: subAfter } = await c.query<{
            user_id: string;
            status: string;
            stripe_customer_id: string;
            lec_matches: boolean;
          }>(
            `SELECT user_id, status, stripe_customer_id,
                    last_event_created = $2::timestamptz AS lec_matches
               FROM public.subscriptions WHERE stripe_subscription_id = $1`,
            [`sub_ac3f_${slug}`, EVT_T1],
          );
          expect(subAfter).toHaveLength(1);
          expect(subAfter[0]!.user_id).toBe(USER_UUID);
          expect(subAfter[0]!.status).toBe(terminalStatus);
          expect(subAfter[0]!.stripe_customer_id).toBe(`cus_ac3f_${slug}_1`);
          expect(subAfter[0]!.lec_matches).toBe(true);
        });
      },
      15_000,
    );

    // ── PAY1-AC3c extensions / PAY1-AC3i: billing_customers upsert + user resolution ──

    it("PAY1-AC3c-bc: applied sync upserts billing_customers (user_id, stripe_customer_id)", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        const priceId = "price_sync_bc_upsert";
        await seedPlan(c, priceId);

        await asServiceRole(c);
        const result = await callSync(
          c,
          pEvent("evt_sync_bc", EVT_T1),
          pSub({ id: "sub_sync_bc", customerId: "cus_sync_bc", userId: USER_UUID, priceId }),
        );
        expect(result.outcome).toBe("applied");

        const { rows } = await c.query<{ user_id: string; stripe_customer_id: string }>(
          "SELECT user_id, stripe_customer_id FROM public.billing_customers WHERE stripe_customer_id = $1",
          ["cus_sync_bc"],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ user_id: USER_UUID, stripe_customer_id: "cus_sync_bc" });
      });
    }, 15_000);

    it("PAY1-AC3c-stale-older-no-bc: stale sync (older event) writes no billing_customers row", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        const priceId = "price_ac3c_snbc1";
        const planId = await seedPlan(c, priceId);

        // Directly insert a subscription at EVT_T2 without a billing_customers row
        // (bypasses the payments function so billing_customers is not pre-written).
        await c.query(
          `INSERT INTO public.subscriptions
             (stripe_subscription_id, user_id, stripe_customer_id, plan_id, status, last_event_created)
           VALUES ('sub_ac3c_snbc1', $1, 'cus_ac3c_snbc1', $2, 'active', $3::timestamptz)`,
          [USER_UUID, planId, EVT_T2],
        );
        await asServiceRole(c);
        // Sync at EVT_T1 (older than EVT_T2 on the stored row) → stale.
        const staleSync = await callSync(
          c,
          pEvent("evt_ac3c_snbc1", EVT_T1),
          pSub({ id: "sub_ac3c_snbc1", customerId: "cus_ac3c_snbc1", userId: USER_UUID, priceId }),
        );
        expect(staleSync.outcome).toBe("stale");
        // No billing_customers row written for the customer of the stale sync.
        const { rows: bc } = await c.query(
          "SELECT 1 FROM public.billing_customers WHERE stripe_customer_id = $1",
          ["cus_ac3c_snbc1"],
        );
        expect(bc).toHaveLength(0);
      });
    }, 15_000);

    it.each(["canceled", "incomplete_expired"])(
      "PAY1-AC3j-record-no-bc: invoice call with terminal-guarded subscription (%s) writes no billing_customers row",
      async (status) => {
        await withTx(client, async (c) => {
          // Use USER2 so this test is independent of any USER_UUID billing_customers state.
          await seedAuthUser(c, USER2_UUID, USER2_EMAIL);
          const priceId = "price_ac3j_snbc";
          const planId = await seedPlan(c, priceId);

          // Directly insert an ended subscription (no prior sync → no billing_customers row).
          await c.query(
            `INSERT INTO public.subscriptions
               (stripe_subscription_id, user_id, stripe_customer_id, plan_id, status, last_event_created)
             VALUES ('sub_ac3j_snbc', $1, 'cus_ac3j_snbc', $2, $3, $4::timestamptz)`,
            [USER2_UUID, planId, status, EVT_T1],
          );
          await asServiceRole(c);
          // Invoice call: active sub payload against stored ended row → subscription stale (terminal guard),
          // invoice recorded (outcome applied), billing_customers NOT written.
          const recordResult = await callRecord(
            c,
            pEvent("evt_ac3j_snbc", EVT_T1),
            pSub({ id: "sub_ac3j_snbc", customerId: "cus_ac3j_snbc", userId: USER2_UUID, priceId, status: "active" }),
            pInvoice({ id: "inv_ac3j_snbc", subscriptionId: "sub_ac3j_snbc" }),
          );
          expect(recordResult.outcome).toBe("applied");
          const { rows: bc } = await c.query(
            "SELECT 1 FROM public.billing_customers WHERE stripe_customer_id = $1",
            ["cus_ac3j_snbc"],
          );
          expect(bc).toHaveLength(0);
        });
      },
      15_000,
    );

    it("PAY1-AC3i: user_id = null in payload resolved from existing billing_customers row", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        const priceId = "price_sync_resolve";
        await seedPlan(c, priceId);

        // Pre-seed billing_customers mapping "cus_sync_resolve" to USER_UUID.
        await c.query(
          "INSERT INTO public.billing_customers (user_id, stripe_customer_id) VALUES ($1, $2)",
          [USER_UUID, "cus_sync_resolve"],
        );

        await asServiceRole(c);
        // Payload has user_id = null; function must resolve user via billing_customers.
        const result = await callSync(
          c,
          pEvent("evt_sync_resolve", EVT_T1),
          pSub({ id: "sub_sync_resolve", customerId: "cus_sync_resolve", userId: null, priceId }),
        );
        expect(result.outcome).toBe("applied");

        // Subscription must carry the resolved user_id.
        const { rows } = await c.query<{ user_id: string }>(
          "SELECT user_id FROM public.subscriptions WHERE stripe_subscription_id = $1",
          ["sub_sync_resolve"],
        );
        expect(rows[0]!.user_id).toBe(USER_UUID);
      });
    }, 15_000);

    // ── PAY1-AC3g extensions: invoice subscription_id mismatch and amount validation ──

    it("PAY1-AC3g-inv-mismatch: invoice subscription_id ≠ p_subscription.id → 22023 invalid_payload", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        const priceId = "price_inv_match";
        await seedPlan(c, priceId);

        await asServiceRole(c);
        await expectPgError(
          c,
          () =>
            callRecord(
              c,
              pEvent("evt_inv_match", EVT_T1),
              pSub({ id: "sub_inv_match", customerId: "cus_inv_match", userId: USER_UUID, priceId }),
              pInvoice({ id: "inv_inv_match", subscriptionId: "sub_DIFFERENT" }), // mismatch
            ),
          "22023",
          "invoice subscription_id mismatch",
          { messageIncludes: "invalid_payload" },
        );
      });
    }, 15_000);

    it("PAY1-AC3g-negative-ore: negative amount_total_ore → 22023 invalid_payload", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        const priceId = "price_inv_negore";
        await seedPlan(c, priceId);

        await asServiceRole(c);
        await expectPgError(
          c,
          () =>
            callRecord(
              c,
              pEvent("evt_negore", EVT_T1),
              pSub({ id: "sub_negore", customerId: "cus_negore", userId: USER_UUID, priceId }),
              JSON.stringify({
                id: "inv_negore",
                subscription_id: "sub_negore",
                email: USER_EMAIL,
                amount_total_ore: -1,
                amount_tax_ore: 0,
                period_start: null,
                period_end: null,
                paid_at: EVT_T1,
              }),
            ),
          "22023",
          "negative amount_total_ore",
          { messageIncludes: "invalid_payload" },
        );
      });
    }, 15_000);

    it("PAY1-AC3g-fractional-ore: fractional amount_total_ore → 22023 invalid_payload", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        const priceId = "price_inv_fraccore";
        await seedPlan(c, priceId);

        await asServiceRole(c);
        await expectPgError(
          c,
          () =>
            callRecord(
              c,
              pEvent("evt_fraccore", EVT_T1),
              pSub({ id: "sub_fraccore", customerId: "cus_fraccore", userId: USER_UUID, priceId }),
              JSON.stringify({
                id: "inv_fraccore",
                subscription_id: "sub_fraccore",
                email: USER_EMAIL,
                amount_total_ore: 0.5,
                amount_tax_ore: 0,
                period_start: null,
                period_end: null,
                paid_at: EVT_T1,
              }),
            ),
          "22023",
          "fractional amount_total_ore",
          { messageIncludes: "invalid_payload" },
        );
      });
    }, 15_000);

    it("PAY1-AC3g-overbi-ore: amount_total_ore exceeding bigint max → 22023 invalid_payload", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        const priceId = "price_inv_overbi";
        await seedPlan(c, priceId);

        await asServiceRole(c);
        // Use a template literal to avoid JavaScript float64 rounding (9223372036854775808 > bigint max)
        const overBiInvoice = `{"id":"inv_overbi","subscription_id":"sub_overbi","email":"${USER_EMAIL}","amount_total_ore":9223372036854775808,"amount_tax_ore":0,"period_start":null,"period_end":null,"paid_at":"${EVT_T1}"}`;
        await expectPgError(
          c,
          () =>
            callRecord(
              c,
              pEvent("evt_overbi", EVT_T1),
              pSub({ id: "sub_overbi", customerId: "cus_overbi", userId: USER_UUID, priceId }),
              overBiInvoice,
            ),
          "22023",
          "over-bigint amount_total_ore",
          { messageIncludes: "invalid_payload" },
        );
      });
    }, 15_000);

    // ── PAY1-AC3h extensions: duplicate invoice and lapse on invoice path ──

    it("PAY1-AC3h-dup: same event id for invoice call twice → outcome duplicate, no second invoice row", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        const priceId = "price_inv_dup";
        await seedPlan(c, priceId);

        await asServiceRole(c);
        const first = await callRecord(
          c,
          pEvent("evt_inv_dup", EVT_T1),
          pSub({ id: "sub_inv_dup", customerId: "cus_inv_dup", userId: USER_UUID, priceId }),
          pInvoice({ id: "inv_dup", subscriptionId: "sub_inv_dup" }),
        );
        expect(first.outcome).toBe("applied");

        // Second call: same event id but a different amount — must be ignored (duplicate)
        const second = await callRecord(
          c,
          pEvent("evt_inv_dup", EVT_T1),
          pSub({ id: "sub_inv_dup", customerId: "cus_inv_dup", userId: USER_UUID, priceId }),
          pInvoice({ id: "inv_dup", subscriptionId: "sub_inv_dup", amountTotalOre: 9999 }),
        );
        expect(second.outcome).toBe("duplicate");

        // Exactly one invoice row; original amount must be preserved, not overwritten by duplicate.
        const { rows } = await c.query<{ amount_total_ore: number }>(
          "SELECT amount_total_ore::int4 AS amount_total_ore FROM public.subscription_invoices WHERE stripe_invoice_id = $1",
          ["inv_dup"],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]!.amount_total_ore).toBe(1000);
      });
    }, 20_000);

    it("PAY1-AC3h-lapse: invoice call with non-entitling subscription for over-cap user → lapse fires, paused reported", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        // Insert monitors while uncapped, then lower the base cap
        await c.query("UPDATE public.profiles SET monitor_limit = NULL WHERE user_id = $1", [USER_UUID]);
        const priceId = "price_inv_lapse";
        await seedPlan(c, priceId); // plan cap 20 by default

        const id1 = await insertMonitorSql(c, USER_UUID, "https://inv-lapse-1.example.com", "2026-01-01T00:00:00Z");
        const id2 = await insertMonitorSql(c, USER_UUID, "https://inv-lapse-2.example.com", "2026-01-02T00:00:00Z");
        const id3 = await insertMonitorSql(c, USER_UUID, "https://inv-lapse-3.example.com", "2026-01-03T00:00:00Z");

        // base 2; with canceled sub (non-entitling) effective = 2; 3 active > 2 → lapse fires
        await c.query("UPDATE public.profiles SET monitor_limit = 2 WHERE user_id = $1", [USER_UUID]);

        await asServiceRole(c);
        const result = await callRecord(
          c,
          pEvent("evt_inv_lapse", EVT_T2),
          pSub({ id: "sub_inv_lapse", customerId: "cus_inv_lapse", userId: USER_UUID, priceId, status: "canceled" }),
          pInvoice({ id: "inv_inv_lapse", subscriptionId: "sub_inv_lapse" }),
        );
        expect(result.outcome).toBe("applied");
        expect(result.paused).toBe(1);

        // Newest monitor (id3) must be paused; older two must remain active
        const { rows } = await c.query<{ id: string; status: string }>(
          "SELECT id, status FROM public.monitors WHERE user_id = $1 ORDER BY created_at",
          [USER_UUID],
        );
        expect(rows).toEqual([
          { id: id1, status: "active" },
          { id: id2, status: "active" },
          { id: id3, status: "paused" },
        ]);
      });
    }, 25_000);

    // ── PAY1-AC3e extensions: unknown_user when profiles row is missing ──

    it("PAY1-AC3e-noprofile-sync: sync with user_id that has no profiles row → 22023 unknown_user, nothing written", async () => {
      await withTx(client, async (c) => {
        // seedAuthUser triggers on_auth_user_created, which creates the profile row; delete it to
        // simulate a user whose profile has been removed.
        await seedAuthUser(c, NOPRFL_UUID, NOPRFL_EMAIL);
        await c.query("DELETE FROM public.profiles WHERE user_id = $1", [NOPRFL_UUID]);

        const priceId = "price_sync_noprfl";
        await seedPlan(c, priceId);

        await asServiceRole(c);
        await expectPgError(
          c,
          () =>
            callSync(
              c,
              pEvent("evt_sync_noprfl", EVT_T1),
              pSub({ id: "sub_sync_noprfl", customerId: "cus_sync_noprfl", userId: NOPRFL_UUID, priceId }),
            ),
          "22023",
          "sync: user_id with no profiles row",
          { messageIncludes: "unknown_user" },
        );

        // Nothing written
        const { rows: evtRows } = await c.query("SELECT 1 FROM public.stripe_events WHERE id = $1", ["evt_sync_noprfl"]);
        expect(evtRows).toHaveLength(0);
        const { rows: subRows } = await c.query("SELECT 1 FROM public.subscriptions WHERE stripe_subscription_id = $1", ["sub_sync_noprfl"]);
        expect(subRows).toHaveLength(0);
        const { rows: bcRows } = await c.query("SELECT 1 FROM public.billing_customers WHERE stripe_customer_id = $1", ["cus_sync_noprfl"]);
        expect(bcRows).toHaveLength(0);
      });
    }, 15_000);

    it("PAY1-AC3e-noaccount-sync: sync with a UUID that has no auth.users row → 22023 unknown_user, nothing written", async () => {
      await withTx(client, async (c) => {
        const priceId = "price_sync_noacc";
        await seedPlan(c, priceId);

        await asServiceRole(c);
        await expectPgError(
          c,
          () =>
            callSync(
              c,
              pEvent("evt_sync_noacc", EVT_T1),
              pSub({ id: "sub_sync_noacc", customerId: "cus_sync_noacc", userId: NOACC_UUID, priceId }),
            ),
          "22023",
          "sync: user_id with no auth.users row",
          { messageIncludes: "unknown_user" },
        );

        const { rows: evtRows } = await c.query("SELECT 1 FROM public.stripe_events WHERE id = $1", ["evt_sync_noacc"]);
        expect(evtRows).toHaveLength(0);
        const { rows: subRows } = await c.query("SELECT 1 FROM public.subscriptions WHERE stripe_subscription_id = $1", ["sub_sync_noacc"]);
        expect(subRows).toHaveLength(0);
      });
    }, 15_000);

    it("PAY1-AC3e-noprofile-record: record invoice with user_id that has no profiles row → 22023 unknown_user, nothing written", async () => {
      await withTx(client, async (c) => {
        // seedAuthUser triggers on_auth_user_created, which creates the profile row; delete it to
        // simulate a user whose profile has been removed.
        await seedAuthUser(c, NOPRFL_UUID, NOPRFL_EMAIL);
        await c.query("DELETE FROM public.profiles WHERE user_id = $1", [NOPRFL_UUID]);

        const priceId = "price_rec_noprfl";
        await seedPlan(c, priceId);

        await asServiceRole(c);
        await expectPgError(
          c,
          () =>
            callRecord(
              c,
              pEvent("evt_rec_noprfl", EVT_T1),
              pSub({ id: "sub_rec_noprfl", customerId: "cus_rec_noprfl", userId: NOPRFL_UUID, priceId }),
              pInvoice({ id: "inv_rec_noprfl", subscriptionId: "sub_rec_noprfl" }),
            ),
          "22023",
          "record: user_id with no profiles row",
          { messageIncludes: "unknown_user" },
        );

        const { rows: evtRows } = await c.query("SELECT 1 FROM public.stripe_events WHERE id = $1", ["evt_rec_noprfl"]);
        expect(evtRows).toHaveLength(0);
        const { rows: subRows } = await c.query("SELECT 1 FROM public.subscriptions WHERE stripe_subscription_id = $1", ["sub_rec_noprfl"]);
        expect(subRows).toHaveLength(0);
        const { rows: invRows } = await c.query("SELECT 1 FROM public.subscription_invoices WHERE stripe_invoice_id = $1", ["inv_rec_noprfl"]);
        expect(invRows).toHaveLength(0);
      });
    }, 15_000);

    it("PAY1-AC3e-noaccount-record: record invoice with a UUID that has no auth.users row → 22023 unknown_user, nothing written", async () => {
      await withTx(client, async (c) => {
        const priceId = "price_rec_noacc";
        await seedPlan(c, priceId);

        await asServiceRole(c);
        await expectPgError(
          c,
          () =>
            callRecord(
              c,
              pEvent("evt_rec_noacc", EVT_T1),
              pSub({ id: "sub_rec_noacc", customerId: "cus_rec_noacc", userId: NOACC_UUID, priceId }),
              pInvoice({ id: "inv_rec_noacc", subscriptionId: "sub_rec_noacc" }),
            ),
          "22023",
          "record: user_id with no auth.users row",
          { messageIncludes: "unknown_user" },
        );

        const { rows: evtRows } = await c.query("SELECT 1 FROM public.stripe_events WHERE id = $1", ["evt_rec_noacc"]);
        expect(evtRows).toHaveLength(0);
        const { rows: subRows } = await c.query("SELECT 1 FROM public.subscriptions WHERE stripe_subscription_id = $1", ["sub_rec_noacc"]);
        expect(subRows).toHaveLength(0);
        const { rows: invRows } = await c.query("SELECT 1 FROM public.subscription_invoices WHERE stripe_invoice_id = $1", ["inv_rec_noacc"]);
        expect(invRows).toHaveLength(0);
      });
    }, 15_000);

    // ── PAY1-AC3g extensions: infinite and offset-less event.created timestamps ──

    it("PAY1-AC3g-inf-created: event created = 'infinity' → 22023 invalid_payload", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        const priceId = "price_sync_inf";
        await seedPlan(c, priceId);

        await asServiceRole(c);
        await expectPgError(
          c,
          () =>
            callSync(
              c,
              pEvent("evt_sync_inf", "infinity"),
              pSub({ id: "sub_sync_inf", customerId: "cus_sync_inf", userId: USER_UUID, priceId }),
            ),
          "22023",
          "event created = infinity",
          { messageIncludes: "invalid_payload" },
        );
      });
    }, 15_000);

    it("PAY1-AC3g-notz-created: event created without UTC offset → 22023 invalid_payload", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        const priceId = "price_sync_notz";
        await seedPlan(c, priceId);

        await asServiceRole(c);
        await expectPgError(
          c,
          () =>
            callSync(
              c,
              pEvent("evt_sync_notz", "2026-01-01T00:00:00"), // no UTC offset
              pSub({ id: "sub_sync_notz", customerId: "cus_sync_notz", userId: USER_UUID, priceId }),
            ),
          "22023",
          "event created without UTC offset",
          { messageIncludes: "invalid_payload" },
        );
      });
    }, 15_000);

    it("PAY1-AC3g-inf-created-record: payments_record_subscription_invoice with event created = 'infinity' → 22023 invalid_payload", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        const priceId = "price_rec_inf";
        await seedPlan(c, priceId);

        await asServiceRole(c);
        await expectPgError(
          c,
          () =>
            callRecord(
              c,
              pEvent("evt_rec_inf", "infinity"),
              pSub({ id: "sub_rec_inf", customerId: "cus_rec_inf", userId: USER_UUID, priceId }),
              pInvoice({ id: "inv_rec_inf", subscriptionId: "sub_rec_inf" }),
            ),
          "22023",
          "record: event created = infinity",
          { messageIncludes: "invalid_payload" },
        );
      });
    }, 15_000);

    it("PAY1-AC3g-notz-created-record: payments_record_subscription_invoice with event created without UTC offset → 22023 invalid_payload", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        const priceId = "price_rec_notz";
        await seedPlan(c, priceId);

        await asServiceRole(c);
        await expectPgError(
          c,
          () =>
            callRecord(
              c,
              pEvent("evt_rec_notz", "2026-01-01T00:00:00"), // no UTC offset
              pSub({ id: "sub_rec_notz", customerId: "cus_rec_notz", userId: USER_UUID, priceId }),
              pInvoice({ id: "inv_rec_notz", subscriptionId: "sub_rec_notz" }),
            ),
          "22023",
          "record: event created without UTC offset",
          { messageIncludes: "invalid_payload" },
        );
      });
    }, 15_000);

    // ── PAY1-AC3g extensions: infinity and offset-less timestamps in p_subscription and p_invoice ──

    const AC3G_TS_CASES: Array<{
      label: string;
      field: "current_period_end" | "paid_at" | "period_start" | "period_end";
      value: string;
      via: "sync" | "record";
    }> = [
      { label: "p_subscription.current_period_end infinity via sync",    field: "current_period_end", value: "infinity",            via: "sync"   },
      { label: "p_subscription.current_period_end no-offset via sync",   field: "current_period_end", value: "2026-01-01T00:00:00", via: "sync"   },
      { label: "p_subscription.current_period_end infinity via record",  field: "current_period_end", value: "infinity",            via: "record" },
      { label: "p_subscription.current_period_end no-offset via record", field: "current_period_end", value: "2026-01-01T00:00:00", via: "record" },
      { label: "p_invoice.paid_at infinity",                             field: "paid_at",            value: "infinity",            via: "record" },
      { label: "p_invoice.paid_at no-offset",                            field: "paid_at",            value: "2026-01-01T00:00:00", via: "record" },
      { label: "p_invoice.period_start infinity",                        field: "period_start",       value: "infinity",            via: "record" },
      { label: "p_invoice.period_start no-offset",                       field: "period_start",       value: "2026-01-01T00:00:00", via: "record" },
      { label: "p_invoice.period_end infinity",                          field: "period_end",         value: "infinity",            via: "record" },
      { label: "p_invoice.period_end no-offset",                         field: "period_end",         value: "2026-01-01T00:00:00", via: "record" },
    ];

    describe("PAY1-AC3g: non-finite and offset-less timestamps in subscription / invoice fields", () => {
      it.each(AC3G_TS_CASES)("PAY1-AC3g: $label → 22023 invalid_payload", async ({ field, value, via }) => {
        await withTx(client, async (c) => {
          await seedAuthUser(c, USER_UUID, USER_EMAIL);
          const priceId = "price_ac3g_ts";
          await seedPlan(c, priceId);

          await asServiceRole(c);

          const subJson = pSub({
            id: "sub_ac3g_ts",
            customerId: "cus_ac3g_ts",
            userId: USER_UUID,
            priceId,
            currentPeriodEnd: field === "current_period_end" ? value : null,
          });

          await expectPgError(
            c,
            async () => {
              if (via === "sync") {
                await callSync(c, pEvent("evt_ac3g_ts", EVT_T1), subJson);
              } else {
                await callRecord(
                  c,
                  pEvent("evt_ac3g_ts", EVT_T1),
                  subJson,
                  pInvoice({
                    id:             "inv_ac3g_ts",
                    subscriptionId: "sub_ac3g_ts",
                    paidAt:         field === "paid_at"       ? value : EVT_T1,
                    periodStart:    field === "period_start"  ? value : null,
                    periodEnd:      field === "period_end"    ? value : null,
                  }),
                );
              }
            },
            "22023",
            `${field} = ${value} via ${via}`,
            { messageIncludes: "invalid_payload" },
          );
        });
      }, 15_000);
    });

    // ── PAY1-AC3j: terminal-status subscription is never overwritten ─────────

    it("PAY1-AC3j-canceled-equal: canceled subscription, sync active with created = T (equal) → outcome stale, row still canceled, last_event_created = T, effective_monitor_limit = base cap", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        const priceId = "price_ac3j_ce";
        await seedPlan(c, priceId);
        // Set a known base cap; with canceled sub the effective limit must remain at 2.
        await c.query("UPDATE public.profiles SET monitor_limit = 2 WHERE user_id = $1", [USER_UUID]);

        await asServiceRole(c);
        const setup = await callSync(
          c,
          pEvent("evt_ac3j_ce_1", EVT_T1),
          pSub({ id: "sub_ac3j_ce", customerId: "cus_ac3j_ce", userId: USER_UUID, priceId, status: "canceled" }),
        );
        expect(setup.outcome).toBe("applied");

        // Try to overwrite the terminal row with 'active' at the identical created timestamp.
        const result = await callSync(
          c,
          pEvent("evt_ac3j_ce_2", EVT_T1),
          pSub({ id: "sub_ac3j_ce", customerId: "cus_ac3j_ce", userId: USER_UUID, priceId, status: "active" }),
        );
        expect(result.outcome).toBe("stale");

        const { rows } = await c.query<{ status: string; lec_matches: boolean }>(
          `SELECT status,
                  last_event_created = $2::timestamptz AS lec_matches
             FROM public.subscriptions WHERE stripe_subscription_id = $1`,
          ["sub_ac3j_ce", EVT_T1],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]!.status).toBe("canceled");
        expect(rows[0]!.lec_matches).toBe(true);

        const { rows: lim } = await c.query<{ lim: number | null }>(
          "SELECT private.effective_monitor_limit($1) AS lim",
          [USER_UUID],
        );
        expect(lim[0]!.lim).toBe(2);
      });
    }, 20_000);

    it("PAY1-AC3j-canceled-newer: canceled subscription, sync active with created = T+1s (newer) → outcome stale, row still canceled", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        const priceId = "price_ac3j_cn";
        await seedPlan(c, priceId);
        await c.query("UPDATE public.profiles SET monitor_limit = 2 WHERE user_id = $1", [USER_UUID]);

        await asServiceRole(c);
        const setup = await callSync(
          c,
          pEvent("evt_ac3j_cn_1", EVT_T1),
          pSub({ id: "sub_ac3j_cn", customerId: "cus_ac3j_cn", userId: USER_UUID, priceId, status: "canceled" }),
        );
        expect(setup.outcome).toBe("applied");

        // A strictly newer timestamp must still be blocked when the row holds a terminal status.
        const result = await callSync(
          c,
          pEvent("evt_ac3j_cn_2", EVT_T1_PLUS_1S),
          pSub({ id: "sub_ac3j_cn", customerId: "cus_ac3j_cn", userId: USER_UUID, priceId, status: "active" }),
        );
        expect(result.outcome).toBe("stale");

        const { rows } = await c.query<{ status: string; lec_matches: boolean }>(
          `SELECT status,
                  last_event_created = $2::timestamptz AS lec_matches
             FROM public.subscriptions WHERE stripe_subscription_id = $1`,
          ["sub_ac3j_cn", EVT_T1],
        );
        expect(rows[0]!.status).toBe("canceled");
        // last_event_created must remain T, not advance to T+1s.
        expect(rows[0]!.lec_matches).toBe(true);

        const { rows: lim } = await c.query<{ lim: number | null }>(
          "SELECT private.effective_monitor_limit($1) AS lim",
          [USER_UUID],
        );
        expect(lim[0]!.lim).toBe(2);
      });
    }, 20_000);

    it("PAY1-AC3j-incomplete_expired-equal: incomplete_expired subscription, sync active with created = T → outcome stale, row still incomplete_expired, effective_monitor_limit = base cap", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        const priceId = "price_ac3j_ie";
        await seedPlan(c, priceId);
        await c.query("UPDATE public.profiles SET monitor_limit = 2 WHERE user_id = $1", [USER_UUID]);

        await asServiceRole(c);
        const setup = await callSync(
          c,
          pEvent("evt_ac3j_ie_1", EVT_T1),
          pSub({ id: "sub_ac3j_ie", customerId: "cus_ac3j_ie", userId: USER_UUID, priceId, status: "incomplete_expired" }),
        );
        expect(setup.outcome).toBe("applied");

        const result = await callSync(
          c,
          pEvent("evt_ac3j_ie_2", EVT_T1),
          pSub({ id: "sub_ac3j_ie", customerId: "cus_ac3j_ie", userId: USER_UUID, priceId, status: "active" }),
        );
        expect(result.outcome).toBe("stale");

        const { rows } = await c.query<{ status: string; lec_matches: boolean }>(
          `SELECT status,
                  last_event_created = $2::timestamptz AS lec_matches
             FROM public.subscriptions WHERE stripe_subscription_id = $1`,
          ["sub_ac3j_ie", EVT_T1],
        );
        expect(rows[0]!.status).toBe("incomplete_expired");
        expect(rows[0]!.lec_matches).toBe(true);

        const { rows: lim } = await c.query<{ lim: number | null }>(
          "SELECT private.effective_monitor_limit($1) AS lim",
          [USER_UUID],
        );
        expect(lim[0]!.lim).toBe(2);
      });
    }, 20_000);

    it("PAY1-AC3j-incomplete_expired-newer: incomplete_expired subscription, sync active with created = T+1s → outcome stale, row still incomplete_expired", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        const priceId = "price_ac3j_in";
        await seedPlan(c, priceId);
        await c.query("UPDATE public.profiles SET monitor_limit = 2 WHERE user_id = $1", [USER_UUID]);

        await asServiceRole(c);
        const setup = await callSync(
          c,
          pEvent("evt_ac3j_in_1", EVT_T1),
          pSub({ id: "sub_ac3j_in", customerId: "cus_ac3j_in", userId: USER_UUID, priceId, status: "incomplete_expired" }),
        );
        expect(setup.outcome).toBe("applied");

        const result = await callSync(
          c,
          pEvent("evt_ac3j_in_2", EVT_T1_PLUS_1S),
          pSub({ id: "sub_ac3j_in", customerId: "cus_ac3j_in", userId: USER_UUID, priceId, status: "active" }),
        );
        expect(result.outcome).toBe("stale");

        const { rows } = await c.query<{ status: string; lec_matches: boolean }>(
          `SELECT status,
                  last_event_created = $2::timestamptz AS lec_matches
             FROM public.subscriptions WHERE stripe_subscription_id = $1`,
          ["sub_ac3j_in", EVT_T1],
        );
        expect(rows[0]!.status).toBe("incomplete_expired");
        // last_event_created must remain T, not advance to T+1s.
        expect(rows[0]!.lec_matches).toBe(true);

        const { rows: lim } = await c.query<{ lim: number | null }>(
          "SELECT private.effective_monitor_limit($1) AS lim",
          [USER_UUID],
        );
        expect(lim[0]!.lim).toBe(2);
      });
    }, 20_000);

    it.each(["canceled", "incomplete_expired"] as const)(
      "PAY1-AC3j-orphan-%s: terminal-status subscription with user_id NULL (orphan), sync active newer → stale, paused 0, monitors unchanged, last_event_created = T, no billing_customers; record invoice → applied, paused 0, invoice user_id NULL",
      async (terminalStatus) => {
        const slug = terminalStatus === "canceled" ? "or" : "orie";
        await withTx(client, async (c) => {
          await seedAuthUser(c, USER_UUID, USER_EMAIL);
          const priceId = `price_ac3j_${slug}`;
          const planId = await seedPlan(c, priceId);

          // Insert orphaned subscription row (user_id NULL = account was deleted).
          await c.query(
            `INSERT INTO public.subscriptions
               (stripe_subscription_id, user_id, stripe_customer_id, plan_id, status, last_event_created)
             VALUES ($1, NULL, $2, $3, $4, $5::timestamptz)`,
            [`sub_ac3j_${slug}`, `cus_ac3j_${slug}`, planId, terminalStatus, EVT_T1],
          );

          // Insert 3 monitors for USER_UUID (over cap) to make paused = 0 on stale sync non-vacuous.
          await c.query("UPDATE public.profiles SET monitor_limit = NULL WHERE user_id = $1", [USER_UUID]);
          const mon1 = await insertMonitorSql(c, USER_UUID, `https://orphan-${slug}-m1.example.com`, "2026-01-01T00:00:00Z");
          const mon2 = await insertMonitorSql(c, USER_UUID, `https://orphan-${slug}-m2.example.com`, "2026-01-02T00:00:00Z");
          const mon3 = await insertMonitorSql(c, USER_UUID, `https://orphan-${slug}-m3.example.com`, "2026-01-03T00:00:00Z");
          await c.query("UPDATE public.profiles SET monitor_limit = 2 WHERE user_id = $1", [USER_UUID]);

          await asServiceRole(c);
          // Sync with active payload at T+1s (newer): terminal-status guard blocks the upsert;
          // stored user_id IS NULL so no mismatch; outcome is stale.
          const syncResult = await callSync(
            c,
            pEvent(`evt_ac3j_${slug}_1`, EVT_T1_PLUS_1S),
            pSub({ id: `sub_ac3j_${slug}`, customerId: `cus_ac3j_${slug}`, userId: USER_UUID, priceId, status: "active" }),
          );
          expect(syncResult.outcome).toBe("stale");
          // Lapse does not fire on a stale outcome: USER_UUID's monitors are untouched.
          expect(syncResult.paused).toBe(0);

          // Row keeps user_id NULL and terminal status; last_event_created must remain T (not advance to T+1s).
          const { rows: subAfter } = await c.query<{
            user_id: string | null;
            status: string;
            lec_matches: boolean;
          }>(
            `SELECT user_id, status,
                    last_event_created = $2::timestamptz AS lec_matches
               FROM public.subscriptions WHERE stripe_subscription_id = $1`,
            [`sub_ac3j_${slug}`, EVT_T1],
          );
          expect(subAfter).toHaveLength(1);
          expect(subAfter[0]!.user_id).toBeNull();
          expect(subAfter[0]!.status).toBe(terminalStatus);
          expect(subAfter[0]!.lec_matches).toBe(true);

          // All 3 of USER_UUID's monitors remain active (lapse did not fire for stale outcome).
          const { rows: mons } = await c.query<{ id: string; status: string }>(
            "SELECT id, status FROM public.monitors WHERE user_id = $1 ORDER BY created_at",
            [USER_UUID],
          );
          expect(mons).toEqual([
            { id: mon1, status: "active" },
            { id: mon2, status: "active" },
            { id: mon3, status: "active" },
          ]);
          // Record an invoice against the orphaned subscription.
          const recordResult = await callRecord(
            c,
            pEvent(`evt_ac3j_${slug}_2`, EVT_T1_PLUS_1S),
            pSub({ id: `sub_ac3j_${slug}`, customerId: `cus_ac3j_${slug}`, userId: USER_UUID, priceId, status: "active" }),
            pInvoice({ id: `inv_ac3j_${slug}`, subscriptionId: `sub_ac3j_${slug}` }),
          );
          expect(recordResult.outcome).toBe("applied");
          expect(recordResult.paused).toBe(0);

          // Invoice is recorded with user_id NULL (the orphaned subscription's user).
          const { rows: invRows } = await c.query<{ user_id: string | null }>(
            "SELECT user_id FROM public.subscription_invoices WHERE stripe_invoice_id = $1",
            [`inv_ac3j_${slug}`],
          );
          expect(invRows).toHaveLength(1);
          expect(invRows[0]!.user_id).toBeNull();
          // No billing_customers row written for the orphan's customer on a stale sync.
          const { rows: bcRows } = await c.query(
            "SELECT 1 FROM public.billing_customers WHERE stripe_customer_id = $1",
            [`cus_ac3j_${slug}`],
          );
          expect(bcRows).toHaveLength(0);
        });
      },
      25_000,
    );

    it.each(["canceled", "incomplete_expired"] as const)(
      "PAY1-AC3j-record-%s: active sub payload for stored terminal row → subscription untouched, invoice recorded, outcome applied",
      async (terminalStatus) => {
        const slug = terminalStatus === "canceled" ? "rc" : "rie";
        await withTx(client, async (c) => {
          await seedAuthUser(c, USER_UUID, USER_EMAIL);
          const priceId = `price_ac3j_${slug}`;
          await seedPlan(c, priceId);
          // Establish the subscription row with the terminal status.
          await asServiceRole(c);
          const setup = await callSync(
            c,
            pEvent(`evt_ac3j_${slug}_1`, EVT_T1),
            pSub({ id: `sub_ac3j_${slug}`, customerId: `cus_ac3j_${slug}`, userId: USER_UUID, priceId, status: terminalStatus }),
          );
          expect(setup.outcome).toBe("applied");

          // Record an invoice; pass an 'active' subscription payload at the same timestamp.
          // The terminal-status protection blocks the subscription upsert (stays as stored),
          // but the invoice is still recorded — outcome is 'applied' for the invoice path.
          const result = await callRecord(
            c,
            pEvent(`evt_ac3j_${slug}_2`, EVT_T1),
            pSub({ id: `sub_ac3j_${slug}`, customerId: `cus_ac3j_${slug}`, userId: USER_UUID, priceId, status: "active" }),
            pInvoice({ id: `inv_ac3j_${slug}`, subscriptionId: `sub_ac3j_${slug}` }),
          );
          expect(result.outcome).toBe("applied");

          // Subscription row must remain at the terminal status.
          const { rows: subRows } = await c.query<{ status: string }>(
            "SELECT status FROM public.subscriptions WHERE stripe_subscription_id = $1",
            [`sub_ac3j_${slug}`],
          );
          expect(subRows).toHaveLength(1);
          expect(subRows[0]!.status).toBe(terminalStatus);

          // Invoice must have been recorded despite the stale subscription payload.
          const { rows: invRows } = await c.query<{ id: string }>(
            "SELECT stripe_invoice_id AS id FROM public.subscription_invoices WHERE stripe_invoice_id = $1",
            [`inv_ac3j_${slug}`],
          );
          expect(invRows).toHaveLength(1);
        });
      },
      20_000,
    );
  },
);
