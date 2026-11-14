/**
 * Unit tests: workers/payments/index.ts — entry routing
 * Journey: payments-slice1c-webhook
 * Criteria: WH-AC1a, WH-AC1b, WH-AC23a..WH-AC23e
 *
 * Covers: 404 (wrong path), 405 (wrong method), 500 (invalid env),
 * 500 (unexpected handler throw), and the happy delegation to handleStripeWebhook.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock all dependencies before importing the worker module.
vi.mock("../../../../workers/payments/env", () => ({
  parsePaymentsEnv: vi.fn(),
}));
vi.mock("../../../../workers/payments/webhook", () => ({
  handleStripeWebhook: vi.fn(),
}));
vi.mock("../../../../workers/payments/rpc", () => ({
  createPaymentsRpc: vi.fn(() => ({})),
}));
vi.mock("../../../../workers/payments/stripe-api", () => ({
  createStripeApi: vi.fn(() => ({})),
}));

import workerModule from "../../../../workers/payments/index";
import { parsePaymentsEnv } from "../../../../workers/payments/env";
import { handleStripeWebhook } from "../../../../workers/payments/webhook";


const SB_KEY_FX = "sb_secret_unittest";
const WHSEC_FX = "whsec_unittest1234";
const SK_TEST_FX = "sk_test_unittest";
const RE_FX = "re_unittest1234";

// Slice 1d (A6): RESEND_API_KEY, MAIL_FROM, WITHDRAWAL_ALERT_TO, SITE_URL join the env; the
// fetch handler builds the mailer (consent confirmation) from them.
const VALID_ENV_RESULT = {
  supabaseUrl: "https://example.invalid",
  supabaseSecretKey: SB_KEY_FX,
  stripeKey: SK_TEST_FX,
  webhookSecret: WHSEC_FX,
  livemode: false,
  resendApiKey: RE_FX,
  mailFrom: "Alnyron <noreply@send.alnyron.dk>",
  withdrawalAlertTo: "owner@alnyron.dk",
  siteUrl: "https://alnyron.dk",
};

const FAKE_ENV = {
  SUPABASE_URL: "https://example.invalid",
  SUPABASE_SECRET_KEY: SB_KEY_FX,
  STRIPE_PAYMENTS_KEY: SK_TEST_FX,
  STRIPE_WEBHOOK_SECRET: WHSEC_FX,
  STRIPE_LIVEMODE: "false",
  RESEND_API_KEY: RE_FX,
  MAIL_FROM: "Alnyron <noreply@send.alnyron.dk>",
  WITHDRAWAL_ALERT_TO: "owner@alnyron.dk",
  SITE_URL: "https://alnyron.dk",
};

const fakeCtx = { waitUntil: () => {}, passThroughOnException: () => {} };

function makeRequest(method: string, path: string): Request {
  return new Request(`https://pay.alnyron.dk${path}`, { method });
}

beforeEach(() => {
  vi.mocked(parsePaymentsEnv).mockReturnValue(VALID_ENV_RESULT);
  vi.mocked(handleStripeWebhook).mockResolvedValue(new Response('{"received":true}', { status: 200 }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── WH-AC1a / WH-AC23a: wrong path → 404 ────────────────────────────────────

describe("WH-AC23a / WH-AC1a: wrong path → 404 empty body", () => {
  it.each(["/", "/webhook/extra", "/health", ""])(
    "WH-AC23a: path '%s' → 404",
    async (path) => {
      const req = makeRequest("POST", path || "/");
      const resp = await workerModule.fetch(req, FAKE_ENV, fakeCtx);
      expect(resp.status).toBe(404);
      expect(await resp.text()).toBe("");
    },
  );

  // PAYMENTS_WEBHOOK_PATH pin is in tests/unit/config/payments.test.ts (WH-AC27a).
});

// ── WH-AC1b / WH-AC23b: right path, wrong method → 405 ──────────────────────

describe("WH-AC23b / WH-AC1b: /webhook with non-POST method → 405 Allow: POST", () => {
  it.each(["GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])(
    "WH-AC23b: method '%s' → 405",
    async (method) => {
      const req = makeRequest(method, "/webhook");
      const resp = await workerModule.fetch(req, FAKE_ENV, fakeCtx);
      expect(resp.status).toBe(405);
      expect(resp.headers.get("Allow")).toBe("POST");
      expect(await resp.text()).toBe("");
    },
  );
});

// ── WH-AC23c: invalid env → 500, console.error names keys ────────────────────

describe("WH-AC23c: invalid env → 500 {error:unavailable}, console.error names the bad keys", () => {
  it("WH-AC23c: parsePaymentsEnv throws → 500 and no handleStripeWebhook call", async () => {
    vi.mocked(parsePaymentsEnv).mockImplementation(() => {
      throw new Error("payments: missing or invalid environment keys: STRIPE_PAYMENTS_KEY");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const req = makeRequest("POST", "/webhook");
    const resp = await workerModule.fetch(req, FAKE_ENV, fakeCtx);

    expect(resp.status).toBe(500);
    expect(await resp.json()).toEqual({ error: "unavailable" });
    expect(handleStripeWebhook).not.toHaveBeenCalled();
    // console.error called with the error message (names keys, never values)
    expect(errorSpy).toHaveBeenCalled();
    const errorArg = errorSpy.mock.calls[0]?.[0];
    if (typeof errorArg !== "string") throw new Error("expected string as first console.error arg");
    expect(errorArg).toContain("STRIPE_PAYMENTS_KEY");
    errorSpy.mockRestore();
  });
});

// ── WH-AC23d: unexpected throw from handler → 500 logged as unexpected ────────

describe("WH-AC23d: unexpected throw from handleStripeWebhook → 500 and outcome:error log", () => {
  it("WH-AC23d: handler throws unexpected error → 500 {error:unavailable}", async () => {
    vi.mocked(handleStripeWebhook).mockRejectedValue(new Error("unexpected boom"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const req = makeRequest("POST", "/webhook");
    const resp = await workerModule.fetch(req, FAKE_ENV, {});

    expect(resp.status).toBe(500);
    expect(await resp.json()).toEqual({ error: "unavailable" });
    expect(logSpy).toHaveBeenCalledOnce();
    const rawLogArg = logSpy.mock.calls[0]![0];
    if (typeof rawLogArg !== "string") throw new Error("expected string as first console.log arg");
    expect(JSON.parse(rawLogArg)).toEqual({ msg: "payments webhook", event: null, type: null, outcome: "error", code: "unexpected", paused: null });
    logSpy.mockRestore();
  });
});

// ── Happy path: delegates to handleStripeWebhook ─────────────────────────────

describe("WH-AC23e: valid POST to /webhook delegates to handleStripeWebhook", () => {
  it("WH-AC23e: valid POST → handleStripeWebhook called once, response returned as-is", async () => {
    const mockedResponse = new Response('{"received":true}', { status: 200 });
    vi.mocked(handleStripeWebhook).mockResolvedValue(mockedResponse);
    const req = makeRequest("POST", "/webhook");
    const resp = await workerModule.fetch(req, FAKE_ENV, {});
    expect(handleStripeWebhook).toHaveBeenCalledOnce();
    expect(resp).toBe(mockedResponse);
  });
});
