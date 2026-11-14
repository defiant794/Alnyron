/**
 * Unit tests: workers/payments/webhook.ts — handleStripeWebhook
 * Journey: payments-slice1c-webhook
 * Criteria: WH-AC2a..b (+ WH-AC2b-multistream/-multibyte/-exact/-cl-norequest), WH-AC4a..b, WH-AC5a, WH-AC6a, WH-AC7a,
 *           WH-AC8a..e (+ WH-AC8d-A5a..c), WH-AC9a..b, WH-AC10a..b, WH-AC11a..c,
 *           WH-AC12a..c, WH-AC13a..e, WH-AC14a..f,
 *           WH-AC18a..d (+ WH-AC18d-applied/-ignored/-rejected/-invalid-sig/-invalid-event/-error/-duplicate/-stale/
 *                          -dup-sub-canceled/-dup-invoice-refunded),
 *           WH-AC19a, WH-AC20a..s (+ WH-AC20b-order1/order2, excluding WH-AC20p superseded by A25),
 *           WH-AC20a-replay, WH-AC21a..c,
 *           WH-AC_A6a, WH-AC_A12b-sub (× 3)/-inv-parent/-inv-id/-pi (A12),
 *           WH-AC_A12e..g, WH-AC_A15 (A15),
 *           WH-AC_A16a..c (A16; + WH-AC_A16b-other/-partial/-mismatch, WH-AC_A16c-keeper),
 *           WH-AC_A17a..e (+ WH-AC_A17b-stale), WH-AC_A19a..d (A19b/A19c updated A26a), WH-AC_A19f (+ WH-AC_A19d-nouser),
 *           WH-AC_A21c, WH-AC_A22,
 *           WH-AC_A23a (+ WH-AC_A23a-null), WH-AC_A24b (A24b, superseded by A26a), WH-AC_A24c (via WH-AC_A25a-priority log assertion),
 *           WH-AC_A25a (+ WH-AC_A25a-only-open + WH-AC_A25a-two-dups-both-canceled
 *                        + WH-AC_A25a-priority + WH-AC_A25a-paid-open-mix),
 *           WH-AC_A25b-nonentitling/-mismatch/-transient-writer/-entitling/-entitling-sameInv/
 *                       -nopaid/-charge-already-refunded/-unmarked/-refusal-entitling (updated A26)/-entitling-malformed (A25, no DB read A26a),
 *           WH-AC_A26a-csu (it.each × 7), WH-AC_A26a-invpaid (it.each × 7), WH-AC_A26b (+ WH-AC_A26b-sameInv,
 *                       developer-added -mismatch / -unmarked-malformed / -keeper) (A26),
 *           WH-AC11b updated (A27b retrieve-first; unmarked→rejected), WH-AC11b-retrieve-404 / -retrieve-503, WH-AC13 unknown_user nullUserId,
 *           WH-AC_A27a (+ -nulluser / -nonentitling / -malformed-invoice / -invpaid),
 *           WH-AC_A27b-normalizeInvoice-null-marked / -normalizeSubscription-null-marked /
 *                       -normalizeSubscription-null-unmarked / -raw-id-mismatch /
 *                       -marked-nopaid / -marked-transient / -both-null-marked (A27),
 *           WH-AC_A28a-false, -true, -transient, -scope (A28).
 *
 * Uses fake StripeApi + fake PaymentsRpc injected via deps.
 * verifyStripeSignature is mocked so signature tests live in stripe-signature.test.ts.
 * Log line assertions use whole-object toEqual; fixture ids are alphanumeric after prefix.
 */
import { describe, expect, it, vi, beforeEach, afterEach, type Mock } from "vitest";
import type { StripeApi } from "../../../../workers/payments/stripe-api";
import type { PaymentsRpc } from "../../../../workers/payments/rpc";
import { PaymentsRpcError } from "../../../../workers/payments/rpc";
import { handleStripeWebhook, type WebhookDeps } from "../../../../workers/payments/webhook";
import { PAYMENTS_WEBHOOK_MAX_BODY_BYTES } from "@/config/payments";

// Mock verifyStripeSignature so we can control ok/fail independently
vi.mock("@/lib/payments/stripe-signature", () => ({
  verifyStripeSignature: vi.fn(),
}));
import { verifyStripeSignature } from "@/lib/payments/stripe-signature";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fakeStripe(overrides: Partial<StripeApi> = {}): StripeApi {
  return {
    retrieveSubscription: vi.fn().mockResolvedValue({ ok: true, data: validStripeSubscription() }),
    cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { id: "sub_test", status: "canceled" } }),
    listInvoicePayments: vi.fn().mockResolvedValue({ ok: true, data: { data: [] } }),
    createRefund: vi.fn().mockResolvedValue({ ok: true, data: { id: "re_test" } }),
    markDuplicateSubscription: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    ...overrides,
  };
}

function fakeRpc(overrides: Partial<PaymentsRpc> = {}): PaymentsRpc {
  return {
    syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
    recordSubscriptionInvoice: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
    otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([]),
    // A28 default: account exists (true → missing_profile → 500); forces explicit false override on A27(a) tests
    accountExists: vi.fn().mockResolvedValue(true),
    // Slice 1d consent writers + Auth email lookup (webhook-consent.test.ts covers them).
    paymentsRecordCheckoutConsent: vi.fn().mockResolvedValue({ outcome: "recorded", mail: null }),
    paymentsMarkConsentInfoSent: vi.fn().mockResolvedValue({ outcome: "stamped" }),
    getUserEmail: vi.fn().mockResolvedValue("user@test.local"),
    ...overrides,
  };
}

const WHSEC_FX = "whsec_unittest1234";

/** Shape returned by fakeDeps. */
type WebhookTestDeps = {
  webhookSecret: string;
  livemode: boolean;
  stripe: StripeApi;
  rpc: PaymentsRpc;
  mail: WebhookDeps["mail"];
  now: () => number;
  log: Mock<(line: string) => void>;
};

function fakeDeps(opts: { stripe?: Partial<StripeApi>; rpc?: Partial<PaymentsRpc>; livemode?: boolean } = {}): WebhookTestDeps {
  return {
    webhookSecret: WHSEC_FX,
    livemode: opts.livemode ?? false,
    stripe: fakeStripe(opts.stripe ?? {}),
    rpc: fakeRpc(opts.rpc ?? {}),
    // Slice 1d: the Checkout consent's order confirmation (webhook-consent.test.ts covers it).
    mail: { sendConfirmationEmail: vi.fn().mockResolvedValue({ id: "email-unit-001" }) },
    now: () => 1_700_000_000_000,
    log: vi.fn(),
  };
}

function validStripeSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_test001",
    customer: "cus_test001",
    status: "active",
    cancel_at_period_end: false,
    created: 1_700_000_000,
    start_date: 1_700_000_000,
    metadata: { kind: "monitor_subscription", user_id: "00000000-0000-0000-0000-000000000001" },
    items: { data: [{ price: { id: "price_test001" }, current_period_end: 1_732_000_000 }] },
    latest_invoice: "in_test001",
    ...overrides,
  };
}

function validStripeInvoice(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "in_test001",
    customer_email: "user@test.local",
    amount_paid: 9500,
    total_taxes: [{ amount: 1900 }],
    parent: { type: "subscription_details", subscription_details: { subscription: "sub_test001" } },
    lines: { data: [{ period: { start: 1_700_000_000, end: 1_732_000_000 } }] },
    status_transitions: { paid_at: 1_700_000_001 },
    ...overrides,
  };
}

/** Typed key-omit helper — no cast; rest destructuring lets TypeScript infer Omit<T,K>. */
function omitKey<T extends object, K extends keyof T>(o: T, k: K): Omit<T, K> {
  const { [k]: _omit, ...rest } = o;
  void _omit;
  return rest;
}

function makeEventBody(opts: {
  id?: string;
  type?: string;
  created?: number;
  livemode?: boolean;
  dataObject?: unknown;
}): string {
  return JSON.stringify({
    id: opts.id ?? "evt_test001",
    type: opts.type ?? "customer.subscription.updated",
    created: opts.created ?? 1_700_000_000,
    livemode: opts.livemode ?? false,
    data: { object: opts.dataObject ?? { id: "sub_test001" } },
  });
}

function makeRequest(body: string, extraHeaders: Record<string, string> = {}): Request {
  return new Request("https://pay.alnyron.dk/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": "t=1700000000,v1=fakesig",
      ...extraHeaders,
    },
    body,
  });
}

/**
 * Assert every StripeApi and PaymentsRpc method was NOT called.
 * Pass `allow` to skip the check for methods that WERE expected to be called.
 */
function expectNoCollaboratorCalls(
  deps: WebhookTestDeps,
  opts: { allow?: Array<keyof StripeApi | keyof PaymentsRpc> } = {},
): void {
  const allowed = new Set<string>(opts.allow ?? []);
  if (!allowed.has("retrieveSubscription")) expect(deps.stripe.retrieveSubscription).not.toHaveBeenCalled();
  if (!allowed.has("cancelSubscription")) expect(deps.stripe.cancelSubscription).not.toHaveBeenCalled();
  if (!allowed.has("listInvoicePayments")) expect(deps.stripe.listInvoicePayments).not.toHaveBeenCalled();
  if (!allowed.has("createRefund")) expect(deps.stripe.createRefund).not.toHaveBeenCalled();
  if (!allowed.has("markDuplicateSubscription")) expect(deps.stripe.markDuplicateSubscription).not.toHaveBeenCalled();
  if (!allowed.has("syncSubscription")) expect(deps.rpc.syncSubscription).not.toHaveBeenCalled();
  if (!allowed.has("recordSubscriptionInvoice")) expect(deps.rpc.recordSubscriptionInvoice).not.toHaveBeenCalled();
  if (!allowed.has("otherEntitlingSubscriptionIds")) expect(deps.rpc.otherEntitlingSubscriptionIds).not.toHaveBeenCalled();
  if (!allowed.has("accountExists")) expect(deps.rpc.accountExists).not.toHaveBeenCalled();
}

/** Parse the single log line the handler emits; also asserts exactly one call. */
function parseLog(deps: WebhookTestDeps): Record<string, unknown> {
  expect(deps.log).toHaveBeenCalledOnce();
  const [call] = deps.log.mock.calls;
  if (!call) throw new Error("parseLog: log not called");
  const raw: unknown = JSON.parse(call[0]);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("log line is not an object");
  return Object.fromEntries(Object.entries(raw));
}

beforeEach(() => {
  vi.mocked(verifyStripeSignature).mockResolvedValue({ ok: true, timestamp: 1_700_000_000 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── WH-AC2a: content-length guard (before reading) ───────────────────────────

describe("WH-AC2a: content-length > max → 413 before reading body", () => {
  it("WH-AC2a: content-length one byte over limit → 413; verifyStripeSignature NOT called", async () => {
    const req = makeRequest("{}", { "content-length": String(PAYMENTS_WEBHOOK_MAX_BODY_BYTES + 1) });
    const deps = fakeDeps();
    const resp = await handleStripeWebhook(req, deps);
    expect(resp.status).toBe(413);
    expect(vi.mocked(verifyStripeSignature)).not.toHaveBeenCalled();
    expectNoCollaboratorCalls(deps);
  });
});

// ── WH-AC2b: body stream cap ──────────────────────────────────────────────────

describe("WH-AC2b: body stream capped at PAYMENTS_WEBHOOK_MAX_BODY_BYTES", () => {
  it("WH-AC2b: oversized ASCII body (single chunk) → 413", async () => {
    const oversized = "x".repeat(PAYMENTS_WEBHOOK_MAX_BODY_BYTES + 1);
    const req = new Request("https://pay.alnyron.dk/webhook", {
      method: "POST",
      headers: { "stripe-signature": "t=1700000000,v1=fakesig" },
      body: oversized,
    });
    const deps = fakeDeps();
    const resp = await handleStripeWebhook(req, deps);
    expect(resp.status).toBe(413);
    expectNoCollaboratorCalls(deps);
  });

  it("WH-AC2b-multistream: unbounded pull-based stream → stops consuming at max+1 bytes, cancel called", async () => {
    // Pull-based stream: each pull enqueues 1 KiB; the handler must cancel it after the limit.
    let cancelCalled = false;
    let pulled = 0;
    const CHUNK = 1024;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = new Uint8Array(CHUNK).fill(120);
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() { cancelCalled = true; },
    });
    const reqInit: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: { "stripe-signature": "t=1700000000,v1=fakesig" },
      body: stream,
      duplex: "half",
    };
    const req = new Request("https://pay.alnyron.dk/webhook", reqInit);
    const deps = fakeDeps();
    const resp = await handleStripeWebhook(req, deps);
    expect(resp.status).toBe(413);
    expect(cancelCalled).toBe(true);
    expect(pulled).toBeGreaterThan(PAYMENTS_WEBHOOK_MAX_BODY_BYTES);
    expect(pulled).toBeLessThanOrEqual(PAYMENTS_WEBHOOK_MAX_BODY_BYTES + 2 * CHUNK);
    expectNoCollaboratorCalls(deps);
  });

  it("WH-AC2b-multibyte: multi-byte chars where bytes > max but chars < max → 413", async () => {
    // '€' is 3 UTF-8 bytes; enough chars to exceed byte limit but not char limit.
    const charCount = Math.floor(PAYMENTS_WEBHOOK_MAX_BODY_BYTES / 3) + 1;
    const req = new Request("https://pay.alnyron.dk/webhook", {
      method: "POST",
      headers: { "stripe-signature": "t=1700000000,v1=fakesig" },
      body: "€".repeat(charCount),
    });
    const deps = fakeDeps();
    const resp = await handleStripeWebhook(req, deps);
    expect(resp.status).toBe(413);
    expectNoCollaboratorCalls(deps);
  });

  it("WH-AC2b-exact: body of exactly PAYMENTS_WEBHOOK_MAX_BODY_BYTES → 400 invalid_event; sig receives full payload", async () => {
    const exactBody = "x".repeat(PAYMENTS_WEBHOOK_MAX_BODY_BYTES);
    const req = new Request("https://pay.alnyron.dk/webhook", {
      method: "POST",
      headers: { "stripe-signature": "t=1700000000,v1=fakesig" },
      body: exactBody,
    });
    const deps = fakeDeps();
    const resp = await handleStripeWebhook(req, deps);
    // Not rejected by size check (not 413), but invalid JSON → 400 invalid_event
    expect(resp.status).toBe(400);
    expect(await resp.json()).toEqual({ error: "invalid_event" });
    // verifyStripeSignature was called with the full max-bytes payload
    expect(vi.mocked(verifyStripeSignature)).toHaveBeenCalledOnce();
    const [sigCall] = vi.mocked(verifyStripeSignature).mock.calls;
    if (!sigCall) throw new Error("verifyStripeSignature not called");
    expect(sigCall[0].payload).toHaveLength(PAYMENTS_WEBHOOK_MAX_BODY_BYTES);
  });

  it("WH-AC2b-cl-norequest: content-length 413 fires before body is consumed (bodyUsed === false)", async () => {
    const req = makeRequest("{}", { "content-length": String(PAYMENTS_WEBHOOK_MAX_BODY_BYTES + 1) });
    const deps = fakeDeps();
    const resp = await handleStripeWebhook(req, deps);
    expect(resp.status).toBe(413);
    expect(req.bodyUsed).toBe(false);
  });
});

// ── WH-AC4a: signature failure → 400, log, no collaborators ──────────────────

describe("WH-AC4a: signature failure → 400 {error:invalid_signature}, no collaborator calls", () => {
  it.each([
    { reason: "missing_header" as const },
    { reason: "malformed_header" as const },
    { reason: "stale_timestamp" as const },
    { reason: "no_signature_match" as const },
  ])("WH-AC4a: reason=$reason → 400 and no collaborator calls", async ({ reason }) => {
    vi.mocked(verifyStripeSignature).mockResolvedValue({ ok: false, reason });
    const deps = fakeDeps();
    const resp = await handleStripeWebhook(makeRequest(makeEventBody({})), deps);
    expect(resp.status).toBe(400);
    expect(await resp.json()).toEqual({ error: "invalid_signature" });
    expectNoCollaboratorCalls(deps);
  });
});

// ── WH-AC4b: signature failure log has reason, not event/type ────────────────

describe("WH-AC4b: invalid_signature log has reason key, not event/type", () => {
  it("WH-AC4b: log line has reason but no event or type keys", async () => {
    vi.mocked(verifyStripeSignature).mockResolvedValue({ ok: false, reason: "missing_header" });
    const deps = fakeDeps();
    await handleStripeWebhook(makeRequest(makeEventBody({})), deps);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      outcome: "invalid_signature",
      reason: "missing_header",
    });
  });
});

// ── WH-AC5a: invalid event JSON ───────────────────────────────────────────────

describe("WH-AC5a: invalid event body → 400 {error:invalid_event}; no collaborator calls", () => {
  it.each([
    ["not JSON at all", "not-json{{{"],
    ["JSON non-object", '"a string"'],
    ["id not ^evt_", JSON.stringify({ id: "sub_bad", type: "t", created: 1, livemode: false, data: { object: {} } })],
    ["missing type", JSON.stringify({ id: "evt_1", created: 1, livemode: false, data: { object: {} } })],
    ["created is string not integer", JSON.stringify({ id: "evt_1", type: "t", created: "now", livemode: false, data: { object: {} } })],
    ["livemode not boolean", JSON.stringify({ id: "evt_1", type: "t", created: 1, livemode: "true", data: { object: {} } })],
    ["data.object not an object", JSON.stringify({ id: "evt_1", type: "t", created: 1, livemode: false, data: { object: null } })],
    // A7: out-of-range |created| > 8.64e12 → invalid_event
    ["created out of Date range", JSON.stringify({ id: "evt_1", type: "t", created: 9e12, livemode: false, data: { object: {} } })],
  ])("WH-AC5a: %s → 400 invalid_event", async (_label, body) => {
    const deps = fakeDeps();
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(400);
    expect(await resp.json()).toEqual({ error: "invalid_event" });
    expectNoCollaboratorCalls(deps);
  });
});

// ── WH-AC6a: livemode mismatch → 200 ignored, no collaborators ───────────────

describe("WH-AC6a: event.livemode !== deps.livemode → 200 ignored livemode_mismatch", () => {
  it("WH-AC6a: live event to test worker → 200 ignored; log and no collaborator calls", async () => {
    const body = makeEventBody({ livemode: true });
    const deps = fakeDeps({ livemode: false });
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expectNoCollaboratorCalls(deps);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.updated",
      outcome: "ignored",
      code: "livemode_mismatch",
      paused: null,
    });
  });
});

// ── WH-AC7a: unhandled event type → 200 ignored ───────────────────────────────

describe("WH-AC7a: unhandled event type → 200 ignored unhandled_type", () => {
  it.each([
    "charge.succeeded",
    "payment_intent.created",
    "customer.created",
    "some.future.event",
  ])("WH-AC7a: type '%s' → 200 ignored; log and no collaborator calls", async (type) => {
    const body = makeEventBody({ type });
    const deps = fakeDeps();
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expectNoCollaboratorCalls(deps);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type,
      outcome: "ignored",
      code: "unhandled_type",
      paused: null,
    });
  });
});

// ── WH-AC8: checkout.session.completed ────────────────────────────────────────

describe("WH-AC8a: mode !== subscription → 200 ignored not_monitor_subscription", () => {
  it("WH-AC8a: mode='payment' → ignored; no collaborator calls", async () => {
    const body = makeEventBody({
      type: "checkout.session.completed",
      dataObject: { mode: "payment", metadata: { kind: "monitor_subscription" }, subscription: "sub_test001" },
    });
    const deps = fakeDeps();
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expectNoCollaboratorCalls(deps);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "checkout.session.completed",
      outcome: "ignored",
      code: "not_monitor_subscription",
      paused: null,
    });
  });
});

describe("WH-AC8b: metadata.kind !== monitor_subscription → 200 ignored", () => {
  it("WH-AC8b: kind='other' → ignored not_monitor_subscription; no collaborator calls", async () => {
    const body = makeEventBody({
      type: "checkout.session.completed",
      dataObject: { mode: "subscription", metadata: { kind: "other" }, subscription: "sub_test001" },
    });
    const deps = fakeDeps();
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expectNoCollaboratorCalls(deps);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "checkout.session.completed",
      outcome: "ignored",
      code: "not_monitor_subscription",
      paused: null,
    });
  });
});

describe("WH-AC8c: s.subscription not a sub_ string → 200 rejected invalid_session", () => {
  it("WH-AC8c: subscription='pi_badid' → rejected invalid_session; no collaborator calls", async () => {
    const body = makeEventBody({
      type: "checkout.session.completed",
      dataObject: {
        mode: "subscription",
        metadata: { kind: "monitor_subscription", user_id: "00000000-0000-0000-0000-000000000001" },
        client_reference_id: "00000000-0000-0000-0000-000000000001",
        subscription: "pi_badid",
      },
    });
    const deps = fakeDeps();
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expectNoCollaboratorCalls(deps);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "checkout.session.completed",
      outcome: "rejected",
      code: "invalid_session",
      paused: null,
    });
  });
});

describe("WH-AC8d: checkout session user_id validation", () => {
  const userId = "00000000-0000-0000-0000-000000000001";
  const wrongId = "00000000-0000-0000-0000-000000000002";

  it("WH-AC8d: client_reference_id !== sub.metadata.user_id → rejected user_mismatch", async () => {
    const body = makeEventBody({
      type: "checkout.session.completed",
      dataObject: {
        mode: "subscription",
        metadata: { kind: "monitor_subscription", user_id: userId },
        client_reference_id: wrongId,
        subscription: "sub_test001",
      },
    });
    const deps = fakeDeps({
      stripe: {
        retrieveSubscription: vi.fn().mockResolvedValue({
          ok: true,
          data: validStripeSubscription({ metadata: { kind: "monitor_subscription", user_id: userId } }),
        }),
      },
    });
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(deps.stripe.retrieveSubscription).toHaveBeenCalledExactlyOnceWith("sub_test001");
    expectNoCollaboratorCalls(deps, { allow: ["retrieveSubscription"] });
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "checkout.session.completed",
      outcome: "rejected",
      code: "user_mismatch",
      paused: null,
    });
  });

  it("WH-AC8d-A5a: session metadata missing user_id → rejected user_mismatch", async () => {
    const body = makeEventBody({
      type: "checkout.session.completed",
      dataObject: {
        mode: "subscription",
        metadata: { kind: "monitor_subscription" },
        client_reference_id: userId,
        subscription: "sub_test001",
      },
    });
    const deps = fakeDeps({
      stripe: {
        retrieveSubscription: vi.fn().mockResolvedValue({
          ok: true,
          data: validStripeSubscription({ metadata: { kind: "monitor_subscription", user_id: userId } }),
        }),
      },
    });
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(deps.stripe.retrieveSubscription).toHaveBeenCalledExactlyOnceWith("sub_test001");
    expectNoCollaboratorCalls(deps, { allow: ["retrieveSubscription"] });
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "checkout.session.completed",
      outcome: "rejected",
      code: "user_mismatch",
      paused: null,
    });
  });

  it("WH-AC8d-A5c: session user_id is a valid UUID but differs from client_reference_id → rejected user_mismatch", async () => {
    // A5: session.metadata.user_id must equal client_reference_id; a valid but different UUID fails.
    const differentUuid = "00000000-0000-0000-0000-000000000099";
    const body = makeEventBody({
      type: "checkout.session.completed",
      dataObject: {
        mode: "subscription",
        metadata: { kind: "monitor_subscription", user_id: differentUuid },
        client_reference_id: userId,
        subscription: "sub_test001",
      },
    });
    const deps = fakeDeps({
      stripe: {
        retrieveSubscription: vi.fn().mockResolvedValue({
          ok: true,
          data: validStripeSubscription({ metadata: { kind: "monitor_subscription", user_id: userId } }),
        }),
      },
    });
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(deps.stripe.retrieveSubscription).toHaveBeenCalledExactlyOnceWith("sub_test001");
    expectNoCollaboratorCalls(deps, { allow: ["retrieveSubscription"] });
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "checkout.session.completed",
      outcome: "rejected",
      code: "user_mismatch",
      paused: null,
    });
  });

  it("WH-AC8d-A5b: session metadata has non-UUID user_id → rejected user_mismatch", async () => {
    const body = makeEventBody({
      type: "checkout.session.completed",
      dataObject: {
        mode: "subscription",
        metadata: { kind: "monitor_subscription", user_id: "not-a-uuid" },
        client_reference_id: userId,
        subscription: "sub_test001",
      },
    });
    const deps = fakeDeps({
      stripe: {
        retrieveSubscription: vi.fn().mockResolvedValue({
          ok: true,
          data: validStripeSubscription({ metadata: { kind: "monitor_subscription", user_id: userId } }),
        }),
      },
    });
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(deps.stripe.retrieveSubscription).toHaveBeenCalledExactlyOnceWith("sub_test001");
    expectNoCollaboratorCalls(deps, { allow: ["retrieveSubscription"] });
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "checkout.session.completed",
      outcome: "rejected",
      code: "user_mismatch",
      paused: null,
    });
  });
});

describe("WH-AC8e: checkout.session.completed happy path → applied", () => {
  it("WH-AC8e: all checks pass → getSub called, sync writer called, outcome applied", async () => {
    const userId = "00000000-0000-0000-0000-000000000001";
    const body = makeEventBody({
      type: "checkout.session.completed",
      dataObject: {
        mode: "subscription",
        metadata: { kind: "monitor_subscription", user_id: userId },
        client_reference_id: userId,
        subscription: "sub_test001",
      },
    });
    const deps = fakeDeps({
      stripe: {
        retrieveSubscription: vi.fn().mockResolvedValue({
          ok: true,
          data: validStripeSubscription({ metadata: { kind: "monitor_subscription", user_id: userId } }),
        }),
      },
    });
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(deps.stripe.retrieveSubscription).toHaveBeenCalledWith("sub_test001");
    expect(deps.rpc.syncSubscription).toHaveBeenCalledOnce();
    // Verify user_id and id flow through to the writer
    const [syncCall8e] = vi.mocked(deps.rpc.syncSubscription).mock.calls;
    if (!syncCall8e) throw new Error("syncSubscription not called");
    const [, subArg8e] = syncCall8e;
    expect(subArg8e.id).toBe("sub_test001");
    expect(subArg8e.user_id).toBe(userId);
    // Slice 1d A13: the log line gains consent + mail; this session carries no consent.
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "checkout.session.completed",
      outcome: "applied",
      code: null,
      paused: 0,
      consent: "consent_missing",
      mail: null,
    });
  });
});

// ── WH-AC9: customer.subscription.* ──────────────────────────────────────────

describe("WH-AC9a..b: customer.subscription.created/updated/deleted → getSub + sync writer", () => {
  it.each([
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
  ] as const)("WH-AC9: type '%s' → retrieveSubscription + sync writer + outcome applied", async (type) => {
    const body = makeEventBody({ type, dataObject: { id: "sub_test001" } });
    const deps = fakeDeps();
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(deps.stripe.retrieveSubscription).toHaveBeenCalledWith("sub_test001");
    expect(deps.rpc.syncSubscription).toHaveBeenCalledOnce();
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type,
      outcome: "applied",
      code: null,
      paused: 0,
    });
  });
});

// ── A14 (slice 1d): a subscription without a usable start_date is malformed ──

describe("WD-T-MAP-start-date (A14): retrieved subscription without a valid start_date → rejected invalid_subscription before the writer", () => {
  it.each<[label: string, subscription: unknown]>([
    ["absent", omitKey(validStripeSubscription(), "start_date")],
    ["null", validStripeSubscription({ start_date: null })],
    ["string", validStripeSubscription({ start_date: "1700000000" })],
  ])("WD-T-MAP-start-date-webhook-%s: customer.subscription.updated → 200 rejected invalid_subscription; no writer", async (_label, subscription) => {
    const body = makeEventBody({ type: "customer.subscription.updated", dataObject: { id: "sub_test001" } });
    const deps = fakeDeps({ stripe: { retrieveSubscription: vi.fn().mockResolvedValue({ ok: true, data: subscription }) } });
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expectNoCollaboratorCalls(deps, { allow: ["retrieveSubscription"] });
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.updated",
      outcome: "rejected",
      code: "invalid_subscription",
      paused: null,
    });
  });
});

// ── WH-AC_A6a: malformed sub id on customer.subscription.* → rejected before Stripe ──

describe("WH-AC_A6a: customer.subscription.* with non-sub_ data.object.id → rejected invalid_subscription before Stripe call", () => {
  it.each([
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
  ] as const)("WH-AC_A6a: type '%s', id='cus_notasub' → rejected invalid_subscription; no Stripe or DB call", async (type) => {
    const body = makeEventBody({ type, dataObject: { id: "cus_notasub" } });
    const deps = fakeDeps();
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type,
      outcome: "rejected",
      code: "invalid_subscription",
      paused: null,
    });
    expectNoCollaboratorCalls(deps);
  });
});

// ── WH-AC10: invoice.payment_failed ──────────────────────────────────────────

describe("WH-AC10a: invoice.payment_failed without subscription parent → 200 ignored", () => {
  it("WH-AC10a: no parent → ignored not_subscription_invoice; no collaborator calls", async () => {
    const body = makeEventBody({
      type: "invoice.payment_failed",
      dataObject: { id: "in_test001", parent: null },
    });
    const deps = fakeDeps();
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expectNoCollaboratorCalls(deps);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "invoice.payment_failed",
      outcome: "ignored",
      code: "not_subscription_invoice",
      paused: null,
    });
  });
});

