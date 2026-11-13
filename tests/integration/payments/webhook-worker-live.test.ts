/**
 * Live Worker integration test: workers/payments in real workerd + Stripe TEST mode + e2e DB.
 * Journey: payments-slice1c-webhook
 * Criteria: WH-AC33a..WH-AC33h, WH-AC_A28a-live (accountExists via the rpc module, no harness)
 *
 * Uses wrangler's `createTestHarness` on workers/payments/wrangler.jsonc.
 * Skipped unless BOTH SUPABASE_E2E_REF (e2e project credentials) AND
 * the Stripe test key (STRIPE_CHECKOUT_KEY from .env.local, sk_test_/rk_test_) are set.
 *
 * STRIPE_CHECKOUT_KEY is read from .env.local via readEnvFile
 * — it is NEVER logged, never printed, never asserted as a string value.
 *
 * A random whsec_ is generated per run (never stored, never shared).
 *
 * Limitation (documented per contract §8): no real Stripe→Worker delivery is tested
 * here because that requires a public deploy. All events are synthetically signed.
 *
 * Run: npm run test:integration:e2e-project -- tests/integration/payments/webhook-worker-live.test.ts
 */
import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "wrangler";
import { getClient, type PoolClient } from "../../integration/rls/helpers/db.js";
import { STRIPE_API_VERSION } from "@/lib/payments/stripe";
import { readEnvFile } from "../../helpers/env-file";
import { createPaymentsRpc } from "../../../workers/payments/rpc";
import { signStripeHeader } from "../../helpers/stripe-webhook";

// ── Env / credentials ─────────────────────────────────────────────────────────

/**
 * Load STRIPE_CHECKOUT_KEY from .env.local via readEnvFile (no hardcoded path; ENOENT-safe).
 * Returns null when the file is absent or the key is not a test key.
 * Never prints or logs the key value.
 */
function loadStripeTestKey(): string | null {
  const env = readEnvFile(".env.local");
  const key = env["STRIPE_CHECKOUT_KEY"] ?? null;
  if (!key || (!key.startsWith("sk_test_") && !key.startsWith("rk_test_"))) return null;
  return key;
}

const STRIPE_TEST_KEY = loadStripeTestKey();

const SKIP =
  !process.env.SUPABASE_E2E_REF ||
  !STRIPE_TEST_KEY;

// ── Per-run random webhook secret ─────────────────────────────────────────────

/** Generate `whsec_<32 random alnum>` — different every run, never stored. */
function generateWebhookSecret(): string {
  const alnum = randomBytes(24).toString("base64url").replace(/[^A-Za-z0-9]/g, "").slice(0, 32);
  return `whsec_${alnum}`;
}

const RUN_WEBHOOK_SECRET = generateWebhookSecret();

// ── Signing helper ────────────────────────────────────────────────────────────

// signStripeHeader is imported from tests/helpers/stripe-webhook.ts.

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Strip underscores and non-alphanumeric chars so the result passes ^[A-Za-z0-9]+$. */
function cleanId(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, "");
}
// ── Typed parse helpers — zero `as` casts; `in` + isObject narrowing ────────

/** Runtime object guard: narrows unknown → Record<string, unknown>. */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Expects { id: string }. */
function parseId(raw: unknown): { id: string } {
  if (!isObject(raw)) throw new Error("parseId: not an object");
  if (typeof raw.id !== "string") throw new Error("parseId: id not a string");
  return { id: raw.id };
}

/** Expects { received: boolean } from worker resp.json(). */
function parseWorkerJson(raw: unknown): { received: boolean } {
  if (!isObject(raw)) throw new Error("parseWorkerJson: not an object");
  if (typeof raw.received !== "boolean") throw new Error("parseWorkerJson: received not boolean");
  return { received: raw.received };
}

/** Expects { status: string }. */
function parseSubStatus(raw: unknown): { status: string } {
  if (!isObject(raw)) throw new Error("parseSubStatus: not an object");
  if (typeof raw.status !== "string") throw new Error("parseSubStatus: status not a string");
  return { status: raw.status };
}

/** Full subscription shape needed by WH-AC33e. */
function parseSubForDupCheck(raw: unknown): {
  status: string;
  latest_invoice: string;
  cancellation_details: { comment: string | null };
  metadata: Record<string, string>;
} {
  if (!isObject(raw)) throw new Error("parseSubForDupCheck: not an object");
  if (typeof raw.status !== "string") throw new Error("parseSubForDupCheck: status not a string");
  if (typeof raw.latest_invoice !== "string") throw new Error("parseSubForDupCheck: latest_invoice not a string");
  if (!isObject(raw.cancellation_details)) throw new Error("parseSubForDupCheck: cancellation_details not an object");
  const cd = raw.cancellation_details;
  if (cd.comment !== null && typeof cd.comment !== "string")
    throw new Error("parseSubForDupCheck: comment not string|null");
  if (!isObject(raw.metadata)) throw new Error("parseSubForDupCheck: metadata not an object");
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.metadata)) {
    if (typeof v !== "string") throw new Error(`parseSubForDupCheck: metadata.${k} not a string`);
    metadata[k] = v;
  }
  return {
    status: raw.status,
    latest_invoice: raw.latest_invoice,
    cancellation_details: { comment: cd.comment === null ? null : cd.comment },
    metadata,
  };
}

/**
 * Extracts latest_invoice (kept as unknown; caller handles string vs expanded object).
 */
function parseSubLatestInvoice(raw: unknown): { latest_invoice: unknown } {
  if (!isObject(raw)) throw new Error("parseSubLatestInvoice: not an object");
  if (!("latest_invoice" in raw)) throw new Error("parseSubLatestInvoice: missing latest_invoice");
  return { latest_invoice: raw.latest_invoice };
}

/**
 * Validates amount_paid is a number; spreads the rest of the invoice object so
 * { ...invoice, id } passes every field through to the Worker unchanged.
 */
function parseInvoiceForEvent(raw: unknown): { amount_paid: number } & Record<string, unknown> {
  if (!isObject(raw)) throw new Error("parseInvoiceForEvent: not an object");
  if (typeof raw.amount_paid !== "number") throw new Error("parseInvoiceForEvent: amount_paid not a number");
  const { amount_paid, ...rest } = raw;
  return { amount_paid, ...rest };
}

