/**
 * Live integration test: real Stripe TEST mode + e2e DB
 * Pattern mirrors tests/integration/payments/webhook-worker-live.test.ts
 * Journey: payments-slice1d-withdrawal
 * Criteria: WD-J4-C05, WD-J4-C06, WD-J5-C03
 *
 * Coverage:
 *   - real test subscription (pm_card_visa, 25 % inclusive tax rate on the item, as the spike) →
 *     processWithdrawal with the Worker's real stripe-api + rpc modules → Stripe shows canceled
 *   - Stripe credit note exists: amount = refund øre, VAT reversed (25% inclusive),
 *       metadata.withdrawal_id present, refunded
 *   - DB row: status=completed, stripe_credit_note_id set, invoice amount_refunded_ore once
 *   - replay of processWithdrawal → same credit note (idempotent, no second charge), also after a
 *     pass that died between the credit note and the refunded step (metadata reconcile)
 *
 * Fixtures: the 1c env helpers (readEnvFile, e2e URL/secret key), real DB columns (plan_id,
 * last_event_created, invoice email/paid_at), a payment method and a tax rate (else the
 * subscription stays incomplete and the credit note has no VAT), a consent (a partial refund),
 * and the 1c cleanup with a count probe.
 *
 * Guards: SUPABASE_E2E_REF + test-mode Stripe key (sk_test_ / rk_test_).
 * Run: npm run test:integration:e2e-project -- tests/integration/payments/withdrawal-live.test.ts
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getClient, type PoolClient } from "../../integration/rls/helpers/db.js";
import { WITHDRAWAL_TEXT_SHA256, WITHDRAWAL_TEXT_VERSION } from "@/config/legal/withdrawal-texts";
import { STRIPE_API_VERSION } from "@/lib/payments/stripe";
import { computeWithdrawalRefund } from "@/lib/payments/withdrawal-refund";
import { readEnvFile } from "../../helpers/env-file";
import { createPaymentsRpc } from "../../../workers/payments/rpc";
import { createStripeApi } from "../../../workers/payments/stripe-api";
import { processWithdrawal, type WithdrawalDeps } from "../../../workers/payments/withdrawal";

// ── Env guards ────────────────────────────────────────────────────────────────

/** STRIPE_CHECKOUT_KEY from .env.local when it is a test key (never printed). */
function loadStripeTestKey(): string | null {
  const key = readEnvFile(".env.local")["STRIPE_CHECKOUT_KEY"] ?? null;
  return key !== null && (key.startsWith("sk_test_") || key.startsWith("rk_test_")) ? key : null;
}

const STRIPE_TEST_KEY = loadStripeTestKey();
const SKIP = !process.env.SUPABASE_E2E_REF || !STRIPE_TEST_KEY;

function e2eSupabaseUrl(): string {
  const ref = process.env.SUPABASE_E2E_REF;
  if (!ref) throw new Error("SUPABASE_E2E_REF not set");
  return `https://${ref}.supabase.co`;
}

function e2eSecretKey(): string {
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_E2E_SECRET_KEY;
  if (!key) throw new Error("SUPABASE_SECRET_KEY / SUPABASE_E2E_SECRET_KEY not set");
  return key;
}

// ── Namespace ─────────────────────────────────────────────────────────────────

const USER_UUID   = "00000000-0000-0000-0d1d-000000000010";
const USER_EMAIL  = "e2e-pay1d-live@alnyron-test.local";
const CONSUMER_NAME = "Live Test Consumer";
const MONTHLY_PRICE_ID = "price_1Ub3CoFIgZG2PjS1sJ7VtPSS"; // from seed-e2e
const SESSION_ID = `cs_test_wd1dlive${randomBytes(6).toString("hex")}`;

// ── Stripe helpers ────────────────────────────────────────────────────────────