describe("WH-AC10b: invoice.payment_failed with valid subId → getSub + sync writer", () => {
  it("WH-AC10b: past_due status synced", async () => {
    const body = makeEventBody({
      type: "invoice.payment_failed",
      dataObject: {
        id: "in_test001",
        parent: { type: "subscription_details", subscription_details: { subscription: "sub_test001" } },
      },
    });
    const deps = fakeDeps({
      stripe: {
        retrieveSubscription: vi.fn().mockResolvedValue({
          ok: true,
          data: validStripeSubscription({ status: "past_due" }),
        }),
      },
    });
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(deps.stripe.retrieveSubscription).toHaveBeenCalledWith("sub_test001");
    expect(deps.rpc.syncSubscription).toHaveBeenCalledOnce();
    // Verify the subscription payload carries the retrieved status
    const [syncCall] = vi.mocked(deps.rpc.syncSubscription).mock.calls;
    if (!syncCall) throw new Error("syncSubscription not called");
    const [, subArg] = syncCall;
    expect(subArg.status).toBe("past_due");
    expect(subArg.id).toBe("sub_test001");
  });
});

// ── WH-AC11: invoice.paid ─────────────────────────────────────────────────────

describe("WH-AC11a: invoice.paid without subscription parent → 200 ignored", () => {
  it("WH-AC11a: no parent → ignored not_subscription_invoice; no collaborator calls", async () => {
    const body = makeEventBody({
      type: "invoice.paid",
      dataObject: { id: "in_test001", parent: null },
    });
    const deps = fakeDeps();
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expectNoCollaboratorCalls(deps);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "invoice.paid",
      outcome: "ignored",
      code: "not_subscription_invoice",
      paused: null,
    });
  });
});

describe("WH-AC11b: invoice.paid; normalizeInvoice null, unmarked sub → getSub called first, then rejected invalid_invoice (A27b)", () => {
  it("WH-AC11b: invoice missing paid_at; unmarked sub → retrieveSubscription called; rejected invalid_invoice (A27b order)", async () => {
    // A27b: getSub is called BEFORE normalizeInvoice. Unmarked sub → still rejected invalid_invoice.
    const body = makeEventBody({
      type: "invoice.paid",
      dataObject: {
        id: "in_bad",
        parent: { type: "subscription_details", subscription_details: { subscription: "sub_test001" } },
        amount_paid: 9500,
        status_transitions: {},
        lines: { data: [] },
      },
    });
    const deps = fakeDeps();
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(deps.stripe.retrieveSubscription).toHaveBeenCalledExactlyOnceWith("sub_test001");
    expectNoCollaboratorCalls(deps, { allow: ["retrieveSubscription"] });
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "invoice.paid",
      outcome: "rejected",
      code: "invalid_invoice",
      paused: null,
    });
  });
});

describe("WH-AC11c: invoice.paid happy path → getSub + recordInvoice", () => {
  it("WH-AC11c: valid sub + valid invoice → both called", async () => {
    const body = makeEventBody({
      type: "invoice.paid",
      dataObject: validStripeInvoice(),
    });
    const deps = fakeDeps();
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(deps.stripe.retrieveSubscription).toHaveBeenCalledOnce();
    expect(deps.rpc.recordSubscriptionInvoice).toHaveBeenCalledOnce();
    // Verify the full p_invoice payload (normalizeInvoice output for validStripeInvoice())
    const [invCall] = vi.mocked(deps.rpc.recordSubscriptionInvoice).mock.calls;
    if (!invCall) throw new Error("recordSubscriptionInvoice not called");
    const [, , invArg] = invCall;
    expect(invArg).toEqual({
      id: "in_test001",
      subscription_id: "sub_test001",
      email: "user@test.local",
      amount_total_ore: 9500,
      amount_tax_ore: 1900,
      period_start: "2023-11-14T22:13:20.000Z",
      period_end: "2024-11-19T07:06:40.000Z",
      paid_at: "2023-11-14T22:13:21.000Z",
    });
  });
});

// ── WH-AC12: Stripe retrieve failures ────────────────────────────────────────

describe("WH-AC12a: stripe.retrieveSubscription → 404 → 200 rejected subscription_not_found", () => {
  it("WH-AC12a: 404 http result → rejected subscription_not_found; no DB calls", async () => {
    const body = makeEventBody({ type: "customer.subscription.updated", dataObject: { id: "sub_test001" } });
    const deps = fakeDeps({
      stripe: {
        retrieveSubscription: vi.fn().mockResolvedValue({ ok: false, kind: "http", status: 404, code: "resource_missing" }),
      },
    });
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(deps.stripe.retrieveSubscription).toHaveBeenCalledExactlyOnceWith("sub_test001");
    expectNoCollaboratorCalls(deps, { allow: ["retrieveSubscription"] });
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.updated",
      outcome: "rejected",
      code: "subscription_not_found",
      paused: null,
    });
  });
});

describe("WH-AC12b: stripe transient failures → 500 with structured log code", () => {
  it.each([
    { label: "network", result: { ok: false as const, kind: "network" as const }, expectedCode: "stripe_network" },
    { label: "429 http", result: { ok: false as const, kind: "http" as const, status: 429, code: "rate_limit" }, expectedCode: "stripe_http_429" },
    { label: "503 http", result: { ok: false as const, kind: "http" as const, status: 503, code: null }, expectedCode: "stripe_http_503" },
    { label: "invalid_response", result: { ok: false as const, kind: "invalid_response" as const }, expectedCode: "stripe_invalid_response" },
  ])("WH-AC12b: stripe $label → 500; log code='$expectedCode'", async ({ result, expectedCode }) => {
    const body = makeEventBody({ type: "customer.subscription.updated", dataObject: { id: "sub_test001" } });
    const deps = fakeDeps({
      stripe: { retrieveSubscription: vi.fn().mockResolvedValue(result) },
    });
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(500);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.updated",
      outcome: "error",
      code: expectedCode,
      paused: null,
    });
  });
});

// ── WH-AC13: writer permanent errors → 200 rejected ──────────────────────────

describe("WH-AC13a..d: writer 22023 permanent errors → 200 rejected with matching code", () => {
  it.each<{ errorCode: "invalid_payload" | "unknown_plan" | "unknown_user"; nullUserId?: boolean }>([
    { errorCode: "invalid_payload" },
    { errorCode: "unknown_plan" },
    { errorCode: "unknown_user", nullUserId: true }, // A27a: unknown_user + null user_id still rejected; non-null → WH-AC_A27a
  ])("WH-AC13: writer raises '$errorCode' (refusal) → 200 rejected code='$errorCode'", async ({ errorCode, nullUserId }) => {
    const body = makeEventBody({ type: "customer.subscription.updated", dataObject: { id: "sub_test001" } });
    const err = new PaymentsRpcError(errorCode, "22023", 400);
    const stripeOverride: Partial<StripeApi> = nullUserId
      ? { retrieveSubscription: vi.fn().mockResolvedValue({ ok: true, data: validStripeSubscription({ metadata: { kind: "monitor_subscription" } }) }) }
      : {};
    const deps = fakeDeps({
      stripe: stripeOverride,
      rpc: { syncSubscription: vi.fn().mockRejectedValue(err) },
    });
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expectNoCollaboratorCalls(deps, { allow: ["retrieveSubscription", "syncSubscription"] });
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.updated",
      outcome: "rejected",
      code: errorCode,
      paused: null,
    });
  });
});

describe("WH-AC13e: 22023 with unknown message → 500; exact code rpc_22023_400", () => {
  it("WH-AC13e: PaymentsRpcError('rpc_failed', '22023', 400) → 500; code='rpc_22023_400'", async () => {
    // A14: refusal=null (unknown message) → transient → 500. WH-AC_A10e is the same case; kept here.
    const body = makeEventBody({ type: "customer.subscription.updated", dataObject: { id: "sub_test001" } });
    const err = new PaymentsRpcError("rpc_failed", "22023", 400);
    const deps = fakeDeps({
      rpc: { syncSubscription: vi.fn().mockRejectedValue(err) },
    });
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(500);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.updated",
      outcome: "error",
      code: "rpc_22023_400",
      paused: null,
    });
  });
});

// ── WH-AC14: writer transient errors → 500 ───────────────────────────────────

describe("WH-AC14a..f: writer transient failures → 500", () => {
  function makeRpcErr(code: string, status: number | null = null): PaymentsRpcError {
    return new PaymentsRpcError("rpc_failed", code, status);
  }

  it.each([
    { label: "network error (non-PaymentsRpcError)", err: Object.assign(new Error("network"), { code: "network" }), expectedCode: "rpc_failed" },
    { label: "timeout DOMException (non-PaymentsRpcError)", err: new DOMException("Timeout", "TimeoutError"), expectedCode: "rpc_failed" },
    { label: "rpc http_429", err: makeRpcErr("http_429", 429), expectedCode: "rpc_http_429_429" },
    { label: "rpc http_503", err: makeRpcErr("http_503", 503), expectedCode: "rpc_http_503_503" },
    { label: "rpc invalid_response", err: makeRpcErr("invalid_response"), expectedCode: "rpc_invalid_response" },
  ])("WH-AC14: writer throws '$label' → 500; outcome error", async ({ err, expectedCode }) => {
    const body = makeEventBody({ type: "customer.subscription.updated", dataObject: { id: "sub_test001" } });
    const deps = fakeDeps({
      rpc: { syncSubscription: vi.fn().mockRejectedValue(err) },
    });
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(500);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.updated",
      outcome: "error",
      code: expectedCode,
      paused: null,
    });
  });
});

// WH-AC_A10e is covered by WH-AC13e above (same PaymentsRpcError("rpc_failed","22023",400) case).

// ── WH-AC18: log line contract ────────────────────────────────────────────────

describe("WH-AC18a: every handled request logs exactly one JSON line with required keys", () => {
  it("WH-AC18a: success path → one log line with all 6 keys", async () => {
    const body = makeEventBody({});
    const deps = fakeDeps();
    await handleStripeWebhook(makeRequest(body), deps);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.updated",
      outcome: "applied",
      code: null,
      paused: 0,
    });
  });
});

describe("WH-AC18b: log line never contains PII — email, user_id, customer_id", () => {
  it("WH-AC18b: invoice.paid event with customer_email, user_id, customer → log has exactly 6 keys, no PII", async () => {
    const piiEmail = "pii-user@test.local";
    const piiUserId = "00000000-0000-0000-0000-000000000099";
    const piiCustomerId = "cus_piitest001";
    const nologWhsec = "whsec_nolog1234";
    const sigHeader = "t=1700000000,v1=fakesignaturevalue";
    const rawBody = makeEventBody({
      type: "invoice.paid",
      dataObject: validStripeInvoice({ customer_email: piiEmail }),
    });
    const logs: string[] = [];
    const deps: WebhookTestDeps = {
      webhookSecret: nologWhsec, livemode: false,
      stripe: fakeStripe({
        retrieveSubscription: vi.fn().mockResolvedValue({
          ok: true,
          data: validStripeSubscription({
            customer: piiCustomerId,
            metadata: { kind: "monitor_subscription", user_id: piiUserId },
          }),
        }),
      }),
      rpc: fakeRpc(),
      mail: { sendConfirmationEmail: vi.fn().mockResolvedValue({ id: "email-unit-001" }) },
      now: () => 1_700_000_000_000,
      log: vi.fn((line: string) => { logs.push(line); }),
    };
    await handleStripeWebhook(makeRequest(rawBody, { "stripe-signature": sigHeader }), deps);
    const logLine = logs[0] ?? "";
    expect(logLine).not.toContain(nologWhsec);
    expect(logLine).not.toContain(sigHeader);
    expect(logLine).not.toContain(piiEmail);
    expect(logLine).not.toContain(piiUserId);
    expect(logLine).not.toContain(piiCustomerId);
    expect(JSON.parse(logLine)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "invoice.paid",
      outcome: "applied",
      code: null,
      paused: 0,
    });
  });
});

describe("WH-AC18c: invalid_signature log has reason, not event/type", () => {
  it("WH-AC18c: reason present, event/type absent; whole-object log matches", async () => {
    vi.mocked(verifyStripeSignature).mockResolvedValue({ ok: false, reason: "stale_timestamp" });
    const deps = fakeDeps();
    await handleStripeWebhook(makeRequest(makeEventBody({})), deps);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      outcome: "invalid_signature",
      reason: "stale_timestamp",
    });
  });
});

describe("WH-AC18d: outcome values match the allowed set — all 10 outcomes exercised", () => {
  const ALLOWED_OUTCOMES: Record<string, true> = {
    applied: true, duplicate: true, stale: true, ignored: true, rejected: true,
    duplicate_subscription_canceled: true, duplicate_invoice_refunded: true,
    invalid_signature: true, invalid_event: true, error: true,
  };

  it("WH-AC18d-applied: writer returns applied → outcome 'applied'", async () => {
    const body = makeEventBody({});
    const deps = fakeDeps();
    await handleStripeWebhook(makeRequest(body), deps);
    const logObj = parseLog(deps);
    const outcome = logObj.outcome;
    expect(typeof outcome === "string" && outcome in ALLOWED_OUTCOMES).toBe(true);
    expect(outcome).toBe("applied");
  });

  it("WH-AC18d-ignored: livemode mismatch → outcome 'ignored'", async () => {
    const body = makeEventBody({ livemode: true });
    const deps = fakeDeps({ livemode: false });
    await handleStripeWebhook(makeRequest(body), deps);
    const logObj = parseLog(deps);
    const outcome = logObj.outcome;
    expect(typeof outcome === "string" && outcome in ALLOWED_OUTCOMES).toBe(true);
    expect(outcome).toBe("ignored");
  });

  it("WH-AC18d-rejected: subscription_not_found → outcome 'rejected'", async () => {
    const body = makeEventBody({ type: "customer.subscription.updated", dataObject: { id: "sub_test001" } });
    const deps = fakeDeps({
      stripe: { retrieveSubscription: vi.fn().mockResolvedValue({ ok: false, kind: "http", status: 404, code: "resource_missing" }) },
    });
    await handleStripeWebhook(makeRequest(body), deps);
    const logObj = parseLog(deps);
    const outcome = logObj.outcome;
    expect(typeof outcome === "string" && outcome in ALLOWED_OUTCOMES).toBe(true);
    expect(outcome).toBe("rejected");
  });

  it("WH-AC18d-invalid-sig: signature failure → outcome 'invalid_signature'", async () => {
    vi.mocked(verifyStripeSignature).mockResolvedValue({ ok: false, reason: "missing_header" });
    const deps = fakeDeps();
    await handleStripeWebhook(makeRequest(makeEventBody({})), deps);
    const logObj = parseLog(deps);
    const outcome = logObj.outcome;
    expect(typeof outcome === "string" && outcome in ALLOWED_OUTCOMES).toBe(true);
    expect(outcome).toBe("invalid_signature");
  });

  it("WH-AC18d-invalid-event: bad event body → outcome 'invalid_event'", async () => {
    const deps = fakeDeps();
    await handleStripeWebhook(makeRequest("not-json"), deps);
    const logObj = parseLog(deps);
    const outcome = logObj.outcome;
    expect(typeof outcome === "string" && outcome in ALLOWED_OUTCOMES).toBe(true);
    expect(outcome).toBe("invalid_event");
  });

  it("WH-AC18d-error: Stripe network failure → outcome 'error'", async () => {
    const body = makeEventBody({ type: "customer.subscription.updated", dataObject: { id: "sub_test001" } });
    const deps = fakeDeps({
      stripe: { retrieveSubscription: vi.fn().mockResolvedValue({ ok: false, kind: "network" }) },
    });
    await handleStripeWebhook(makeRequest(body), deps);
    const logObj = parseLog(deps);
    const outcome = logObj.outcome;
    expect(typeof outcome === "string" && outcome in ALLOWED_OUTCOMES).toBe(true);
    expect(outcome).toBe("error");
  });

  it("WH-AC18d-duplicate: writer returns duplicate → outcome 'duplicate'", async () => {
    const body = makeEventBody({ type: "customer.subscription.updated", dataObject: { id: "sub_test001" } });
    const deps = fakeDeps({
      stripe: {
        retrieveSubscription: vi.fn().mockResolvedValue({
          ok: true,
          data: validStripeSubscription({ status: "canceled" }), // non-entitling → no dup check
        }),
      },
      rpc: { syncSubscription: vi.fn().mockResolvedValue({ outcome: "duplicate", paused: 0 }) },
    });
    await handleStripeWebhook(makeRequest(body), deps);
    const logObj = parseLog(deps);
    const outcome = logObj.outcome;
    expect(typeof outcome === "string" && outcome in ALLOWED_OUTCOMES).toBe(true);
    expect(outcome).toBe("duplicate");
  });

  it("WH-AC18d-stale: writer returns stale → outcome 'stale'", async () => {
    const body = makeEventBody({ type: "customer.subscription.updated", dataObject: { id: "sub_test001" } });
    const deps = fakeDeps({
      stripe: {
        retrieveSubscription: vi.fn().mockResolvedValue({
          ok: true,
          data: validStripeSubscription({ status: "canceled" }),
        }),
      },
      rpc: { syncSubscription: vi.fn().mockResolvedValue({ outcome: "stale", paused: 0 }) },
    });
    await handleStripeWebhook(makeRequest(body), deps);
    const logObj = parseLog(deps);
    const outcome = logObj.outcome;
    expect(typeof outcome === "string" && outcome in ALLOWED_OUTCOMES).toBe(true);
    expect(outcome).toBe("stale");
  });

  it("WH-AC18d-dup-sub-canceled: duplicate-subscription canceled → outcome 'duplicate_subscription_canceled'", async () => {
    const dupId = "sub_dup18d";
    const keeperId = "sub_keep18d";
    const userId = "00000000-0000-0000-0000-000000000001";
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: dupId } });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => ({
        ok: true,
        data: validStripeSubscription({
          id,
          status: "active",
          created: id === dupId ? 1_700_001_000 : 1_700_000_000,
          metadata: { kind: "monitor_subscription", user_id: userId },
          latest_invoice: null,
        }),
      })),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([keeperId]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    await handleStripeWebhook(makeRequest(body), deps);
    const logObj = parseLog(deps);
    const outcome = logObj.outcome;
    expect(typeof outcome === "string" && outcome in ALLOWED_OUTCOMES).toBe(true);
    expect(outcome).toBe("duplicate_subscription_canceled");
  });

  it("WH-AC18d-dup-invoice-refunded: invoice.paid for marked canceled sub → outcome 'duplicate_invoice_refunded' (A25)", async () => {
    const subId = "sub_dup18ir";
    const invId = "in_dup18ir";
    const body = makeEventBody({
      type: "invoice.paid",
      dataObject: validStripeInvoice({
        id: invId,
        parent: { type: "subscription_details", subscription_details: { subscription: subId } },
        status_transitions: { paid_at: 1_700_000_001 },
      }),
    });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockResolvedValue({
        ok: true,
        data: validStripeSubscription({
          id: subId,
          status: "canceled",
          metadata: { kind: "monitor_subscription", user_id: "00000000-0000-0000-0000-000000000001", duplicate_subscription: "true" },
        }),
      }),
      listInvoicePayments: vi.fn().mockResolvedValue({
        ok: true,
        data: { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: "pi_dup18ir" }, amount_paid: 9500 }] },
      }),
      createRefund: vi.fn().mockResolvedValue({ ok: true, data: { id: "re_dup18ir" } }),
    });
    const deps = { ...fakeDeps(), stripe };
    await handleStripeWebhook(makeRequest(body), deps);
    const logObj = parseLog(deps);
    const outcome = logObj.outcome;
    expect(typeof outcome === "string" && outcome in ALLOWED_OUTCOMES).toBe(true);
    expect(outcome).toBe("duplicate_invoice_refunded");
  });
});

// ── WH-AC19a: idempotency — same event twice ──────────────────────────────────

describe("WH-AC19a: same event id twice → second outcome duplicate; no extra dup-subscription check for non-entitling", () => {
  it("WH-AC19a: writer returns duplicate; non-entitling sub → no cancel/refund/otherEntitling", async () => {
    const body = makeEventBody({ type: "customer.subscription.updated", dataObject: { id: "sub_test001" } });
    const deps = fakeDeps({
      stripe: {
        retrieveSubscription: vi.fn().mockResolvedValue({
          ok: true,
          data: validStripeSubscription({ status: "canceled" }),
        }),
      },
      rpc: { syncSubscription: vi.fn().mockResolvedValue({ outcome: "duplicate", paused: 0 }) },
    });
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expectNoCollaboratorCalls(deps, { allow: ["retrieveSubscription", "syncSubscription"] });
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.updated",
      outcome: "duplicate",
      code: null,
      paused: 0,
    });
  });
});

// ── WH-AC20: duplicate subscription cancellation ─────────────────────────────

describe("WH-AC20a..b: duplicate subscription → keeper preserved, duplicate refunded then canceled", () => {
  it("WH-AC20a..b: older sub is keeper, newer is refunded (refund first) then canceled", async () => {
    const keeperId = "sub_keeper001";
    const dupId = "sub_dup002";
    const userId = "00000000-0000-0000-0000-000000000001";
    const piId = "pi_dupp001";
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: dupId } });

    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => {
        if (id === dupId) {
          return {
            ok: true,
            data: validStripeSubscription({
              id: dupId, status: "active", created: 1_700_001_000,
              metadata: { kind: "monitor_subscription", user_id: userId },
              latest_invoice: "in_dup001",
            }),
          };
        }
        return {
          ok: true,
          data: validStripeSubscription({
            id: keeperId, status: "active", created: 1_700_000_000,
            metadata: { kind: "monitor_subscription", user_id: userId },
            latest_invoice: null,
          }),
        };
      }),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { id: dupId, status: "canceled" } }),
      listInvoicePayments: vi.fn().mockResolvedValue({
        ok: true,
        data: { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: piId }, amount_paid: 9500 }] },
      }),
      createRefund: vi.fn().mockResolvedValue({ ok: true, data: { id: "re_dup001" } }),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([keeperId]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(stripe.cancelSubscription).toHaveBeenCalledWith(dupId);
    expect(stripe.createRefund).toHaveBeenCalledWith(piId, dupId, 9500);
    expect(stripe.cancelSubscription).not.toHaveBeenCalledWith(keeperId);
    expect(stripe.createRefund).not.toHaveBeenCalledWith(expect.anything(), keeperId, expect.anything());
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.created",
      outcome: "duplicate_subscription_canceled",
      code: null,
      paused: 0,
    });
  });
});

describe("WH-AC20c: event is for the keeper; duplicate (newer) is canceled; keeper untouched", () => {
  it("WH-AC20c: keeper is older → it is NOT canceled or refunded; duplicate IS canceled", async () => {
    const keeperId = "sub_keepreal";
    const dupId = "sub_dupreal";
    const userId = "00000000-0000-0000-0000-000000000001";
    const piId = "pi_dupreal001";
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: keeperId } });

    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => {
        if (id === keeperId) {
          return {
            ok: true,
            data: validStripeSubscription({
              id: keeperId, status: "active", created: 1_700_000_000,
              metadata: { kind: "monitor_subscription", user_id: userId },
              latest_invoice: null,
            }),
          };
        }
        return {
          ok: true,
          data: validStripeSubscription({
            id: dupId, status: "active", created: 1_700_001_000,
            metadata: { kind: "monitor_subscription", user_id: userId },
            latest_invoice: "in_dupreal",
          }),
        };
      }),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
      listInvoicePayments: vi.fn().mockResolvedValue({
        ok: true,
        data: { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: piId }, amount_paid: 9500 }] },
      }),
      createRefund: vi.fn().mockResolvedValue({ ok: true, data: { id: "re_dupreal" } }),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([dupId]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(stripe.cancelSubscription).toHaveBeenCalledExactlyOnceWith(dupId);
    expect(stripe.createRefund).toHaveBeenCalledExactlyOnceWith(piId, dupId, 9500);
    expect(stripe.cancelSubscription).not.toHaveBeenCalledWith(keeperId);
    expect(stripe.createRefund).not.toHaveBeenCalledWith(expect.anything(), keeperId, expect.anything());
  });
});

describe("WH-AC20d: non-entitling sub → no duplicate-subscription check", () => {
  it("WH-AC20d: canceled status (non-entitling) → no cancel, no refund, no otherEntitlingSubscriptionIds", async () => {
    const body = makeEventBody({ type: "customer.subscription.deleted", dataObject: { id: "sub_test001" } });
    const deps = fakeDeps({
      stripe: {
        retrieveSubscription: vi.fn().mockResolvedValue({
          ok: true,
          data: validStripeSubscription({ status: "canceled" }),
        }),
      },
      rpc: { syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }) },
    });
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expectNoCollaboratorCalls(deps, { allow: ["retrieveSubscription", "syncSubscription"] });
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.deleted",
      outcome: "applied",
      code: null,
      paused: 0,
    });
  });
});

describe("WH-AC20e: redelivery where event sub is already canceled → no cancel/refund of other subs", () => {
  it("WH-AC20e: event sub status=canceled (non-entitling); duplicate check does NOT run", async () => {
    const dupId = "sub_cancelrdlv";
    const keeperId = "sub_keeprdlv";
    const userId = "00000000-0000-0000-0000-000000000001";
    const body = makeEventBody({ type: "customer.subscription.updated", dataObject: { id: dupId } });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => {
        if (id === dupId) {
          return { ok: true, data: validStripeSubscription({ id: dupId, status: "canceled", metadata: { kind: "monitor_subscription", user_id: userId } }) };
        }
        return { ok: true, data: validStripeSubscription({ id: keeperId, status: "active", created: 1_700_000_000, metadata: { kind: "monitor_subscription", user_id: userId } }) };
      }),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([keeperId]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    // dupId is non-entitling → duplicate-subscription check does not run.
    expectNoCollaboratorCalls(deps, { allow: ["retrieveSubscription", "syncSubscription"] });
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.updated",
      outcome: "applied",
      code: null,
      paused: 0,
    });
  });
});

describe("WH-AC20f: cancelSubscription 4xx → re-retrieve; already canceled → continue; not canceled → 500", () => {
  it("WH-AC20f1: cancel 4xx, re-retrieve shows canceled → continues (200); re-retrieve was called twice", async () => {
    const dupId = "sub_cancel4xx";
    const keeperId = "sub_keep4xx";
    const userId = "00000000-0000-0000-0000-000000000001";
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: dupId } });

    let dupRetrieveCount = 0;
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => {
        if (id === dupId) {
          dupRetrieveCount++;
          if (dupRetrieveCount === 1) {
            return { ok: true, data: validStripeSubscription({ id: dupId, status: "active", created: 1_700_001_000, metadata: { kind: "monitor_subscription", user_id: userId }, latest_invoice: null }) };
          }
          return { ok: true, data: validStripeSubscription({ id: dupId, status: "canceled", created: 1_700_001_000, metadata: { kind: "monitor_subscription", user_id: userId } }) };
        }
        return { ok: true, data: validStripeSubscription({ id: keeperId, status: "active", created: 1_700_000_000, metadata: { kind: "monitor_subscription", user_id: userId } }) };
      }),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: false, kind: "http", status: 400, code: "subscription_already_canceled" }),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([keeperId]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(dupRetrieveCount).toBe(2); // initial + re-retrieve after 4xx
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.created",
      outcome: "duplicate_subscription_canceled",
      code: null,
      paused: 0,
    });
  });

  it("WH-AC20f2: cancel 4xx, re-retrieve shows NOT canceled → 500", async () => {
    const dupId = "sub_cancel4xxB";
    const keeperId = "sub_keep4xxB";
    const userId = "00000000-0000-0000-0000-000000000001";
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: dupId } });

    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => {
        if (id === dupId) {
          // Always returns active — 4xx cancel + re-retrieve still shows active.
          return { ok: true, data: validStripeSubscription({ id: dupId, status: "active", created: 1_700_001_000, metadata: { kind: "monitor_subscription", user_id: userId }, latest_invoice: null }) };
        }
        return { ok: true, data: validStripeSubscription({ id: keeperId, status: "active", created: 1_700_000_000, metadata: { kind: "monitor_subscription", user_id: userId } }) };
      }),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: false, kind: "http", status: 400, code: "some_other_error" }),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([keeperId]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(500);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.created",
      outcome: "error",
      code: "stripe_http_400",
      paused: null,
    });
  });
});

describe("WH-AC20g: Stripe charge_already_refunded → treated as done, not an error", () => {
  it("WH-AC20g: createRefund returns charge_already_refunded → 200; cancel still called; outcome dup_sub_canceled", async () => {
    const dupId = "sub_alreadyref";
    const keeperId = "sub_keepref";
    const userId = "00000000-0000-0000-0000-000000000001";
    const piId = "pi_alreadyref";
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: dupId } });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => ({
        ok: true,
        data: validStripeSubscription({
          id,
          status: "active",
          created: id === dupId ? 1_700_001_000 : 1_700_000_000,
          metadata: { kind: "monitor_subscription", user_id: userId },
          latest_invoice: id === dupId ? "in_alreadyref" : null,
        }),
      })),
      listInvoicePayments: vi.fn().mockResolvedValue({
        ok: true,
        data: { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: piId }, amount_paid: 9500 }] },
      }),
      createRefund: vi.fn().mockResolvedValue({ ok: false, kind: "http", status: 400, code: "charge_already_refunded" }),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([keeperId]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(stripe.cancelSubscription).toHaveBeenCalledExactlyOnceWith(dupId);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.created",
      outcome: "duplicate_subscription_canceled",
      code: null,
      paused: 0,
    });
  });
});