/** Parses the invoice_payments list; throws on any unexpected shape. */
function parseInvoicePaymentsList(raw: unknown): Array<{
  status: string;
  amount_paid: number;
  payment: { type: string; payment_intent: string };
}> {
  if (!isObject(raw) || !Array.isArray(raw.data))
    throw new Error("parseInvoicePaymentsList: expected { data: [...] }");
  return raw.data.map((item: unknown, idx: number) => {
    if (!isObject(item)) throw new Error(`invoice_payments[${idx}]: not an object`);
    if (typeof item.status !== "string") throw new Error(`invoice_payments[${idx}]: status not a string`);
    if (typeof item.amount_paid !== "number") throw new Error(`invoice_payments[${idx}]: amount_paid not a number`);
    if (!isObject(item.payment)) throw new Error(`invoice_payments[${idx}]: payment not an object`);
    if (typeof item.payment.type !== "string") throw new Error(`invoice_payments[${idx}]: payment.type not a string`);
    if (typeof item.payment.payment_intent !== "string") throw new Error(`invoice_payments[${idx}]: payment.payment_intent not a string`);
    return {
      status: item.status,
      amount_paid: item.amount_paid,
      payment: { type: item.payment.type, payment_intent: item.payment.payment_intent },
    };
  });
}

/** Parses the refunds list; throws on any unexpected shape. */
function parseRefundsList(raw: unknown): Array<{
  amount: number;
  reason: string;
  status: string;
  payment_intent: string;
  metadata: Record<string, string>;
}> {
  if (!isObject(raw) || !Array.isArray(raw.data))
    throw new Error("parseRefundsList: expected { data: [...] }");
  return raw.data.map((item: unknown, idx: number) => {
    if (!isObject(item)) throw new Error(`refunds[${idx}]: not an object`);
    if (typeof item.amount !== "number") throw new Error(`refunds[${idx}]: amount not a number`);
    if (typeof item.reason !== "string") throw new Error(`refunds[${idx}]: reason not a string`);
    if (typeof item.status !== "string") throw new Error(`refunds[${idx}]: status not a string`);
    if (typeof item.payment_intent !== "string") throw new Error(`refunds[${idx}]: payment_intent not a string`);
    if (!isObject(item.metadata)) throw new Error(`refunds[${idx}]: metadata not an object`);
    const metadata: Record<string, string> = {};
    for (const [k, v] of Object.entries(item.metadata)) {
      if (typeof v !== "string") throw new Error(`refunds[${idx}]: metadata.${k} not a string`);
      metadata[k] = v;
    }
    return { amount: item.amount, reason: item.reason, status: item.status, payment_intent: item.payment_intent, metadata };
  });
}

/** Parses a Stripe Price to extract its product id. */
function parsePriceProduct(raw: unknown): { id: string; product: string } {
  if (!isObject(raw)) throw new Error("parsePriceProduct: not an object");
  if (typeof raw.id !== "string") throw new Error("parsePriceProduct: id not a string");
  if (typeof raw.product !== "string") throw new Error("parsePriceProduct: product not a string");
  return { id: raw.id, product: raw.product };
}

/** Parses a Stripe Price archive reply; validates active is a boolean. */
function parsePriceArchive(raw: unknown): { id: string; active: boolean } {
  if (!isObject(raw)) throw new Error("parsePriceArchive: not an object");
  if (typeof raw.id !== "string") throw new Error("parsePriceArchive: id not a string");
  if (typeof raw.active !== "boolean") throw new Error("parsePriceArchive: active not a boolean");
  return { id: raw.id, active: raw.active };
}

/** Webhook log line emitted by handleStripeWebhook for every handled event (normal path). */
type WebhookLogLine = {
  msg: "payments webhook";
  event: string | null;
  type: string | null;
  outcome: string;
  code: string | null;
  paused: number | null;
};

function isWebhookLogLine(v: unknown): v is WebhookLogLine {
  if (!isObject(v)) return false;
  return (
    v.msg === "payments webhook" &&
    (v.event === null || typeof v.event === "string") &&
    (v.type === null || typeof v.type === "string") &&
    typeof v.outcome === "string" &&
    (v.code === null || typeof v.code === "string") &&
    (v.paused === null || typeof v.paused === "number")
  );
}

/**
 * Finds and parses the single `"payments webhook"` log line matching `guard`
 * from harness logs after a `clearLogs()` / per-fetch window.
 */
function parseWebhookLogLine<T>(
  logs: Array<{ level: string; message: string }>,
  guard: (v: unknown) => v is T,
): T {
  const matches = logs.filter((l) => {
    try {
      const parsed: unknown = JSON.parse(l.message);
      return isObject(parsed) && parsed.msg === "payments webhook";
    } catch {
      return false;
    }
  });
  if (matches.length === 0) throw new Error("No 'payments webhook' log line found in harness logs");
  if (matches.length > 1) throw new Error(`Expected 1 'payments webhook' log line, got ${matches.length}`);
  const parsed: unknown = JSON.parse(matches[0]!.message);
  if (!guard(parsed)) throw new Error(`Unexpected log line shape: ${matches[0]!.message}`);
  return parsed;
}

/** The bad-signature log line handleStripeWebhook writes. */
type WebhookSigLogLine = {
  msg: "payments webhook";
  outcome: "invalid_signature";
  reason: string;
};

function isWebhookSigLogLine(v: unknown): v is WebhookSigLogLine {
  if (!isObject(v)) return false;
  return (
    Object.keys(v).length === 3 &&
    v.msg === "payments webhook" &&
    v.outcome === "invalid_signature" &&
    typeof v.reason === "string"
  );
}

// ── Fixture constants ─────────────────────────────────────────────────────────

// Prefix 0c02 = payments-slice1c-live test namespace
const FIXTURE_USER_UUID  = "00000000-0000-0000-0c02-000000000001";
const FIXTURE_USER_EMAIL = "e2e-pay1c-live@alnyron-test.local";

// From supabase/seed-e2e/monitor-plans-test.sql
const MONTHLY_PRICE_ID = "price_1Ub3CoFIgZG2PjS1sJ7VtPSS";