const API = "https://api.stripe.com/v1";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function stripeRequest(method: "GET" | "POST" | "DELETE", path: string, params?: Record<string, string>): Promise<Record<string, unknown>> {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${STRIPE_TEST_KEY}`,
      "Stripe-Version": STRIPE_API_VERSION,
      ...(params ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: params ? new URLSearchParams(params) : undefined,
  });
  if (!r.ok) throw new Error(`Stripe ${method} ${path} failed: ${r.status}`);
  const json: unknown = await r.json();
  if (!isObject(json)) throw new Error(`Stripe ${method} ${path}: not an object`);
  return json;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`${key} is not a string`);
  return value;
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number") throw new Error(`${key} is not a number`);
  return value;
}

/** The credit notes of `invoiceId` that carry this withdrawal's id. */
async function withdrawalCreditNotes(invoiceId: string, withdrawalId: string): Promise<Record<string, unknown>[]> {
  const list = (await stripeRequest("GET", `/credit_notes?invoice=${invoiceId}&limit=100`))["data"];
  if (!Array.isArray(list)) throw new Error("credit notes: no data");
  return list.filter(isObject).filter((note) => isObject(note["metadata"]) && note["metadata"]["withdrawal_id"] === withdrawalId);
}

// ── Fixtures created in beforeAll ─────────────────────────────────────────────

const cleanup: { customerIds: string[]; subscriptionIds: string[]; taxRateIds: string[] } = {
  customerIds: [],
  subscriptionIds: [],
  taxRateIds: [],
};

describe.skipIf(SKIP)("WD-live — real Stripe TEST + e2e DB withdrawal integration", () => {
  let client: PoolClient | undefined;
  let subscriptionId: string;
  let invoiceId: string;
  let paidOre: number;
  let periodStart: number;
  let periodEnd: number;
  let withdrawalId: string | undefined;
  const receipts: string[] = [];
  const logLines: string[] = [];

  /** The Worker's real Stripe and Supabase modules; the emails are recorded, not sent. */
  function workerDeps(): WithdrawalDeps {
    return {
      stripe: createStripeApi(STRIPE_TEST_KEY!),
      rpc: createPaymentsRpc(e2eSupabaseUrl(), e2eSecretKey()),
      mail: {
        sendReceiptEmail: async ({ idempotencyKey }) => {
          receipts.push(idempotencyKey);
          return { id: `email-${receipts.length}` };
        },
        sendOwnerAlertEmail: async () => {
          throw new Error("no owner alert expected");
        },
      },
      now: () => Date.now(),
      log: (line) => logLines.push(line),
    };
  }

  beforeAll(async () => {
    client = await getClient();
    await client.query("RESET ROLE");
    await client.query(
      `INSERT INTO auth.users (id, email, email_confirmed_at, created_at, updated_at)
       VALUES ($1, $2, now(), now(), now())
       ON CONFLICT (id) DO UPDATE SET email = excluded.email`,
      [USER_UUID, USER_EMAIL],
    );

    // Stripe: 25 % VAT included in the price (spike), a customer paying with pm_card_visa.
    const taxRate = stringField(await stripeRequest("POST", "/tax_rates", {
      display_name: "Moms", percentage: "25", inclusive: "true", country: "DK", jurisdiction: "DK",
      "metadata[purpose]": "e2e-pay1d-live",
    }), "id");
    cleanup.taxRateIds.push(taxRate);
    const customerId = stringField(await stripeRequest("POST", "/customers", {
      name: "1d Live Test", email: USER_EMAIL, "metadata[user_id]": USER_UUID,
    }), "id");
    cleanup.customerIds.push(customerId);
    const pm = stringField(await stripeRequest("POST", "/payment_methods/pm_card_visa/attach", { customer: customerId }), "id");
    await stripeRequest("POST", `/customers/${customerId}`, { "invoice_settings[default_payment_method]": pm });

    const created = await stripeRequest("POST", "/subscriptions", {
      customer: customerId,
      "items[0][price]": MONTHLY_PRICE_ID,
      "items[0][tax_rates][0]": taxRate,
      "metadata[kind]": "monitor_subscription",
      "metadata[user_id]": USER_UUID,
      "metadata[locale]": "da",
    });
    subscriptionId = stringField(created, "id");
    cleanup.subscriptionIds.push(subscriptionId);
    expect(created["status"], "subscription not active after creation").toBe("active");
    const startedAt = new Date(numberField(created, "start_date") * 1000).toISOString();

    const invoice = await stripeRequest("GET", `/invoices/${stringField(created, "latest_invoice")}`);
    invoiceId = stringField(invoice, "id");
    paidOre = numberField(invoice, "amount_paid");
    const lines = isObject(invoice["lines"]) ? invoice["lines"]["data"] : null;
    const period = Array.isArray(lines) && isObject(lines[0]) && isObject(lines[0]["period"]) ? lines[0]["period"] : null;
    if (period === null) throw new Error("invoice line has no period");
    periodStart = numberField(period, "start") * 1000;
    periodEnd = numberField(period, "end") * 1000;
    const taxes = invoice["total_taxes"];
    const taxOre = Array.isArray(taxes) ? taxes.filter(isObject).reduce((sum, tax) => sum + numberField(tax, "amount"), 0) : 0;
    expect(paidOre).toBeGreaterThan(0);
    expect(taxOre, "the invoice carries the inclusive VAT").toBe(paidOre - Math.round(paidOre / 1.25));

    // The e2e DB as the webhook would have synced it (postgres), then the Checkout consent.
    await client.query(
      `INSERT INTO public.subscriptions
         (user_id, stripe_subscription_id, stripe_customer_id, plan_id, status, started_at, cancel_at_period_end, last_event_created)
       VALUES ($1, $2, $3, (SELECT id FROM public.monitor_plans WHERE stripe_price_id = $4), 'active', $5::timestamptz, false, now())`,
      [USER_UUID, subscriptionId, customerId, MONTHLY_PRICE_ID, startedAt],
    );
    await client.query(
      `INSERT INTO public.subscription_invoices
         (stripe_invoice_id, stripe_subscription_id, user_id, email, amount_total_ore, amount_tax_ore, period_start, period_end, paid_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, now())`,
      [invoiceId, subscriptionId, USER_UUID, USER_EMAIL, paidOre, taxOre, new Date(periodStart).toISOString(), new Date(periodEnd).toISOString()],
    );
    await client.query("SET role = service_role");
    await client.query("SELECT public.payments_record_checkout_consent($1::jsonb)", [JSON.stringify({
      checkout_session_id: SESSION_ID, subscription_id: subscriptionId, text_version: WITHDRAWAL_TEXT_VERSION,
      text_sha256: WITHDRAWAL_TEXT_SHA256[WITHDRAWAL_TEXT_VERSION]!.da, locale: "da", stripe_consent: "accepted",
      accepted_at: startedAt,
    })]);
    await client.query("RESET ROLE");
  }, 90_000);

  afterAll(async () => {
    const cleanupErrors: string[] = [];
    // Stripe: the withdrawal canceled the subscription already; delete the customer, archive the rate.
    for (const id of cleanup.subscriptionIds) {
      try {
        const sub = await stripeRequest("GET", `/subscriptions/${id}`);
        if (sub["status"] !== "canceled") await stripeRequest("DELETE", `/subscriptions/${id}`);
      } catch (err) {
        cleanupErrors.push(`cancel subscription: ${String(err)}`);
      }
    }
    for (const id of cleanup.customerIds) {
      try { await stripeRequest("DELETE", `/customers/${id}`); } catch (err) { cleanupErrors.push(`delete customer: ${String(err)}`); }
    }
    for (const id of cleanup.taxRateIds) {
      try { await stripeRequest("POST", `/tax_rates/${id}`, { active: "false" }); } catch (err) { cleanupErrors.push(`archive tax rate: ${String(err)}`); }
    }

    try {
      if (client) {
        await client.query("RESET ROLE");
        const subs = cleanup.subscriptionIds;
        await client.query("DELETE FROM public.subscription_withdrawals WHERE stripe_subscription_id = ANY($1::text[])", [subs]);
        await client.query("DELETE FROM public.subscription_consents WHERE stripe_subscription_id = ANY($1::text[])", [subs]);
        await client.query("DELETE FROM public.subscription_invoices WHERE stripe_subscription_id = ANY($1::text[])", [subs]);
        await client.query("DELETE FROM public.subscriptions WHERE stripe_subscription_id = ANY($1::text[])", [subs]);
        await client.query("DELETE FROM public.billing_customers WHERE user_id = $1", [USER_UUID]);
        await client.query("DELETE FROM auth.users WHERE id = $1", [USER_UUID]);

        // ── Cleanup count probe (count-only) ──
        const { rows } = await client.query<{ wd: number; cons: number; inv: number; sub: number; usr: number }>(
          `SELECT (SELECT COUNT(*)::int FROM public.subscription_withdrawals WHERE stripe_subscription_id = ANY($1::text[])) AS wd,
                  (SELECT COUNT(*)::int FROM public.subscription_consents WHERE stripe_subscription_id = ANY($1::text[])) AS cons,
                  (SELECT COUNT(*)::int FROM public.subscription_invoices WHERE stripe_subscription_id = ANY($1::text[])) AS inv,
                  (SELECT COUNT(*)::int FROM public.subscriptions WHERE stripe_subscription_id = ANY($1::text[])) AS sub,
                  (SELECT COUNT(*)::int FROM auth.users WHERE id = $2) AS usr`,
          [subs, USER_UUID],
        );
        const counts = rows[0]!;
        console.log(`afterAll cleanup: db_wd=${counts.wd} db_consents=${counts.cons} db_inv=${counts.inv} db_subs=${counts.sub} db_users=${counts.usr}`);
        for (const [table, count] of Object.entries(counts)) {
          if (count !== 0) cleanupErrors.push(`${table} rows remaining: ${count}`);
        }
      }
    } catch (err) {
      cleanupErrors.push(`DB cleanup: ${String(err)}`);
    } finally {
      client?.release();
    }

    let subsNotCanceled = 0;
    let customersNotDeleted = 0;
    let ratesActive = 0;
    for (const id of cleanup.subscriptionIds) {
      if ((await stripeRequest("GET", `/subscriptions/${id}`))["status"] !== "canceled") subsNotCanceled++;
    }
    for (const id of cleanup.customerIds) {
      if ((await stripeRequest("GET", `/customers/${id}`))["deleted"] !== true) customersNotDeleted++;
    }
    for (const id of cleanup.taxRateIds) {
      if ((await stripeRequest("GET", `/tax_rates/${id}`))["active"] !== false) ratesActive++;
    }
    console.log(`afterAll cleanup: stripe_subs_not_canceled=${subsNotCanceled} customers_not_deleted=${customersNotDeleted} tax_rates_active=${ratesActive}`);
    if (subsNotCanceled + customersNotDeleted + ratesActive > 0) cleanupErrors.push("Stripe fixtures left behind");
    expect(cleanupErrors, "afterAll cleanup failures").toEqual([]);
  }, 90_000);

  // ── Main: processWithdrawal → canceled + credit note + DB completed ─────────

  it("WD-J4-C05/C06 (live): processWithdrawal cancels subscription, creates credit note, marks DB completed", async () => {
    const deps = workerDeps();
    const begun = await createPaymentsRpc(e2eSupabaseUrl(), e2eSecretKey()).paymentsBeginWithdrawal({
      userId: USER_UUID,
      subscriptionId,
      consumerName: CONSUMER_NAME,
      ackEmail: USER_EMAIL,
      statementVersion: WITHDRAWAL_TEXT_VERSION,
      locale: "da",
    });
    expect(begun.outcome).toBe("created");
    expect(begun.withdrawal.retention_basis).toBe("consent");
    withdrawalId = begun.withdrawal.id;

    const done = await processWithdrawal(deps, withdrawalId);
    expect(done.status).toBe("completed");

    // ── The amounts: the Worker's formula with the stored notice time ─────
    const expected = computeWithdrawalRefund({
      paidOre, periodStart, periodEnd, requestedAt: Date.parse(done.requested_at), basis: "consent",
    });
    expect(expected.refundOre).toBeGreaterThan(0);
    expect({ paid: done.paid_ore, retained: done.retained_ore, refund: done.refund_ore }).toEqual({
      paid: expected.paidOre, retained: expected.retainedOre, refund: expected.refundOre,
    });

    // ── Assert: Stripe subscription canceled ───────────────────────────────
    const subAfter = await stripeRequest("GET", `/subscriptions/${subscriptionId}`);
    expect(subAfter["status"]).toBe("canceled");
    expect(isObject(subAfter["cancellation_details"]) && subAfter["cancellation_details"]["comment"]).toBe("withdrawal");

    // ── Assert: Stripe credit note exists with metadata.withdrawal_id ──────
    const notes = await withdrawalCreditNotes(invoiceId, withdrawalId);
    expect(notes).toHaveLength(1);
    const note = notes[0]!;
    expect(note["id"]).toBe(done.stripe_credit_note_id);
    expect(note["amount"]).toBe(expected.refundOre);
    // VAT 25 % inclusive reversed on the line: tax = amount − round(amount / 1.25)
    const taxes = note["total_taxes"];
    const noteTax = Array.isArray(taxes) ? taxes.filter(isObject).reduce((sum, tax) => sum + numberField(tax, "amount"), 0) : -1;
    expect(noteTax).toBe(expected.refundOre - Math.round(expected.refundOre / 1.25));
    expect(done.refund_tax_ore).toBe(noteTax);
    const refunds = note["refunds"];
    expect(Array.isArray(refunds) && isObject(refunds[0]) && refunds[0]["amount_refunded"]).toBe(expected.refundOre);
    expect(isObject(note["metadata"]) && note["metadata"]["subscription"]).toBe(subscriptionId);

    // ── Assert: DB withdrawal completed, invoice refunded once, receipt stamped ──
    const { rows } = await client!.query<{ status: string; stripe_credit_note_id: string; refunded: string; ack: boolean }>(
      `SELECT w.status, w.stripe_credit_note_id, i.amount_refunded_ore AS refunded, w.ack_sent_at IS NOT NULL AS ack
         FROM public.subscription_withdrawals w
         JOIN public.subscription_invoices i ON i.stripe_invoice_id = $2
        WHERE w.id = $1`,
      [withdrawalId, invoiceId],
    );
    expect(rows[0]).toEqual({ status: "completed", stripe_credit_note_id: note["id"], refunded: String(expected.refundOre), ack: true });
    expect(receipts).toEqual([`withdrawal-ack/${withdrawalId}`]);
    // Logs carry ids and codes only.
    for (const line of logLines) {
      expect(line).not.toContain(USER_EMAIL);
      expect(line).not.toContain(CONSUMER_NAME);
    }
  }, 120_000);

  // ── Replay: second processWithdrawal → same credit note ───────────────────

  it("WD-J5-C03 (live): replay processWithdrawal → same credit note, no second refund", async () => {
    if (withdrawalId === undefined) throw new Error("the first live test did not begin a withdrawal");
    const first = await withdrawalCreditNotes(invoiceId, withdrawalId);
    expect(first).toHaveLength(1);

    // A plain replay: nothing left to do (claim answers done).
    const again = await processWithdrawal(workerDeps(), withdrawalId);
    expect(again.status).toBe("completed");

    // A pass that died between the credit note and the refunded step: the row is still canceled
    // and the invoice not yet counted. The next pass must find the note by its metadata.
    await client!.query(
      `UPDATE public.subscription_withdrawals
          SET status = 'canceled', stripe_invoice_id = NULL, service_start_at = NULL, period_end_at = NULL,
              paid_ore = NULL, retained_ore = NULL, refund_ore = NULL, refund_tax_ore = NULL, calc_version = NULL,
              stripe_credit_note_id = NULL, stripe_refund_id = NULL, refunded_at = NULL
        WHERE id = $1`,
      [withdrawalId],
    );
    await client!.query("UPDATE public.subscription_invoices SET amount_refunded_ore = 0 WHERE stripe_invoice_id = $1", [invoiceId]);
    const reconciled = await processWithdrawal(workerDeps(), withdrawalId);
    expect(reconciled.status).toBe("completed");
    expect(reconciled.stripe_credit_note_id).toBe(first[0]!["id"]);

    // Credit note count must still be 1 (not duplicated); the invoice counts the refund once.
    expect(await withdrawalCreditNotes(invoiceId, withdrawalId)).toHaveLength(1);
    const { rows } = await client!.query<{ refunded: string }>(
      "SELECT amount_refunded_ore AS refunded FROM public.subscription_invoices WHERE stripe_invoice_id = $1",
      [invoiceId],
    );
    expect(rows[0]?.refunded).toBe(String(reconciled.refund_ore));
  }, 120_000);
});