describe("WH-AC20h: sub.id is passed correctly to cancelSubscription and createRefund", () => {
  it("WH-AC20h: cancelSubscription(dupId); createRefund(piId, dupId)", async () => {
    const dupId = "sub_idempkey";
    const keeperId = "sub_keepkey";
    const userId = "00000000-0000-0000-0000-000000000001";
    const piId = "pi_idempkey001";
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: dupId } });

    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => {
        if (id === dupId) {
          return { ok: true, data: validStripeSubscription({ id: dupId, status: "active", created: 1_700_001_000, metadata: { kind: "monitor_subscription", user_id: userId }, latest_invoice: "in_idempkey" }) };
        }
        return { ok: true, data: validStripeSubscription({ id: keeperId, status: "active", created: 1_700_000_000, metadata: { kind: "monitor_subscription", user_id: userId }, latest_invoice: null }) };
      }),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
      listInvoicePayments: vi.fn().mockResolvedValue({
        ok: true,
        data: { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: piId }, amount_paid: 9500 }] },
      }),
      createRefund: vi.fn().mockResolvedValue({ ok: true, data: { id: "re_idempkey" } }),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([keeperId]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    await handleStripeWebhook(makeRequest(body), deps);
    // The stripe-api layer builds the refund's Idempotency-Key from the ids passed here (the cancel has none, A11).
    expect(stripe.cancelSubscription).toHaveBeenCalledWith(dupId);
    expect(stripe.createRefund).toHaveBeenCalledWith(piId, dupId, 9500);
  });
});

// ── WH-AC20b-order: refund before cancel ─────────────────────────────────────

describe("WH-AC20b-order: the duplicate is refunded before it is canceled", () => {
  const dupId = "sub_orderdup";
  const keeperId = "sub_orderkeep";
  const userId = "00000000-0000-0000-0000-000000000001";
  const piId = "pi_order001";

  function orderStripe(createRefund: StripeApi["createRefund"]): StripeApi {
    return fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => ({
        ok: true,
        data: validStripeSubscription({
          id,
          status: "active",
          created: id === dupId ? 1_700_001_000 : 1_700_000_000,
          metadata: { kind: "monitor_subscription", user_id: userId },
          latest_invoice: id === dupId ? "in_order001" : null,
        }),
      })),
      listInvoicePayments: vi.fn().mockResolvedValue({
        ok: true,
        data: { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: piId }, amount_paid: 9500 }] },
      }),
      createRefund,
    });
  }

  const orderRpc = () =>
    fakeRpc({
      syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([keeperId]),
    });

  it("WH-AC20b-order1: mark runs before createRefund, createRefund runs before cancelSubscription (A19)", async () => {
    const stripe = orderStripe(vi.fn().mockResolvedValue({ ok: true, data: { id: "re_order001" } }));
    const deps = { ...fakeDeps(), stripe, rpc: orderRpc() };
    const resp = await handleStripeWebhook(
      makeRequest(makeEventBody({ type: "customer.subscription.created", dataObject: { id: dupId } })),
      deps,
    );
    expect(resp.status).toBe(200);
    expect(stripe.markDuplicateSubscription).toHaveBeenCalledExactlyOnceWith(dupId);
    expect(stripe.createRefund).toHaveBeenCalledExactlyOnceWith(piId, dupId, 9500);
    expect(stripe.cancelSubscription).toHaveBeenCalledExactlyOnceWith(dupId);
    // assert WHICH retrieve calls were made (dupId first, keeperId second)
    expect(vi.mocked(stripe.retrieveSubscription).mock.calls).toEqual([[dupId], [keeperId]]);
    // A19 order: mark → refund → cancel
    const [markOrd20b] = vi.mocked(stripe.markDuplicateSubscription).mock.invocationCallOrder;
    const [refundOrd20b] = vi.mocked(stripe.createRefund).mock.invocationCallOrder;
    const [cancelOrd20b] = vi.mocked(stripe.cancelSubscription).mock.invocationCallOrder;
    if (markOrd20b === undefined || refundOrd20b === undefined || cancelOrd20b === undefined) throw new Error("expected calls not made");
    expect(markOrd20b).toBeLessThan(refundOrd20b);
    expect(refundOrd20b).toBeLessThan(cancelOrd20b);
  });

  it("WH-AC20b-order2: failed refund → 500; cancelSubscription NOT called", async () => {
    const stripe = orderStripe(vi.fn().mockResolvedValue({ ok: false, kind: "http", status: 500, code: "api_error" }));
    const deps = { ...fakeDeps(), stripe, rpc: orderRpc() };
    const resp = await handleStripeWebhook(
      makeRequest(makeEventBody({ type: "customer.subscription.created", dataObject: { id: dupId } })),
      deps,
    );
    expect(resp.status).toBe(500);
    expect(await resp.json()).toEqual({ error: "unavailable" });
    expect(stripe.cancelSubscription).not.toHaveBeenCalled();
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.created",
      outcome: "error",
      code: "stripe_http_500",
      paused: null,
    });
  });
});

// ── WH-AC20a-replay: duplicate check also runs on duplicate/stale outcomes ────

describe("WH-AC20a-replay: duplicate check also runs when the writer answers duplicate or stale", () => {
  it.each(["duplicate", "stale"] as const)(
    "WH-AC20a-replay: writer outcome '%s' on entitling sub → newer dup refunded + canceled",
    async (writerOutcome) => {
      const dupId = "sub_replaydup";
      const keeperId = "sub_replaykeep";
      const userId = "00000000-0000-0000-0000-000000000001";
      const piId = "pi_replay001";
      const stripe = fakeStripe({
        retrieveSubscription: vi.fn().mockImplementation(async (id: string) => ({
          ok: true,
          data: validStripeSubscription({
            id,
            status: "active",
            created: id === dupId ? 1_700_001_000 : 1_700_000_000,
            metadata: { kind: "monitor_subscription", user_id: userId },
            latest_invoice: id === dupId ? "in_replay001" : null,
          }),
        })),
        listInvoicePayments: vi.fn().mockResolvedValue({
          ok: true,
          data: { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: piId }, amount_paid: 9500 }] },
        }),
      });
      const rpc = fakeRpc({
        syncSubscription: vi.fn().mockResolvedValue({ outcome: writerOutcome, paused: 0 }),
        otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([keeperId]),
      });
      const deps = { ...fakeDeps(), stripe, rpc };

      const resp = await handleStripeWebhook(
        makeRequest(makeEventBody({ type: "customer.subscription.updated", dataObject: { id: dupId } })),
        deps,
      );

      expect(resp.status).toBe(200);
      expect(rpc.otherEntitlingSubscriptionIds).toHaveBeenCalledExactlyOnceWith(userId, dupId);
      expect(stripe.createRefund).toHaveBeenCalledExactlyOnceWith(piId, dupId, 9500);
      expect(stripe.cancelSubscription).toHaveBeenCalledExactlyOnceWith(dupId);
      expect(parseLog(deps)).toEqual({
        msg: "payments webhook",
        event: "evt_test001",
        type: "customer.subscription.updated",
        outcome: "duplicate_subscription_canceled",
        code: null,
        paused: 0,
      });
    },
  );
});

// ── WH-AC21: customer_user_mismatch path ─────────────────────────────────────

describe("WH-AC21a: customer_user_mismatch with other entitling subs → cancelAndRefund", () => {
  it("WH-AC21a: mismatch + others → cancelSubscription(dupId), createRefund(pi, dupId); keeper untouched", async () => {
    const dupId = "sub_mismatchA";
    const keeperId = "sub_keepmatch";
    const userId = "00000000-0000-0000-0000-000000000001";
    const piId = "pi_mismatch001";
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: dupId } });

    const mismatchErr = new PaymentsRpcError("customer_user_mismatch", "22023", 400);
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => ({
        ok: true,
        data: validStripeSubscription({
          id,
          status: "active",
          created: 1_700_000_000,
          metadata: { kind: "monitor_subscription", user_id: userId },
          latest_invoice: id === dupId ? "in_mismatch" : null,
        }),
      })),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
      listInvoicePayments: vi.fn().mockResolvedValue({
        ok: true,
        data: { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: piId }, amount_paid: 9500 }] },
      }),
      createRefund: vi.fn().mockResolvedValue({ ok: true, data: { id: "re_mismatch" } }),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockRejectedValue(mismatchErr),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([keeperId]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(stripe.cancelSubscription).toHaveBeenCalledExactlyOnceWith(dupId);
    expect(stripe.createRefund).toHaveBeenCalledExactlyOnceWith(piId, dupId, 9500);
    expect(stripe.cancelSubscription).not.toHaveBeenCalledWith(keeperId);
    expect(stripe.createRefund).not.toHaveBeenCalledWith(expect.anything(), keeperId, expect.anything());
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.created",
      outcome: "duplicate_subscription_canceled",
      code: null,
      paused: null, // mismatch path: writer threw, so no writer paused value
    });
  });
});

describe("WH-AC21b: customer_user_mismatch with no other entitling subs → cancelAndRefund code unrecordable_refunded (A17)", () => {
  it("WH-AC21b: mismatch + no DB others + entitling → cancelAndRefund; mark called once with dupId; code unrecordable_refunded", async () => {
    const dupId = "sub_mismatchB";
    const userId = "00000000-0000-0000-0000-000000000001";
    const piId = "pi_mismatchB1";
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: dupId } });
    const mismatchErr = new PaymentsRpcError("customer_user_mismatch", "22023", 400);
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockResolvedValue({
        ok: true,
        data: validStripeSubscription({
          id: dupId,
          status: "active",
          created: 1_700_000_000,
          metadata: { kind: "monitor_subscription", user_id: userId },
          latest_invoice: "in_mismatchB",
        }),
      }),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
      listInvoicePayments: vi.fn().mockResolvedValue({
        ok: true,
        data: { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: piId }, amount_paid: 9500 }] },
      }),
      createRefund: vi.fn().mockResolvedValue({ ok: true, data: { id: "re_mismatchB" } }),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockRejectedValue(mismatchErr),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    // A17 / A24d: always cancelAndRefund; mark called with dupId
    expect(stripe.markDuplicateSubscription).toHaveBeenCalledExactlyOnceWith(dupId);
    expect(stripe.cancelSubscription).toHaveBeenCalledExactlyOnceWith(dupId);
    expect(stripe.createRefund).toHaveBeenCalledExactlyOnceWith(piId, dupId, 9500);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.created",
      outcome: "duplicate_subscription_canceled",
      code: "unrecordable_refunded",
      paused: null,
    });
  });
});

// ── WH-AC_A12b: malformed ids → permanent rejection before Stripe calls ────────

describe("WH-AC_A12b-sub: customer.subscription.* with malformed sub id → rejected before Stripe call", () => {
  it.each([
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
  ] as const)("WH-AC_A12b-sub: '%s'; id='sub_has space' → rejected invalid_subscription; no collaborator calls", async (type) => {
    const body = makeEventBody({ type, dataObject: { id: "sub_has space" } });
    const deps = fakeDeps();
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type,
      outcome: "rejected",
      code: "invalid_subscription",
      paused: null,
    });
    expectNoCollaboratorCalls(deps);
  });
});

describe("WH-AC_A12b-inv-parent: invoice.paid with malformed parent subscription id → rejected before getSub", () => {
  it("WH-AC_A12b-inv-parent: parent.subscription='sub_has space' → rejected invalid_invoice; no collaborator calls", async () => {
    const body = makeEventBody({
      type: "invoice.paid",
      dataObject: validStripeInvoice({
        parent: {
          type: "subscription_details",
          subscription_details: { subscription: "sub_has space" },
        },
      }),
    });
    const deps = fakeDeps();
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "invoice.paid",
      outcome: "rejected",
      code: "invalid_invoice",
      paused: null,
    });
    expectNoCollaboratorCalls(deps);
  });
});

describe("WH-AC_A12b-inv-id: invoice.paid with malformed invoice id → rejected invalid_invoice before getSub", () => {
  it("WH-AC_A12b-inv-id: invoice id='in_has space' → rejected invalid_invoice; no collaborator calls", async () => {
    const body = makeEventBody({
      type: "invoice.paid",
      dataObject: validStripeInvoice({ id: "in_has space" }),
    });
    const deps = fakeDeps();
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "invoice.paid",
      outcome: "rejected",
      code: "invalid_invoice",
      paused: null,
    });
    expectNoCollaboratorCalls(deps);
  });
});

describe("WH-AC_A12b-pi: malformed pi_ id from listInvoicePayments → createRefund not called, cancel proceeds", () => {
  it("WH-AC_A12b-pi: payment_intent='pi_has space' → createRefund NOT called; cancel IS called; 200 dup_sub_canceled", async () => {
    const dupId = "sub_dup12d";
    const keeperId = "sub_keep12d";
    const userId = "00000000-0000-0000-0000-000000000001";
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: dupId } });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => ({
        ok: true,
        data: validStripeSubscription({
          id,
          status: "active",
          created: id === dupId ? 1_700_001_000 : 1_700_000_000,
          metadata: { kind: "monitor_subscription", user_id: userId },
          latest_invoice: id === dupId ? "in_dup12d" : null,
        }),
      })),
      listInvoicePayments: vi.fn().mockResolvedValue({
        ok: true,
        data: { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: "pi_has space" }, amount_paid: 9500 }] },
      }),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([keeperId]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(stripe.createRefund).not.toHaveBeenCalled();
    expect(stripe.cancelSubscription).toHaveBeenCalledExactlyOnceWith(dupId);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.created",
      outcome: "duplicate_subscription_canceled",
      code: null,
      paused: 0,
    });
  });
});

// ── WH-AC_A15: re-retrieve failure code is from the re-retrieve, not the cancel ──

describe("WH-AC_A15: re-retrieve failure after refused cancel → code from re-retrieve", () => {
  it("WH-AC_A15: cancel 4xx → re-retrieve network failure → 500; log code='stripe_network'", async () => {
    // A15: when re-retrieve fails, the log code reflects the re-retrieve failure, not the cancel's.
    const dupId = "sub_a15dup";
    const keeperId = "sub_a15keep";
    const userId = "00000000-0000-0000-0000-000000000001";
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: dupId } });

    let dupRetrieveCount = 0;
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => {
        if (id === dupId) {
          dupRetrieveCount++;
          if (dupRetrieveCount === 1) {
            return { ok: true, data: validStripeSubscription({ id: dupId, status: "active", created: 1_700_001_000, metadata: { kind: "monitor_subscription", user_id: userId }, latest_invoice: null }) };
          }
          // Re-retrieve after 4xx cancel: network failure.
          return { ok: false, kind: "network" as const };
        }
        return { ok: true, data: validStripeSubscription({ id: keeperId, status: "active", created: 1_700_000_000, metadata: { kind: "monitor_subscription", user_id: userId } }) };
      }),
      cancelSubscription: vi.fn().mockResolvedValue({
        ok: false, kind: "http" as const, status: 400, code: "some_cancel_error",
      }),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([keeperId]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(500);
    // A15: code must be from the re-retrieve's failure, not the cancel's.
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.created",
      outcome: "error",
      code: "stripe_network",
      paused: null,
    });
  });
});

// ── WH-AC_A12e: latest_invoice is validated on the duplicate path only ───────

describe("WH-AC_A12e: latest_invoice malformed or null → sync proceeds (validated only on dup path per A16)", () => {
  it.each<[label: string, latest: unknown, why: string]>([
    ["null", null, "latest_invoice null is not malformed — no invoice is fine"],
    ["string malformed", "in_has space", "malformed latest_invoice not on dup path → sync still runs"],
    ["expanded malformed", { id: "in_has space" }, "expanded malformed latest_invoice → sync still runs"],
    ["wrong prefix", "sub_test001", "wrong-prefix latest_invoice → sync still runs"],
  ])("WH-AC_A12e: latest_invoice %s → synced; fakeRpc returns no other subs so dup path skipped", async (_label, latest) => {
    // A16: latest_invoice is checked only inside cancelAndRefund (dup path).
    // With no other entitling subs the dup path never runs → latest_invoice is irrelevant.
    const body = makeEventBody({ type: "customer.subscription.updated", dataObject: { id: "sub_test001" } });
    const deps = fakeDeps({
      stripe: {
        retrieveSubscription: vi.fn().mockResolvedValue({ ok: true, data: validStripeSubscription({ latest_invoice: latest }) }),
      },
      rpc: { syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }) },
    });
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(deps.rpc.syncSubscription).toHaveBeenCalledOnce();
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.updated",
      outcome: "applied",
      code: null,
      paused: 0,
    });
  });
});

describe("WH-AC_A12f: a malformed id listed by the database is never sent to Stripe", () => {
  it("WH-AC_A12f: other id 'sub_e2e_x-1' → not retrieved, not canceled; outcome applied (200)", async () => {
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: "sub_test001" } });
    const deps = fakeDeps({ rpc: { otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue(["sub_e2e_x-1"]) } });
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.created",
      outcome: "applied",
      code: null,
      paused: 0,
    });
    // The duplicate rule ran (entitling sub with a metadata user), so the skip is what kept the id from Stripe.
    expect(deps.rpc.otherEntitlingSubscriptionIds).toHaveBeenCalledOnce();
    expect(deps.stripe.retrieveSubscription).toHaveBeenCalledOnce();
    expect(deps.stripe.retrieveSubscription).toHaveBeenCalledWith("sub_test001");
    expect(deps.stripe.cancelSubscription).not.toHaveBeenCalled();
    expect(deps.stripe.listInvoicePayments).not.toHaveBeenCalled();
    expect(deps.stripe.createRefund).not.toHaveBeenCalled();
  });
});

describe("WH-AC_A12g: an event id that fails ^evt_[A-Za-z0-9]+$ → 400 invalid_event", () => {
  it("WH-AC_A12g: id 'evt_has space' → 400 invalid_event; no collaborator calls", async () => {
    const deps = fakeDeps();
    const resp = await handleStripeWebhook(makeRequest(makeEventBody({ id: "evt_has space" })), deps);
    expect(resp.status).toBe(400);
    expect(await resp.json()).toEqual({ error: "invalid_event" });
    expectNoCollaboratorCalls(deps);
  });
});

// ── WH-AC20i-s, WH-AC21c, WH-AC12c: duplicate-rule branch coverage ──────────

describe("WH-AC20i: keeper tie-break — equal created → smaller id lexicographically kept", () => {
  const userId = "00000000-0000-0000-0000-000000000001";
  const sameCreated = 1_700_000_000;

  it.each([
    { eventId: "sub_zzzz0001", otherId: "sub_aaaa0001", label: "event=larger id → event sub is duplicate" },
    { eventId: "sub_aaaa0001", otherId: "sub_zzzz0001", label: "event=smaller id → other sub is duplicate" },
  ])("WH-AC20i: $label", async ({ eventId, otherId }) => {
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: eventId } });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => ({
        ok: true,
        data: validStripeSubscription({ id, status: "active", created: sameCreated, metadata: { kind: "monitor_subscription", user_id: userId }, latest_invoice: null }),
      })),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([otherId]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    const [expectedDup] = [eventId, otherId].sort().reverse();
    const [expectedKeeper] = [eventId, otherId].sort();
    if (expectedDup === undefined || expectedKeeper === undefined) throw new Error("sort produced no element");
    expect(stripe.cancelSubscription).toHaveBeenCalledExactlyOnceWith(expectedDup);
    expect(stripe.cancelSubscription).not.toHaveBeenCalledWith(expectedKeeper);
    expect(parseLog(deps)).toEqual({ msg: "payments webhook", event: "evt_test001", type: "customer.subscription.created", outcome: "duplicate_subscription_canceled", code: null, paused: 0 });
  });
});

describe("WH-AC20j: DB-listed other sub returns 404 from Stripe → skipped, outcome applied", () => {
  it("WH-AC20j: other id retrieve 404 → skipped; event sub applied; no cancel or refund", async () => {
    const eventSubId = "sub_evtsub01";
    const otherId = "sub_other404";
    const userId = "00000000-0000-0000-0000-000000000001";
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: eventSubId } });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => {
        if (id === eventSubId) return { ok: true, data: validStripeSubscription({ id: eventSubId, status: "active", created: 1_700_000_000, metadata: { kind: "monitor_subscription", user_id: userId }, latest_invoice: null }) };
        return { ok: false, kind: "http" as const, status: 404, code: "resource_missing" };
      }),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([otherId]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expectNoCollaboratorCalls(deps, { allow: ["retrieveSubscription", "syncSubscription", "otherEntitlingSubscriptionIds"] });
    expect(parseLog(deps)).toEqual({ msg: "payments webhook", event: "evt_test001", type: "customer.subscription.created", outcome: "applied", code: null, paused: 0 });
  });
});

describe("WH-AC20k: DB-listed other sub is non-entitling in Stripe → skipped", () => {
  it("WH-AC20k: other sub status=canceled → skipped; no cancel or refund", async () => {
    const eventSubId = "sub_evtsub02";
    const otherId = "sub_othercxl";
    const userId = "00000000-0000-0000-0000-000000000001";
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: eventSubId } });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => ({
        ok: true,
        data: validStripeSubscription({ id, status: id === eventSubId ? "active" : "canceled", created: 1_700_000_000, metadata: { kind: "monitor_subscription", user_id: userId }, latest_invoice: null }),
      })),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([otherId]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expectNoCollaboratorCalls(deps, { allow: ["retrieveSubscription", "syncSubscription", "otherEntitlingSubscriptionIds"] });
    expect(parseLog(deps)).toEqual({ msg: "payments webhook", event: "evt_test001", type: "customer.subscription.created", outcome: "applied", code: null, paused: 0 });
  });
});

describe("WH-AC20l: DB-listed other sub returns a different id from Stripe → skipped", () => {
  it("WH-AC20l: retrieve returns id mismatch → skipped; no cancel", async () => {
    const eventSubId = "sub_evtsub03";
    const otherId = "sub_othermis";
    const userId = "00000000-0000-0000-0000-000000000001";
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: eventSubId } });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => ({
        ok: true,
        data: validStripeSubscription({ id: id === eventSubId ? eventSubId : "sub_differentid", status: "active", created: 1_700_000_000, metadata: { kind: "monitor_subscription", user_id: userId }, latest_invoice: null }),
      })),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([otherId]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expectNoCollaboratorCalls(deps, { allow: ["retrieveSubscription", "syncSubscription", "otherEntitlingSubscriptionIds"] });
    expect(parseLog(deps)).toEqual({ msg: "payments webhook", event: "evt_test001", type: "customer.subscription.created", outcome: "applied", code: null, paused: 0 });
  });
});

describe("WH-AC20m: otherEntitlingSubscriptionIds throws on duplicate path → 500", () => {
  it("WH-AC20m: entitling sub; otherEntitling throws → 500 rpc code", async () => {
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: "sub_test001" } });
    const rpcErr = new PaymentsRpcError("rpc_failed", "http_503", 503);
    const deps = fakeDeps({
      rpc: {
        syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
        otherEntitlingSubscriptionIds: vi.fn().mockRejectedValue(rpcErr),
      },
    });
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(500);
    expect(parseLog(deps)).toEqual({ msg: "payments webhook", event: "evt_test001", type: "customer.subscription.created", outcome: "error", code: "rpc_http_503_503", paused: null });
  });
});

describe("WH-AC21c: otherEntitlingSubscriptionIds throws on mismatch path → 500", () => {
  it("WH-AC21c: customer_user_mismatch; otherEntitling throws → 500", async () => {
    const dupId = "sub_mismatchC";
    const userId = "00000000-0000-0000-0000-000000000001";
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: dupId } });
    const mismatchErr = new PaymentsRpcError("customer_user_mismatch", "22023", 400);
    const rpcErr = new PaymentsRpcError("rpc_failed", "http_503", 503);
    const deps = fakeDeps({
      stripe: {
        retrieveSubscription: vi.fn().mockResolvedValue({
          ok: true,
          data: validStripeSubscription({ id: dupId, status: "active", metadata: { kind: "monitor_subscription", user_id: userId } }),
        }),
      },
      rpc: {
        syncSubscription: vi.fn().mockRejectedValue(mismatchErr),
        otherEntitlingSubscriptionIds: vi.fn().mockRejectedValue(rpcErr),
      },
    });
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(500);
    expect(parseLog(deps)).toEqual({ msg: "payments webhook", event: "evt_test001", type: "customer.subscription.created", outcome: "error", code: "rpc_http_503_503", paused: null });
  });
});

describe("WH-AC20n: listInvoicePayments network or HTTP 5xx failure → 500", () => {
  it.each([
    { label: "network", result: { ok: false as const, kind: "network" as const }, expectedCode: "stripe_network" },
    { label: "stripe_http_503", result: { ok: false as const, kind: "http" as const, status: 503, code: null }, expectedCode: "stripe_http_503" },
  ])("WH-AC20n: listInvoicePayments $label → 500; log code='$expectedCode'", async ({ result, expectedCode }) => {
    const dupId = "sub_lidup01";
    const keeperId = "sub_likeep01";
    const userId = "00000000-0000-0000-0000-000000000001";
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: dupId } });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => ({
        ok: true,
        data: validStripeSubscription({ id, status: "active", created: id === dupId ? 1_700_001_000 : 1_700_000_000, metadata: { kind: "monitor_subscription", user_id: userId }, latest_invoice: id === dupId ? "in_lidup01" : null }),
      })),
      listInvoicePayments: vi.fn().mockResolvedValue(result),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([keeperId]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(500);
    expect(parseLog(deps)).toEqual({ msg: "payments webhook", event: "evt_test001", type: "customer.subscription.created", outcome: "error", code: expectedCode, paused: null });
  });
});

describe("WH-AC20o: listInvoicePayments non-array data → stripe_invalid_response 500", () => {
  it("WH-AC20o: data.data is a string → 500 stripe_invalid_response", async () => {
    const dupId = "sub_lidup02";
    const keeperId = "sub_likeep02";
    const userId = "00000000-0000-0000-0000-000000000001";
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: dupId } });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => ({
        ok: true,
        data: validStripeSubscription({ id, status: "active", created: id === dupId ? 1_700_001_000 : 1_700_000_000, metadata: { kind: "monitor_subscription", user_id: userId }, latest_invoice: id === dupId ? "in_lidup02" : null }),
      })),
      listInvoicePayments: vi.fn().mockResolvedValue({ ok: true, data: { data: "not-an-array" } }),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([keeperId]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(500);
    expect(parseLog(deps)).toEqual({ msg: "payments webhook", event: "evt_test001", type: "customer.subscription.created", outcome: "error", code: "stripe_invalid_response", paused: null });
  });
});

describe("WH-AC20q: payments with type!='payment_intent' are skipped — no refund", () => {
  it("WH-AC20q: payment type=bank_transfer → skipped; cancel runs; outcome dup_sub_canceled", async () => {
    const dupId = "sub_skipbt01";
    const keeperId = "sub_keepbt01";
    const userId = "00000000-0000-0000-0000-000000000001";
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: dupId } });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => ({
        ok: true,
        data: validStripeSubscription({ id, status: "active", created: id === dupId ? 1_700_001_000 : 1_700_000_000, metadata: { kind: "monitor_subscription", user_id: userId }, latest_invoice: id === dupId ? "in_skipbt01" : null }),
      })),
      listInvoicePayments: vi.fn().mockResolvedValue({ ok: true, data: { data: [{ status: "paid", payment: { type: "bank_transfer", bank_transfer: "bt_x1" }, amount_paid: 9500 }] } }),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([keeperId]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(stripe.createRefund).not.toHaveBeenCalled();
    expect(stripe.cancelSubscription).toHaveBeenCalledExactlyOnceWith(dupId);
    expect(parseLog(deps)).toEqual({ msg: "payments webhook", event: "evt_test001", type: "customer.subscription.created", outcome: "duplicate_subscription_canceled", code: null, paused: 0 });
  });
});

describe("WH-AC20r: cancel network/5xx → 500 without re-retrieve", () => {
  it.each([
    { label: "network", cancelResult: { ok: false as const, kind: "network" as const }, expectedCode: "stripe_network" },
    { label: "5xx http", cancelResult: { ok: false as const, kind: "http" as const, status: 503, code: null }, expectedCode: "stripe_http_503" },
  ])("WH-AC20r: cancel $label → 500; no re-retrieve after non-4xx cancel", async ({ cancelResult, expectedCode }) => {
    const dupId = "sub_cxlnet01";
    const keeperId = "sub_keepnet01";
    const userId = "00000000-0000-0000-0000-000000000001";
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: dupId } });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => ({
        ok: true,
        data: validStripeSubscription({ id, status: "active", created: id === dupId ? 1_700_001_000 : 1_700_000_000, metadata: { kind: "monitor_subscription", user_id: userId }, latest_invoice: null }),
      })),
      cancelSubscription: vi.fn().mockResolvedValue(cancelResult),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([keeperId]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(500);
    // No re-retrieve: initial retrieve(dupId) + retrieve(keeperId) = 2 total; no third call
    expect(vi.mocked(stripe.retrieveSubscription)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(stripe.retrieveSubscription)).toHaveBeenNthCalledWith(1, dupId);
    expect(vi.mocked(stripe.retrieveSubscription)).toHaveBeenNthCalledWith(2, keeperId);
    expect(parseLog(deps)).toEqual({ msg: "payments webhook", event: "evt_test001", type: "customer.subscription.created", outcome: "error", code: expectedCode, paused: null });
  });
});

describe("WH-AC20s: expanded latest_invoice → its .id used for listInvoicePayments", () => {
  it("WH-AC20s: latest_invoice={id:'in_exp01'} → listInvoicePayments('in_exp01')", async () => {
    const dupId = "sub_expinv01";
    const keeperId = "sub_keepexp01";
    const userId = "00000000-0000-0000-0000-000000000001";
    const piId = "pi_expinv01";
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: dupId } });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => ({
        ok: true,
        data: validStripeSubscription({ id, status: "active", created: id === dupId ? 1_700_001_000 : 1_700_000_000, metadata: { kind: "monitor_subscription", user_id: userId }, latest_invoice: id === dupId ? { id: "in_exp01" } : null }),
      })),
      listInvoicePayments: vi.fn().mockResolvedValue({ ok: true, data: { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: piId }, amount_paid: 9500 }] } }),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
      createRefund: vi.fn().mockResolvedValue({ ok: true, data: { id: "re_expinv01" } }),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([keeperId]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(stripe.listInvoicePayments).toHaveBeenCalledExactlyOnceWith("in_exp01");
    expect(stripe.createRefund).toHaveBeenCalledExactlyOnceWith(piId, dupId, 9500);
    expect(parseLog(deps)).toEqual({ msg: "payments webhook", event: "evt_test001", type: "customer.subscription.created", outcome: "duplicate_subscription_canceled", code: null, paused: 0 });
  });
});

