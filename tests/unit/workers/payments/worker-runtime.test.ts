/**
 * Workers-runtime unit test: workers/payments fetch handler in real workerd
 * Journey: payments-slice1c-webhook
 * Criteria: WH-AC31a..WH-AC31e
 *
 * Uses wrangler's `createTestHarness` (wrangler 4.156;
 * `@cloudflare/vitest-pool-workers` 0.23 peers vitest ^4.1 and cannot be used with vitest 5)
 * to run the REAL `workers/payments/wrangler.jsonc` in local workerd.
 * The harness forwards outbound requests through Node's fetch; this test makes
 * no outbound request (SUPABASE_URL set to a non-routable .invalid domain and
 * fake secrets keep the env-parse from throwing without hitting Supabase).
 *
 * Note: wrangler's `createTestHarness` does not expose exception text through getLogs()
 * (wrangler 4.156); signature and env errors are verified by status code.
 *
 * Run as part of `npm test` (vitest unit project).
 * Generous timeout: harness start ≈ 1–2 s; test timeout 60 s for slow CI.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "wrangler";
import { signStripeHeader } from "../../../helpers/stripe-webhook";
/** Worker config relative to the project root (CWD for vitest). */
const WRANGLER_CONFIG = "workers/payments/wrangler.jsonc";

/** Non-routable URL: .invalid TLD (RFC 2606) never resolves. */
const NON_ROUTABLE_SUPABASE_URL = "https://example.invalid/";

/**
 * Fake webhook secret for the harness run.
 * Must match ^whsec_[A-Za-z0-9]+$ (the env validator).
 * Not a real credential.
 */
const HARNESS_WHSEC = "whsec_unittest1234";

/**
 * Fake Stripe test key for the harness run (test mode, sk_test_ prefix).
 * Not a real credential.
 */
const FAKE_STRIPE_KEY = "sk_test_harness1234";

/**
 * Fake Supabase secret key for the harness run.
 * Not a real credential.
 */
const HARNESS_SBKEY = "sb_secret_harness1234";

/**
 * Fake Resend key for the harness run (must match ^re_[A-Za-z0-9_]+$).
 * Not a real credential.
 */
const HARNESS_RE = "re_harness1234";

// signStripeHeader is imported from tests/helpers/stripe-webhook.ts.

/** A minimal valid Stripe event JSON string. */
function eventBody(opts: { type?: string; livemode?: boolean } = {}): string {
  return JSON.stringify({
    id: "evt_harnesstest001",
    type: opts.type ?? "customer.subscription.updated",
    created: 1_700_000_000,
    livemode: opts.livemode ?? false,
    data: { object: { id: "sub_harness001" } },
  });
}

let harness: TestHarness | undefined;
// Unix "now" in seconds used to sign headers (keep within 300 s of when the
// Worker reads Date.now(); the harness runs locally so clock skew is negligible).
const NOW_S = Math.floor(Date.now() / 1000);

beforeAll(async () => {
  harness = createTestHarness({
    workers: [
      {
        configPath: WRANGLER_CONFIG,
        vars: {
          SUPABASE_URL: NON_ROUTABLE_SUPABASE_URL,
          STRIPE_LIVEMODE: "false",
        },
        // Slice 1d (C-3): RESEND_API_KEY is a required secret; MAIL_FROM, WITHDRAWAL_ALERT_TO and
        // SITE_URL come from the real wrangler.jsonc vars.
        secrets: {
          SUPABASE_SECRET_KEY: HARNESS_SBKEY,
          STRIPE_PAYMENTS_KEY: FAKE_STRIPE_KEY,
          STRIPE_WEBHOOK_SECRET: HARNESS_WHSEC,
          RESEND_API_KEY: HARNESS_RE,
        },
      },
    ],
  });
  await harness.listen();
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

// ── WH-AC31a: tampered body → 400 ────────────────────────────────────────────

describe("WH-AC31a: tampered body (sig over different body) → 400 invalid_signature", () => {
  it(
    "WH-AC31a: bad signature → 400",
    async () => {
      const worker = harness!.getWorker();
      const body = eventBody();
      // Sign a DIFFERENT body but present for this body → tampered
      const otherBody = '{"id":"evt_other"}';
      const sig = signStripeHeader(otherBody, HARNESS_WHSEC, NOW_S);
      const resp = await worker.fetch("https://pay.alnyron.dk/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "stripe-signature": sig,
        },
        body,
      });
      expect(resp.status).toBe(400);
      expect(await resp.json()).toMatchObject({ error: "invalid_signature" });
    },
    60_000,
  );
});

// ── WH-AC31b: GET → 405 ───────────────────────────────────────────────────────

describe("WH-AC31b: GET /webhook → 405 Allow: POST", () => {
  it(
    "WH-AC31b: GET method → 405",
    async () => {
      const worker = harness!.getWorker();
      const resp = await worker.fetch("https://pay.alnyron.dk/webhook", {
        method: "GET",
      });
      expect(resp.status).toBe(405);
      expect(resp.headers.get("Allow")).toBe("POST");
    },
    60_000,
  );
});

// ── WH-AC31c: wrong path → 404 ────────────────────────────────────────────────

describe("WH-AC31c: POST to /other-path → 404", () => {
  it(
    "WH-AC31c: wrong path → 404",
    async () => {
      const worker = harness!.getWorker();
      const resp = await worker.fetch("https://pay.alnyron.dk/not-webhook", {
        method: "POST",
        body: "{}",
      });
      expect(resp.status).toBe(404);
    },
    60_000,
  );
});

// ── WH-AC31d: livemode mismatch → 200 ignored ────────────────────────────────

describe("WH-AC31d: signed live-mode event to test-mode worker → 200 ignored livemode_mismatch", () => {
  it(
    "WH-AC31d: livemode=true event → 200 ignored",
    async () => {
      const worker = harness!.getWorker();
      // livemode=true in the event but the harness STRIPE_LIVEMODE=false
      const body = eventBody({ livemode: true });
      const sig = signStripeHeader(body, HARNESS_WHSEC, NOW_S);
      const resp = await worker.fetch("https://pay.alnyron.dk/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "stripe-signature": sig,
        },
        body,
      });
      expect(resp.status).toBe(200);
    },
    60_000,
  );
});

// ── WH-AC31e: unhandled event type → 200 ─────────────────────────────────────

describe("WH-AC31e: signed unknown event type → 200", () => {
  it(
    "WH-AC31e: unhandled type → 200",
    async () => {
      const worker = harness!.getWorker();
      const body = eventBody({ type: "some.unhandled.event" });
      const sig = signStripeHeader(body, HARNESS_WHSEC, NOW_S);
      const resp = await worker.fetch("https://pay.alnyron.dk/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "stripe-signature": sig,
        },
        body,
      });
      // Unhandled event types return 200 ignored (no DB call is made).
      expect(resp.status).toBe(200);
    },
    60_000,
  );
});