/** IDs created during the run, collected for afterAll cleanup. */
const cleanup: {
  stripeCustomerIds: string[];
  stripeSubscriptionIds: string[];
  stripeEventIds: string[];
  stripePriceIdsToArchive: string[];
} = {
  stripeCustomerIds: [],
  stripeSubscriptionIds: [],
  stripeEventIds: [],
  stripePriceIdsToArchive: [],
};

// ── Stripe REST helpers ───────────────────────────────────────────────────────

const STRIPE_API = "https://api.stripe.com/v1";

async function stripeGet(path: string): Promise<unknown> {
  const r = await fetch(`${STRIPE_API}${path}`, {
    headers: {
      Authorization: `Bearer ${STRIPE_TEST_KEY}`,
      "Stripe-Version": STRIPE_API_VERSION,
    },
  });
  if (!r.ok) throw new Error(`Stripe GET ${path} failed: ${r.status}`);
  return r.json();
}

async function stripePost(
  path: string,
  params: Record<string, string | Record<string, string>>,
): Promise<unknown> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "string") body.set(k, v);
    else for (const [sk, sv] of Object.entries(v)) body.set(`${k}[${sk}]`, sv);
  }
  const r = await fetch(`${STRIPE_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${STRIPE_TEST_KEY}`,
      "Stripe-Version": STRIPE_API_VERSION,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!r.ok) throw new Error(`Stripe POST ${path} failed: ${r.status}`);
  return r.json();
}

async function stripeDelete(path: string): Promise<unknown> {
  const r = await fetch(`${STRIPE_API}${path}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${STRIPE_TEST_KEY}`,
      "Stripe-Version": STRIPE_API_VERSION,
    },
  });
  if (!r.ok) throw new Error(`Stripe DELETE ${path} failed: ${r.status}`);
  return r.json();
}

// ── DB helper ─────────────────────────────────────────────────────────────────

/** Supabase E2E URL from env (set by vitest-e2e-project.mjs). */
function e2eSupabaseUrl(): string {
  const ref = process.env.SUPABASE_E2E_REF;
  if (!ref) throw new Error("SUPABASE_E2E_REF not set");
  return `https://${ref}.supabase.co`;
}

/** Supabase e2e secret key from env. */
function e2eSecretKey(): string {
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_E2E_SECRET_KEY;
  if (!key) throw new Error("SUPABASE_SECRET_KEY / SUPABASE_E2E_SECRET_KEY not set");
  return key;
}

// ── Build a synthetic event body matching what Stripe would send ──────────────

function checkoutSessionCompletedBody(opts: {
  sessionId: string;
  subscriptionId: string;
  customerId: string;
  userId: string;
  eventId?: string;
}): string {
  return JSON.stringify({
    id: opts.eventId ?? `evt_livecsc${cleanId(opts.subscriptionId)}`,
    type: "checkout.session.completed",
    created: nowSeconds(),
    livemode: false,
    data: {
      object: {
        id: opts.sessionId,
        object: "checkout.session",
        mode: "subscription",
        status: "complete",
        payment_status: "paid",
        customer: opts.customerId,
        subscription: opts.subscriptionId,
        client_reference_id: opts.userId,
        metadata: { kind: "monitor_subscription", user_id: opts.userId, plan_id: "plan_test", locale: "da" },
      },
    },
  });
}

function subscriptionEventBody(type: string, subscriptionId: string, customerId: string): string {
  return JSON.stringify({
    id: `evt_live${type.replace(/[^A-Za-z0-9]/g, "")}${cleanId(subscriptionId)}`,
    type,
    created: nowSeconds(),
    livemode: false,
    data: { object: { id: subscriptionId, object: "subscription", customer: customerId } },
  });
}

// ── Harness ───────────────────────────────────────────────────────────────────

let harness: TestHarness | undefined;
let pgClient: PoolClient | undefined;

// Real Stripe objects created in beforeAll
let customerId1: string;
let subscriptionId1: string;
let customerId2: string;
let subscriptionId2: string;