describe("WH-AC12c: retrieved subscription normalizes to null → 200 rejected invalid_subscription", () => {
  it("WH-AC12c: retrieveSubscription returns id='bad id!' → normalizeSubscription null → rejected", async () => {
    const body = makeEventBody({ type: "customer.subscription.updated", dataObject: { id: "sub_test001" } });
    const deps = fakeDeps({
      stripe: {
        retrieveSubscription: vi.fn().mockResolvedValue({
          ok: true,
          data: { id: "bad id!", customer: "cus_test001", status: "active", cancel_at_period_end: false, created: 1_700_000_000, items: { data: [{ price: { id: "price_x" }, current_period_end: 1_732_000_000 }] }, metadata: {} },
        }),
      },
    });
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(deps.stripe.retrieveSubscription).toHaveBeenCalledExactlyOnceWith("sub_test001");
    expectNoCollaboratorCalls(deps, { allow: ["retrieveSubscription"] });
    expect(parseLog(deps)).toEqual({ msg: "payments webhook", event: "evt_test001", type: "customer.subscription.updated", outcome: "rejected", code: "invalid_subscription", paused: null });
  });
});

// ── WH-AC_A16: latest_invoice validation on the dup/mismatch paths ─────────────

describe("WH-AC_A16a: non-entitling customer.subscription.deleted with malformed latest_invoice still syncs", () => {
  it("WH-AC_A16a: status=canceled, latest_invoice malformed → writer called, outcome applied", async () => {
    // A16: latest_invoice is validated ONLY on the duplicate path; non-entitling → no dup path → syncs fine.
    const body = makeEventBody({ type: "customer.subscription.deleted", dataObject: { id: "sub_test001" } });
    const deps = fakeDeps({
      stripe: {
        retrieveSubscription: vi.fn().mockResolvedValue({
          ok: true,
          data: validStripeSubscription({ status: "canceled", latest_invoice: "in_has space" }),
        }),
      },
      rpc: { syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 2 }) },
    });
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(deps.rpc.syncSubscription).toHaveBeenCalledOnce();
    expectNoCollaboratorCalls(deps, { allow: ["retrieveSubscription", "syncSubscription"] });
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.deleted",
      outcome: "applied",
      code: null,
      paused: 2,
    });
  });
});

describe("WH-AC_A16b: entitling dup candidate with malformed latest_invoice → rejected invalid_subscription 200", () => {
  it("WH-AC_A16b: dup has latest_invoice='in_has space' → writer called first, then rejected; no mark, no cancel, no refund", async () => {
    // A16: the write commits first; then cancelAndRefund rejects because of the malformed invoice.
    // paused:1 (non-zero) proves the writer's paused value flows through, distinguishing
    // "writer ran" from "rejected before write" (which would leave paused:null).
    const dupId = "sub_a16dupB";
    const keeperId = "sub_a16keepB";
    const userId = "00000000-0000-0000-0000-000000000001";
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: dupId } });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => ({
        ok: true,
        data: validStripeSubscription({
          id,
          status: "active",
          created: id === dupId ? 1_700_001_000 : 1_700_000_000,
          metadata: { kind: "monitor_subscription", user_id: userId },
          latest_invoice: id === dupId ? "in_has space" : null,
        }),
      })),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 1 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([keeperId]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(rpc.syncSubscription).toHaveBeenCalledOnce();
    expect(rpc.otherEntitlingSubscriptionIds).toHaveBeenCalledOnce();
    expectNoCollaboratorCalls(deps, { allow: ["retrieveSubscription", "syncSubscription", "otherEntitlingSubscriptionIds"] });
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.created",
      outcome: "rejected",
      code: "invalid_subscription",
      paused: 1,
    });
  });
});

describe("WH-AC_A16c: dup with absent/null latest_invoice → cancel without refund", () => {
  it.each([
    { label: "null" as const },
    { label: "absent" as const },
  ])(
    "WH-AC_A16c: latest_invoice=$label → cancelSubscription called; listInvoicePayments and createRefund NOT called",
    async ({ label }) => {
      const dupId = "sub_a16dupC";
      const keeperId = "sub_a16keepC";
      const userId = "00000000-0000-0000-0000-000000000001";
      const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: dupId } });
      /** Build the sub fixture; absent case uses omitKey — no cast. */
      const getSubData = (id: string) => {
        const sub = validStripeSubscription({
          id,
          status: "active",
          created: id === dupId ? 1_700_001_000 : 1_700_000_000,
          metadata: { kind: "monitor_subscription", user_id: userId },
          latest_invoice: null,
        });
        return id === dupId && label === "absent" ? omitKey(sub, "latest_invoice") : sub;
      };
      // dupFixture is the exact object the mock returns for dupId — not a separately built copy.
      const dupFixture = getSubData(dupId);
      expect("latest_invoice" in dupFixture).toBe(label === "null");
      if (label === "null") expect(dupFixture).toHaveProperty("latest_invoice", null);
      const stripe = fakeStripe({
        retrieveSubscription: vi.fn().mockImplementation(async (id: string) => ({ ok: true, data: id === dupId ? dupFixture : getSubData(id) })),
        cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
      });
      const rpc = fakeRpc({
        syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
        otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([keeperId]),
      });
      const deps = { ...fakeDeps(), stripe, rpc };
      const resp = await handleStripeWebhook(makeRequest(body), deps);
      expect(resp.status).toBe(200);
      expect(stripe.cancelSubscription).toHaveBeenCalledExactlyOnceWith(dupId);
      expect(stripe.listInvoicePayments).not.toHaveBeenCalled();
      expect(stripe.createRefund).not.toHaveBeenCalled();
      expectNoCollaboratorCalls(deps, { allow: ["retrieveSubscription", "syncSubscription", "otherEntitlingSubscriptionIds", "cancelSubscription", "markDuplicateSubscription"] });
      expect(parseLog(deps)).toEqual({
        msg: "payments webhook",
        event: "evt_test001",
        type: "customer.subscription.created",
        outcome: "duplicate_subscription_canceled",
        code: null,
        paused: 0,
      });
    },
  );
});

describe("WH-AC_A16b-other: a DB-listed duplicate with a malformed latest_invoice is left alone", () => {
  it("WH-AC_A16b-other: newer other has latest_invoice {id:'in_bad-1'} → no list/refund/cancel; rejected invalid_subscription with the writer's paused", async () => {
    const selfId = "sub_a16keepO";
    const otherId = "sub_a16dupO";
    const userId = "00000000-0000-0000-0000-000000000001";
    const body = makeEventBody({ type: "customer.subscription.updated", dataObject: { id: selfId } });
    const deps = fakeDeps({
      stripe: {
        retrieveSubscription: vi.fn().mockImplementation(async (id: string) => ({
          ok: true,
          data: validStripeSubscription({
            id,
            status: "active",
            created: id === selfId ? 1_700_000_000 : 1_700_001_000,
            metadata: { kind: "monitor_subscription", user_id: userId },
            latest_invoice: id === otherId ? { id: "in_bad-1" } : null,
          }),
        })),
      },
      rpc: {
        syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 3 }),
        otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([otherId]),
      },
    });
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(deps.stripe.retrieveSubscription).toHaveBeenCalledTimes(2);
    expect(deps.stripe.retrieveSubscription).toHaveBeenNthCalledWith(2, otherId);
    expect(deps.rpc.syncSubscription).toHaveBeenCalledOnce();
    // A16b-other: malformed candidate must NOT be marked (README: neither marked nor refunded nor canceled)
    expect(deps.stripe.markDuplicateSubscription).not.toHaveBeenCalled();
    expectNoCollaboratorCalls(deps, { allow: ["retrieveSubscription", "syncSubscription", "otherEntitlingSubscriptionIds"] });
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.updated",
      outcome: "rejected",
      code: "invalid_subscription",
      paused: 3,
    });
  });
});

describe("WH-AC_A16b-partial: a malformed duplicate does not stop the other duplicates' cancel", () => {
  it("WH-AC_A16b-partial: keeper self, malformed dup listed first, valid dup second → only the valid dup canceled; rejected invalid_subscription", async () => {
    const selfId = "sub_a16keepP";
    const badDupId = "sub_a16dupP1";
    const validDupId = "sub_a16dupP2";
    const userId = "00000000-0000-0000-0000-000000000001";
    const created: Record<string, number> = { [selfId]: 1_700_000_000, [badDupId]: 1_700_001_000, [validDupId]: 1_700_002_000 };
    const body = makeEventBody({ type: "customer.subscription.updated", dataObject: { id: selfId } });
    const deps = fakeDeps({
      stripe: {
        retrieveSubscription: vi.fn().mockImplementation(async (id: string) => ({
          ok: true,
          data: validStripeSubscription({
            id,
            status: "active",
            created: created[id],
            metadata: { kind: "monitor_subscription", user_id: userId },
            latest_invoice: id === badDupId ? "in_has space" : null,
          }),
        })),
        cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
      },
      rpc: {
        syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
        otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([badDupId, validDupId]),
      },
    });
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    // A16b-partial: valid dup is marked exactly once; malformed dup is not marked
    expect(deps.stripe.markDuplicateSubscription).toHaveBeenCalledExactlyOnceWith(validDupId);
    expect(deps.stripe.cancelSubscription).toHaveBeenCalledExactlyOnceWith(validDupId);
    expectNoCollaboratorCalls(deps, {
      allow: ["retrieveSubscription", "cancelSubscription", "syncSubscription", "otherEntitlingSubscriptionIds", "markDuplicateSubscription"],
    });
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.updated",
      outcome: "rejected",
      code: "invalid_subscription",
      paused: 0,
    });
  });
});

describe("WH-AC_A16b-mismatch: a customer_user_mismatch duplicate with a malformed latest_invoice is left alone", () => {
  it("WH-AC_A16b-mismatch: writer refuses mismatch, other exists, latest_invoice 'sub_test001' → no list/refund/cancel; rejected invalid_subscription, paused null", async () => {
    const dupId = "sub_a16dupM";
    const keeperId = "sub_a16keepM";
    const userId = "00000000-0000-0000-0000-000000000001";
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: dupId } });
    const deps = fakeDeps({
      stripe: {
        retrieveSubscription: vi.fn().mockResolvedValue({
          ok: true,
          data: validStripeSubscription({
            id: dupId,
            status: "active",
            metadata: { kind: "monitor_subscription", user_id: userId },
            latest_invoice: "sub_test001",
          }),
        }),
      },
      rpc: {
        syncSubscription: vi.fn().mockRejectedValue(new PaymentsRpcError("customer_user_mismatch", "22023", 400)),
        otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([keeperId]),
      },
    });
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(deps.stripe.retrieveSubscription).toHaveBeenCalledExactlyOnceWith(dupId);
    expect(deps.rpc.otherEntitlingSubscriptionIds).toHaveBeenCalledExactlyOnceWith(userId, dupId);
    // A16b-mismatch: malformed candidate on mismatch path must not be marked
    expect(deps.stripe.markDuplicateSubscription).not.toHaveBeenCalled();
    expectNoCollaboratorCalls(deps, { allow: ["retrieveSubscription", "syncSubscription", "otherEntitlingSubscriptionIds"] });
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.created",
      outcome: "rejected",
      code: "invalid_subscription",
      paused: null, // mismatch path: the writer refused, so no paused value
    });
  });
});

describe("WH-AC_A16c-keeper: the keeper's latest_invoice is never read", () => {
  it("WH-AC_A16c-keeper: older DB-listed other with a malformed latest_invoice stays the keeper → self (latest null) canceled without refund", async () => {
    const dupId = "sub_a16dupK";
    const keeperId = "sub_a16keepK";
    const userId = "00000000-0000-0000-0000-000000000001";
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: dupId } });
    const deps = fakeDeps({
      stripe: {
        retrieveSubscription: vi.fn().mockImplementation(async (id: string) => ({
          ok: true,
          data: validStripeSubscription({
            id,
            status: "active",
            created: id === dupId ? 1_700_001_000 : 1_700_000_000,
            metadata: { kind: "monitor_subscription", user_id: userId },
            latest_invoice: id === keeperId ? "in_has space" : null,
          }),
        })),
        cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
      },
      rpc: {
        syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
        otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([keeperId]),
      },
    });
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(deps.stripe.cancelSubscription).toHaveBeenCalledExactlyOnceWith(dupId);
    expectNoCollaboratorCalls(deps, {
      allow: ["retrieveSubscription", "cancelSubscription", "syncSubscription", "otherEntitlingSubscriptionIds", "markDuplicateSubscription"],
    });
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.created",
      outcome: "duplicate_subscription_canceled",
      code: null,
      paused: 0,
    });
  });
});

// ── WH-AC_A17: mismatch path enhancements (A17) ───────────────────────────────

describe("WH-AC_A17b: mismatch + entitling + no DB others → cancelAndRefund, code unrecordable_refunded", () => {
  it("WH-AC_A17b: n.user_id present, no DB others → cancelAndRefund; code unrecordable_refunded", async () => {
    const dupId = "sub_a17noOth";
    const userId = "00000000-0000-0000-0000-000000000001";
    const piId = "pi_a17noOth";
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: dupId } });
    const mismatchErr = new PaymentsRpcError("customer_user_mismatch", "22023", 400);
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockResolvedValue({
        ok: true,
        data: validStripeSubscription({
          id: dupId,
          status: "active",
          metadata: { kind: "monitor_subscription", user_id: userId },
          latest_invoice: "in_a17noOth",
        }),
      }),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
      listInvoicePayments: vi.fn().mockResolvedValue({
        ok: true,
        data: { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: piId }, amount_paid: 9500 }] },
      }),
      createRefund: vi.fn().mockResolvedValue({ ok: true, data: { id: "re_a17noOth" } }),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockRejectedValue(mismatchErr),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(stripe.cancelSubscription).toHaveBeenCalledExactlyOnceWith(dupId);
    expect(stripe.createRefund).toHaveBeenCalledExactlyOnceWith(piId, dupId, 9500);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.created",
      outcome: "duplicate_subscription_canceled",
      code: "unrecordable_refunded",
      paused: null,
    });
  });
});

describe("WH-AC_A17a: mismatch + DB others + ≥1 Stripe-live entitling other → code null", () => {
  it("WH-AC_A17a: DB lists one other; retrieved from Stripe as entitling → code null", async () => {
    const dupId = "sub_a17withO";
    const keeperId = "sub_a17keepO";
    const userId = "00000000-0000-0000-0000-000000000001";
    const piId = "pi_a17withO";
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: dupId } });
    const mismatchErr = new PaymentsRpcError("customer_user_mismatch", "22023", 400);
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => ({
        ok: true,
        data: validStripeSubscription({
          id,
          status: "active",
          metadata: { kind: "monitor_subscription", user_id: userId },
          latest_invoice: id === dupId ? "in_a17withO" : null,
        }),
      })),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
      listInvoicePayments: vi.fn().mockResolvedValue({
        ok: true,
        data: { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: piId }, amount_paid: 9500 }] },
      }),
      createRefund: vi.fn().mockResolvedValue({ ok: true, data: { id: "re_a17withO" } }),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockRejectedValue(mismatchErr),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([keeperId]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    // A17 / A24d: mark before refund before cancel; others retrieve before mark
    expect(stripe.markDuplicateSubscription).toHaveBeenCalledExactlyOnceWith(dupId);
    // A24d: assert WHICH retrieve calls were made (dupId first, keeperId second)
    expect(vi.mocked(stripe.retrieveSubscription).mock.calls).toEqual([[dupId], [keeperId]]);
    const retrieveOrders = vi.mocked(stripe.retrieveSubscription).mock.invocationCallOrder;
    const [dbReadOrder] = vi.mocked(rpc.otherEntitlingSubscriptionIds).mock.invocationCallOrder;
    const [markOrder] = vi.mocked(stripe.markDuplicateSubscription).mock.invocationCallOrder;
    const [refundOrder] = vi.mocked(stripe.createRefund).mock.invocationCallOrder;
    const [cancelOrder] = vi.mocked(stripe.cancelSubscription).mock.invocationCallOrder;
    if (dbReadOrder === undefined || markOrder === undefined || refundOrder === undefined || cancelOrder === undefined) throw new Error("expected calls not made");
    const secondRetrieve = retrieveOrders[1];
    if (secondRetrieve === undefined) throw new Error("expected second retrieve not made");
    // DB read precedes the second (keeper) retrieve; retrieve(keeperId) precedes mark
    expect(dbReadOrder).toBeLessThan(secondRetrieve);
    expect(secondRetrieve).toBeLessThan(markOrder);
    expect(markOrder).toBeLessThan(refundOrder);
    expect(refundOrder).toBeLessThan(cancelOrder);
    expect(stripe.cancelSubscription).toHaveBeenCalledExactlyOnceWith(dupId);
    expect(stripe.createRefund).toHaveBeenCalledExactlyOnceWith(piId, dupId, 9500);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.created",
      outcome: "duplicate_subscription_canceled",
      code: null,
      paused: null,
    });
  });
});

describe("WH-AC_A17d: non-entitling n.status + mismatch → rejected customer_user_mismatch (unchanged)", () => {
  it("WH-AC_A17d: status=canceled + mismatch → rejected customer_user_mismatch; no Stripe cancel", async () => {
    const dupId = "sub_a17nonEnt";
    const userId = "00000000-0000-0000-0000-000000000001";
    const body = makeEventBody({ type: "customer.subscription.deleted", dataObject: { id: dupId } });
    const mismatchErr = new PaymentsRpcError("customer_user_mismatch", "22023", 400);
    const deps = fakeDeps({
      stripe: {
        retrieveSubscription: vi.fn().mockResolvedValue({
          ok: true,
          data: validStripeSubscription({ id: dupId, status: "canceled", metadata: { kind: "monitor_subscription", user_id: userId } }),
        }),
      },
      rpc: { syncSubscription: vi.fn().mockRejectedValue(mismatchErr) },
    });
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expectNoCollaboratorCalls(deps, { allow: ["retrieveSubscription", "syncSubscription"] });
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.deleted",
      outcome: "rejected",
      code: "customer_user_mismatch",
      paused: null,
    });
  });
});

describe("WH-AC_A17c: n.user_id null + mismatch + entitling → cancelAndRefund, code unrecordable_refunded", () => {
  it("WH-AC_A17c: user_id null in normalize → no DB query; cancelAndRefund; code unrecordable_refunded", async () => {
    const dupId = "sub_a17nullU";
    const piId = "pi_a17nullU";
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: dupId } });
    const mismatchErr = new PaymentsRpcError("customer_user_mismatch", "22023", 400);
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockResolvedValue({
        ok: true,
        // user_id absent from metadata → normalizeSubscription produces user_id: null
        data: validStripeSubscription({
          id: dupId,
          status: "active",
          metadata: { kind: "monitor_subscription" },
          latest_invoice: "in_a17nullU",
        }),
      }),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
      listInvoicePayments: vi.fn().mockResolvedValue({
        ok: true,
        data: { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: piId }, amount_paid: 9500 }] },
      }),
      createRefund: vi.fn().mockResolvedValue({ ok: true, data: { id: "re_a17nullU" } }),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockRejectedValue(mismatchErr),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    // n.user_id null → no DB query for others; still cancelAndRefund
    expect(rpc.otherEntitlingSubscriptionIds).not.toHaveBeenCalled();
    expect(stripe.cancelSubscription).toHaveBeenCalledExactlyOnceWith(dupId);
    expect(stripe.createRefund).toHaveBeenCalledExactlyOnceWith(piId, dupId, 9500);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.created",
      outcome: "duplicate_subscription_canceled",
      code: "unrecordable_refunded",
      paused: null,
    });
  });
});

describe("WH-AC_A17b-stale: mismatch + DB others + ALL retrieved from Stripe as non-entitling → code unrecordable_refunded (stale DB row)", () => {
  it("WH-AC_A17b-stale: DB lists keeperId but Stripe shows it canceled (stale row) → no live other → code unrecordable_refunded", async () => {
    const dupId = "sub_a17staleD";
    const stalekeepId = "sub_a17staleK";
    const userId = "00000000-0000-0000-0000-000000000001";
    const piId = "pi_a17stale";
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: dupId } });
    const mismatchErr = new PaymentsRpcError("customer_user_mismatch", "22023", 400);
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => ({
        ok: true,
        data: validStripeSubscription({
          id,
          // dupId is entitling; stalekeepId is "canceled" in Stripe (stale DB row)
          status: id === dupId ? "active" : "canceled",
          metadata: { kind: "monitor_subscription", user_id: userId },
          latest_invoice: id === dupId ? "in_a17stale" : null,
        }),
      })),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
      listInvoicePayments: vi.fn().mockResolvedValue({
        ok: true,
        data: { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: piId }, amount_paid: 9500 }] },
      }),
      createRefund: vi.fn().mockResolvedValue({ ok: true, data: { id: "re_a17stale" } }),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockRejectedValue(mismatchErr),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([stalekeepId]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    // stalekeepId retrieved from Stripe as canceled → ignored; no live others → code unrecordable_refunded
    expect(stripe.cancelSubscription).toHaveBeenCalledExactlyOnceWith(dupId);
    expect(stripe.createRefund).toHaveBeenCalledExactlyOnceWith(piId, dupId, 9500);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.created",
      outcome: "duplicate_subscription_canceled",
      code: "unrecordable_refunded",
      paused: null,
    });
  });
});

describe("WH-AC_A21c: handler never retrieves more than PAYMENTS_MAX_DUPLICATE_CANDIDATES others from Stripe (A21)", () => {
  it("WH-AC_A21c: 7 ids returned → only first 5 retrieved in order; 6th and 7th never fetched", async () => {
    // A21: handler must cap at PAYMENTS_MAX_DUPLICATE_CANDIDATES = 5 others.
    // Feed 7: a handler with no cap fetches all 7 (8 total incl. event sub) → test fails.
    const eventSubId = "sub_a21evtX";
    const userId = "00000000-0000-0000-0000-000000000001";
    const otherIds = [
      "sub_a21oth1", "sub_a21oth2", "sub_a21oth3", "sub_a21oth4", "sub_a21oth5",
      "sub_a21oth6", "sub_a21oth7",
    ];
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: eventSubId } });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => ({
        ok: true,
        data: validStripeSubscription({
          id,
          status: "active",
          created: id === eventSubId ? 1_700_010_000 : 1_700_000_000,
          metadata: { kind: "monitor_subscription", user_id: userId },
          latest_invoice: null,
        }),
      })),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue(otherIds),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    // Exact call order: event sub first, then exactly the first 5 others in list order.
    expect(
      vi.mocked(stripe.retrieveSubscription).mock.calls.map(([id]) => id),
    ).toEqual([eventSubId, ...otherIds.slice(0, 5)]);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.created",
      outcome: "duplicate_subscription_canceled",
      code: null,
      paused: 0,
    });
  });
});

// ── WH-AC_A19: duplicate marker (A19) ─────────────────────────────────────────

describe("WH-AC_A19a: markDuplicateSubscription called before refund and cancel (A19)", () => {
  it("WH-AC_A19a: markDuplicateSubscription(dupId) called (Idempotency-Key: WH-AC24h3); order mark→refund→cancel", async () => {
    const dupId = "sub_a19mark";
    const keeperId = "sub_a19keep";
    const userId = "00000000-0000-0000-0000-000000000001";
    const piId = "pi_a19mark";
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: dupId } });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => ({
        ok: true,
        data: validStripeSubscription({
          id,
          status: "active",
          created: id === dupId ? 1_700_001_000 : 1_700_000_000,
          metadata: { kind: "monitor_subscription", user_id: userId },
          latest_invoice: id === dupId ? "in_a19mark" : null,
        }),
      })),
      listInvoicePayments: vi.fn().mockResolvedValue({
        ok: true,
        data: { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: piId }, amount_paid: 9500 }] },
      }),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
      createRefund: vi.fn().mockResolvedValue({ ok: true, data: { id: "re_a19mark" } }),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([keeperId]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    // A19: mark must be called with the dup id
    expect(stripe.markDuplicateSubscription).toHaveBeenCalledExactlyOnceWith(dupId);
    // assert WHICH retrieve calls were made (dupId first, keeperId second)
    expect(vi.mocked(stripe.retrieveSubscription).mock.calls).toEqual([[dupId], [keeperId]]);
    // assert WHICH refund and cancel calls happened
    expect(vi.mocked(stripe.createRefund).mock.calls).toEqual([[piId, dupId, 9500]]);
    expect(vi.mocked(stripe.cancelSubscription).mock.calls).toEqual([[dupId]]);
    // A19 order via invocationCallOrder: mark → refund → cancel
    const [markOrd] = vi.mocked(stripe.markDuplicateSubscription).mock.invocationCallOrder;
    const [refundOrd] = vi.mocked(stripe.createRefund).mock.invocationCallOrder;
    const [cancelOrd] = vi.mocked(stripe.cancelSubscription).mock.invocationCallOrder;
    if (markOrd === undefined || refundOrd === undefined || cancelOrd === undefined) throw new Error("expected calls not made");
    expect(markOrd).toBeLessThan(refundOrd);
    expect(refundOrd).toBeLessThan(cancelOrd);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.created",
      outcome: "duplicate_subscription_canceled",
      code: null,
      paused: 0,
    });
  });
});

describe("WH-AC_A19b: already marked (metadata.duplicate_subscription==='true') → mark step skipped (A19)", () => {
  it("WH-AC_A19b: duplicate_marked: true in normalize → markDuplicateSubscription not called", async () => {
    const dupId = "sub_a19alrdy";
    const keeperId = "sub_a19keepB";
    const userId = "00000000-0000-0000-0000-000000000001";
    const piId = "pi_a19alrdy";
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: dupId } });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => ({
        ok: true,
        data: validStripeSubscription({
          id,
          status: "active",
          created: id === dupId ? 1_700_001_000 : 1_700_000_000,
          metadata: {
            kind: "monitor_subscription",
            user_id: userId,
            ...(id === dupId ? { duplicate_subscription: "true" } : {}),
          },
          latest_invoice: id === dupId ? "in_a19alrdy" : null,
        }),
      })),
      listInvoicePayments: vi.fn().mockResolvedValue({
        ok: true,
        data: { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: piId }, amount_paid: 9500 }] },
      }),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
      createRefund: vi.fn().mockResolvedValue({ ok: true, data: { id: "re_a19alrdy" } }),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([keeperId]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    // A26a: a marked event sub is finished alone: no DB read, the DB-listed keeper is never retrieved
    expect(rpc.otherEntitlingSubscriptionIds).not.toHaveBeenCalled();
    expect(vi.mocked(stripe.retrieveSubscription).mock.calls).toEqual([[dupId]]);
    // A19: mark step skipped because already marked
    expect(stripe.markDuplicateSubscription).not.toHaveBeenCalled();
    expect(stripe.cancelSubscription).toHaveBeenCalledExactlyOnceWith(dupId);
    // A19b: refund clause restored — list latest_invoice, refund paid PI, refund before cancel
    expect(vi.mocked(stripe.listInvoicePayments).mock.calls).toEqual([["in_a19alrdy"]]);
    expect(vi.mocked(stripe.createRefund).mock.calls).toEqual([[piId, dupId, 9500]]);
    const [a19bRefundOrd] = vi.mocked(stripe.createRefund).mock.invocationCallOrder;
    const [a19bCancelOrd] = vi.mocked(stripe.cancelSubscription).mock.invocationCallOrder;
    if (a19bRefundOrd === undefined || a19bCancelOrd === undefined)
      throw new Error("WH-AC_A19b: expected refund and cancel calls");
    expect(a19bRefundOrd).toBeLessThan(a19bCancelOrd);
    // A26a: without the read no kept subscription is known → code unrecordable_refunded
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.created",
      outcome: "duplicate_subscription_canceled",
      code: "unrecordable_refunded",
      paused: 0,
    });
  });
});

describe("WH-AC_A19c: marked+entitling sub is never the keeper — always finished (A19)", () => {
  it("WH-AC_A19c: marked sub has older created but is not the keeper; it is finished instead", async () => {
    // A19: a marked sub can never be the keeper, even if it has older created.
    // A26a: a marked event sub is finished alone, so the keeper choice is pinned at the UNMARKED sub's event.
    const markedId = "sub_a19markC";  // older created but marked → must be finished
    const otherId = "sub_a19othC";    // newer but unmarked → the event sub, kept
    const userId = "00000000-0000-0000-0000-000000000001";
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: otherId } });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => ({
        ok: true,
        data: validStripeSubscription({
          id,
          status: "active",
          // markedId is OLDER (would normally be keeper), but it's marked
          created: id === markedId ? 1_700_000_000 : 1_700_001_000,
          metadata: {
            kind: "monitor_subscription",
            user_id: userId,
            ...(id === markedId ? { duplicate_subscription: "true" } : {}),
          },
          latest_invoice: null,
        }),
      })),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([markedId]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(rpc.otherEntitlingSubscriptionIds).toHaveBeenCalledExactlyOnceWith(userId, otherId);
    expect(vi.mocked(stripe.retrieveSubscription).mock.calls).toEqual([[otherId], [markedId]]);
    // markedId must be finished (cancelSubscription called) even though it was older; the newer unmarked one is kept
    expect(stripe.markDuplicateSubscription).not.toHaveBeenCalled();
    expect(stripe.cancelSubscription).toHaveBeenCalledExactlyOnceWith(markedId);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.created",
      outcome: "duplicate_subscription_canceled",
      code: null,
      paused: 0,
    });
  });
});

