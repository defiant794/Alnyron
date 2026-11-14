/**
 * Unit tests: workers/payments/webhook.ts — slice 1d consent recording path
 * Journey: payments-slice1d-withdrawal
 * Criteria: WD-J2-C01..C05
 *
 * Coverage (C-6):
 *   - accepted → record + mail + stamp
 *   - not accepted → consent_missing logged; record + mail NOT called
 *   - unknown version (not in WITHDRAWAL_TEXT_SHA256) → consent_missing
 *   - mail failure → 200 (never 500 for mail)
 *   - consent writer transient → 500 so Stripe redelivers
 *   - A1: sync answers applied/duplicate/stale → consent runs; refusal → skipped
 *   - A2: subscription status canceled/incomplete_expired → record but no mail; sweep excludes (pending_work)
 *
 * Uses the same handleStripeWebhook + fakeDeps pattern as webhook.test.ts.
 * The consent deps are the real WebhookDeps members: rpc.paymentsRecordCheckoutConsent,
 * rpc.paymentsMarkConsentInfoSent, rpc.getUserEmail (the account email via
 * auth.admin.getUserById) and mail.sendConfirmationEmail.
 */
import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { handleStripeWebhook } from "../../../../workers/payments/webhook";
import { PaymentsRpcError } from "../../../../workers/payments/rpc";
import { WITHDRAWAL_TEXT_VERSION, WITHDRAWAL_TEXT_SHA256 } from "@/config/legal/withdrawal-texts";
import { unixToIso } from "@/lib/payments/webhook-mapping";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("@/lib/payments/stripe-signature", () => ({
  verifyStripeSignature: vi.fn().mockReturnValue({ ok: true }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const WHSEC_FX = "whsec_unittest1234";

/** Checkout session that passes all 1c checks AND carries the consent fields. */
function checkoutSessionBody(opts: {
  consentStatus?: string | null;
  textVersion?: string;
  locale?: string;
  subscriptionId?: string;
  userId?: string;
  syncOutcome?: string;
}): string {
  const userId = opts.userId ?? "00000000-0000-0000-0000-000000000001";
  const subId  = opts.subscriptionId ?? "sub_csttest001";
  return JSON.stringify({
    id: "evt_cst001",
    type: "checkout.session.completed",
    created: 1_731_542_400,
    livemode: false,
    data: {
      object: {
        id: "cs_test_session001",
        mode: "subscription",
        subscription: subId,
        client_reference_id: userId,
        consent: opts.consentStatus !== undefined ? { terms_of_service: opts.consentStatus } : null,
        metadata: {
          kind: "monitor_subscription",
          user_id: userId,
          locale: opts.locale ?? "da",
          withdrawal_text_version: opts.textVersion ?? WITHDRAWAL_TEXT_VERSION,
        },
      },
    },
  });
}

type ConsentDeps = {
  webhookSecret: string;
  livemode: boolean;
  stripe: { retrieveSubscription: Mock; cancelSubscription: Mock; listInvoicePayments: Mock; createRefund: Mock; markDuplicateSubscription: Mock };
  rpc: {
    syncSubscription: Mock;
    recordSubscriptionInvoice: Mock;
    otherEntitlingSubscriptionIds: Mock;
    accountExists: Mock;
    // 1d consent additions
    paymentsRecordCheckoutConsent: Mock;
    paymentsMarkConsentInfoSent: Mock;
    getUserEmail: Mock;
  };
  mail: { sendConfirmationEmail: Mock };
  now: () => number;
  log: Mock;
};

/** The writer's unsent order confirmation context (`ConsentMail`) of the session's consent. */
const CONSENT_MAIL = {
  checkout_session_id: "cs_test_session001",
  subscription_id: "sub_csttest001",
  user_id: "00000000-0000-0000-0000-000000000001",
  locale: "da",
  text_version: WITHDRAWAL_TEXT_VERSION,
  accepted_at: "2026-11-14T00:00:00.000Z",
  started_at: "2026-11-14T00:00:00.000Z",
  plan: { billing_interval: "month", amount_ore: 1000, name: "Monitor Plus" },
};

function fakeDeps(syncOutcome = "applied"): ConsentDeps {
  return {
    webhookSecret: WHSEC_FX,
    livemode: false,
    stripe: {
      retrieveSubscription: vi.fn().mockResolvedValue({ ok: true, data: fakeRetrievedSub() }),
      cancelSubscription: vi.fn(),
      listInvoicePayments: vi.fn().mockResolvedValue({ ok: true, data: { data: [] } }),
      createRefund: vi.fn(),
      markDuplicateSubscription: vi.fn(),
    },
    rpc: {
      syncSubscription: vi.fn().mockResolvedValue({ outcome: syncOutcome, paused: 0 }),
      recordSubscriptionInvoice: vi.fn().mockResolvedValue({ outcome: "applied", paused: 0 }),
      otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([]),
      accountExists: vi.fn().mockResolvedValue(false),
      // 1d
      paymentsRecordCheckoutConsent: vi.fn().mockResolvedValue({ outcome: "recorded", mail: CONSENT_MAIL }),
      paymentsMarkConsentInfoSent: vi.fn().mockResolvedValue({ outcome: "stamped" }),
      getUserEmail: vi.fn().mockResolvedValue("test@test.local"),
    },
    mail: {
      sendConfirmationEmail: vi.fn().mockResolvedValue({ id: "email-conf-id" }),
    },
    now: () => 1_700_000_000_000,
    log: vi.fn(),
  };
}

function fakeRetrievedSub(status = "active", metadata: Record<string, string> = {}): Record<string, unknown> {
  return {
    id: "sub_csttest001", customer: "cus_csttest001", status,
    start_date: 1731542400, cancel_at_period_end: false, created: 1731542400,
    metadata: { kind: "monitor_subscription", user_id: "00000000-0000-0000-0000-000000000001", ...metadata },
    items: { data: [{ price: { id: "price_1Ub3CoFIgZG2PjS1sJ7VtPSS" }, current_period_end: 1734134400 }] },
    latest_invoice: "in_csttest001",
  };
}

function makeRequest(body: string): Request {
  return new Request("https://pay.alnyron.dk/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": "t=1700000000,v1=fakesig" },
    body,
  });
}

// ── WD-J2-C01: accepted → record + mail + stamp ───────────────────────────────

describe("WD-J2-C01 (WD-T-WH-01): checkout consent accepted → record + mail + stamp", () => {
  it("WD-T-WH-01a: recordCheckoutConsent called with correct sha256, locale, accepted_at=event.created", async () => {
    const d = fakeDeps("applied");
    const body = checkoutSessionBody({ consentStatus: "accepted" });
    const resp = await handleStripeWebhook(makeRequest(body), d);
    expect(resp.status).toBe(200);
    expect(d.rpc.paymentsRecordCheckoutConsent).toHaveBeenCalled();
    const arg = d.rpc.paymentsRecordCheckoutConsent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg?.["text_sha256"]).toBe(WITHDRAWAL_TEXT_SHA256[WITHDRAWAL_TEXT_VERSION]?.["da"]);
    expect(arg?.["locale"]).toBe("da");
    expect(arg?.["accepted_at"]).toBe(unixToIso(1_731_542_400));
  });

  it("WD-J2-C03 (WD-T-WH-01b): getUserById called with user_id from mail context", async () => {
    // rpc.getUserEmail is the Worker's auth.admin.getUserById lookup (rpc.ts).
    const d = fakeDeps("applied");
    const body = checkoutSessionBody({ consentStatus: "accepted" });
    await handleStripeWebhook(makeRequest(body), d);
    expect(d.rpc.getUserEmail).toHaveBeenCalledWith("00000000-0000-0000-0000-000000000001");
    const mailArg = d.mail.sendConfirmationEmail.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(mailArg?.["to"]).toBe("test@test.local");
  });

  it("WD-J2-C03 (WD-T-WH-01c): sendConfirmationEmail called with Resend key withdrawal-info/<session-id>", async () => {
    const d = fakeDeps("applied");
    const body = checkoutSessionBody({ consentStatus: "accepted" });
    await handleStripeWebhook(makeRequest(body), d);
    expect(d.mail.sendConfirmationEmail).toHaveBeenCalled();
    const mailArg = d.mail.sendConfirmationEmail.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(String(mailArg?.["idempotencyKey"] ?? "")).toBe("withdrawal-info/cs_test_session001");
  });

  it("WD-J2-C03 (WD-T-WH-04): markConsentInfoSent called after successful mail send", async () => {
    const d = fakeDeps("applied");
    const body = checkoutSessionBody({ consentStatus: "accepted" });
    await handleStripeWebhook(makeRequest(body), d);
    expect(d.rpc.paymentsMarkConsentInfoSent).toHaveBeenCalledWith("cs_test_session001", "email-conf-id");
  });

  it("WD-T-WH-01d: consent path runs for sync outcome=duplicate (A1)", async () => {
    const d = fakeDeps("duplicate");
    const body = checkoutSessionBody({ consentStatus: "accepted" });
    await handleStripeWebhook(makeRequest(body), d);
    expect(d.rpc.paymentsRecordCheckoutConsent).toHaveBeenCalled();
  });

  it("WD-T-WH-01e: consent path runs for sync outcome=stale (A1)", async () => {
    const d = fakeDeps("stale");
    const body = checkoutSessionBody({ consentStatus: "accepted" });
    await handleStripeWebhook(makeRequest(body), d);
    expect(d.rpc.paymentsRecordCheckoutConsent).toHaveBeenCalled();
  });
});

// ── WD-J2-C02: not accepted / unknown version → consent_missing ───────────────

describe("WD-J2-C02 (WD-T-WH-02): terms_of_service not 'accepted' → consent_missing; no record or mail", () => {
  it.each([
    { label: "null consent",       consentStatus: null },
    { label: "consent not accepted", consentStatus: "pending" },
  ])("WD-T-WH-02 $label → consent_missing logged; recordCheckoutConsent NOT called", async ({ consentStatus }) => {
    const d = fakeDeps("applied");
    const body = checkoutSessionBody({ consentStatus });
    const resp = await handleStripeWebhook(makeRequest(body), d);
    expect(resp.status).toBe(200);
    expect(d.rpc.paymentsRecordCheckoutConsent).not.toHaveBeenCalled();
    expect(d.mail.sendConfirmationEmail).not.toHaveBeenCalled();
    // consent_missing must appear in logs
    const logLines = d.log.mock.calls.map((c) => String(c[0]));
    expect(logLines.some((l) => l.includes("consent_missing"))).toBe(true);
  });
});

describe("WD-J2-C02 (WD-T-WH-03): unknown withdrawal_text_version → consent_missing", () => {
  it("WD-T-WH-03: version not in WITHDRAWAL_TEXT_SHA256 → consent_missing; no record", async () => {
    const d = fakeDeps("applied");
    const body = checkoutSessionBody({ consentStatus: "accepted", textVersion: "9999-01-01.1" });
    const resp = await handleStripeWebhook(makeRequest(body), d);
    expect(resp.status).toBe(200);
    expect(d.rpc.paymentsRecordCheckoutConsent).not.toHaveBeenCalled();
    const logLines = d.log.mock.calls.map((c) => String(c[0]));
    expect(logLines.some((l) => l.includes("consent_missing"))).toBe(true);
  });
});

// ── WD-J2-C05: mail failure → 200; consent writer transient → 500 ───────────

describe("WD-J2-C05 (WD-T-WH-07): mail failure → HTTP 200; webhook not retried", () => {
  it("WD-T-WH-07: sendConfirmationEmail throws → response is still 200", async () => {
    const d = fakeDeps("applied");
    d.mail.sendConfirmationEmail.mockRejectedValue(new Error("Resend network error"));
    const body = checkoutSessionBody({ consentStatus: "accepted" });
    const resp = await handleStripeWebhook(makeRequest(body), d);
    expect(resp.status).toBe(200);
  });
});

describe("WD-J2-C01: consent writer transient failure → 500 so Stripe redelivers", () => {
  it("WD-T-WH-01f: recordCheckoutConsent throws transient error → response 500", async () => {
    const d = fakeDeps("applied");
    d.rpc.paymentsRecordCheckoutConsent.mockRejectedValue(new Error("DB timeout"));
    const body = checkoutSessionBody({ consentStatus: "accepted" });
    const resp = await handleStripeWebhook(makeRequest(body), d);
    expect(resp.status).toBe(500);
  });
});

// ── A1: sync refusal → consent skipped ───────────────────────────────────────

describe("WD-J2-C01 (A1): sync writer refusal → consent path skipped entirely", () => {
  // A real writer refusal (PaymentsRpcError with SQLSTATE 22023 and a refusal message): a plain Error
  // would be a transient failure (500) and never reach the A1 skip. unknown_plan / invalid_payload stop
  // at the writer; unknown_user of an entitling subscription would run the duplicate rule's finish.
  it.each(["unknown_plan", "invalid_payload"] as const)("sync refusal=%s → recordCheckoutConsent NOT called", async (outcome) => {
    const d = fakeDeps("applied");
    d.rpc.syncSubscription.mockRejectedValue(new PaymentsRpcError(outcome, "22023", 400));
    const body = checkoutSessionBody({ consentStatus: "accepted" });
    const resp = await handleStripeWebhook(makeRequest(body), d);
    expect(resp.status).toBe(200);
    expect(d.rpc.paymentsRecordCheckoutConsent).not.toHaveBeenCalled();
    expect(d.mail.sendConfirmationEmail).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledOnce();
    expect(JSON.parse(String(d.log.mock.calls[0]?.[0]))).toEqual({
      msg: "payments webhook",
      event: "evt_cst001",
      type: "checkout.session.completed",
      outcome: "rejected",
      code: outcome,
      paused: null,
    });
  });
});

// ── A2: canceled/incomplete_expired subscription → record but no mail ─────────

describe("WD-J2-C04 (WD-T-WH-06): A2 — canceled/incomplete_expired subscription → record consent but no mail", () => {
  it.each(["canceled", "incomplete_expired"])(
    "WD-T-WH-06: recordCheckoutConsent called; sendConfirmationEmail NOT called (duplicate/canceled sub: %s)",
    async (status) => {
      const d = fakeDeps("duplicate");
      // A2: the session's subscription has ended (Stripe answers it so); the writer still answers
      // an unsent mail context, but no confirmation goes out and nothing is stamped.
      d.stripe.retrieveSubscription.mockResolvedValue({ ok: true, data: fakeRetrievedSub(status) });
      const body = checkoutSessionBody({ consentStatus: "accepted" });
      const resp = await handleStripeWebhook(makeRequest(body), d);
      expect(resp.status).toBe(200);
      expect(d.rpc.paymentsRecordCheckoutConsent).toHaveBeenCalled();
      expect(d.mail.sendConfirmationEmail).not.toHaveBeenCalled();
      expect(d.rpc.paymentsMarkConsentInfoSent).not.toHaveBeenCalled();
    },
  );

  it("WD-T-WH-06d: the subscription carries the duplicate mark (finished in this delivery) → consent recorded, no lookup, mail or stamp", async () => {
    const d = fakeDeps("applied");
    d.stripe.retrieveSubscription.mockResolvedValue({
      ok: true,
      data: fakeRetrievedSub("active", { duplicate_subscription: "true" }),
    });
    d.stripe.cancelSubscription.mockResolvedValue({ ok: true, data: { id: "sub_csttest001", status: "canceled" } });
    const resp = await handleStripeWebhook(makeRequest(checkoutSessionBody({ consentStatus: "accepted" })), d);
    expect(resp.status).toBe(200);
    expect(d.stripe.cancelSubscription).toHaveBeenCalledWith("sub_csttest001");
    expect(d.rpc.paymentsRecordCheckoutConsent).toHaveBeenCalledOnce();
    expect(d.rpc.getUserEmail).not.toHaveBeenCalled();
    expect(d.mail.sendConfirmationEmail).not.toHaveBeenCalled();
    expect(d.rpc.paymentsMarkConsentInfoSent).not.toHaveBeenCalled();
    expect(JSON.parse(String(d.log.mock.calls[0]?.[0]))).toEqual({
      msg: "payments webhook", event: "evt_cst001", type: "checkout.session.completed",
      outcome: "duplicate_subscription_canceled", code: "unrecordable_refunded", paused: 0,
      consent: "recorded", mail: "not_needed",
    });
  });

  it("WD-T-WH-06e: a parallel Checkout's newer subscription finished as a duplicate in this delivery → consent recorded, no mail", async () => {
    const d = fakeDeps("applied");
    // The user's other entitling subscription is older and unmarked: it is kept, this one finished.
    d.rpc.otherEntitlingSubscriptionIds.mockResolvedValue(["sub_olderkeep001"]);
    d.stripe.retrieveSubscription.mockImplementation(async (id: string) =>
      id === "sub_olderkeep001"
        ? { ok: true, data: { id, status: "active", created: 1_731_500_000, metadata: {}, latest_invoice: "in_older001" } }
        : { ok: true, data: fakeRetrievedSub() },
    );
    d.stripe.markDuplicateSubscription.mockResolvedValue({ ok: true, data: { id: "sub_csttest001" } });
    d.stripe.cancelSubscription.mockResolvedValue({ ok: true, data: { id: "sub_csttest001", status: "canceled" } });
    const resp = await handleStripeWebhook(makeRequest(checkoutSessionBody({ consentStatus: "accepted" })), d);
    expect(resp.status).toBe(200);
    expect(d.stripe.cancelSubscription.mock.calls).toEqual([["sub_csttest001"]]);
    expect(d.rpc.paymentsRecordCheckoutConsent).toHaveBeenCalledOnce();
    expect(d.mail.sendConfirmationEmail).not.toHaveBeenCalled();
    expect(d.rpc.paymentsMarkConsentInfoSent).not.toHaveBeenCalled();
    expect(JSON.parse(String(d.log.mock.calls[0]?.[0]))).toEqual({
      msg: "payments webhook", event: "evt_cst001", type: "checkout.session.completed",
      outcome: "duplicate_subscription_canceled", code: null, paused: 0,
      consent: "recorded", mail: "not_needed",
    });
  });

  it("WD-T-WH-06b: the record answers no mail context (already stamped) → no lookup, mail or stamp; logs mail not_needed", async () => {
    const d = fakeDeps("applied");
    d.rpc.paymentsRecordCheckoutConsent.mockResolvedValue({ outcome: "duplicate", mail: null });
    await handleStripeWebhook(makeRequest(checkoutSessionBody({ consentStatus: "accepted" })), d);
    expect(d.rpc.getUserEmail).not.toHaveBeenCalled();
    expect(d.mail.sendConfirmationEmail).not.toHaveBeenCalled();
    expect(d.rpc.paymentsMarkConsentInfoSent).not.toHaveBeenCalled();
    expect(JSON.parse(String(d.log.mock.calls[0]?.[0]))).toEqual({
      msg: "payments webhook", event: "evt_cst001", type: "checkout.session.completed",
      outcome: "applied", code: null, paused: 0, consent: "duplicate", mail: "not_needed",
    });
  });

  it("WD-T-WH-06c: the mail context's user_id is null (account deleted) → no lookup, mail or stamp; logs mail no_recipient", async () => {
    const d = fakeDeps("applied");
    d.rpc.paymentsRecordCheckoutConsent.mockResolvedValue({ outcome: "recorded", mail: { ...CONSENT_MAIL, user_id: null } });
    await handleStripeWebhook(makeRequest(checkoutSessionBody({ consentStatus: "accepted" })), d);
    expect(d.rpc.paymentsRecordCheckoutConsent).toHaveBeenCalledOnce();
    expect(d.rpc.getUserEmail).not.toHaveBeenCalled();
    expect(d.mail.sendConfirmationEmail).not.toHaveBeenCalled();
    expect(d.rpc.paymentsMarkConsentInfoSent).not.toHaveBeenCalled();
    expect(JSON.parse(String(d.log.mock.calls[0]?.[0]))).toEqual({
      msg: "payments webhook", event: "evt_cst001", type: "checkout.session.completed",
      outcome: "applied", code: null, paused: 0, consent: "recorded", mail: "no_recipient",
    });
  });
});