describe.skipIf(SKIP)(
  "WH-AC33 — live Worker integration (createTestHarness + real Stripe TEST mode)",
  () => {
    beforeAll(async () => {
      // Start harness against the real payments worker config
      harness = createTestHarness({
        workers: [
          {
            configPath: "workers/payments/wrangler.jsonc",
            vars: {
              SUPABASE_URL: e2eSupabaseUrl(),
              STRIPE_LIVEMODE: "false",
            },
            secrets: {
              SUPABASE_SECRET_KEY: e2eSecretKey(),
              STRIPE_PAYMENTS_KEY: STRIPE_TEST_KEY!,
              STRIPE_WEBHOOK_SECRET: RUN_WEBHOOK_SECRET,
            },
          },
        ],
      });
      await harness.listen();

      // Create fixture user in DB as postgres
      pgClient = await getClient();
      await pgClient.query("RESET ROLE");
      // Upsert auth user (idempotent)
      await pgClient.query(
        `INSERT INTO auth.users (id, email, email_confirmed_at, created_at, updated_at)
         VALUES ($1, $2, now(), now(), now())
         ON CONFLICT (id) DO UPDATE SET email = excluded.email`,
        [FIXTURE_USER_UUID, FIXTURE_USER_EMAIL],
      );

      // Create real Stripe test customer + subscription (pm_card_visa, test monthly price)
      const cust1 = parseId(await stripePost("/customers", {
        email: FIXTURE_USER_EMAIL,
        metadata: { user_id: FIXTURE_USER_UUID },
      }));
      customerId1 = cust1.id;
      cleanup.stripeCustomerIds.push(customerId1);

      // Attach pm_card_visa payment method
      const pm = parseId(await stripePost("/payment_methods", {
        type: "card",
        "card[token]": "tok_visa",
      }));
      await stripePost(`/payment_methods/${pm.id}/attach`, { customer: customerId1 });
      await stripePost(`/customers/${customerId1}`, { invoice_settings: { default_payment_method: pm.id } });

      const sub1 = parseId(await stripePost("/subscriptions", {
        customer: customerId1,
        "items[0][price]": MONTHLY_PRICE_ID,
        "metadata[kind]": "monitor_subscription",
        "metadata[user_id]": FIXTURE_USER_UUID,
        "metadata[plan_id]": "plan_test",
        "metadata[locale]": "da",
      }));
      subscriptionId1 = sub1.id;
      cleanup.stripeSubscriptionIds.push(subscriptionId1);
    }, 180_000);

    afterAll(async () => {
      const cleanupErrors: string[] = [];

      // Cancel Stripe subscriptions and delete customers (best effort)
      for (const id of cleanup.stripeSubscriptionIds) {
        try { await stripeDelete(`/subscriptions/${id}`); } catch { /* best effort */ }
      }
      for (const id of cleanup.stripeCustomerIds) {
        try { await stripeDelete(`/customers/${id}`); } catch { /* best effort */ }
      }

      // DB cleanup — pgClient.release() and harness.close() run in finally
      try {
        if (pgClient) {
          await pgClient.query("RESET ROLE");
          await pgClient.query(
            `DELETE FROM public.subscription_invoices
             WHERE stripe_subscription_id = ANY($1::text[])`,
            [cleanup.stripeSubscriptionIds],
          );
          await pgClient.query(
            `DELETE FROM public.subscriptions
             WHERE stripe_subscription_id = ANY($1::text[])`,
            [cleanup.stripeSubscriptionIds],
          );
          await pgClient.query(
            `DELETE FROM public.billing_customers
             WHERE user_id = $1`,
            [FIXTURE_USER_UUID],
          );
          if (cleanup.stripeEventIds.length > 0) {
            await pgClient.query(
              `DELETE FROM public.stripe_events
               WHERE id = ANY($1::text[])`,
              [cleanup.stripeEventIds],
            );
          }
          // Remove fixture user
          await pgClient.query("DELETE FROM auth.users WHERE id = $1", [FIXTURE_USER_UUID]);

          // ── Cleanup count probe (count-only; collect failures) ──
          const { rows: rSub } = await pgClient.query<{ cnt: number }>(
            "SELECT COUNT(*)::int AS cnt FROM public.subscriptions WHERE stripe_subscription_id = ANY($1::text[])",
            [cleanup.stripeSubscriptionIds],
          );
          const { rows: rInv } = await pgClient.query<{ cnt: number }>(
            "SELECT COUNT(*)::int AS cnt FROM public.subscription_invoices WHERE stripe_subscription_id = ANY($1::text[])",
            [cleanup.stripeSubscriptionIds],
          );
          const evtIds = cleanup.stripeEventIds.length > 0 ? cleanup.stripeEventIds : ["__none__"];
          const { rows: rEvt } = await pgClient.query<{ cnt: number }>(
            "SELECT COUNT(*)::int AS cnt FROM public.stripe_events WHERE id = ANY($1::text[])",
            [evtIds],
          );
          console.log(`afterAll cleanup: db_subs=${rSub[0]!.cnt} db_inv=${rInv[0]!.cnt} db_evt=${rEvt[0]!.cnt}`);
          if (rSub[0]!.cnt !== 0) cleanupErrors.push(`subscriptions rows remaining: ${rSub[0]!.cnt}`);
          if (rInv[0]!.cnt !== 0) cleanupErrors.push(`subscription_invoices rows remaining: ${rInv[0]!.cnt}`);
          if (rEvt[0]!.cnt !== 0) cleanupErrors.push(`stripe_events rows remaining: ${rEvt[0]!.cnt}`);
        }
      } catch (err) {
        cleanupErrors.push(`DB cleanup: ${String(err)}`);
      } finally {
        pgClient?.release();
        await harness?.close().catch((e: unknown) => cleanupErrors.push(`harness.close: ${String(e)}`));
      }

      // Archive throwaway test prices (after DB cleanup)
      for (const id of cleanup.stripePriceIdsToArchive) {
        try {
          const archived = parsePriceArchive(await stripePost(`/prices/${id}`, { active: "false" }));
          if (archived.active !== false) cleanupErrors.push(`price ${id} not archived`);
        } catch (err) {
          cleanupErrors.push(`archive price ${id}: ${String(err)}`);
        }
      }

      // ── Stripe cleanup count probe ──
      let subsNotCanceled = 0;
      for (const id of cleanup.stripeSubscriptionIds) {
        try {
          const s = parseSubStatus(await stripeGet(`/subscriptions/${id}`));
          if (s.status !== "canceled") subsNotCanceled++;
        } catch (err) {
          cleanupErrors.push(`sub status ${id}: ${String(err)}`);
        }
      }
      let customersNotDeleted = 0;
      for (const id of cleanup.stripeCustomerIds) {
        try {
          const c = await stripeGet(`/customers/${id}`);
          if (!(isObject(c) && c.deleted === true)) customersNotDeleted++;
        } catch (err) {
          cleanupErrors.push(`customer status ${id}: ${String(err)}`);
        }
      }
      let pricesStillActive = 0;
      for (const id of cleanup.stripePriceIdsToArchive) {
        try {
          const p = parsePriceArchive(await stripeGet(`/prices/${id}`));
          if (p.active) pricesStillActive++;
        } catch (err) {
          cleanupErrors.push(`price status ${id}: ${String(err)}`);
        }
      }
      console.log(`afterAll cleanup: stripe_subs_not_canceled=${subsNotCanceled} customers_not_deleted=${customersNotDeleted} prices_still_active=${pricesStillActive}`);
      if (subsNotCanceled > 0) cleanupErrors.push(`subscriptions not canceled: ${subsNotCanceled}`);
      if (customersNotDeleted > 0) cleanupErrors.push(`customers not deleted: ${customersNotDeleted}`);
      if (pricesStillActive > 0) cleanupErrors.push(`prices still active: ${pricesStillActive}`);

      // Assert all collected failures at once — after all cleanup has run
      expect(cleanupErrors, "afterAll cleanup failures").toEqual([]);
    }, 90_000);

    // ── WH-AC33a: checkout.session.completed → subscription active, cap 20 ───

    it("WH-AC33a: checkout.session.completed → subscription active in DB, effective_monitor_limit=20", async () => {
      const worker = harness!.getWorker();
      const eventId = `evt_livecsc${cleanId(subscriptionId1)}`;
      cleanup.stripeEventIds.push(eventId);

      const body = checkoutSessionCompletedBody({
        sessionId: `cs_live_test_${subscriptionId1}`,
        subscriptionId: subscriptionId1,
        customerId: customerId1,
        userId: FIXTURE_USER_UUID,
        eventId,
      });
      const t = nowSeconds();
      const sig = signStripeHeader(body, RUN_WEBHOOK_SECRET, t);

      harness!.clearLogs();
      const resp = await worker.fetch("https://pay.alnyron.dk/webhook", {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": sig },
        body,
      });
      expect(resp.status).toBe(200);
      const json = parseWorkerJson(await resp.json());
      expect(json.received).toBe(true);

      // Verify DB state as postgres
      await pgClient!.query("RESET ROLE");
      const { rows } = await pgClient!.query<{ status: string }>(
        "SELECT status FROM public.subscriptions WHERE stripe_subscription_id = $1",
        [subscriptionId1],
      );
      expect(rows[0]?.status).toBe("active");

      const { rows: lim } = await pgClient!.query<{ lim: number }>(
        "SELECT private.effective_monitor_limit($1::uuid) AS lim",
        [FIXTURE_USER_UUID],
      );
      expect(lim[0]!.lim).toBe(20);
      // ── Worker log assertion (outcome proof) ──
      const whLog33a = parseWebhookLogLine(harness!.getLogs(), isWebhookLogLine);
      expect(whLog33a).toEqual({ msg: "payments webhook", event: eventId, type: "checkout.session.completed", outcome: "applied", code: null, paused: 0 });
    }, 60_000);

    // ── WH-AC33b: replay same event → one stripe_events row ──────────────────

    it("WH-AC33b: replay same checkout.session.completed → one stripe_events row (idempotent)", async () => {
      const worker = harness!.getWorker();
      const eventId = `evt_livecsc${cleanId(subscriptionId1)}`;

      const body = checkoutSessionCompletedBody({
        sessionId: `cs_live_test_${subscriptionId1}`,
        subscriptionId: subscriptionId1,
        customerId: customerId1,
        userId: FIXTURE_USER_UUID,
        eventId,
      });
      const t = nowSeconds();
      const sig = signStripeHeader(body, RUN_WEBHOOK_SECRET, t);
      harness!.clearLogs();

      const resp = await worker.fetch("https://pay.alnyron.dk/webhook", {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": sig },
        body,
      });
      expect(resp.status).toBe(200);

      await pgClient!.query("RESET ROLE");
      const { rows } = await pgClient!.query<{ cnt: number }>(
        "SELECT COUNT(*)::int AS cnt FROM public.stripe_events WHERE id = $1",
        [eventId],
      );
      expect(rows[0]!.cnt).toBe(1);
      // ── Worker log assertion (outcome proof) ──
      const whLog33b = parseWebhookLogLine(harness!.getLogs(), isWebhookLogLine);
      expect(whLog33b).toEqual({ msg: "payments webhook", event: eventId, type: "checkout.session.completed", outcome: "duplicate", code: null, paused: 0 });
    }, 60_000);

    // ── WH-AC33c: tampered body → 400, DB unchanged ───────────────────────────

    it("WH-AC33c: tampered body → 400 invalid_signature, DB unchanged", async () => {
      const worker = harness!.getWorker();
      const realBody = `{"id":"evt_tampered01","type":"customer.subscription.updated","created":${nowSeconds()},"livemode":false,"data":{"object":{"id":"${subscriptionId1}"}}}`;
      const differentBody = `{"id":"evt_tampered01","type":"customer.subscription.updated","created":${nowSeconds() - 1},"livemode":false,"data":{"object":{"id":"${subscriptionId1}"}}}`;
      // Sign the DIFFERENT body but send the real body
      const sig = signStripeHeader(differentBody, RUN_WEBHOOK_SECRET, nowSeconds());

      harness!.clearLogs();
      const resp = await worker.fetch("https://pay.alnyron.dk/webhook", {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": sig },
        body: realBody,
      });
      expect(resp.status).toBe(400);

      // No new stripe_events row for the tampered event
      await pgClient!.query("RESET ROLE");
      const { rows } = await pgClient!.query<{ cnt: number }>(
        "SELECT COUNT(*)::int AS cnt FROM public.stripe_events WHERE id = $1",
        ["evt_tampered01"],
      );
      expect(rows[0]!.cnt).toBe(0);
      // ── Worker log assertion (outcome proof) ──
      const whLog33c = parseWebhookLogLine(harness!.getLogs(), isWebhookSigLogLine);
      expect(whLog33c).toEqual({ msg: "payments webhook", outcome: "invalid_signature", reason: "no_signature_match" });
    }, 60_000);

    // ── WH-AC33d: stale timestamp → 400, DB unchanged ─────────────────────────

    it("WH-AC33d: stale timestamp (> 300 s old) → 400, DB unchanged", async () => {
      const worker = harness!.getWorker();
      const staleT = nowSeconds() - 310;
      const body = `{"id":"evt_stale01","type":"customer.subscription.updated","created":${staleT},"livemode":false,"data":{"object":{"id":"${subscriptionId1}"}}}`;
      const sig = signStripeHeader(body, RUN_WEBHOOK_SECRET, staleT);

      harness!.clearLogs();
      const resp = await worker.fetch("https://pay.alnyron.dk/webhook", {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": sig },
        body,
      });
      expect(resp.status).toBe(400);

      await pgClient!.query("RESET ROLE");
      const { rows } = await pgClient!.query<{ cnt: number }>(
        "SELECT COUNT(*)::int AS cnt FROM public.stripe_events WHERE id = $1",
        ["evt_stale01"],
      );
      expect(rows[0]!.cnt).toBe(0);
      // ── Worker log assertion (outcome proof) ──
      const whLog33d = parseWebhookLogLine(harness!.getLogs(), isWebhookSigLogLine);
      expect(whLog33d).toEqual({ msg: "payments webhook", outcome: "invalid_signature", reason: "stale_timestamp" });
    }, 60_000);

    // ── WH-AC33e: duplicate subscription → second canceled, payment refunded ──

    it("WH-AC33e: second subscription for same user → second sub canceled in Stripe, first kept", async () => {
      // Create a second customer + subscription for the same FIXTURE_USER_UUID
      const cust2 = parseId(await stripePost("/customers", {
        email: `e2e-pay1c-live-dup@alnyron-test.local`,
        metadata: { user_id: FIXTURE_USER_UUID },
      }));
      customerId2 = cust2.id;
      cleanup.stripeCustomerIds.push(customerId2);

      const pm2 = parseId(await stripePost("/payment_methods", { type: "card", "card[token]": "tok_visa" }));
      await stripePost(`/payment_methods/${pm2.id}/attach`, { customer: customerId2 });
      await stripePost(`/customers/${customerId2}`, { invoice_settings: { default_payment_method: pm2.id } });

      const sub2 = parseId(await stripePost("/subscriptions", {
        customer: customerId2,
        "items[0][price]": MONTHLY_PRICE_ID,
        "metadata[kind]": "monitor_subscription",
        "metadata[user_id]": FIXTURE_USER_UUID,
        "metadata[plan_id]": "plan_test",
        "metadata[locale]": "da",
      }));
      subscriptionId2 = sub2.id;
      cleanup.stripeSubscriptionIds.push(subscriptionId2);

      const worker = harness!.getWorker();
      const body = subscriptionEventBody("customer.subscription.created", subscriptionId2, customerId2);
      // The id the event really carries, so afterAll removes its stripe_events row if one was written.
      const sent = parseId(JSON.parse(body)); // built just above by subscriptionEventBody
      cleanup.stripeEventIds.push(sent.id);

      const t = nowSeconds();
      const sig = signStripeHeader(body, RUN_WEBHOOK_SECRET, t);
      harness!.clearLogs();

      const resp = await worker.fetch("https://pay.alnyron.dk/webhook", {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": sig },
        body,
      });
      expect(resp.status).toBe(200);

      // Verify one of the two subscriptions is now canceled in Stripe
      const sub1Data = parseSubStatus(await stripeGet(`/subscriptions/${subscriptionId1}`));
      const sub2Data = parseSubForDupCheck(await stripeGet(`/subscriptions/${subscriptionId2}`));
      // Exactly one should be canceled (the duplicate)
      const canceledCount = [sub1Data.status, sub2Data.status].filter((s) => s === "canceled").length;
      expect(canceledCount).toBe(1);
      // The first (older created) is the keeper
      expect(sub1Data.status).toBe("active");
      // Contract §4.5: the cancel carries cancellation_details[comment]=duplicate_subscription.
      expect(sub2Data.cancellation_details.comment).toBe("duplicate_subscription");

      // Contract §8: the duplicate's payment is refunded in Stripe, in full, as a duplicate.
      const payments = { data: parseInvoicePaymentsList(await stripeGet(`/invoice_payments?invoice=${sub2Data.latest_invoice}`)) };
      const paid = payments.data.filter((p) => p.status === "paid");
      expect(paid).toHaveLength(1);
      const refunds = { data: parseRefundsList(await stripeGet(`/refunds?payment_intent=${paid[0]!.payment.payment_intent}`)) };
      expect(refunds.data).toHaveLength(1);
      expect(refunds.data[0]).toMatchObject({
        amount: paid[0]!.amount_paid,
        reason: "duplicate",
        metadata: { reason: "duplicate_subscription", subscription: subscriptionId2 },
      });
      // A19: the duplicate is marked with metadata.duplicate_subscription=true in Stripe
      expect(sub2Data.metadata["duplicate_subscription"]).toBe("true");
      // ── Worker log assertion (outcome proof) ──
      const whLog33e = parseWebhookLogLine(harness!.getLogs(), isWebhookLogLine);
      expect(whLog33e).toEqual({ msg: "payments webhook", event: sent.id, type: "customer.subscription.created", outcome: "duplicate_subscription_canceled", code: null, paused: null });
    }, 120_000);

    // ── WH-AC33f: subscription.deleted → lapse pause ─────────────────────────

    it("WH-AC33f: customer.subscription.deleted → monitors beyond base cap paused", async () => {
      const worker = harness!.getWorker();

      // Seed monitors as postgres while the user is entitled
      await pgClient!.query("RESET ROLE");
      await pgClient!.query("UPDATE public.profiles SET monitor_limit = NULL WHERE user_id = $1", [FIXTURE_USER_UUID]);
      for (let i = 0; i < 4; i++) {
        await pgClient!.query(
          `INSERT INTO public.monitors (user_id, url, interval_minutes, status, created_at)
           VALUES ($1, $2, 30, 'active', $3::timestamptz)`,
          [FIXTURE_USER_UUID, `https://live-del-m${i + 1}.example.com`, `2026-01-01T1${i}:00:00Z`],
        );
      }
      await pgClient!.query("UPDATE public.profiles SET monitor_limit = 2 WHERE user_id = $1", [FIXTURE_USER_UUID]);

      // Cancel the subscription in Stripe
      await stripeDelete(`/subscriptions/${subscriptionId1}`);

      const body = subscriptionEventBody("customer.subscription.deleted", subscriptionId1, customerId1);
      const sent = parseId(JSON.parse(body)); // built just above by subscriptionEventBody
      cleanup.stripeEventIds.push(sent.id);
      const t = nowSeconds();
      const sig = signStripeHeader(body, RUN_WEBHOOK_SECRET, t);
      harness!.clearLogs();

      const resp = await worker.fetch("https://pay.alnyron.dk/webhook", {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": sig },
        body,
      });
      expect(resp.status).toBe(200);

      // WH-AC33f: exactly 2 monitors paused, oldest 2 kept active.
      // The keeper rule is oldest first (by created_at); base cap = 2 → keep 2 oldest, pause 2 newest.
      await pgClient!.query("RESET ROLE");
      const { rows } = await pgClient!.query<{ url: string; status: string }>(
        "SELECT url, status FROM public.monitors WHERE user_id = $1 ORDER BY created_at ASC",
        [FIXTURE_USER_UUID],
      );
      // 4 monitors seeded with created_at T10, T11, T12, T13 (ascending order above)
      expect(rows).toHaveLength(4);
      // Oldest 2 kept active; newest 2 paused (monitor_limit = 2 → pauses 4-2 = 2).
      expect(rows[0]!.status).toBe("active");  // https://live-del-m1.example.com (oldest)
      expect(rows[1]!.status).toBe("active");  // https://live-del-m2.example.com
      expect(rows[2]!.status).toBe("paused");  // https://live-del-m3.example.com (paused)
      expect(rows[3]!.status).toBe("paused");  // https://live-del-m4.example.com (newest)
      // ── Worker log assertion (outcome proof) ──
      const whLog33f = parseWebhookLogLine(harness!.getLogs(), isWebhookLogLine);
      expect(whLog33f).toEqual({ msg: "payments webhook", event: sent.id, type: "customer.subscription.deleted", outcome: "applied", code: null, paused: 2 });
    }, 60_000);

    // ── WH-AC33g: invoice.paid → subscription_invoices row ───────────────────

    it("WH-AC33g: invoice.paid on the real latest invoice → subscription_invoices row (amount in øre)", async () => {
      // Retrieve the real latest invoice from Stripe
      const subData = parseSubLatestInvoice(await stripeGet(`/subscriptions/${subscriptionId1}`));
      const latestInvoice = subData.latest_invoice;
      const invoiceId: string =
        typeof latestInvoice === "string"
          ? latestInvoice
          : typeof latestInvoice === "object" && latestInvoice !== null && "id" in latestInvoice && typeof latestInvoice.id === "string"
            ? latestInvoice.id
            : (() => { throw new Error("latest_invoice is neither a string nor an object with id"); })();

      const invoice = parseInvoiceForEvent(await stripeGet(`/invoices/${invoiceId}`));

      const eventId = `evt_liveinvpaid${cleanId(invoiceId)}`;
      cleanup.stripeEventIds.push(eventId);

      const body = JSON.stringify({
        id: eventId,
        type: "invoice.paid",
        created: nowSeconds(),
        livemode: false,
        data: { object: { ...invoice, id: invoiceId } },
      });
      const t = nowSeconds();
      const sig = signStripeHeader(body, RUN_WEBHOOK_SECRET, t);
      harness!.clearLogs();

      const worker = harness!.getWorker();
      const resp = await worker.fetch("https://pay.alnyron.dk/webhook", {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": sig },
        body,
      });
      expect(resp.status).toBe(200);

      await pgClient!.query("RESET ROLE");
      const { rows } = await pgClient!.query<{ amount_total_ore: number }>(
        // bigint comes back from pg as a string: cast to int for number equality.
        "SELECT amount_total_ore::int AS amount_total_ore FROM public.subscription_invoices WHERE stripe_invoice_id = $1",
        [invoiceId],
      );
      expect(rows).toHaveLength(1);
      // amount in øre = Stripe amount_paid (integer)
      expect(rows[0]!.amount_total_ore).toBe(invoice.amount_paid);
      // ── Worker log assertion (outcome proof) ──
      const whLog33g = parseWebhookLogLine(harness!.getLogs(), isWebhookLogLine);
      expect(whLog33g).toEqual({ msg: "payments webhook", event: eventId, type: "invoice.paid", outcome: "applied", code: null, paused: 0 });
    }, 60_000);

    // ── WH-AC33h: invoice.paid on a raw-marked two-item sub → normalizeSubscription null → refund, no DB write ──

    it("WH-AC33h: invoice.paid on two-item marked sub (normalizeSubscription null) → event invoice PI refunded; no subscriptions/subscription_invoices row", async () => {
      // Reuse the existing product from the seeded monthly price to avoid an orphan Product.
      const monthlyPrice = parsePriceProduct(await stripeGet(`/prices/${MONTHLY_PRICE_ID}`));

      // Create a throwaway monthly price on the same product as the second sub item.
      const throwawayPrice = parseId(await stripePost("/prices", {
        product: monthlyPrice.product,
        currency: "dkk",
        "recurring[interval]": "month",
        unit_amount: "1",
      }));
      cleanup.stripePriceIdsToArchive.push(throwawayPrice.id);

      // Create a Stripe customer for this test.
      const custH = parseId(await stripePost("/customers", {
        email: "e2e-pay1c-33h@alnyron-test.local",
        metadata: { user_id: FIXTURE_USER_UUID },
      }));
      cleanup.stripeCustomerIds.push(custH.id);

      // Attach pm_card_visa directly (Stripe TEST mode predefined PM); parse the reply.
      const pmHAttach = parseId(await stripePost(`/payment_methods/pm_card_visa/attach`, { customer: custH.id }));
      parseId(await stripePost(`/customers/${custH.id}`, { invoice_settings: { default_payment_method: pmHAttach.id } }));

      // Create a two-item subscription marked as a duplicate.
      // Two items → normalizeSubscription returns null (items.data.length !== 1).
      const subH = parseId(await stripePost("/subscriptions", {
        customer: custH.id,
        "items[0][price]": MONTHLY_PRICE_ID,
        "items[1][price]": throwawayPrice.id,
        "metadata[kind]": "monitor_subscription",
        "metadata[user_id]": FIXTURE_USER_UUID,
        "metadata[duplicate_subscription]": "true",
      }));
      cleanup.stripeSubscriptionIds.push(subH.id);

      // Guard: pm_card_visa settles synchronously; confirm sub is active before proceeding.
      const subHStatus = parseSubStatus(await stripeGet(`/subscriptions/${subH.id}`));
      expect(subHStatus.status, "WH-AC33h: subscription not active after creation").toBe("active");

      // Extract the latest_invoice id (may be string or expanded object).
      const subHLatest = parseSubLatestInvoice(await stripeGet(`/subscriptions/${subH.id}`));
      const latestInvoiceRaw = subHLatest.latest_invoice;
      const invoiceHId: string =
        typeof latestInvoiceRaw === "string"
          ? latestInvoiceRaw
          : typeof latestInvoiceRaw === "object" && latestInvoiceRaw !== null &&
            "id" in latestInvoiceRaw && typeof latestInvoiceRaw.id === "string"
            ? latestInvoiceRaw.id
            : (() => { throw new Error("WH-AC33h: latest_invoice is neither string nor {id:string}"); })();

      // Retrieve the full invoice; guard that it is paid before building the event.
      const invoiceH = parseInvoiceForEvent(await stripeGet(`/invoices/${invoiceHId}`));
      if (typeof invoiceH.status !== "string" || invoiceH.status !== "paid")
        throw new Error(`WH-AC33h: invoice not paid; status=${String(invoiceH.status)}`);

      // Build and sign the invoice.paid event body.
      const eventHId = `evt_live33h${cleanId(subH.id)}`;
      cleanup.stripeEventIds.push(eventHId);
      const bodyH = JSON.stringify({
        id: eventHId,
        type: "invoice.paid",
        created: nowSeconds(),
        livemode: false,
        data: { object: { ...invoiceH, id: invoiceHId } },
      });
      const tH = nowSeconds();
      const sigH = signStripeHeader(bodyH, RUN_WEBHOOK_SECRET, tH);
      harness!.clearLogs();

      // POST to the worker — expect 200 (duplicate_invoice_refunded / normalizeSubscription-null-marked path).
      const worker = harness!.getWorker();
      const resp = await worker.fetch("https://pay.alnyron.dk/webhook", {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": sigH },
        body: bodyH,
      });
      expect(resp.status).toBe(200);
      const json = parseWorkerJson(await resp.json());
      expect(json.received).toBe(true);

      // ── Stripe assertion: exactly one paid payment for the invoice; its PI refunded (whole-object) ──
      const paymentsH = parseInvoicePaymentsList(await stripeGet(`/invoice_payments?invoice=${invoiceHId}`));
      expect(paymentsH).toHaveLength(1);
      const piId = paymentsH[0]!.payment.payment_intent;
      expect(paymentsH).toEqual([{
        status: "paid",
        amount_paid: invoiceH.amount_paid,
        payment: { type: "payment_intent", payment_intent: piId },
      }]);

      const refundsH = parseRefundsList(await stripeGet(`/refunds?payment_intent=${piId}`));
      expect(refundsH).toEqual([{
        amount: invoiceH.amount_paid,
        reason: "duplicate",
        status: "succeeded",
        payment_intent: piId,
        metadata: { reason: "duplicate_subscription", subscription: subH.id },
      }]);

      // ── DB assertion: writer NOT called — no subscriptions, subscription_invoices, or stripe_events row ──
      await pgClient!.query("RESET ROLE");
      const { rows: subRows } = await pgClient!.query<{ cnt: number }>(
        "SELECT COUNT(*)::int AS cnt FROM public.subscriptions WHERE stripe_subscription_id = $1",
        [subH.id],
      );
      expect(subRows[0]!.cnt).toBe(0);

      const { rows: invRows } = await pgClient!.query<{ cnt: number }>(
        "SELECT COUNT(*)::int AS cnt FROM public.subscription_invoices WHERE stripe_subscription_id = $1",
        [subH.id],
      );
      expect(invRows[0]!.cnt).toBe(0);

      const { rows: evtRows } = await pgClient!.query<{ cnt: number }>(
        "SELECT COUNT(*)::int AS cnt FROM public.stripe_events WHERE id = $1",
        [eventHId],
      );
      expect(evtRows[0]!.cnt).toBe(0);
      // ── Worker log assertion: proves normalizeSubscription-null-marked branch ──
      const whLog33h = parseWebhookLogLine(harness!.getLogs(), isWebhookLogLine);
      expect(whLog33h).toEqual({ msg: "payments webhook", event: eventHId, type: "invoice.paid", outcome: "duplicate_invoice_refunded", code: "invalid_subscription", paused: null });
    }, 120_000);

    // ── WH-AC_A28a-live: accountExists against the e2e project's Supabase Auth ──

    it("WH-AC_A28a-live: accountExists (rpc module, real e2e Auth) → true for an Auth account, false once it is deleted and for a random uuid", async () => {
      // The suite's fixture user is inserted into auth.users by SQL without the nil instance_id
      // GoTrue filters on, so Auth does not see it: this test makes a real account through the
      // Auth admin API (as the web app's signup does) and deletes it again.
      const admin = createClient(e2eSupabaseUrl(), e2eSecretKey(), {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      const { data, error } = await admin.auth.admin.createUser({
        email: `e2e-pay1c-a28-${randomBytes(6).toString("hex")}@alnyron-test.local`,
        email_confirm: true,
        user_metadata: {},
      });
      if (error) throw new Error(`WH-AC_A28a-live: createUser failed (status ${String(error.status)})`);
      const accountId = data.user.id;
      let deleted = false;
      try {
        // The same module and client the Worker builds, called directly (no harness).
        const rpc = createPaymentsRpc(e2eSupabaseUrl(), e2eSecretKey());
        await expect(rpc.accountExists(accountId)).resolves.toBe(true);
        const { error: deleteError } = await admin.auth.admin.deleteUser(accountId);
        if (deleteError) throw new Error(`WH-AC_A28a-live: deleteUser failed (status ${String(deleteError.status)})`);
        deleted = true;
        // A28(a)'s case: the account was deleted → Auth answers 404 user_not_found → false.
        await expect(rpc.accountExists(accountId)).resolves.toBe(false);
        await expect(rpc.accountExists(randomUUID())).resolves.toBe(false);
      } finally {
        if (!deleted) {
          const { error: cleanupErr } = await admin.auth.admin.deleteUser(accountId);
          if (cleanupErr) {
            console.error(`WH-AC_A28a-live: cleanup deleteUser failed (status ${String(cleanupErr.status)})`);
          }
        }
      }
      // Count-only cleanup proof: neither the account nor its profile is left behind.
      await pgClient!.query("RESET ROLE");
      const { rows } = await pgClient!.query<{ users: number; profiles: number }>(
        `SELECT (SELECT COUNT(*)::int FROM auth.users WHERE id = $1) AS users,
                (SELECT COUNT(*)::int FROM public.profiles WHERE user_id = $1) AS profiles`,
        [accountId],
      );
      expect(rows[0]).toEqual({ users: 0, profiles: 0 });
    }, 60_000);
  },
);