describe("WH-AC_A19d: event sub already marked + no DB others → still finished (mark step skipped, A19)", () => {
  it("WH-AC_A19d: event sub marked + entitling + no other DB subs → cancelAndRefund (mark skipped), code unrecordable_refunded", async () => {
    // A19: a marked+entitling sub is finished even when the user has no other subscription.
    const dupId = "sub_a19noOth";
    const userId = "00000000-0000-0000-0000-000000000001";
    const piId = "pi_a19noOth";
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: dupId } });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockResolvedValue({
        ok: true,
        data: validStripeSubscription({
          id: dupId,
          status: "active",
          metadata: { kind: "monitor_subscription", user_id: userId, duplicate_subscription: "true" },
          latest_invoice: "in_a19noOth",
        }),
      }),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
      listInvoicePayments: vi.fn().mockResolvedValue({
        ok: true,
        data: { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: piId }, amount_paid: 9500 }] },
      }),
      createRefund: vi.fn().mockResolvedValue({ ok: true, data: { id: "re_a19noOth" } }),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    // mark step skipped (already marked), cancel+refund still run
    expect(stripe.markDuplicateSubscription).not.toHaveBeenCalled();
    expect(stripe.cancelSubscription).toHaveBeenCalledExactlyOnceWith(dupId);
    expect(stripe.createRefund).toHaveBeenCalledExactlyOnceWith(piId, dupId, 9500);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.created",
      outcome: "duplicate_subscription_canceled",
      code: "unrecordable_refunded",
      paused: 0,
    });
  });
});

// ── WH-AC_A25a: open payments ignored — cancel always runs (A25, replaces A20 pending path) ────

describe("WH-AC_A25a-two-dups-both-canceled: open-payment dup and normal dup both canceled (A25)", () => {
  it("WH-AC_A25a-two-dups-both-canceled: keeper self; [openPayDup, normalDup] → both canceled; open ignored; only normalDup refunded; outcome duplicate_subscription_canceled", async () => {
    // A25: open payments are ignored; openPayDup IS canceled (no refund); normalDup canceled with its paid PI refunded.
    const keeperId = "sub_a25tKeep";
    const openPayDupId = "sub_a25tOpen";
    const normalDupId = "sub_a25tNorm";
    const userId = "00000000-0000-0000-0000-000000000001";
    const normalPiId = "pi_a25tNorm";
    const body = makeEventBody({ type: "customer.subscription.updated", dataObject: { id: keeperId } });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => ({
        ok: true,
        data: validStripeSubscription({
          id,
          status: "active",
          created: id === keeperId ? 1_700_000_000 : id === openPayDupId ? 1_700_001_000 : 1_700_002_000,
          metadata: { kind: "monitor_subscription", user_id: userId },
          latest_invoice: id === normalDupId ? "in_a25tNorm" : (id === openPayDupId ? "in_a25tOpen" : null),
        }),
      })),
      listInvoicePayments: vi.fn().mockImplementation(async (invId: string) => {
        if (invId === "in_a25tOpen") {
          return { ok: true, data: { data: [{ status: "open", payment: { type: "payment_intent", payment_intent: "pi_a25tOpen" }, amount_paid: 0 }] } };
        }
        return { ok: true, data: { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: normalPiId }, amount_paid: 9500 }] } };
      }),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
      createRefund: vi.fn().mockResolvedValue({ ok: true, data: { id: "re_a25tNorm" } }),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([openPayDupId, normalDupId]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    // Both marked (openPayDupId first, normalDupId second per list order)
    expect(vi.mocked(stripe.markDuplicateSubscription).mock.calls).toEqual([[openPayDupId], [normalDupId]]);
    // Only normalDup has a paid PI → only one refund call
    expect(vi.mocked(stripe.createRefund).mock.calls).toEqual([[normalPiId, normalDupId, 9500]]);
    // Both canceled
    expect(vi.mocked(stripe.cancelSubscription).mock.calls).toEqual([[openPayDupId], [normalDupId]]);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.updated",
      outcome: "duplicate_subscription_canceled",
      code: null,
      paused: 0,
    });
  });
});

// ── WH-AC_A22: refund amount validation (A22) ─────────────────────────────────

describe("WH-AC_A22: malformed amount_paid on InvoicePayment → payment skipped; cancel still runs (A22)", () => {
  it.each([
    { label: "non-positive: amount_paid=0", amountPaid: 0, dupId: "sub_a22zero", keeperId: "sub_a22keepZ", piId: "pi_a22zero", invoiceId: "in_a22zero" },
    { label: "non-integer: amount_paid=9.5", amountPaid: 9.5, dupId: "sub_a22float", keeperId: "sub_a22keepF", piId: "pi_a22float", invoiceId: "in_a22float" },
  ])("WH-AC_A22: $label → no refund; cancel still runs", async ({ amountPaid, dupId, keeperId, piId, invoiceId }) => {
    const userId = "00000000-0000-0000-0000-000000000001";
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: dupId } });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => ({
        ok: true,
        data: validStripeSubscription({
          id,
          status: "active",
          created: id === dupId ? 1_700_001_000 : 1_700_000_000,
          metadata: { kind: "monitor_subscription", user_id: userId },
          latest_invoice: id === dupId ? invoiceId : null,
        }),
      })),
      listInvoicePayments: vi.fn().mockResolvedValue({
        ok: true,
        data: { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: piId }, amount_paid: amountPaid }] },
      }),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([keeperId]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(stripe.createRefund).not.toHaveBeenCalled();
    expect(stripe.cancelSubscription).toHaveBeenCalledExactlyOnceWith(dupId);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.created",
      outcome: "duplicate_subscription_canceled",
      code: null,
      paused: 0,
    });
  });
});

// ── WH-AC_A23a: Connect event rejected (A23) ──────────────────────────────────

describe("WH-AC_A23a: event with non-null account → 200 ignored connect_event (A23)", () => {
  it("WH-AC_A23a: event.account = 'acct_conn01' → 200 ignored connect_event; zero collaborator calls", async () => {
    const body = JSON.stringify({
      id: "evt_conn01",
      type: "customer.subscription.created",
      account: "acct_conn01",
      created: 1_700_000_000,
      livemode: false,
      data: { object: { id: "sub_conn01" } },
    });
    const deps = fakeDeps();
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_conn01",
      type: "customer.subscription.created",
      outcome: "ignored",
      code: "connect_event",
      paused: null,
    });
    expectNoCollaboratorCalls(deps);
  });
});

describe("WH-AC_A23a-null: event with account: null → handled like any other event (A23)", () => {
  it("WH-AC_A23a-null: account null → synced; outcome applied", async () => {
    const body = JSON.stringify({
      id: "evt_connnull",
      type: "customer.subscription.updated",
      account: null,
      created: 1_700_000_000,
      livemode: false,
      data: { object: { id: "sub_test001" } },
    });
    const deps = fakeDeps({ stripe: { retrieveSubscription: vi.fn().mockResolvedValue({ ok: true, data: validStripeSubscription({ status: "canceled" }) }) } });
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(deps.rpc.syncSubscription).toHaveBeenCalledOnce();
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_connnull",
      type: "customer.subscription.updated",
      outcome: "applied",
      code: null,
      paused: 0,
    });
  });
});

describe("WH-AC_A19f: a failed mark is transient; nothing else is done for the duplicate (A19)", () => {
  it.each([
    { label: "http 500", mark: { ok: false as const, kind: "http" as const, status: 500, code: "api_error" }, expectedCode: "stripe_http_500" },
    { label: "network", mark: { ok: false as const, kind: "network" as const }, expectedCode: "stripe_network" },
  ])("WH-AC_A19f: markDuplicateSubscription $label → 500 $expectedCode; no list, refund or cancel", async ({ mark, expectedCode }) => {
    const dupId = "sub_a19fdup";
    const keeperId = "sub_a19fkeep";
    const userId = "00000000-0000-0000-0000-000000000001";
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: dupId } });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => ({
        ok: true,
        data: validStripeSubscription({
          id,
          status: "active",
          created: id === dupId ? 1_700_001_000 : 1_700_000_000,
          metadata: { kind: "monitor_subscription", user_id: userId },
          latest_invoice: id === dupId ? "in_a19fdup" : null,
        }),
      })),
      markDuplicateSubscription: vi.fn().mockResolvedValue(mark),
    });
    const rpc = fakeRpc({ otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([keeperId]) });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(500);
    expect(stripe.markDuplicateSubscription).toHaveBeenCalledExactlyOnceWith(dupId);
    expect(stripe.listInvoicePayments).not.toHaveBeenCalled();
    expect(stripe.createRefund).not.toHaveBeenCalled();
    expect(stripe.cancelSubscription).not.toHaveBeenCalled();
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.created",
      outcome: "error",
      code: expectedCode,
      paused: null,
    });
  });
});

describe("WH-AC_A19d-nouser: marked event sub without metadata.user_id → finished without a database read (A19)", () => {
  it("WH-AC_A19d-nouser: user_id null + marked + entitling → no otherEntitling call; canceled; code unrecordable_refunded", async () => {
    const dupId = "sub_a19dnoU";
    const body = makeEventBody({ type: "customer.subscription.updated", dataObject: { id: dupId } });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockResolvedValue({
        ok: true,
        data: validStripeSubscription({
          id: dupId,
          status: "active",
          metadata: { kind: "monitor_subscription", duplicate_subscription: "true" },
          latest_invoice: null,
        }),
      }),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
    });
    const deps = { ...fakeDeps(), stripe };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(deps.rpc.otherEntitlingSubscriptionIds).not.toHaveBeenCalled();
    expect(stripe.markDuplicateSubscription).not.toHaveBeenCalled();
    expect(stripe.cancelSubscription).toHaveBeenCalledExactlyOnceWith(dupId);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.updated",
      outcome: "duplicate_subscription_canceled",
      code: "unrecordable_refunded",
      paused: 0,
    });
  });
});

describe("WH-AC_A17e: mismatch + the only live other is itself marked → code unrecordable_refunded (A17 + A19)", () => {
  it("WH-AC_A17e: other entitling but marked → not counted as kept; self finished; code unrecordable_refunded; other untouched", async () => {
    const dupId = "sub_a17eDup";
    const markedOtherId = "sub_a17eMrk";
    const userId = "00000000-0000-0000-0000-000000000001";
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: dupId } });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => ({
        ok: true,
        data: validStripeSubscription({
          id,
          status: "active",
          metadata: {
            kind: "monitor_subscription",
            user_id: userId,
            ...(id === markedOtherId ? { duplicate_subscription: "true" } : {}),
          },
          latest_invoice: null,
        }),
      })),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockRejectedValue(new PaymentsRpcError("customer_user_mismatch", "22023", 400)),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([markedOtherId]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(stripe.cancelSubscription).toHaveBeenCalledExactlyOnceWith(dupId);
    expect(stripe.markDuplicateSubscription).toHaveBeenCalledExactlyOnceWith(dupId);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.created",
      outcome: "duplicate_subscription_canceled",
      code: "unrecordable_refunded",
      paused: null,
    });
  });
});

describe("WH-AC_A25a-priority: rejected/invalid_subscription outranks canceled in outcome priority (A25)", () => {
  it("WH-AC_A25a-priority: keeper self; open-payment dup (canceled, A25) + malformed dup → rejected invalid_subscription with the writer's paused", async () => {
    // A25: open payments are ignored; openPayDupId DOES get canceled.
    // malformed badId → rejected. Priority: rejected > canceled.
    const keeperId = "sub_a25prKeep";
    const openPayDupId = "sub_a25prPend";
    const badId = "sub_a25prBad";
    const userId = "00000000-0000-0000-0000-000000000001";
    const body = makeEventBody({ type: "customer.subscription.updated", dataObject: { id: keeperId } });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => ({
        ok: true,
        data: validStripeSubscription({
          id,
          status: "active",
          created: id === keeperId ? 1_700_000_000 : 1_700_001_000,
          metadata: { kind: "monitor_subscription", user_id: userId },
          latest_invoice: id === openPayDupId ? "in_a25prPend" : id === badId ? "in_a25pr bad" : null,
        }),
      })),
      listInvoicePayments: vi.fn().mockResolvedValue({
        ok: true,
        data: { data: [{ status: "open", payment: { type: "payment_intent", payment_intent: "pi_a25prPend" }, amount_paid: 0 }] },
      }),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 2 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([openPayDupId, badId]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    // openPayDup: marked then canceled (open payment → no refund)
    expect(vi.mocked(stripe.markDuplicateSubscription).mock.calls).toEqual([[openPayDupId]]);
    expect(vi.mocked(stripe.cancelSubscription).mock.calls).toEqual([[openPayDupId]]);
    expect(vi.mocked(stripe.createRefund).mock.calls).toEqual([]);
    // Priority: rejected > canceled → outcome = rejected
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.updated",
      outcome: "rejected",
      code: "invalid_subscription",
      paused: 2,
    });
  });
});

describe("WH-AC_A25a-paid-open-mix: mixed paid+open payments — only paid PI refunded; cancel still runs (A25)", () => {
  it("WH-AC_A25a-paid-open-mix: payments [paid, open] → only paid PI in mock.calls; open ignored; cancel runs; outcome duplicate_subscription_canceled", async () => {
    const dupId = "sub_a25mixDup";
    const keeperId = "sub_a25mixKeep";
    const userId = "00000000-0000-0000-0000-000000000001";
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: dupId } });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => ({
        ok: true,
        data: validStripeSubscription({
          id,
          status: "active",
          created: id === dupId ? 1_700_001_000 : 1_700_000_000,
          metadata: { kind: "monitor_subscription", user_id: userId },
          latest_invoice: id === dupId ? "in_a25mix" : null,
        }),
      })),
      listInvoicePayments: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          data: [
            { status: "paid", payment: { type: "payment_intent", payment_intent: "pi_a25mixPaid" }, amount_paid: 9500 },
            { status: "open", payment: { type: "payment_intent", payment_intent: "pi_a25mixOpen" }, amount_paid: 0 },
          ],
        },
      }),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
      createRefund: vi.fn().mockResolvedValue({ ok: true, data: { id: "re_a25mix" } }),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([keeperId]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(vi.mocked(stripe.markDuplicateSubscription).mock.calls).toEqual([[dupId]]);
    // Only paid PI in createRefund calls; open one absent
    expect(vi.mocked(stripe.createRefund).mock.calls).toEqual([["pi_a25mixPaid", dupId, 9500]]);
    expect(vi.mocked(stripe.cancelSubscription).mock.calls).toEqual([[dupId]]);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.created",
      outcome: "duplicate_subscription_canceled",
      code: null,
      paused: 0,
    });
  });
});

// ── WH-AC_A24b (superseded by A26a): a marked event sub is finished alone; its marked other waits for its own event ──

describe("WH-AC_A24b: event sub and its only other both marked → only the event sub finished, no DB read; code unrecordable_refunded (A24b, A26a)", () => {
  it("WH-AC_A24b: event sub marked + only other is also marked → event sub finished (mark skipped); other never retrieved; code unrecordable_refunded", async () => {
    // A24b's "every candidate marked → all finished in one delivery" is superseded by A26a: a marked event
    // sub is finished without reading the user's others, so the marked other is finished at its own event.
    const eventId = "sub_a24bEv";
    const otherId = "sub_a24bOth";
    const userId = "00000000-0000-0000-0000-000000000001";
    const piEv = "pi_a24bEv";
    const piOth = "pi_a24bOth";
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: eventId } });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => ({
        ok: true,
        data: validStripeSubscription({
          id,
          status: "active",
          created: id === eventId ? 1_700_001_000 : 1_700_000_000,
          metadata: {
            kind: "monitor_subscription",
            user_id: userId,
            duplicate_subscription: "true",   // both are marked
          },
          latest_invoice: id === eventId ? "in_a24bEv" : "in_a24bOth",
        }),
      })),
      listInvoicePayments: vi.fn().mockImplementation(async (invId: string) => ({
        ok: true,
        data: {
          data: [{
            status: "paid",
            payment: {
              type: "payment_intent",
              payment_intent: invId === "in_a24bEv" ? piEv : piOth,
            },
            amount_paid: 9500,
          }],
        },
      })),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
      createRefund: vi.fn().mockResolvedValue({ ok: true, data: { id: "re_a24b" } }),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([otherId]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    // A26a: the marked event sub is finished alone: no DB read, the marked other is not retrieved
    expect(rpc.otherEntitlingSubscriptionIds).not.toHaveBeenCalled();
    expect(vi.mocked(stripe.retrieveSubscription).mock.calls).toEqual([[eventId]]);
    // mark step skipped (already marked); only the event sub's latest invoice refunded, only it canceled
    expect(stripe.markDuplicateSubscription).not.toHaveBeenCalled();
    expect(vi.mocked(stripe.listInvoicePayments).mock.calls).toEqual([["in_a24bEv"]]);
    expect(vi.mocked(stripe.createRefund).mock.calls).toEqual([[piEv, eventId, 9500]]);
    expect(vi.mocked(stripe.cancelSubscription).mock.calls).toEqual([[eventId]]);
    expectNoCollaboratorCalls(deps, {
      allow: ["retrieveSubscription", "syncSubscription", "listInvoicePayments", "createRefund", "cancelSubscription"],
    });
    // No kept subscription known → code unrecordable_refunded
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.created",
      outcome: "duplicate_subscription_canceled",
      code: "unrecordable_refunded",
      paused: 0,
    });
  });
});

// ── WH-AC_A25: A25 — open payments ignored; marked invoice refund ─────────────

describe("WH-AC_A25a: open payment ignored — cancel still runs; only paid PIs refunded (A25)", () => {
  it("WH-AC_A25a: listInvoicePayments returns only open payment → no refund; cancel runs; outcome duplicate_subscription_canceled", async () => {
    const dupId = "sub_a25aOpen";
    const keeperId = "sub_a25aKeep";
    const userId = "00000000-0000-0000-0000-000000000001";
    const body = makeEventBody({ type: "customer.subscription.created", dataObject: { id: dupId } });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => ({
        ok: true,
        data: validStripeSubscription({
          id,
          status: "active",
          created: id === dupId ? 1_700_001_000 : 1_700_000_000,
          metadata: { kind: "monitor_subscription", user_id: userId },
          latest_invoice: id === dupId ? "in_a25aOpen" : null,
        }),
      })),
      listInvoicePayments: vi.fn().mockResolvedValue({
        ok: true,
        data: { data: [{ status: "open", payment: { type: "payment_intent", payment_intent: "pi_a25aOpen" }, amount_paid: 9500 }] },
      }),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([keeperId]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(stripe.markDuplicateSubscription).toHaveBeenCalledExactlyOnceWith(dupId);
    // Open payment → ignored; no refund
    expect(stripe.createRefund).not.toHaveBeenCalled();
    // Cancel still runs
    expect(stripe.cancelSubscription).toHaveBeenCalledExactlyOnceWith(dupId);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.created",
      outcome: "duplicate_subscription_canceled",
      code: null,
      paused: 0,
    });
  });
});

describe("WH-AC_A25a-only-open: past_due dup with only open payment → no refund; cancel runs (A25)", () => {
  it("WH-AC_A25a-only-open: past_due dup + only open payment → open ignored; canceled; outcome duplicate_subscription_canceled", async () => {
    const dupId = "sub_a25aOop";
    const keeperId = "sub_a25aOkeep";
    const userId = "00000000-0000-0000-0000-000000000001";
    const body = makeEventBody({ type: "customer.subscription.updated", dataObject: { id: dupId } });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => ({
        ok: true,
        data: validStripeSubscription({
          id,
          status: id === dupId ? "past_due" : "active",
          created: id === dupId ? 1_700_001_000 : 1_700_000_000,
          metadata: { kind: "monitor_subscription", user_id: userId },
          latest_invoice: id === dupId ? "in_a25aOop" : null,
        }),
      })),
      listInvoicePayments: vi.fn().mockResolvedValue({
        ok: true,
        data: { data: [{ status: "open", payment: { type: "payment_intent", payment_intent: "pi_a25aOop" }, amount_paid: 7500 }] },
      }),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([keeperId]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(stripe.createRefund).not.toHaveBeenCalled();
    expect(stripe.cancelSubscription).toHaveBeenCalledExactlyOnceWith(dupId);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.updated",
      outcome: "duplicate_subscription_canceled",
      code: null,
      paused: 0,
    });
  });
});

// ── WH-AC_A25b: invoice.paid for a marked subscription (A25) ─────────────────

describe("WH-AC_A25b-nonentitling: invoice.paid for MARKED canceled sub → writer → list → refund paid PIs → outcome duplicate_invoice_refunded (A25)", () => {
  it("WH-AC_A25b-nonentitling: marked canceled sub + invoice.paid → writer called, list THIS invoice, refund paid PIs; code null; paused = writer's", async () => {
    const subId = "sub_a25bcanc";
    const invId = "in_a25bcanc";
    const piId = "pi_a25bcanc";
    const body = makeEventBody({
      type: "invoice.paid",
      dataObject: validStripeInvoice({
        id: invId,
        parent: { type: "subscription_details", subscription_details: { subscription: subId } },
        status_transitions: { paid_at: 1_700_000_001 },
      }),
    });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockResolvedValue({
        ok: true,
        data: validStripeSubscription({
          id: subId,
          status: "canceled",
          metadata: { kind: "monitor_subscription", user_id: "00000000-0000-0000-0000-000000000001", duplicate_subscription: "true" },
          latest_invoice: "in_a25bLast",
        }),
      }),
      listInvoicePayments: vi.fn().mockResolvedValue({
        ok: true,
        data: { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: piId }, amount_paid: 9500 }] },
      }),
      createRefund: vi.fn().mockResolvedValue({ ok: true, data: { id: "re_a25bcanc" } }),
    });
    const rpc = fakeRpc({
      recordSubscriptionInvoice: vi.fn().mockResolvedValue({ outcome: "applied", paused: 3 }),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    // Writer called
    expect(rpc.recordSubscriptionInvoice).toHaveBeenCalledOnce();
    // listInvoicePayments called with THIS event's invoice id
    expect(stripe.listInvoicePayments).toHaveBeenCalledExactlyOnceWith(invId);
    // Refund of the paid PI
    expect(stripe.createRefund).toHaveBeenCalledExactlyOnceWith(piId, subId, 9500);
    // No cancelSubscription (sub already canceled)
    expectNoCollaboratorCalls(deps, {
      allow: ["retrieveSubscription", "recordSubscriptionInvoice", "listInvoicePayments", "createRefund"],
    });
    // Order: writer < list < refund
    const [writerOrder] = vi.mocked(rpc.recordSubscriptionInvoice).mock.invocationCallOrder;
    const [listOrder] = vi.mocked(stripe.listInvoicePayments).mock.invocationCallOrder;
    const [refundOrder] = vi.mocked(stripe.createRefund).mock.invocationCallOrder;
    if (writerOrder === undefined || listOrder === undefined || refundOrder === undefined) throw new Error("expected calls not made");
    expect(writerOrder).toBeLessThan(listOrder);
    expect(listOrder).toBeLessThan(refundOrder);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "invoice.paid",
      outcome: "duplicate_invoice_refunded",
      code: null,
      paused: 3,
    });
  });
});

describe("WH-AC_A25b-mismatch: invoice.paid for MARKED sub with customer_user_mismatch → list THIS invoice → refund paid PIs → duplicate_invoice_refunded, paused null (A25)", () => {
  it("WH-AC_A25b-mismatch: writer throws mismatch; sub is marked → list → refund; outcome duplicate_invoice_refunded, code null, paused null", async () => {
    const subId = "sub_a25bMis";
    const invId = "in_a25bMis";
    const piId = "pi_a25bMis";
    const body = makeEventBody({
      type: "invoice.paid",
      dataObject: validStripeInvoice({
        id: invId,
        parent: { type: "subscription_details", subscription_details: { subscription: subId } },
        status_transitions: { paid_at: 1_700_000_001 },
      }),
    });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockResolvedValue({
        ok: true,
        data: validStripeSubscription({
          id: subId,
          status: "canceled",
          metadata: { kind: "monitor_subscription", user_id: "00000000-0000-0000-0000-000000000001", duplicate_subscription: "true" },
          latest_invoice: "in_a25bMisLast",
        }),
      }),
      listInvoicePayments: vi.fn().mockResolvedValue({
        ok: true,
        data: { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: piId }, amount_paid: 8000 }] },
      }),
      createRefund: vi.fn().mockResolvedValue({ ok: true, data: { id: "re_a25bMis" } }),
    });
    const rpc = fakeRpc({
      recordSubscriptionInvoice: vi.fn().mockRejectedValue(new PaymentsRpcError("customer_user_mismatch", "22023", 400)),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(rpc.recordSubscriptionInvoice).toHaveBeenCalledOnce();
    expect(stripe.listInvoicePayments).toHaveBeenCalledExactlyOnceWith(invId);
    expect(stripe.createRefund).toHaveBeenCalledExactlyOnceWith(piId, subId, 8000);
    expectNoCollaboratorCalls(deps, {
      allow: ["retrieveSubscription", "recordSubscriptionInvoice", "listInvoicePayments", "createRefund"],
    });
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "invoice.paid",
      outcome: "duplicate_invoice_refunded",
      code: null,
      paused: null,
    });
  });
});

describe("WH-AC_A25b-transient-writer: invoice.paid for MARKED sub with transient writer failure → 500; NO list or refund (A25)", () => {
  it("WH-AC_A25b-transient-writer: writer throws transient → 500; listInvoicePayments and createRefund NOT called", async () => {
    const subId = "sub_a25bTrans";
    const invId = "in_a25bTrans";
    const body = makeEventBody({
      type: "invoice.paid",
      dataObject: validStripeInvoice({
        id: invId,
        parent: { type: "subscription_details", subscription_details: { subscription: subId } },
        status_transitions: { paid_at: 1_700_000_001 },
      }),
    });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockResolvedValue({
        ok: true,
        data: validStripeSubscription({
          id: subId,
          status: "canceled",
          metadata: { kind: "monitor_subscription", user_id: "00000000-0000-0000-0000-000000000001", duplicate_subscription: "true" },
          latest_invoice: "in_a25bTransLast",
        }),
      }),
    });
    const rpc = fakeRpc({
      recordSubscriptionInvoice: vi.fn().mockRejectedValue(new PaymentsRpcError("rpc_failed", "http_503", 503)),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(500);
    expect(rpc.recordSubscriptionInvoice).toHaveBeenCalledOnce();
    expectNoCollaboratorCalls(deps, {
      allow: ["retrieveSubscription", "recordSubscriptionInvoice"],
    });
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "invoice.paid",
      outcome: "error",
      code: "rpc_http_503_503",
      paused: null,
    });
  });
});

describe("WH-AC_A25b-entitling: invoice.paid for MARKED entitling sub → normal dup path PLUS refund THIS invoice if ≠ latest; outcome duplicate_subscription_canceled (A25)", () => {
  it("WH-AC_A25b-entitling: marked active sub; event invoice ≠ latest → dup path (refund latest, cancel) + refund this invoice", async () => {
    const subId = "sub_a25bEnt";
    const latestInvId = "in_a25bLast";
    const eventInvId = "in_a25bEv";
    const latestPiId = "pi_a25bLast";
    const eventPiId = "pi_a25bEv";
    const userId = "00000000-0000-0000-0000-000000000001";
    const body = makeEventBody({
      type: "invoice.paid",
      dataObject: validStripeInvoice({
        id: eventInvId,
        parent: { type: "subscription_details", subscription_details: { subscription: subId } },
        status_transitions: { paid_at: 1_700_000_001 },
      }),
    });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockResolvedValue({
        ok: true,
        data: validStripeSubscription({
          id: subId,
          status: "active",
          metadata: { kind: "monitor_subscription", user_id: userId, duplicate_subscription: "true" },
          latest_invoice: latestInvId,
        }),
      }),
      listInvoicePayments: vi.fn().mockImplementation(async (invId: string) => ({
        ok: true,
        data: {
          data: [{
            status: "paid",
            payment: {
              type: "payment_intent",
              payment_intent: invId === latestInvId ? latestPiId : eventPiId,
            },
            amount_paid: 9500,
          }],
        },
      })),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
      createRefund: vi.fn().mockResolvedValue({ ok: true, data: { id: "re_a25bEnt" } }),
    });
    const rpc = fakeRpc({
      recordSubscriptionInvoice: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    // Both invoices listed and refunded (order-insensitive — A25b doesn't mandate event-invoice order)
    expect([...vi.mocked(stripe.listInvoicePayments).mock.calls].sort()).toEqual(
      [[eventInvId], [latestInvId]].sort(),
    );
    expect([...vi.mocked(stripe.createRefund).mock.calls].sort()).toEqual(
      [[eventPiId, subId, 9500], [latestPiId, subId, 9500]].sort(),
    );
    expect(vi.mocked(stripe.cancelSubscription).mock.calls).toEqual([[subId]]);
    // Sub already marked → markDuplicateSubscription NOT called
    expect(stripe.markDuplicateSubscription).not.toHaveBeenCalled();
    expectNoCollaboratorCalls(deps, {
      allow: ["retrieveSubscription", "recordSubscriptionInvoice", "otherEntitlingSubscriptionIds", "listInvoicePayments", "createRefund", "cancelSubscription"],
    });
    // Ordering constraints (A19 order within each invoice's block; event-invoice block relative to cancel unconstrained)
    const [writerOrd] = vi.mocked(rpc.recordSubscriptionInvoice).mock.invocationCallOrder;
    const listCalls = vi.mocked(stripe.listInvoicePayments).mock.calls;
    const listOrders = vi.mocked(stripe.listInvoicePayments).mock.invocationCallOrder;
    const listLatestIdx = listCalls.findIndex(([id]) => id === latestInvId);
    const listEvIdx = listCalls.findIndex(([id]) => id === eventInvId);
    if (listLatestIdx < 0 || listEvIdx < 0) throw new Error("expected list calls not found");
    const listLatestOrd = listOrders[listLatestIdx];
    const listEvOrd = listOrders[listEvIdx];
    const refundCalls = vi.mocked(stripe.createRefund).mock.calls;
    const refundOrders = vi.mocked(stripe.createRefund).mock.invocationCallOrder;
    const refundLatestIdx = refundCalls.findIndex(([pi]) => pi === latestPiId);
    if (refundLatestIdx < 0) throw new Error("expected latest refund call not found");
    const refundLatestOrd = refundOrders[refundLatestIdx];
    const [cancelOrd] = vi.mocked(stripe.cancelSubscription).mock.invocationCallOrder;
    if (writerOrd === undefined || listLatestOrd === undefined || listEvOrd === undefined || refundLatestOrd === undefined || cancelOrd === undefined) throw new Error("expected calls not made");
    // writer < both list calls; refund(latest) < cancel (A19 order; event-invoice block unconstrained per A25b)
    expect(writerOrd).toBeLessThan(Math.min(listLatestOrd, listEvOrd));
    expect(refundLatestOrd).toBeLessThan(cancelOrd);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "invoice.paid",
      outcome: "duplicate_subscription_canceled",
      code: "unrecordable_refunded",
      paused: 0,
    });
  });
});

describe("WH-AC_A25b-nopaid: invoice.paid for MARKED canceled sub with no paid PIs → list called, no refund; outcome = writer's (A25)", () => {
  it("WH-AC_A25b-nopaid: marked + canceled; invoice has no paid payment_intent payments → listInvoicePayments called; createRefund NOT called; outcome applied", async () => {
    const subId = "sub_a25bNopd";
    const invId = "in_a25bNopd";
    const body = makeEventBody({
      type: "invoice.paid",
      dataObject: validStripeInvoice({
        id: invId,
        parent: { type: "subscription_details", subscription_details: { subscription: subId } },
        status_transitions: { paid_at: 1_700_000_001 },
      }),
    });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockResolvedValue({
        ok: true,
        data: validStripeSubscription({
          id: subId,
          status: "canceled",
          metadata: { kind: "monitor_subscription", user_id: "00000000-0000-0000-0000-000000000001", duplicate_subscription: "true" },
          latest_invoice: "in_a25bNodLast",
        }),
      }),
      listInvoicePayments: vi.fn().mockResolvedValue({
        ok: true,
        data: { data: [{ status: "open", payment: { type: "payment_intent", payment_intent: "pi_a25bNopd" }, amount_paid: 0 }] },
      }),
    });
    const rpc = fakeRpc({
      recordSubscriptionInvoice: vi.fn().mockResolvedValue({ outcome: "applied", paused: 1 }),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(vi.mocked(stripe.listInvoicePayments).mock.calls).toEqual([[invId]]);
    expect(stripe.createRefund).not.toHaveBeenCalled();
    expectNoCollaboratorCalls(deps, {
      allow: ["retrieveSubscription", "recordSubscriptionInvoice", "listInvoicePayments"],
    });
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "invoice.paid",
      outcome: "applied",
      code: null,
      paused: 1,
    });
  });
});

describe("WH-AC_A25b-charge-already-refunded: charge_already_refunded on marked invoice path → done, no error (A25)", () => {
  it("WH-AC_A25b-charge-already-refunded: createRefund returns charge_already_refunded → 200; outcome duplicate_invoice_refunded", async () => {
    const subId = "sub_a25bCar";
    const invId = "in_a25bCar";
    const piId = "pi_a25bCar";
    const body = makeEventBody({
      type: "invoice.paid",
      dataObject: validStripeInvoice({
        id: invId,
        parent: { type: "subscription_details", subscription_details: { subscription: subId } },
        status_transitions: { paid_at: 1_700_000_001 },
      }),
    });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockResolvedValue({
        ok: true,
        data: validStripeSubscription({
          id: subId,
          status: "canceled",
          metadata: { kind: "monitor_subscription", user_id: "00000000-0000-0000-0000-000000000001", duplicate_subscription: "true" },
          latest_invoice: "in_a25bCarLast",
        }),
      }),
      listInvoicePayments: vi.fn().mockResolvedValue({
        ok: true,
        data: { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: piId }, amount_paid: 9500 }] },
      }),
      createRefund: vi.fn().mockResolvedValue({ ok: false, kind: "http", status: 400, code: "charge_already_refunded" }),
    });
    const rpc = fakeRpc({
      recordSubscriptionInvoice: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    // THIS event's invoice listed (not latest_invoice of the sub)
    expect(vi.mocked(stripe.listInvoicePayments).mock.calls).toEqual([[invId]]);
    expect(vi.mocked(stripe.createRefund).mock.calls).toEqual([[piId, subId, 9500]]);
    expectNoCollaboratorCalls(deps, {
      allow: ["retrieveSubscription", "recordSubscriptionInvoice", "listInvoicePayments", "createRefund"],
    });
    // charge_already_refunded → 200, duplicate_invoice_refunded, code null, paused = writer's (0)
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "invoice.paid",
      outcome: "duplicate_invoice_refunded",
      code: null,
      paused: 0,
    });
  });
});

describe("WH-AC_A25b-unmarked: invoice.paid for UNMARKED canceled sub → NO list; NO refund; normal flow (A25)", () => {
  it("WH-AC_A25b-unmarked: unmarked canceled sub + invoice.paid → no listInvoicePayments, no createRefund; outcome applied", async () => {
    const subId = "sub_a25bUnmrk";
    const invId = "in_a25bUnmrk";
    const body = makeEventBody({
      type: "invoice.paid",
      dataObject: validStripeInvoice({
        id: invId,
        parent: { type: "subscription_details", subscription_details: { subscription: subId } },
        status_transitions: { paid_at: 1_700_000_001 },
      }),
    });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockResolvedValue({
        ok: true,
        data: validStripeSubscription({
          id: subId,
          status: "canceled",
          // NOT marked: no duplicate_subscription metadata
          metadata: { kind: "monitor_subscription", user_id: "00000000-0000-0000-0000-000000000001" },
          latest_invoice: "in_a25bUnmrkLast",
        }),
      }),
    });
    const rpc = fakeRpc({
      recordSubscriptionInvoice: vi.fn().mockResolvedValue({ outcome: "applied", paused: 2 }),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expectNoCollaboratorCalls(deps, {
      allow: ["retrieveSubscription", "recordSubscriptionInvoice"],
    });
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "invoice.paid",
      outcome: "applied",
      code: null,
      paused: 2,
    });
  });
});

describe("WH-AC_A25b-entitling-sameInv: invoice.paid for MARKED entitling sub; event invoice = latest → dup path only, refund once (A25)", () => {
  it("WH-AC_A25b-entitling-sameInv: event invoice equals latest_invoice → listInvoicePayments called once; createRefund once; no second list; outcome duplicate_subscription_canceled", async () => {
    const subId = "sub_a25bEsi";
    const sameInvId = "in_a25bSame"; // event invoice = latest invoice
    const piId = "pi_a25bSame";
    const userId = "00000000-0000-0000-0000-000000000001";
    const body = makeEventBody({
      type: "invoice.paid",
      dataObject: validStripeInvoice({
        id: sameInvId,
        parent: { type: "subscription_details", subscription_details: { subscription: subId } },
        status_transitions: { paid_at: 1_700_000_001 },
      }),
    });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockResolvedValue({
        ok: true,
        data: validStripeSubscription({
          id: subId,
          status: "active",
          metadata: { kind: "monitor_subscription", user_id: userId, duplicate_subscription: "true" },
          latest_invoice: sameInvId, // same as event invoice
        }),
      }),
      listInvoicePayments: vi.fn().mockResolvedValue({
        ok: true,
        data: { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: piId }, amount_paid: 9500 }] },
      }),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
      createRefund: vi.fn().mockResolvedValue({ ok: true, data: { id: "re_a25bEsi" } }),
    });
    const rpc = fakeRpc({
      recordSubscriptionInvoice: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    // event invoice = latest → list called ONCE only (no duplicate refund)
    expect(vi.mocked(stripe.listInvoicePayments).mock.calls).toEqual([[sameInvId]]);
    expect(vi.mocked(stripe.createRefund).mock.calls).toEqual([[piId, subId, 9500]]);
    expect(vi.mocked(stripe.cancelSubscription).mock.calls).toEqual([[subId]]);
    expect(stripe.markDuplicateSubscription).not.toHaveBeenCalled();
    expectNoCollaboratorCalls(deps, {
      allow: ["retrieveSubscription", "recordSubscriptionInvoice", "otherEntitlingSubscriptionIds", "listInvoicePayments", "createRefund", "cancelSubscription"],
    });
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "invoice.paid",
      outcome: "duplicate_subscription_canceled",
      code: "unrecordable_refunded",
      paused: 0,
    });
  });
});

describe("WH-AC_A25b-refusal-entitling: invoice.paid for a MARKED entitling sub refused unknown_plan → both invoices refunded, canceled (A26)", () => {
  it("WH-AC_A25b-refusal-entitling: writer refuses unknown_plan; marked active sub → no DB read, no mark; list THIS invoice and latest_invoice → refund both; cancel; duplicate_subscription_canceled, code unrecordable_refunded, paused null", async () => {
    // A26(a): a permanent refusal on a marked+entitling sub no longer stops the finish; cancelAndRefund runs.
    // A26(b): event invoice ≠ latest → also refund this invoice's paid PIs.
    const subId = "sub_a25bRef";
    const invId = "in_a25bRef";
    const piId = "pi_a25bRef";
    const latestInvId = "in_a25bRefLast";
    const latestPiId = "pi_a25bRefLast";
    const body = makeEventBody({
      type: "invoice.paid",
      dataObject: validStripeInvoice({
        id: invId,
        parent: { type: "subscription_details", subscription_details: { subscription: subId } },
        status_transitions: { paid_at: 1_700_000_001 },
      }),
    });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockResolvedValue({
        ok: true,
        data: validStripeSubscription({
          id: subId,
          status: "active",
          metadata: { kind: "monitor_subscription", user_id: "00000000-0000-0000-0000-000000000001", duplicate_subscription: "true" },
          latest_invoice: latestInvId,
        }),
      }),
      listInvoicePayments: vi.fn().mockImplementation(async (id: string) => ({
        ok: true,
        data: {
          data: [{
            status: "paid",
            payment: { type: "payment_intent", payment_intent: id === latestInvId ? latestPiId : piId },
            amount_paid: 9500,
          }],
        },
      })),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
      createRefund: vi.fn().mockResolvedValue({ ok: true, data: { id: "re_a25bRef" } }),
    });
    const rpc = fakeRpc({
      recordSubscriptionInvoice: vi.fn().mockRejectedValue(new PaymentsRpcError("unknown_plan", "22023", 400)),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    // A26(a): no DB read for marked sub
    expect(rpc.otherEntitlingSubscriptionIds).not.toHaveBeenCalled();
    // mark step skipped (already marked)
    expect(stripe.markDuplicateSubscription).not.toHaveBeenCalled();
    // Both invoices listed (order-agnostic)
    expect([...vi.mocked(stripe.listInvoicePayments).mock.calls].sort()).toEqual(
      [[invId], [latestInvId]].sort(),
    );
    // Both PIs refunded (order-agnostic)
    expect([...vi.mocked(stripe.createRefund).mock.calls].sort()).toEqual(
      [[latestPiId, subId, 9500], [piId, subId, 9500]].sort(),
    );
    expect(vi.mocked(stripe.cancelSubscription).mock.calls).toEqual([[subId]]);
    expectNoCollaboratorCalls(deps, {
      allow: ["retrieveSubscription", "recordSubscriptionInvoice", "listInvoicePayments", "createRefund", "cancelSubscription"],
    });
    // invocationCallOrder: writer < lists < refund(latest) < cancel
    const [writerOrd] = vi.mocked(rpc.recordSubscriptionInvoice).mock.invocationCallOrder;
    const listCalls = vi.mocked(stripe.listInvoicePayments).mock.calls;
    const listOrdAll = vi.mocked(stripe.listInvoicePayments).mock.invocationCallOrder;
    const refundCalls = vi.mocked(stripe.createRefund).mock.calls;
    const refundOrdAll = vi.mocked(stripe.createRefund).mock.invocationCallOrder;
    const [cancelOrd] = vi.mocked(stripe.cancelSubscription).mock.invocationCallOrder;
    const latestListIdx = listCalls.findIndex(([id]) => id === latestInvId);
    const latestRefundIdx = refundCalls.findIndex(([pi]) => pi === latestPiId);
    if (writerOrd === undefined || latestListIdx < 0 || latestRefundIdx < 0 || cancelOrd === undefined)
      throw new Error("WH-AC_A25b-refusal-entitling: expected calls not found");
    const latestListOrd = listOrdAll[latestListIdx];
    const latestRefundOrd = refundOrdAll[latestRefundIdx];
    if (latestListOrd === undefined || latestRefundOrd === undefined)
      throw new Error("WH-AC_A25b-refusal-entitling: call order undefined");
    expect(writerOrd).toBeLessThan(latestListOrd);
    expect(latestRefundOrd).toBeLessThan(cancelOrd);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "invoice.paid",
      outcome: "duplicate_subscription_canceled",
      code: "unrecordable_refunded",
      paused: null,
    });
  });
});

describe("WH-AC_A25b-entitling-malformed: invoice.paid for a MARKED entitling sub with a malformed latest_invoice → left alone, this invoice refunded (A16 + A25)", () => {
  it("WH-AC_A25b-entitling-malformed: latest_invoice 'in_a25b bad' → no list of it, no cancel; THIS invoice listed + refunded; rejected invalid_subscription with the writer's paused", async () => {
    // The finish leaves the sub alone (A16); the event's own invoice cannot be shown to be the latest, so it is refunded.
    const subId = "sub_a25bMal";
    const invId = "in_a25bMal";
    const piId = "pi_a25bMal";
    const userId = "00000000-0000-0000-0000-000000000001";
    const body = makeEventBody({
      type: "invoice.paid",
      dataObject: validStripeInvoice({
        id: invId,
        parent: { type: "subscription_details", subscription_details: { subscription: subId } },
        status_transitions: { paid_at: 1_700_000_001 },
      }),
    });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockResolvedValue({
        ok: true,
        data: validStripeSubscription({
          id: subId,
          status: "active",
          metadata: { kind: "monitor_subscription", user_id: userId, duplicate_subscription: "true" },
          latest_invoice: "in_a25b bad",
        }),
      }),
      listInvoicePayments: vi.fn().mockResolvedValue({
        ok: true,
        data: { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: piId }, amount_paid: 9500 }] },
      }),
      createRefund: vi.fn().mockResolvedValue({ ok: true, data: { id: "re_a25bMal" } }),
    });
    const rpc = fakeRpc({
      recordSubscriptionInvoice: vi.fn().mockResolvedValue({ outcome: "applied", paused: 4 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    // A26a: a marked sub goes straight to its own finish (left alone here, A16), without the DB read of the user's others.
    expect(rpc.otherEntitlingSubscriptionIds).not.toHaveBeenCalled();
    expect(vi.mocked(stripe.listInvoicePayments).mock.calls).toEqual([[invId]]);
    expect(vi.mocked(stripe.createRefund).mock.calls).toEqual([[piId, subId, 9500]]);
    expectNoCollaboratorCalls(deps, {
      allow: ["retrieveSubscription", "recordSubscriptionInvoice", "listInvoicePayments", "createRefund"],
    });
    expect(vi.mocked(stripe.retrieveSubscription).mock.calls).toEqual([[subId]]);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "invoice.paid",
      outcome: "rejected",
      code: "invalid_subscription",
      paused: 4,
    });
  });
});

// ── WH-AC_A26a-csu: marked+entitling, ANY writer result → cancelAndRefund, no DB read (A26) ─────

describe("WH-AC_A26a-csu: customer.subscription.updated; MARKED entitling sub; cancelAndRefund on ANY writer outcome, no DB read (A26)", () => {
  it.each<{
    label: string;
    spec:
      | { kind: "ok"; outcome: "applied" | "duplicate" | "stale"; paused: number }
      | { kind: "refusal"; code: "invalid_payload" | "unknown_plan" | "unknown_user" | "customer_user_mismatch" };
    expectedPaused: number | null;
    sfx: string;
  }>([
    { label: "applied",                 spec: { kind: "ok", outcome: "applied",   paused: 2 }, expectedPaused: 2,    sfx: "app" },
    { label: "duplicate",               spec: { kind: "ok", outcome: "duplicate", paused: 1 }, expectedPaused: 1,    sfx: "dup" },
    { label: "stale",                   spec: { kind: "ok", outcome: "stale",     paused: 0 }, expectedPaused: 0,    sfx: "stl" },
    { label: "invalid_payload refusal", spec: { kind: "refusal", code: "invalid_payload"        }, expectedPaused: null, sfx: "ip"  },
    { label: "unknown_plan refusal",    spec: { kind: "refusal", code: "unknown_plan"            }, expectedPaused: null, sfx: "up"  },
    { label: "unknown_user refusal",    spec: { kind: "refusal", code: "unknown_user"            }, expectedPaused: null, sfx: "uu"  },
    { label: "customer_user_mismatch",  spec: { kind: "refusal", code: "customer_user_mismatch" }, expectedPaused: null, sfx: "cum" },
  ])(
    "WH-AC_A26a-csu: writer=$label → no DB read; mark skipped; list(latest)+refund+cancel; outcome duplicate_subscription_canceled, paused $expectedPaused",
    async ({ label, spec, expectedPaused, sfx }) => {
      const subId = `sub_a26c${sfx}`;
      const latestInvId = `in_a26cLast${sfx}`;
      const piId = `pi_a26c${sfx}`;
      const userId = "00000000-0000-0000-0000-000000000001";
      const body = makeEventBody({ type: "customer.subscription.updated", dataObject: { id: subId } });
      const writerMock =
        spec.kind === "ok"
          ? vi.fn().mockResolvedValue({ outcome: spec.outcome, paused: spec.paused })
          : vi.fn().mockRejectedValue(new PaymentsRpcError(spec.code, "22023", 400));
      const stripe = fakeStripe({
        retrieveSubscription: vi.fn().mockResolvedValue({
          ok: true,
          data: validStripeSubscription({
            id: subId,
            status: "active",
            metadata: { kind: "monitor_subscription", user_id: userId, duplicate_subscription: "true" },
            latest_invoice: latestInvId,
          }),
        }),
        listInvoicePayments: vi.fn().mockResolvedValue({
          ok: true,
          data: { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: piId }, amount_paid: 9500 }] },
        }),
        cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
        createRefund: vi.fn().mockResolvedValue({ ok: true, data: { id: `re_a26c${sfx}` } }),
      });
      const rpc = fakeRpc({ syncSubscription: writerMock });
      const deps = { ...fakeDeps(), stripe, rpc };
      const resp = await handleStripeWebhook(makeRequest(body), deps);
      expect(resp.status).toBe(200);
      // A26(a): no DB read for marked sub
      expect(rpc.otherEntitlingSubscriptionIds).not.toHaveBeenCalled();
      // mark step skipped (already marked)
      expect(stripe.markDuplicateSubscription).not.toHaveBeenCalled();
      expect(vi.mocked(stripe.listInvoicePayments).mock.calls).toEqual([[latestInvId]]);
      expect(vi.mocked(stripe.createRefund).mock.calls).toEqual([[piId, subId, 9500]]);
      expect(vi.mocked(stripe.cancelSubscription).mock.calls).toEqual([[subId]]);
      expectNoCollaboratorCalls(deps, {
        allow: ["retrieveSubscription", "syncSubscription", "listInvoicePayments", "createRefund", "cancelSubscription"],
      });
      // invocationCallOrder: writer < list < refund < cancel
      const [writerOrd] = vi.mocked(rpc.syncSubscription).mock.invocationCallOrder;
      const [listOrd] = vi.mocked(stripe.listInvoicePayments).mock.invocationCallOrder;
      const [refundOrd] = vi.mocked(stripe.createRefund).mock.invocationCallOrder;
      const [cancelOrd] = vi.mocked(stripe.cancelSubscription).mock.invocationCallOrder;
      if (writerOrd === undefined || listOrd === undefined || refundOrd === undefined || cancelOrd === undefined)
        throw new Error(`WH-AC_A26a-csu(${label}): expected all calls`);
      expect(writerOrd).toBeLessThan(listOrd);
      expect(listOrd).toBeLessThan(refundOrd);
      expect(refundOrd).toBeLessThan(cancelOrd);
      expect(parseLog(deps)).toEqual({
        msg: "payments webhook",
        event: "evt_test001",
        type: "customer.subscription.updated",
        outcome: "duplicate_subscription_canceled",
        code: "unrecordable_refunded",
        paused: expectedPaused,
      });
    },
  );
});

// ── WH-AC_A26a-invpaid: invoice.paid; marked+entitling, ANY writer → cancelAndRefund(latest) + refund event invoice; no DB read ─────

describe("WH-AC_A26a-invpaid: invoice.paid; MARKED entitling sub; cancelAndRefund(latest) + refund event invoice on ANY writer outcome; no DB read (A26)", () => {
  it.each<{
    label: string;
    spec:
      | { kind: "ok"; outcome: "applied" | "duplicate" | "stale"; paused: number }
      | { kind: "refusal"; code: "invalid_payload" | "unknown_plan" | "unknown_user" | "customer_user_mismatch" };
    expectedPaused: number | null;
    sfx: string;
  }>([
    { label: "applied",                 spec: { kind: "ok", outcome: "applied",   paused: 2 }, expectedPaused: 2,    sfx: "app" },
    { label: "duplicate",               spec: { kind: "ok", outcome: "duplicate", paused: 1 }, expectedPaused: 1,    sfx: "dup" },
    { label: "stale",                   spec: { kind: "ok", outcome: "stale",     paused: 0 }, expectedPaused: 0,    sfx: "stl" },
    { label: "invalid_payload refusal", spec: { kind: "refusal", code: "invalid_payload"        }, expectedPaused: null, sfx: "ip"  },
    { label: "unknown_plan refusal",    spec: { kind: "refusal", code: "unknown_plan"            }, expectedPaused: null, sfx: "up"  },
    { label: "unknown_user refusal",    spec: { kind: "refusal", code: "unknown_user"            }, expectedPaused: null, sfx: "uu"  },
    { label: "customer_user_mismatch",  spec: { kind: "refusal", code: "customer_user_mismatch" }, expectedPaused: null, sfx: "cum" },
  ])(
    "WH-AC_A26a-invpaid: writer=$label → no DB read; cancelAndRefund(latest)+refund(event); outcome duplicate_subscription_canceled, paused $expectedPaused",
    async ({ label, spec, expectedPaused, sfx }) => {
      const subId = `sub_a26ip${sfx}`;
      const latestInvId = `in_a26ipLast${sfx}`;
      const latestPiId = `pi_a26ipLast${sfx}`;
      const eventInvId = `in_a26ipEv${sfx}`;
      const eventPiId = `pi_a26ipEv${sfx}`;
      const userId = "00000000-0000-0000-0000-000000000001";
      const body = makeEventBody({
        type: "invoice.paid",
        dataObject: validStripeInvoice({
          id: eventInvId,
          parent: { type: "subscription_details", subscription_details: { subscription: subId } },
          status_transitions: { paid_at: 1_700_000_001 },
        }),
      });
      const writerMock =
        spec.kind === "ok"
          ? vi.fn().mockResolvedValue({ outcome: spec.outcome, paused: spec.paused })
          : vi.fn().mockRejectedValue(new PaymentsRpcError(spec.code, "22023", 400));
      const stripe = fakeStripe({
        retrieveSubscription: vi.fn().mockResolvedValue({
          ok: true,
          data: validStripeSubscription({
            id: subId,
            status: "active",
            metadata: { kind: "monitor_subscription", user_id: userId, duplicate_subscription: "true" },
            latest_invoice: latestInvId,
          }),
        }),
        listInvoicePayments: vi.fn().mockImplementation(async (invId: string) => ({
          ok: true,
          data: {
            data: [{
              status: "paid",
              payment: { type: "payment_intent", payment_intent: invId === latestInvId ? latestPiId : eventPiId },
              amount_paid: 9500,
            }],
          },
        })),
        cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
        createRefund: vi.fn().mockResolvedValue({ ok: true, data: { id: `re_a26ip${sfx}` } }),
      });
      const rpc = fakeRpc({ recordSubscriptionInvoice: writerMock });
      const deps = { ...fakeDeps(), stripe, rpc };
      const resp = await handleStripeWebhook(makeRequest(body), deps);
      expect(resp.status).toBe(200);
      // A26(a): no DB read for marked sub
      expect(rpc.otherEntitlingSubscriptionIds).not.toHaveBeenCalled();
      expect(stripe.markDuplicateSubscription).not.toHaveBeenCalled();
      // Both invoices listed (order-agnostic)
      expect([...vi.mocked(stripe.listInvoicePayments).mock.calls].sort()).toEqual(
        [[eventInvId], [latestInvId]].sort(),
      );
      // Both PIs refunded (order-agnostic)
      expect([...vi.mocked(stripe.createRefund).mock.calls].sort()).toEqual(
        [[eventPiId, subId, 9500], [latestPiId, subId, 9500]].sort(),
      );
      expect(vi.mocked(stripe.cancelSubscription).mock.calls).toEqual([[subId]]);
      expectNoCollaboratorCalls(deps, {
        allow: ["retrieveSubscription", "recordSubscriptionInvoice", "listInvoicePayments", "createRefund", "cancelSubscription"],
      });
      // invocationCallOrder: writer < lists; refund(latest) < cancel
      const [writerOrd] = vi.mocked(rpc.recordSubscriptionInvoice).mock.invocationCallOrder;
      const listCalls = vi.mocked(stripe.listInvoicePayments).mock.calls;
      const listOrdAll = vi.mocked(stripe.listInvoicePayments).mock.invocationCallOrder;
      const refundCalls = vi.mocked(stripe.createRefund).mock.calls;
      const refundOrdAll = vi.mocked(stripe.createRefund).mock.invocationCallOrder;
      const [cancelOrd] = vi.mocked(stripe.cancelSubscription).mock.invocationCallOrder;
      const latestListIdx = listCalls.findIndex(([id]) => id === latestInvId);
      const latestRefundIdx = refundCalls.findIndex(([pi]) => pi === latestPiId);
      if (writerOrd === undefined || latestListIdx < 0 || latestRefundIdx < 0 || cancelOrd === undefined)
        throw new Error(`WH-AC_A26a-invpaid(${label}): expected calls not found`);
      const latestListOrd = listOrdAll[latestListIdx];
      const latestRefundOrd = refundOrdAll[latestRefundIdx];
      if (latestListOrd === undefined || latestRefundOrd === undefined)
        throw new Error(`WH-AC_A26a-invpaid(${label}): call order undefined`);
      expect(writerOrd).toBeLessThan(latestListOrd);
      expect(latestRefundOrd).toBeLessThan(cancelOrd);
      expect(parseLog(deps)).toEqual({
        msg: "payments webhook",
        event: "evt_test001",
        type: "invoice.paid",
        outcome: "duplicate_subscription_canceled",
        code: "unrecordable_refunded",
        paused: expectedPaused,
      });
    },
  );
});

// ── WH-AC_A26b: invoice.paid; sub UNMARKED at retrieval, gets marked during delivery; event invoices' PIs also refunded ─────

describe("WH-AC_A26b: invoice.paid; sub UNMARKED at retrieval, marked during delivery by dup rule; event invoice ≠ latest → both invoices' paid PIs refunded each once (A26)", () => {
  it("WH-AC_A26b: unmarked sub; writer applies; keeper found in DB; event invoice ≠ latest → markDuplicateSubscription + list(latest)+refund(latest)+cancel + list(event)+refund(event); outcome duplicate_subscription_canceled", async () => {
    const eventSubId = "sub_a26bDup";
    const keeperId = "sub_a26bKeep";
    const latestInvId = "in_a26bLast";
    const latestPiId = "pi_a26bLast";
    const eventInvId = "in_a26bEv";
    const eventPiId = "pi_a26bEv";
    const userId = "00000000-0000-0000-0000-000000000001";
    const body = makeEventBody({
      type: "invoice.paid",
      dataObject: validStripeInvoice({
        id: eventInvId,
        parent: { type: "subscription_details", subscription_details: { subscription: eventSubId } },
        status_transitions: { paid_at: 1_700_000_001 },
      }),
    });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => ({
        ok: true,
        data: validStripeSubscription({
          id,
          status: "active",
          // Keeper has older created → eventSub is the duplicate
          created: id === keeperId ? 1_699_000_000 : 1_700_000_000,
          metadata: { kind: "monitor_subscription", user_id: userId },
          latest_invoice: id === eventSubId ? latestInvId : "in_a26bKeepLast",
        }),
      })),
      listInvoicePayments: vi.fn().mockImplementation(async (invId: string) => ({
        ok: true,
        data: {
          data: [{
            status: "paid",
            payment: { type: "payment_intent", payment_intent: invId === latestInvId ? latestPiId : eventPiId },
            amount_paid: 9500,
          }],
        },
      })),
      markDuplicateSubscription: vi.fn().mockResolvedValue({ ok: true, data: {} }),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
      createRefund: vi.fn().mockResolvedValue({ ok: true, data: { id: "re_a26b" } }),
    });
    const rpc = fakeRpc({
      recordSubscriptionInvoice: vi.fn().mockResolvedValue({ outcome: "applied", paused: 1 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([keeperId]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    // event sub gets marked during delivery
    expect(vi.mocked(stripe.markDuplicateSubscription).mock.calls).toEqual([[eventSubId]]);
    // Both invoices listed (order-agnostic; never listed twice)
    expect([...vi.mocked(stripe.listInvoicePayments).mock.calls].sort()).toEqual(
      [[eventInvId], [latestInvId]].sort(),
    );
    // Both PIs refunded (order-agnostic)
    expect([...vi.mocked(stripe.createRefund).mock.calls].sort()).toEqual(
      [[eventPiId, eventSubId, 9500], [latestPiId, eventSubId, 9500]].sort(),
    );
    expect(vi.mocked(stripe.cancelSubscription).mock.calls).toEqual([[eventSubId]]);
    expectNoCollaboratorCalls(deps, {
      allow: ["retrieveSubscription", "recordSubscriptionInvoice", "otherEntitlingSubscriptionIds", "markDuplicateSubscription", "listInvoicePayments", "createRefund", "cancelSubscription"],
    });
    // invocationCallOrder: writer < mark < list(latest) < refund(latest) < cancel
    const [writerOrd] = vi.mocked(rpc.recordSubscriptionInvoice).mock.invocationCallOrder;
    const [markOrd] = vi.mocked(stripe.markDuplicateSubscription).mock.invocationCallOrder;
    const listCalls = vi.mocked(stripe.listInvoicePayments).mock.calls;
    const listOrdAll = vi.mocked(stripe.listInvoicePayments).mock.invocationCallOrder;
    const refundCalls = vi.mocked(stripe.createRefund).mock.calls;
    const refundOrdAll = vi.mocked(stripe.createRefund).mock.invocationCallOrder;
    const [cancelOrd] = vi.mocked(stripe.cancelSubscription).mock.invocationCallOrder;
    const latestListIdx = listCalls.findIndex(([id]) => id === latestInvId);
    const latestRefundIdx = refundCalls.findIndex(([pi]) => pi === latestPiId);
    if (writerOrd === undefined || markOrd === undefined || latestListIdx < 0 || latestRefundIdx < 0 || cancelOrd === undefined)
      throw new Error("WH-AC_A26b: expected calls not found");
    const latestListOrd = listOrdAll[latestListIdx];
    const latestRefundOrd = refundOrdAll[latestRefundIdx];
    if (latestListOrd === undefined || latestRefundOrd === undefined)
      throw new Error("WH-AC_A26b: call order undefined");
    expect(writerOrd).toBeLessThan(markOrd);
    expect(markOrd).toBeLessThan(latestListOrd);
    expect(latestRefundOrd).toBeLessThan(cancelOrd);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "invoice.paid",
      outcome: "duplicate_subscription_canceled",
      code: null,
      paused: 1,
    });
  });
});

describe("WH-AC_A26b-sameInv: invoice.paid; sub UNMARKED at retrieval, marked during delivery; event invoice === latest → listed once, refunded once (A26)", () => {
  it("WH-AC_A26b-sameInv: unmarked sub; writer applies; keeper in DB; event invoice === latest_invoice → markDuplicateSubscription [[subId]]; listInvoicePayments [[invId]] once; createRefund once; cancel [[subId]]; outcome duplicate_subscription_canceled", async () => {
    const eventSubId = "sub_a26bSiDup";
    const keeperId = "sub_a26bSiKeep";
    const sameInvId = "in_a26bSame";
    const piId = "pi_a26bSame";
    const userId = "00000000-0000-0000-0000-000000000001";
    const body = makeEventBody({
      type: "invoice.paid",
      dataObject: validStripeInvoice({
        id: sameInvId,
        parent: { type: "subscription_details", subscription_details: { subscription: eventSubId } },
        status_transitions: { paid_at: 1_700_000_001 },
      }),
    });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => ({
        ok: true,
        data: validStripeSubscription({
          id,
          status: "active",
          created: id === keeperId ? 1_699_000_000 : 1_700_000_000,
          metadata: { kind: "monitor_subscription", user_id: userId },
          // event sub's latest_invoice === event invoice id → sameInv case
          latest_invoice: id === eventSubId ? sameInvId : "in_a26bSiKeepLast",
        }),
      })),
      listInvoicePayments: vi.fn().mockResolvedValue({
        ok: true,
        data: { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: piId }, amount_paid: 9500 }] },
      }),
      markDuplicateSubscription: vi.fn().mockResolvedValue({ ok: true, data: {} }),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
      createRefund: vi.fn().mockResolvedValue({ ok: true, data: { id: "re_a26bSi" } }),
    });
    const rpc = fakeRpc({
      recordSubscriptionInvoice: vi.fn().mockResolvedValue({ outcome: "applied", paused: 2 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([keeperId]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    // event sub gets marked (not already marked at retrieval)
    expect(vi.mocked(stripe.markDuplicateSubscription).mock.calls).toEqual([[eventSubId]]);
    // event invoice === latest → listed exactly once (no duplicate list)
    expect(vi.mocked(stripe.listInvoicePayments).mock.calls).toEqual([[sameInvId]]);
    // refunded exactly once
    expect(vi.mocked(stripe.createRefund).mock.calls).toEqual([[piId, eventSubId, 9500]]);
    expect(vi.mocked(stripe.cancelSubscription).mock.calls).toEqual([[eventSubId]]);
    expectNoCollaboratorCalls(deps, {
      allow: ["retrieveSubscription", "recordSubscriptionInvoice", "otherEntitlingSubscriptionIds", "markDuplicateSubscription", "listInvoicePayments", "createRefund", "cancelSubscription"],
    });
    // invocationCallOrder: writer < mark < list < refund < cancel
    const [writerOrd] = vi.mocked(rpc.recordSubscriptionInvoice).mock.invocationCallOrder;
    const [markOrd] = vi.mocked(stripe.markDuplicateSubscription).mock.invocationCallOrder;
    const [listOrd] = vi.mocked(stripe.listInvoicePayments).mock.invocationCallOrder;
    const [refundOrd] = vi.mocked(stripe.createRefund).mock.invocationCallOrder;
    const [cancelOrd] = vi.mocked(stripe.cancelSubscription).mock.invocationCallOrder;
    if (writerOrd === undefined || markOrd === undefined || listOrd === undefined || refundOrd === undefined || cancelOrd === undefined)
      throw new Error("WH-AC_A26b-sameInv: expected all calls");
    expect(writerOrd).toBeLessThan(markOrd);
    expect(markOrd).toBeLessThan(listOrd);
    expect(listOrd).toBeLessThan(refundOrd);
    expect(refundOrd).toBeLessThan(cancelOrd);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "invoice.paid",
      outcome: "duplicate_subscription_canceled",
      code: null,
      paused: 2,
    });
  });
});

describe("WH-AC_A26b-mismatch: invoice.paid; UNMARKED entitling sub refused customer_user_mismatch → marked by the mismatch path; event invoice ≠ latest → both invoices refunded (A26)", () => {
  it("WH-AC_A26b-mismatch: writer refuses customer_user_mismatch; no DB others → mark, list(latest)+refund, cancel, list(event)+refund; duplicate_subscription_canceled, code unrecordable_refunded, paused null", async () => {
    const subId = "sub_a26bMis";
    const latestInvId = "in_a26bMisLast";
    const latestPiId = "pi_a26bMisLast";
    const eventInvId = "in_a26bMisEv";
    const eventPiId = "pi_a26bMisEv";
    const userId = "00000000-0000-0000-0000-000000000001";
    const body = makeEventBody({
      type: "invoice.paid",
      dataObject: validStripeInvoice({
        id: eventInvId,
        parent: { type: "subscription_details", subscription_details: { subscription: subId } },
        status_transitions: { paid_at: 1_700_000_001 },
      }),
    });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockResolvedValue({
        ok: true,
        data: validStripeSubscription({
          id: subId,
          status: "active",
          metadata: { kind: "monitor_subscription", user_id: userId },
          latest_invoice: latestInvId,
        }),
      }),
      listInvoicePayments: vi.fn().mockImplementation(async (invId: string) => ({
        ok: true,
        data: {
          data: [{
            status: "paid",
            payment: { type: "payment_intent", payment_intent: invId === latestInvId ? latestPiId : eventPiId },
            amount_paid: 9500,
          }],
        },
      })),
      markDuplicateSubscription: vi.fn().mockResolvedValue({ ok: true, data: {} }),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
      createRefund: vi.fn().mockResolvedValue({ ok: true, data: { id: "re_a26bMis" } }),
    });
    const rpc = fakeRpc({
      recordSubscriptionInvoice: vi.fn().mockRejectedValue(new PaymentsRpcError("customer_user_mismatch", "22023", 400)),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(rpc.otherEntitlingSubscriptionIds).toHaveBeenCalledExactlyOnceWith(userId, subId);
    expect(vi.mocked(stripe.markDuplicateSubscription).mock.calls).toEqual([[subId]]);
    // Both invoices listed and refunded, each exactly once (order-agnostic, like WH-AC_A26b)
    expect([...vi.mocked(stripe.listInvoicePayments).mock.calls].sort()).toEqual([[eventInvId], [latestInvId]].sort());
    expect([...vi.mocked(stripe.createRefund).mock.calls].sort()).toEqual(
      [[eventPiId, subId, 9500], [latestPiId, subId, 9500]].sort(),
    );
    expect(vi.mocked(stripe.cancelSubscription).mock.calls).toEqual([[subId]]);
    expectNoCollaboratorCalls(deps, {
      allow: ["retrieveSubscription", "recordSubscriptionInvoice", "otherEntitlingSubscriptionIds", "markDuplicateSubscription", "listInvoicePayments", "createRefund", "cancelSubscription"],
    });
    // Nothing is listed or refunded before the mismatch path has marked the sub (mark < every list)
    const [markOrd] = vi.mocked(stripe.markDuplicateSubscription).mock.invocationCallOrder;
    if (markOrd === undefined) throw new Error("WH-AC_A26b-mismatch: mark not called");
    for (const listOrd of vi.mocked(stripe.listInvoicePayments).mock.invocationCallOrder) {
      expect(markOrd).toBeLessThan(listOrd);
    }
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "invoice.paid",
      outcome: "duplicate_subscription_canceled",
      code: "unrecordable_refunded",
      paused: null,
    });
  });
});

describe("WH-AC_A26b-unmarked-malformed: invoice.paid; UNMARKED duplicate with a malformed latest_invoice → left alone and never marked, so this invoice is NOT refunded (A16 + A26)", () => {
  it("WH-AC_A26b-unmarked-malformed: keeper in DB; event sub newer with latest_invoice 'in_a26b bad' → no mark, list, refund or cancel; rejected invalid_subscription with the writer's paused", async () => {
    const eventSubId = "sub_a26bUmDup";
    const keeperId = "sub_a26bUmKeep";
    const eventInvId = "in_a26bUmEv";
    const userId = "00000000-0000-0000-0000-000000000001";
    const body = makeEventBody({
      type: "invoice.paid",
      dataObject: validStripeInvoice({
        id: eventInvId,
        parent: { type: "subscription_details", subscription_details: { subscription: eventSubId } },
        status_transitions: { paid_at: 1_700_000_001 },
      }),
    });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => ({
        ok: true,
        data: validStripeSubscription({
          id,
          status: "active",
          created: id === keeperId ? 1_699_000_000 : 1_700_000_000,
          metadata: { kind: "monitor_subscription", user_id: userId },
          latest_invoice: id === eventSubId ? "in_a26b bad" : "in_a26bUmKeepLast",
        }),
      })),
    });
    const rpc = fakeRpc({
      recordSubscriptionInvoice: vi.fn().mockResolvedValue({ outcome: "applied", paused: 3 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([keeperId]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(rpc.otherEntitlingSubscriptionIds).toHaveBeenCalledExactlyOnceWith(userId, eventSubId);
    expect(vi.mocked(stripe.retrieveSubscription).mock.calls).toEqual([[eventSubId], [keeperId]]);
    expectNoCollaboratorCalls(deps, {
      allow: ["retrieveSubscription", "recordSubscriptionInvoice", "otherEntitlingSubscriptionIds"],
    });
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "invoice.paid",
      outcome: "rejected",
      code: "invalid_subscription",
      paused: 3,
    });
  });
});

// ── WH-AC_A26b-keeper: invoice.paid; event sub is the KEEPER; DB-listed dup is marked/listed/refunded/canceled; keeper invoice never listed ──

describe("WH-AC_A26b-keeper: invoice.paid; event sub is the KEEPER (oldest unmarked); DB-listed dup marked/listed/refunded/canceled; keeper invoice never listed (A26)", () => {
  it("WH-AC_A26b-keeper: writer applies; event sub is keeper; DB dup retrieved, marked, listed, refunded, canceled; keeper latest_invoice never listed; duplicate_subscription_canceled code null", async () => {
    const keeperSubId = "sub_a26bKpKeep";   // event sub — older created → keeper
    const dupId = "sub_a26bKpDup";           // DB-listed — newer created → duplicate
    const keeperInvId = "in_a26bKpKeepLast"; // keeper's latest_invoice — NEVER listed
    const dupInvId = "in_a26bKpDupLast";     // dup's latest_invoice — listed & refunded
    const dupPiId = "pi_a26bKpDup";
    const userId = "00000000-0000-0000-0000-000000000001";
    const body = makeEventBody({
      type: "invoice.paid",
      dataObject: validStripeInvoice({
        id: "in_a26bKpEv",
        parent: { type: "subscription_details", subscription_details: { subscription: keeperSubId } },
        status_transitions: { paid_at: 1_700_000_001 },
      }),
    });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockImplementation(async (id: string) => ({
        ok: true,
        data: validStripeSubscription({
          id,
          status: "active",
          // keeper is OLDER (smaller created) → it is the keeper; dup is newer → dup
          created: id === keeperSubId ? 1_699_000_000 : 1_700_000_000,
          metadata: { kind: "monitor_subscription", user_id: userId },
          latest_invoice: id === keeperSubId ? keeperInvId : dupInvId,
        }),
      })),
      listInvoicePayments: vi.fn().mockResolvedValue({
        ok: true,
        data: { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: dupPiId }, amount_paid: 9500 }] },
      }),
      markDuplicateSubscription: vi.fn().mockResolvedValue({ ok: true, data: {} }),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
      createRefund: vi.fn().mockResolvedValue({ ok: true, data: { id: "re_a26bKp" } }),
    });
    const rpc = fakeRpc({
      recordSubscriptionInvoice: vi.fn().mockResolvedValue({ outcome: "applied", paused: 5 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([dupId]),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    // DB read ran with keeper's userId, excluding the keeper itself
    expect(rpc.otherEntitlingSubscriptionIds).toHaveBeenCalledExactlyOnceWith(userId, keeperSubId);
    // keeper retrieved first (event sub), then dup retrieved from DB
    expect(vi.mocked(stripe.retrieveSubscription).mock.calls).toEqual([[keeperSubId], [dupId]]);
    // dup is marked (not the keeper)
    expect(vi.mocked(stripe.markDuplicateSubscription).mock.calls).toEqual([[dupId]]);
    // only dup's invoice is listed; keeper's invoice (keeperInvId) and event invoice are NEVER listed
    expect(vi.mocked(stripe.listInvoicePayments).mock.calls).toEqual([[dupInvId]]);
    // only dup's PI is refunded; refund call references dupId as the sub
    expect(vi.mocked(stripe.createRefund).mock.calls).toEqual([[dupPiId, dupId, 9500]]);
    // only dup is canceled
    expect(vi.mocked(stripe.cancelSubscription).mock.calls).toEqual([[dupId]]);
    expectNoCollaboratorCalls(deps, {
      allow: ["retrieveSubscription", "recordSubscriptionInvoice", "otherEntitlingSubscriptionIds", "markDuplicateSubscription", "listInvoicePayments", "createRefund", "cancelSubscription"],
    });
    // invocationCallOrder: mark < refund < cancel
    const [kpMarkOrd] = vi.mocked(stripe.markDuplicateSubscription).mock.invocationCallOrder;
    const [kpRefundOrd] = vi.mocked(stripe.createRefund).mock.invocationCallOrder;
    const [kpCancelOrd] = vi.mocked(stripe.cancelSubscription).mock.invocationCallOrder;
    if (kpMarkOrd === undefined || kpRefundOrd === undefined || kpCancelOrd === undefined)
      throw new Error("WH-AC_A26b-keeper: expected mark, refund, cancel calls");
    expect(kpMarkOrd).toBeLessThan(kpRefundOrd);
    expect(kpRefundOrd).toBeLessThan(kpCancelOrd);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "invoice.paid",
      outcome: "duplicate_subscription_canceled",
      code: null,
      paused: 5,
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// A27(a) — unknown_user + non-null user_id → finish (like mismatch path), no DB read
// A27(b) — invoice.paid: retrieve-before-normalize; normalizer null on marked sub → refund
// ══════════════════════════════════════════════════════════════════════════════

// ── WH-AC_A27a: UNMARKED entitling sub refused unknown_user + non-null user_id → mark+refund+cancel ──

describe("WH-AC_A27a: UNMARKED entitling sub refused unknown_user with non-null user_id → mark+refund+cancel, duplicate_subscription_canceled, unrecordable_refunded, no DB read (A27a)", () => {
  it("WH-AC_A27a: active sub refused unknown_user, user_id non-null → mark→list→refund→cancel; otherEntitlingSubscriptionIds NOT called; paused null", async () => {
    const subId = "sub_a27aEnt";
    const latestInvId = "in_a27aLast";
    const piId = "pi_a27aEnt";
    const userId = "00000000-0000-0000-0000-000000000001";
    const body = makeEventBody({ type: "customer.subscription.updated", dataObject: { id: subId } });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockResolvedValue({
        ok: true,
        data: validStripeSubscription({
          id: subId,
          status: "active",
          metadata: { kind: "monitor_subscription", user_id: userId },
          latest_invoice: latestInvId,
        }),
      }),
      listInvoicePayments: vi.fn().mockResolvedValue({
        ok: true,
        data: { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: piId }, amount_paid: 9500 }] },
      }),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
      createRefund: vi.fn().mockResolvedValue({ ok: true, data: { id: "re_a27a" } }),
      markDuplicateSubscription: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockRejectedValue(new PaymentsRpcError("unknown_user", "22023", 400)),
      accountExists: vi.fn().mockResolvedValue(false), // A28: account deleted → proceed as A27(a)
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(vi.mocked(stripe.retrieveSubscription).mock.calls).toEqual([[subId]]);
    // No DB read of others (A27a: user no longer exists)
    expect(rpc.otherEntitlingSubscriptionIds).not.toHaveBeenCalled();
    // mark → list → refund → cancel
    expect(vi.mocked(stripe.markDuplicateSubscription).mock.calls).toEqual([[subId]]);
    expect(vi.mocked(stripe.listInvoicePayments).mock.calls).toEqual([[latestInvId]]);
    expect(vi.mocked(stripe.createRefund).mock.calls).toEqual([[piId, subId, 9500]]);
    expect(vi.mocked(stripe.cancelSubscription).mock.calls).toEqual([[subId]]);
    expectNoCollaboratorCalls(deps, {
      allow: ["retrieveSubscription", "syncSubscription", "accountExists", "markDuplicateSubscription", "listInvoicePayments", "createRefund", "cancelSubscription"],
    });
    // invocationCallOrder: mark < refund < cancel
    const [a27aMarkOrd] = vi.mocked(stripe.markDuplicateSubscription).mock.invocationCallOrder;
    const [a27aRefundOrd] = vi.mocked(stripe.createRefund).mock.invocationCallOrder;
    const [a27aCancelOrd] = vi.mocked(stripe.cancelSubscription).mock.invocationCallOrder;
    if (a27aMarkOrd === undefined || a27aRefundOrd === undefined || a27aCancelOrd === undefined)
      throw new Error("WH-AC_A27a: expected mark, refund, cancel calls");
    expect(a27aMarkOrd).toBeLessThan(a27aRefundOrd);
    expect(a27aRefundOrd).toBeLessThan(a27aCancelOrd);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.updated",
      outcome: "duplicate_subscription_canceled",
      code: "unrecordable_refunded",
      paused: null,
    });
  });
});

// ── WH-AC_A27a-nulluser: unknown_user + null user_id → rejected unknown_user ──

describe("WH-AC_A27a-nulluser: UNMARKED sub refused unknown_user with null user_id → rejected unknown_user, no Stripe calls beyond retrieve (A27a)", () => {
  it("WH-AC_A27a-nulluser: sub with null user_id refused unknown_user → rejected unknown_user; no mark/list/refund/cancel", async () => {
    const subId = "sub_a27aNull";
    const body = makeEventBody({ type: "customer.subscription.updated", dataObject: { id: subId } });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockResolvedValue({
        ok: true,
        data: validStripeSubscription({
          id: subId,
          status: "active",
          metadata: { kind: "monitor_subscription" }, // no user_id → normalizeSubscription returns user_id null
        }),
      }),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockRejectedValue(new PaymentsRpcError("unknown_user", "22023", 400)),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(vi.mocked(stripe.retrieveSubscription).mock.calls).toEqual([[subId]]);
    expectNoCollaboratorCalls(deps, { allow: ["retrieveSubscription", "syncSubscription"] });
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.updated",
      outcome: "rejected",
      code: "unknown_user",
      paused: null,
    });
  });
});

// ── WH-AC_A27a-nonentitling: non-entitling sub refused unknown_user → rejected ──

describe("WH-AC_A27a-nonentitling: non-entitling sub refused unknown_user → rejected unknown_user (A27a)", () => {
  it("WH-AC_A27a-nonentitling: canceled sub with non-null user_id refused unknown_user → rejected unknown_user; no Stripe calls beyond retrieve", async () => {
    const subId = "sub_a27aCanc";
    const userId = "00000000-0000-0000-0000-000000000002";
    const body = makeEventBody({ type: "customer.subscription.updated", dataObject: { id: subId } });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockResolvedValue({
        ok: true,
        data: validStripeSubscription({
          id: subId,
          status: "canceled",
          metadata: { kind: "monitor_subscription", user_id: userId },
        }),
      }),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockRejectedValue(new PaymentsRpcError("unknown_user", "22023", 400)),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(vi.mocked(stripe.retrieveSubscription).mock.calls).toEqual([[subId]]);
    expectNoCollaboratorCalls(deps, { allow: ["retrieveSubscription", "syncSubscription"] });
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.updated",
      outcome: "rejected",
      code: "unknown_user",
      paused: null,
    });
  });
});

// ── WH-AC_A27a-malformed-invoice: unknown_user + non-null user_id + malformed latest_invoice → A16 ──

describe("WH-AC_A27a-malformed-invoice: UNMARKED entitling sub refused unknown_user with non-null user_id and malformed latest_invoice → A16 applies, no finish (A27a)", () => {
  it("WH-AC_A27a-malformed-invoice: latest_invoice 'in_a27a bad' (malformed) → no mark/list/refund/cancel; rejected invalid_subscription (A16)", async () => {
    const subId = "sub_a27aMlf";
    const userId = "00000000-0000-0000-0000-000000000001";
    const body = makeEventBody({ type: "customer.subscription.updated", dataObject: { id: subId } });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockResolvedValue({
        ok: true,
        data: validStripeSubscription({
          id: subId,
          status: "active",
          metadata: { kind: "monitor_subscription", user_id: userId },
          latest_invoice: "in_a27a bad", // space makes it not match ^in_[A-Za-z0-9]+$
        }),
      }),
    });
    const rpc = fakeRpc({
      syncSubscription: vi.fn().mockRejectedValue(new PaymentsRpcError("unknown_user", "22023", 400)),
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(vi.mocked(stripe.retrieveSubscription).mock.calls).toEqual([[subId]]);
    // A16: malformed latest_invoice → no mark, list, refund, or cancel
    expectNoCollaboratorCalls(deps, { allow: ["retrieveSubscription", "syncSubscription"] });
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "customer.subscription.updated",
      outcome: "rejected",
      code: "invalid_subscription",
      paused: null,
    });
  });
});

// ── WH-AC_A27a-invpaid: invoice.paid + unknown_user + non-null user_id → both invoices refunded (A26b+A27a) ──

describe("WH-AC_A27a-invpaid: invoice.paid + UNMARKED entitling sub refused unknown_user + non-null user_id → event invoice refunded in addition to latest_invoice when different (A26b + A27a)", () => {
  it("WH-AC_A27a-invpaid: event invoice ≠ latest_invoice → listInvoicePayments called twice (latest then event); both refunded; duplicate_subscription_canceled, unrecordable_refunded, paused null", async () => {
    const subId = "sub_a27aInvEnt";
    const latestInvId = "in_a27aLstInv";
    const eventInvId = "in_a27aEvInv"; // different from latest
    const piLastId = "pi_a27aLstPi";
    const piEvId = "pi_a27aEvPi";
    const userId = "00000000-0000-0000-0000-000000000001";
    const body = makeEventBody({
      type: "invoice.paid",
      dataObject: validStripeInvoice({
        id: eventInvId,
        parent: { type: "subscription_details", subscription_details: { subscription: subId } },
        status_transitions: { paid_at: 1_700_000_001 },
      }),
    });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockResolvedValue({
        ok: true,
        data: validStripeSubscription({
          id: subId,
          status: "active",
          metadata: { kind: "monitor_subscription", user_id: userId },
          latest_invoice: latestInvId,
        }),
      }),
      listInvoicePayments: vi.fn().mockImplementation(async (invId: string) => ({
        ok: true,
        data: {
          data: [{
            status: "paid",
            payment: { type: "payment_intent", payment_intent: invId === latestInvId ? piLastId : piEvId },
            amount_paid: 9500,
          }],
        },
      })),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
      createRefund: vi.fn().mockResolvedValue({ ok: true, data: { id: "re_a27aInv" } }),
      markDuplicateSubscription: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    });
    const rpc = fakeRpc({
      recordSubscriptionInvoice: vi.fn().mockRejectedValue(new PaymentsRpcError("unknown_user", "22023", 400)),
      accountExists: vi.fn().mockResolvedValue(false), // A28: account deleted → proceed as A27(a) path (A26b+A27a)
    });
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(vi.mocked(stripe.retrieveSubscription).mock.calls).toEqual([[subId]]);
    expect(rpc.otherEntitlingSubscriptionIds).not.toHaveBeenCalled();
    expect(vi.mocked(stripe.markDuplicateSubscription).mock.calls).toEqual([[subId]]);
    // list called for latest_invoice first (cancelAndRefund), then event invoice (A26b)
    expect(vi.mocked(stripe.listInvoicePayments).mock.calls).toEqual([[latestInvId], [eventInvId]]);
    expect(vi.mocked(stripe.createRefund).mock.calls).toEqual([[piLastId, subId, 9500], [piEvId, subId, 9500]]);
    expect(vi.mocked(stripe.cancelSubscription).mock.calls).toEqual([[subId]]);
    expectNoCollaboratorCalls(deps, {
      allow: ["retrieveSubscription", "recordSubscriptionInvoice", "accountExists", "markDuplicateSubscription", "listInvoicePayments", "createRefund", "cancelSubscription"],
    });
    // invocationCallOrder: mark < latest_refund < cancel < event_refund (A26b sequence)
    const [a27aInvMarkOrd] = vi.mocked(stripe.markDuplicateSubscription).mock.invocationCallOrder;
    const [a27aInvLatestRefundOrd] = vi.mocked(stripe.createRefund).mock.invocationCallOrder;
    const a27aInvEventRefundOrd = vi.mocked(stripe.createRefund).mock.invocationCallOrder[1];
    const [a27aInvCancelOrd] = vi.mocked(stripe.cancelSubscription).mock.invocationCallOrder;
    if (a27aInvMarkOrd === undefined || a27aInvLatestRefundOrd === undefined || a27aInvEventRefundOrd === undefined || a27aInvCancelOrd === undefined)
      throw new Error("WH-AC_A27a-invpaid: expected mark, two refunds, and cancel calls");
    expect(a27aInvMarkOrd).toBeLessThan(a27aInvLatestRefundOrd);
    expect(a27aInvLatestRefundOrd).toBeLessThan(a27aInvCancelOrd);
    expect(a27aInvCancelOrd).toBeLessThan(a27aInvEventRefundOrd);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "invoice.paid",
      outcome: "duplicate_subscription_canceled",
      code: "unrecordable_refunded",
      paused: null,
    });
  });
});

// ── WH-AC_A27b-normalizeInvoice-null-marked: invoice.paid; retrieve first; normalizeInvoice null + raw marked → duplicate_invoice_refunded ──

describe("WH-AC_A27b-normalizeInvoice-null-marked: invoice.paid; getSub called first (A27b); normalizeInvoice null + raw marked sub (id matches) → duplicate_invoice_refunded, code invalid_invoice; no writer, no cancel (A27b)", () => {
  it("WH-AC_A27b-normalizeInvoice-null-marked: invoice missing paid_at; raw sub id=parentSubId and duplicate_subscription='true' → retrieve; list event invoice; refund paid PI; no writer; duplicate_invoice_refunded invalid_invoice paused null", async () => {
    const subId = "sub_a27bInvMrk";
    const invId = "in_a27bNullInv";
    const piId = "pi_a27bNullInv";
    const body = makeEventBody({
      type: "invoice.paid",
      dataObject: {
        id: invId,
        parent: { type: "subscription_details", subscription_details: { subscription: subId } },
        amount_paid: 9500,
        status_transitions: {}, // no paid_at → normalizeInvoice null
        lines: { data: [] },
        total_taxes: [],
        customer_email: "test@test.local",
      },
    });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          id: subId, // raw id matches parent sub id ✓
          customer: "cus_a27bInvMrk",
          status: "active",
          metadata: { duplicate_subscription: "true" }, // raw marked
          items: { data: [{ price: { id: "price_a27b1" }, current_period_end: 1_732_000_000 }] },
          cancel_at_period_end: false,
          created: 1_700_000_000,
          latest_invoice: "in_a27bInvLast",
        },
      }),
      listInvoicePayments: vi.fn().mockResolvedValue({
        ok: true,
        data: { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: piId }, amount_paid: 9500 }] },
      }),
      createRefund: vi.fn().mockResolvedValue({ ok: true, data: { id: "re_a27bInvMrk" } }),
    });
    const rpc = fakeRpc();
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    // retrieve called first (A27b order)
    expect(vi.mocked(stripe.retrieveSubscription).mock.calls).toEqual([[subId]]);
    // list called for event invoice id (not latest_invoice)
    expect(vi.mocked(stripe.listInvoicePayments).mock.calls).toEqual([[invId]]);
    expect(vi.mocked(stripe.createRefund).mock.calls).toEqual([[piId, subId, 9500]]);
    // no writer, no mark (raw already marked), no cancel
    expectNoCollaboratorCalls(deps, {
      allow: ["retrieveSubscription", "listInvoicePayments", "createRefund"],
    });
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "invoice.paid",
      outcome: "duplicate_invoice_refunded",
      code: "invalid_invoice",
      paused: null,
    });
  });
});

// ── WH-AC_A27b-normalizeSubscription-null-marked: invoice.paid; normalizeInvoice ok; normalizeSubscription null + raw marked → duplicate_invoice_refunded ──

describe("WH-AC_A27b-normalizeSubscription-null-marked: invoice.paid; normalizeInvoice succeeds; normalizeSubscription null + raw marked sub (id matches) → duplicate_invoice_refunded, code invalid_subscription; no writer, no cancel (A27b)", () => {
  it("WH-AC_A27b-normalizeSubscription-null-marked: bad sub status ('bogus_status'); raw id=parentSubId, duplicate_subscription='true' → retrieve; no writer; list event invoice; refund; duplicate_invoice_refunded invalid_subscription paused null", async () => {
    const subId = "sub_a27bSubMrk";
    const invId = "in_a27bSubMrk";
    const piId = "pi_a27bSubMrk";
    const body = makeEventBody({
      type: "invoice.paid",
      dataObject: validStripeInvoice({
        id: invId,
        parent: { type: "subscription_details", subscription_details: { subscription: subId } },
        status_transitions: { paid_at: 1_700_000_001 },
      }),
    });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          id: subId, // raw id matches parent sub id ✓
          customer: "cus_a27bSubMrk",
          status: "bogus_status", // → normalizeSubscription returns null
          metadata: { kind: "monitor_subscription", user_id: "00000000-0000-0000-0000-000000000001", duplicate_subscription: "true" },
          items: { data: [{ price: { id: "price_a27b2" }, current_period_end: 1_732_000_000 }] },
          cancel_at_period_end: false,
          created: 1_700_000_000,
          latest_invoice: "in_a27bSubLast",
        },
      }),
      listInvoicePayments: vi.fn().mockResolvedValue({
        ok: true,
        data: { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: piId }, amount_paid: 9500 }] },
      }),
      createRefund: vi.fn().mockResolvedValue({ ok: true, data: { id: "re_a27bSubMrk" } }),
    });
    const rpc = fakeRpc();
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(vi.mocked(stripe.retrieveSubscription).mock.calls).toEqual([[subId]]);
    // list called for event invoice (not latest_invoice)
    expect(vi.mocked(stripe.listInvoicePayments).mock.calls).toEqual([[invId]]);
    expect(vi.mocked(stripe.createRefund).mock.calls).toEqual([[piId, subId, 9500]]);
    // no writer (early refund on raw mark), no mark, no cancel
    expectNoCollaboratorCalls(deps, {
      allow: ["retrieveSubscription", "listInvoicePayments", "createRefund"],
    });
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "invoice.paid",
      outcome: "duplicate_invoice_refunded",
      code: "invalid_subscription",
      paused: null,
    });
  });
});

// ── WH-AC_A27b-normalizeSubscription-null-unmarked: invoice.paid; normalizeSubscription null + raw UNMARKED → rejected ──

describe("WH-AC_A27b-normalizeSubscription-null-unmarked: invoice.paid; normalizeInvoice succeeds; normalizeSubscription null + raw UNMARKED sub → rejected invalid_subscription; retrieve called; no list/refund/writer (A27b)", () => {
  it("WH-AC_A27b-normalizeSubscription-null-unmarked: bad status ('bogus_status'), unmarked sub → retrieve called; rejected invalid_subscription; no list, refund, or writer", async () => {
    const subId = "sub_a27bSubUmk";
    const invId = "in_a27bSubUmk";
    const body = makeEventBody({
      type: "invoice.paid",
      dataObject: validStripeInvoice({
        id: invId,
        parent: { type: "subscription_details", subscription_details: { subscription: subId } },
        status_transitions: { paid_at: 1_700_000_001 },
      }),
    });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          id: subId,
          customer: "cus_a27bSubUmk",
          status: "bogus_status", // → normalizeSubscription null
          metadata: { kind: "monitor_subscription", user_id: "00000000-0000-0000-0000-000000000001" }, // UNMARKED
          items: { data: [{ price: { id: "price_a27b3" }, current_period_end: 1_732_000_000 }] },
          cancel_at_period_end: false,
          created: 1_700_000_000,
          latest_invoice: "in_a27bSubUmkLast",
        },
      }),
    });
    const rpc = fakeRpc();
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(vi.mocked(stripe.retrieveSubscription).mock.calls).toEqual([[subId]]);
    expectNoCollaboratorCalls(deps, { allow: ["retrieveSubscription"] });
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "invoice.paid",
      outcome: "rejected",
      code: "invalid_subscription",
      paused: null,
    });
  });
});

// ── WH-AC_A27b-raw-id-mismatch: invoice.paid; normalizeInvoice null; raw sub id ≠ parent sub id → not marked → rejected ──

describe("WH-AC_A27b-raw-id-mismatch: invoice.paid; normalizeInvoice null; raw retrieved sub id ≠ parent sub id → treated as unmarked (not marked); rejected invalid_invoice; getSub IS called (A27b)", () => {
  it("WH-AC_A27b-raw-id-mismatch: Stripe returns different sub id; raw has duplicate_subscription='true'; id mismatch → not refunded; rejected invalid_invoice; retrieve called; no list/refund", async () => {
    const parentSubId = "sub_a27bIdMis";
    const wrongSubId = "sub_a27bIdOth"; // what Stripe returns — ≠ parentSubId
    const invId = "in_a27bIdMis";
    const body = makeEventBody({
      type: "invoice.paid",
      dataObject: {
        id: invId,
        parent: { type: "subscription_details", subscription_details: { subscription: parentSubId } },
        amount_paid: 9500,
        status_transitions: {}, // no paid_at → normalizeInvoice null (triggers A27b check)
        lines: { data: [] },
        total_taxes: [],
        customer_email: "test@test.local",
      },
    });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          id: wrongSubId, // ≠ parentSubId → id mismatch → mark check is false
          customer: "cus_a27bIdMis",
          status: "active",
          metadata: { duplicate_subscription: "true" }, // has mark but id mismatch means it doesn't apply
          items: { data: [{ price: { id: "price_a27b4" }, current_period_end: 1_732_000_000 }] },
          cancel_at_period_end: false,
          created: 1_700_000_000,
        },
      }),
    });
    const rpc = fakeRpc();
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    // retrieve IS called (A27b: before normalize)
    expect(vi.mocked(stripe.retrieveSubscription).mock.calls).toEqual([[parentSubId]]);
    // id mismatch → not marked → no list, refund, or writer
    expectNoCollaboratorCalls(deps, { allow: ["retrieveSubscription"] });
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "invoice.paid",
      outcome: "rejected",
      code: "invalid_invoice",
      paused: null,
    });
  });
});

// ── Developer-added (A27b): marked raw sub, normalizer null, no paid payment / transient refund failure ──

/** invoice.paid whose invoice lacks paid_at (normalizeInvoice null) for a raw-marked subscription with the parent id. */
function a27bMarkedNullInvoice(subId: string, invId: string) {
  return {
    body: makeEventBody({
      type: "invoice.paid",
      dataObject: {
        id: invId,
        parent: { type: "subscription_details", subscription_details: { subscription: subId } },
        amount_paid: 9500,
        status_transitions: {},
        lines: { data: [] },
      },
    }),
    retrieveSubscription: vi.fn().mockResolvedValue({
      ok: true,
      data: validStripeSubscription({ id: subId, status: "active", metadata: { duplicate_subscription: "true" } }),
    }),
  };
}

describe("WH-AC_A27b-marked-nopaid: invoice.paid; normalizeInvoice null; raw marked sub; no paid payment → the rejection stands (A27b + A25 'none refunded')", () => {
  it("WH-AC_A27b-marked-nopaid: the event invoice's only payment is open → listed, nothing refunded; no writer; rejected invalid_invoice, paused null", async () => {
    const subId = "sub_a27bNoPaid";
    const invId = "in_a27bNoPaid";
    const { body, retrieveSubscription } = a27bMarkedNullInvoice(subId, invId);
    const stripe = fakeStripe({
      retrieveSubscription,
      listInvoicePayments: vi.fn().mockResolvedValue({
        ok: true,
        data: { data: [{ status: "open", payment: { type: "payment_intent", payment_intent: "pi_a27bNoPaid" }, amount_paid: 0 }] },
      }),
    });
    const deps = { ...fakeDeps(), stripe, rpc: fakeRpc() };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(vi.mocked(stripe.retrieveSubscription).mock.calls).toEqual([[subId]]);
    expect(vi.mocked(stripe.listInvoicePayments).mock.calls).toEqual([[invId]]);
    expectNoCollaboratorCalls(deps, { allow: ["retrieveSubscription", "listInvoicePayments"] });
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "invoice.paid",
      outcome: "rejected",
      code: "invalid_invoice",
      paused: null,
    });
  });
});

describe("WH-AC_A27b-marked-transient: invoice.paid; normalizeInvoice null; raw marked sub; the refund fails transiently → 500 so Stripe redelivers (A27b)", () => {
  it.each([
    {
      label: "stripe_http_503",
      createRefundResult: { ok: false as const, kind: "http" as const, status: 503, code: null },
      expectedCode: "stripe_http_503",
    },
    {
      label: "stripe_network",
      createRefundResult: { ok: false as const, kind: "network" as const },
      expectedCode: "stripe_network",
    },
    {
      label: "stripe_invalid_response",
      createRefundResult: { ok: false as const, kind: "invalid_response" as const },
      expectedCode: "stripe_invalid_response",
    },
  ])(
    "WH-AC_A27b-marked-transient: createRefund $label → 500 error $expectedCode; no writer",
    async ({ createRefundResult, expectedCode }) => {
      const subId = "sub_a27bTrans";
      const invId = "in_a27bTrans";
      const { body, retrieveSubscription } = a27bMarkedNullInvoice(subId, invId);
      const stripe = fakeStripe({
        retrieveSubscription,
        listInvoicePayments: vi.fn().mockResolvedValue({
          ok: true,
          data: { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: "pi_a27bTrans" }, amount_paid: 9500 }] },
        }),
        createRefund: vi.fn().mockResolvedValue(createRefundResult),
      });
      const deps = { ...fakeDeps(), stripe, rpc: fakeRpc() };
      const resp = await handleStripeWebhook(makeRequest(body), deps);
      expect(resp.status).toBe(500);
      expect(vi.mocked(stripe.createRefund).mock.calls).toEqual([["pi_a27bTrans", subId, 9500]]);
      expectNoCollaboratorCalls(deps, { allow: ["retrieveSubscription", "listInvoicePayments", "createRefund"] });
      expect(parseLog(deps)).toEqual({
        msg: "payments webhook",
        event: "evt_test001",
        type: "invoice.paid",
        outcome: "error",
        code: expectedCode,
        paused: null,
      });
    },
  );
});

// ── WH-AC_A27b-both-null-marked: both normalizers null; invoice checked first → code invalid_invoice ──

describe("WH-AC_A27b-both-null-marked: invoice.paid; normalizeInvoice null + normalizeSubscription null; raw marked sub, matching id; invoice checked first → duplicate_invoice_refunded code invalid_invoice (A27b)", () => {
  it("WH-AC_A27b-both-null-marked: no paid_at (normalizeInvoice null) + bogus_status (normalizeSubscription null); raw marked matching sub; paid PI → refunded; outcome duplicate_invoice_refunded code invalid_invoice (not invalid_subscription)", async () => {
    const subId = "sub_a27bBothNull";
    const invId = "in_a27bBothNull";
    const piId = "pi_a27bBothNull";
    // Invoice missing paid_at → normalizeInvoice returns null
    const body = makeEventBody({
      type: "invoice.paid",
      dataObject: {
        id: invId,
        parent: { type: "subscription_details", subscription_details: { subscription: subId } },
        amount_paid: 9500,
        status_transitions: {}, // no paid_at → normalizeInvoice null
        lines: { data: [] },
      },
    });
    // bogus_status → normalizeSubscription returns null; but raw sub IS marked with matching id
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockResolvedValue({
        ok: true,
        data: validStripeSubscription({ id: subId, status: "bogus_status", metadata: { duplicate_subscription: "true" } }),
      }),
      listInvoicePayments: vi.fn().mockResolvedValue({
        ok: true,
        data: { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: piId }, amount_paid: 9500 }] },
      }),
      createRefund: vi.fn().mockResolvedValue({ ok: true, data: { id: "re_a27bBothNull" } }),
    });
    const deps = { ...fakeDeps(), stripe, rpc: fakeRpc() };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    // Retrieve called first (A27b order)
    expect(vi.mocked(stripe.retrieveSubscription).mock.calls).toEqual([[subId]]);
    // Invoice listed, PI refunded (marked path triggered)
    expect(vi.mocked(stripe.listInvoicePayments).mock.calls).toEqual([[invId]]);
    expect(vi.mocked(stripe.createRefund).mock.calls).toEqual([[piId, subId, 9500]]);
    // Writer NOT called (normalizer failed)
    expectNoCollaboratorCalls(deps, { allow: ["retrieveSubscription", "listInvoicePayments", "createRefund"] });
    // Invoice checked first → code invalid_invoice (not invalid_subscription, even though sub normalizer also fails)
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "invoice.paid",
      outcome: "duplicate_invoice_refunded",
      code: "invalid_invoice",
      paused: null,
    });
  });
});

// ── WH-AC11b-retrieve-404 / -retrieve-503: invoice.paid retrieve failures (retrieve-first per A27b) ──

describe("WH-AC11b-retrieve-404: invoice.paid with bad invoice; retrieve → 404 → 200 rejected subscription_not_found before invoice validation (retrieve-first per A27b)", () => {
  it("WH-AC11b-retrieve-404: bad invoice (no paid_at) + retrieve 404 → rejected subscription_not_found, not invalid_invoice; retrieve called; no listInvoicePayments, no writer", async () => {
    // Bad invoice: status_transitions:{} → normalizeInvoice would return null (invalid_invoice)
    // But retrieve fires first; 404 wins → subscription_not_found (not invalid_invoice)
    const body = makeEventBody({
      type: "invoice.paid",
      dataObject: {
        id: "in_a27bRet404",
        parent: { type: "subscription_details", subscription_details: { subscription: "sub_a27bRet404" } },
        amount_paid: 9500,
        status_transitions: {}, // no paid_at → would be invalid_invoice if retrieve succeeded
        lines: { data: [] },
      },
    });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockResolvedValue({ ok: false, kind: "http", status: 404, code: "resource_missing" }),
    });
    const deps = { ...fakeDeps(), stripe, rpc: fakeRpc() };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(vi.mocked(stripe.retrieveSubscription).mock.calls).toEqual([["sub_a27bRet404"]]);
    expectNoCollaboratorCalls(deps, { allow: ["retrieveSubscription"] });
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "invoice.paid",
      outcome: "rejected",
      code: "subscription_not_found",
      paused: null,
    });
  });
});

describe("WH-AC11b-retrieve-503: invoice.paid with bad invoice; retrieve → 503 → 500 stripe_http_503 before invoice validation (retrieve-first per A27b)", () => {
  it("WH-AC11b-retrieve-503: bad invoice (no paid_at) + retrieve 503 → 500 stripe_http_503, not invalid_invoice; retrieve called; no listInvoicePayments, no writer", async () => {
    // Bad invoice: status_transitions:{} → normalizeInvoice would return null (invalid_invoice)
    // But retrieve fires first; 503 transient wins → 500 stripe_http_503 (not invalid_invoice)
    const body = makeEventBody({
      type: "invoice.paid",
      dataObject: {
        id: "in_a27bRet503",
        parent: { type: "subscription_details", subscription_details: { subscription: "sub_a27bRet503" } },
        amount_paid: 9500,
        status_transitions: {}, // no paid_at → would be invalid_invoice if retrieve succeeded
        lines: { data: [] },
      },
    });
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockResolvedValue({ ok: false, kind: "http", status: 503, code: null }),
    });
    const deps = { ...fakeDeps(), stripe, rpc: fakeRpc() };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(500);
    expect(vi.mocked(stripe.retrieveSubscription).mock.calls).toEqual([["sub_a27bRet503"]]);
    expectNoCollaboratorCalls(deps, { allow: ["retrieveSubscription"] });
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: "invoice.paid",
      outcome: "error",
      code: "stripe_http_503",
      paused: null,
    });
  });
});

// ── WH-AC_A28a: accountExists check before the A27(a) finish ─────────────────

type A28FalseRow = {
  label: string;
  makeBody: (subId: string, invId: string) => string;
  makeRpcOverrides: () => Partial<PaymentsRpc>;
  allowWriter: Array<keyof StripeApi | keyof PaymentsRpc>;
  getWriterOrder: (rpc: PaymentsRpc) => number | undefined;
  logType: string;
};
type A28WebhookRow = {
  label: string;
  makeBody: (subId: string, invId: string) => string;
  makeRpcOverrides: () => Partial<PaymentsRpc>;
  allowWriter: Array<keyof StripeApi | keyof PaymentsRpc>;
  logType: string;
};
type A28TransientRow = {
  label: string;
  makeBody: (subId: string, invId: string) => string;
  makeRpcOverrides: () => Partial<PaymentsRpc>;
  allowWriter: Array<keyof StripeApi | keyof PaymentsRpc>;
  logType: string;
  expectedCode: string;
};

describe("WH-AC_A28a-false: accountExists returns false → A27(a) finishes (mark→refund→cancel); invocationCallOrder writer < accountExists < mark; both event types (A28a)", () => {
  const csuFalseAllow: Array<keyof StripeApi | keyof PaymentsRpc> = ["syncSubscription"];
  const invpaidFalseAllow: Array<keyof StripeApi | keyof PaymentsRpc> = ["recordSubscriptionInvoice"];

  it.each<A28FalseRow>([
    {
      label: "customer.subscription.updated",
      makeBody: (subId: string) => makeEventBody({ type: "customer.subscription.updated", dataObject: { id: subId } }),
      makeRpcOverrides: () => ({
        syncSubscription: vi.fn().mockRejectedValue(new PaymentsRpcError("unknown_user", "22023", 400)),
        accountExists: vi.fn().mockResolvedValue(false),
      }),
      allowWriter: csuFalseAllow,
      getWriterOrder: (rpc: PaymentsRpc) => vi.mocked(rpc.syncSubscription).mock.invocationCallOrder[0],
      logType: "customer.subscription.updated",
    },
    {
      label: "invoice.paid",
      makeBody: (subId: string, invId: string) => makeEventBody({
        type: "invoice.paid",
        dataObject: validStripeInvoice({
          id: invId,
          parent: { type: "subscription_details", subscription_details: { subscription: subId } },
          status_transitions: { paid_at: 1_700_000_001 },
        }),
      }),
      makeRpcOverrides: () => ({
        recordSubscriptionInvoice: vi.fn().mockRejectedValue(new PaymentsRpcError("unknown_user", "22023", 400)),
        accountExists: vi.fn().mockResolvedValue(false),
      }),
      allowWriter: invpaidFalseAllow,
      getWriterOrder: (rpc: PaymentsRpc) => vi.mocked(rpc.recordSubscriptionInvoice).mock.invocationCallOrder[0],
      logType: "invoice.paid",
    },
  ])("WH-AC_A28a-false: $label — accountExists(false) → A27(a) finish; writer < accountExists < mark", async ({
    makeBody, makeRpcOverrides, allowWriter, getWriterOrder, logType,
  }) => {
    const subId = "sub_a28aFalse";
    const latestInvId = "in_a28aFalse";
    const piId = "pi_a28aFalse";
    const userId = "00000000-0000-0000-0000-000000000002";
    const body = makeBody(subId, latestInvId);
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockResolvedValue({
        ok: true,
        data: validStripeSubscription({
          id: subId,
          status: "active",
          metadata: { kind: "monitor_subscription", user_id: userId },
          latest_invoice: latestInvId,
        }),
      }),
      listInvoicePayments: vi.fn().mockResolvedValue({
        ok: true,
        data: { data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: piId }, amount_paid: 9500 }] },
      }),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: true, data: { status: "canceled" } }),
      createRefund: vi.fn().mockResolvedValue({ ok: true, data: { id: "re_a28aF" } }),
      markDuplicateSubscription: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    });
    const rpc = fakeRpc(makeRpcOverrides());
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(200);
    expect(vi.mocked(stripe.retrieveSubscription).mock.calls).toEqual([[subId]]);
    expect(vi.mocked(rpc.accountExists).mock.calls).toEqual([[userId]]);
    expect(rpc.otherEntitlingSubscriptionIds).not.toHaveBeenCalled();
    expect(vi.mocked(stripe.markDuplicateSubscription).mock.calls).toEqual([[subId]]);
    expect(vi.mocked(stripe.listInvoicePayments).mock.calls).toEqual([[latestInvId]]);
    expect(vi.mocked(stripe.createRefund).mock.calls).toEqual([[piId, subId, 9500]]);
    expect(vi.mocked(stripe.cancelSubscription).mock.calls).toEqual([[subId]]);
    const allow: Array<keyof StripeApi | keyof PaymentsRpc> = [
      "retrieveSubscription", ...allowWriter, "accountExists",
      "markDuplicateSubscription", "listInvoicePayments", "createRefund", "cancelSubscription",
    ];
    expectNoCollaboratorCalls(deps, { allow });
    // invocationCallOrder: writer < accountExists < mark (A28a)
    const writerOrd = getWriterOrder(rpc);
    const [accountOrd] = vi.mocked(rpc.accountExists).mock.invocationCallOrder;
    const [markOrd] = vi.mocked(stripe.markDuplicateSubscription).mock.invocationCallOrder;
    if (writerOrd === undefined || accountOrd === undefined || markOrd === undefined)
      throw new Error("WH-AC_A28a-false: expected writer, accountExists, and mark calls");
    expect(writerOrd).toBeLessThan(accountOrd);
    expect(accountOrd).toBeLessThan(markOrd);
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: logType,
      outcome: "duplicate_subscription_canceled",
      code: "unrecordable_refunded",
      paused: null,
    });
  });
});

describe("WH-AC_A28a-true: accountExists returns true → 500 missing_profile; no Stripe mutation; both event types (A28a)", () => {
  const csuTrueAllow: Array<keyof StripeApi | keyof PaymentsRpc> = ["syncSubscription"];
  const invpaidTrueAllow: Array<keyof StripeApi | keyof PaymentsRpc> = ["recordSubscriptionInvoice"];

  it.each<A28WebhookRow>([
    {
      label: "customer.subscription.updated",
      makeBody: (subId: string) => makeEventBody({ type: "customer.subscription.updated", dataObject: { id: subId } }),
      makeRpcOverrides: () => ({
        syncSubscription: vi.fn().mockRejectedValue(new PaymentsRpcError("unknown_user", "22023", 400)),
        accountExists: vi.fn().mockResolvedValue(true),
      }),
      allowWriter: csuTrueAllow,
      logType: "customer.subscription.updated",
    },
    {
      label: "invoice.paid",
      makeBody: (subId: string, invId: string) => makeEventBody({
        type: "invoice.paid",
        dataObject: validStripeInvoice({
          id: invId,
          parent: { type: "subscription_details", subscription_details: { subscription: subId } },
          status_transitions: { paid_at: 1_700_000_001 },
        }),
      }),
      makeRpcOverrides: () => ({
        recordSubscriptionInvoice: vi.fn().mockRejectedValue(new PaymentsRpcError("unknown_user", "22023", 400)),
        accountExists: vi.fn().mockResolvedValue(true),
      }),
      allowWriter: invpaidTrueAllow,
      logType: "invoice.paid",
    },
  ])("WH-AC_A28a-true: $label — accountExists(true) → 500 missing_profile; no Stripe mutation", async ({
    makeBody, makeRpcOverrides, allowWriter, logType,
  }) => {
    const subId = "sub_a28aTrue";
    const userId = "00000000-0000-0000-0000-000000000003";
    const body = makeBody(subId, "in_a28aTrInv");
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockResolvedValue({
        ok: true,
        data: validStripeSubscription({
          id: subId,
          status: "active",
          metadata: { kind: "monitor_subscription", user_id: userId },
          latest_invoice: "in_a28aTrInv",
        }),
      }),
    });
    const rpc = fakeRpc(makeRpcOverrides());
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(500);
    expect(vi.mocked(rpc.accountExists).mock.calls).toEqual([[userId]]);
    const allow: Array<keyof StripeApi | keyof PaymentsRpc> = [
      "retrieveSubscription", ...allowWriter, "accountExists",
    ];
    expectNoCollaboratorCalls(deps, { allow });
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: logType,
      outcome: "error",
      code: "missing_profile",
      paused: null,
    });
  });
});

describe("WH-AC_A28a-transient: accountExists throws PaymentsRpcError → 500 rpc code; no Stripe mutation; both event types; both status kinds (A28a)", () => {
  const csuTransAllow: Array<keyof StripeApi | keyof PaymentsRpc> = ["syncSubscription"];
  const invpaidTransAllow: Array<keyof StripeApi | keyof PaymentsRpc> = ["recordSubscriptionInvoice"];

  it.each<A28TransientRow>([
    {
      label: "customer.subscription.updated HTTP 503",
      makeBody: (subId: string) => makeEventBody({ type: "customer.subscription.updated", dataObject: { id: subId } }),
      makeRpcOverrides: () => ({
        syncSubscription: vi.fn().mockRejectedValue(new PaymentsRpcError("unknown_user", "22023", 400)),
        accountExists: vi.fn().mockRejectedValue(new PaymentsRpcError("rpc_failed", "unknown", 503)),
      }),
      allowWriter: csuTransAllow,
      logType: "customer.subscription.updated",
      expectedCode: "rpc_unknown_503",
    },
    {
      label: "invoice.paid HTTP 503",
      makeBody: (subId: string, invId: string) => makeEventBody({
        type: "invoice.paid",
        dataObject: validStripeInvoice({
          id: invId,
          parent: { type: "subscription_details", subscription_details: { subscription: subId } },
          status_transitions: { paid_at: 1_700_000_001 },
        }),
      }),
      makeRpcOverrides: () => ({
        recordSubscriptionInvoice: vi.fn().mockRejectedValue(new PaymentsRpcError("unknown_user", "22023", 400)),
        accountExists: vi.fn().mockRejectedValue(new PaymentsRpcError("rpc_failed", "unknown", 503)),
      }),
      allowWriter: invpaidTransAllow,
      logType: "invoice.paid",
      expectedCode: "rpc_unknown_503",
    },
    {
      label: "customer.subscription.updated null status (network/timeout)",
      makeBody: (subId: string) => makeEventBody({ type: "customer.subscription.updated", dataObject: { id: subId } }),
      makeRpcOverrides: () => ({
        syncSubscription: vi.fn().mockRejectedValue(new PaymentsRpcError("unknown_user", "22023", 400)),
        accountExists: vi.fn().mockRejectedValue(new PaymentsRpcError("rpc_failed", "unknown", null)),
      }),
      allowWriter: csuTransAllow,
      logType: "customer.subscription.updated",
      expectedCode: "rpc_unknown", // rpc_<code>[_<status>]: no status suffix without an answer (as WH-AC14's rpc_invalid_response)
    },
    {
      label: "invoice.paid null status (network/timeout)",
      makeBody: (subId: string, invId: string) => makeEventBody({
        type: "invoice.paid",
        dataObject: validStripeInvoice({
          id: invId,
          parent: { type: "subscription_details", subscription_details: { subscription: subId } },
          status_transitions: { paid_at: 1_700_000_001 },
        }),
      }),
      makeRpcOverrides: () => ({
        recordSubscriptionInvoice: vi.fn().mockRejectedValue(new PaymentsRpcError("unknown_user", "22023", 400)),
        accountExists: vi.fn().mockRejectedValue(new PaymentsRpcError("rpc_failed", "unknown", null)),
      }),
      allowWriter: invpaidTransAllow,
      logType: "invoice.paid",
      expectedCode: "rpc_unknown", // rpc_<code>[_<status>]: no status suffix without an answer (as WH-AC14's rpc_invalid_response)
    },
  ])("WH-AC_A28a-transient: $label → 500 rpc code; no Stripe mutation", async ({
    makeBody, makeRpcOverrides, allowWriter, logType, expectedCode,
  }) => {
    const subId = "sub_a28aTrans";
    const userId = "00000000-0000-0000-0000-000000000004";
    const body = makeBody(subId, "in_a28aTransInv");
    const stripe = fakeStripe({
      retrieveSubscription: vi.fn().mockResolvedValue({
        ok: true,
        data: validStripeSubscription({
          id: subId,
          status: "active",
          metadata: { kind: "monitor_subscription", user_id: userId },
          latest_invoice: "in_a28aTransInv",
        }),
      }),
    });
    const rpc = fakeRpc(makeRpcOverrides());
    const deps = { ...fakeDeps(), stripe, rpc };
    const resp = await handleStripeWebhook(makeRequest(body), deps);
    expect(resp.status).toBe(500);
    expect(vi.mocked(rpc.accountExists).mock.calls).toEqual([[userId]]);
    const allow: Array<keyof StripeApi | keyof PaymentsRpc> = [
      "retrieveSubscription", ...allowWriter, "accountExists",
    ];
    expectNoCollaboratorCalls(deps, { allow });
    expect(parseLog(deps)).toEqual({
      msg: "payments webhook",
      event: "evt_test001",
      type: logType,
      outcome: "error",
      code: expectedCode,
      paused: null,
    });
  });
});
