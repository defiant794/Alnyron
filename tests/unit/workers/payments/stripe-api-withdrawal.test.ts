/**
 * Unit tests: workers/payments/stripe-api.ts — new withdrawal methods
 * Journey: payments-slice1d-withdrawal
 * Criteria: WD-J4-C05, WD-J4-C06
 *
 * Coverage:
 *   - cancelSubscriptionForWithdrawal: DELETE /v1/subscriptions/{id}, prorate=false,
 *       cancellation_details[comment]=withdrawal, Stripe-Version header, auth
 *   - listSubscriptionInvoices: GET /v1/invoices?subscription=<id>&limit=10
 *   - listInvoiceCreditNotes: GET /v1/credit_notes?invoice=<id>
 *   - createWithdrawalCreditNote: POST /v1/credit_notes, all form fields per C-3+spike,
 *       Idempotency-Key=wd-cn-<uuid>, DA/EN memo, auth
 *   - ID validation without fetch for each method
 *
 * Pattern: capture URL+init into variables, resolve fetch normally, assert after `await`.
 * Asserting inside the fetch callback is unsafe because stripe-api converts thrown errors
 * to {ok:false,kind:"network"}, swallowing any thrown expectation.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStripeApi } from "../../../../workers/payments/stripe-api";

// ── Shared fixtures ───────────────────────────────────────────────────────────

// Namespace 0d1d = withdrawal-1d tests; real UUID for withdrawal id.
const WD_UUID        = "00000000-0000-0000-0d1d-000000000001";
const STRIPE_KEY_FX  = "sk_test_unitstripe1234";
const STRIPE_VERSION = "2026-10-28.endive";
const SUB_ID         = "sub_test1234567890";
const INVOICE_ID     = "in_test123";
const LINE_ID        = "il_test123";

const stripe = createStripeApi(STRIPE_KEY_FX);

afterEach(() => { vi.unstubAllGlobals(); });

// ── Capture helper — no assertions inside callback ────────────────────────────

type Captured = { url: string; method: string; headers: Headers; bodyParams: URLSearchParams };

function captureFetch(response: unknown): { captured: Captured; install: () => void } {
  const captured: Captured = { url: "", method: "", headers: new Headers(), bodyParams: new URLSearchParams() };
  return {
    captured,
    install: () => {
      vi.stubGlobal("fetch", async (url: unknown, init: unknown) => {
        const req = init as RequestInit | undefined;
        captured.url = String(url);
        captured.method = String(req?.method ?? "GET").toUpperCase();
        captured.headers = new Headers(req?.headers as HeadersInit | undefined);
        captured.bodyParams = new URLSearchParams(String(req?.body ?? ""));
        return new Response(JSON.stringify(response), { status: 200 });
      });
    },
  };
}

// ── cancelSubscriptionForWithdrawal ───────────────────────────────────────────

describe("WD-J4-C05: cancelSubscriptionForWithdrawal — DELETE /v1/subscriptions/{id}", () => {
  it("WD-SA-cancel-01: exact URL, method DELETE, form fields prorate+comment, auth+version headers, ok:true", async () => {
    const { captured, install } = captureFetch({ id: SUB_ID, status: "canceled", canceled_at: 1731580800 });
    install();

    const result = await stripe.cancelSubscriptionForWithdrawal(SUB_ID);

    expect(result).toMatchObject({ ok: true, data: { id: SUB_ID, status: "canceled" } });
    expect(captured.url).toMatch(new RegExp(`/v1/subscriptions/${SUB_ID}$`));
    expect(captured.method).toBe("DELETE");
    expect(captured.bodyParams.get("prorate")).toBe("false");
    expect(captured.bodyParams.get("cancellation_details[comment]")).toBe("withdrawal");
    expect(captured.headers.get("Authorization")).toBe(`Bearer ${STRIPE_KEY_FX}`);
    expect(captured.headers.get("Stripe-Version")).toBe(STRIPE_VERSION);
  });

  it("WD-SA-cancel-02: rejects non-sub_ id; fetch never called", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await stripe.cancelSubscriptionForWithdrawal("cus_notasubid");
    expect(result).toMatchObject({ ok: false, kind: "invalid_response" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── listSubscriptionInvoices ──────────────────────────────────────────────────

describe("WD-J4-C05: listSubscriptionInvoices — GET /v1/invoices?subscription=<id>&limit=10", () => {
  it("WD-SA-li-01: exact URL, method GET, subscription + limit params, auth+version headers, ok:true", async () => {
    const payload = { has_more: false, data: [] };
    const { captured, install } = captureFetch(payload);
    install();

    const result = await stripe.listSubscriptionInvoices(SUB_ID);

    expect(result).toMatchObject({ ok: true, data: payload });
    const u = new URL(captured.url);
    expect(u.pathname).toBe("/v1/invoices");
    expect(u.searchParams.get("subscription")).toBe(SUB_ID);
    expect(u.searchParams.get("limit")).toBe("10");
    expect(captured.method).toBe("GET");
    expect(captured.headers.get("Authorization")).toBe(`Bearer ${STRIPE_KEY_FX}`);
    expect(captured.headers.get("Stripe-Version")).toBe(STRIPE_VERSION);
  });
});

// ── listInvoiceCreditNotes ────────────────────────────────────────────────────

describe("WD-J4-C05: listInvoiceCreditNotes — GET /v1/credit_notes?invoice=<id>", () => {
  it("WD-SA-lcn-01: exact URL, invoice query param, GET, auth headers, ok:true", async () => {
    const { captured, install } = captureFetch({ data: [] });
    install();

    const result = await stripe.listInvoiceCreditNotes(INVOICE_ID);

    expect(result).toMatchObject({ ok: true });
    const u = new URL(captured.url);
    expect(u.pathname).toBe("/v1/credit_notes");
    expect(u.searchParams.get("invoice")).toBe(INVOICE_ID);
    expect(captured.method).toBe("GET");
    expect(captured.headers.get("Authorization")).toBe(`Bearer ${STRIPE_KEY_FX}`);
  });
});

// ── createWithdrawalCreditNote ────────────────────────────────────────────────

const CN_RESPONSE = {
  id: "cn_test123", amount: 967,
  total_taxes: [{ amount: 193 }],
  refunds: [{ refund: "re_test123", amount_refunded: 967 }],
};

const CN_ARGS_DA = {
  withdrawalId: WD_UUID,
  subscriptionId: SUB_ID,
  invoiceId: INVOICE_ID,
  lineId: LINE_ID,
  refundOre: 967,
  locale: "da" as const,
};

describe("WD-J4-C05 / WD-J4-C06: createWithdrawalCreditNote — POST /v1/credit_notes, all form fields", () => {
  it("WD-SA-cn-01: POST to /v1/credit_notes with every required form field (C-3 + spike)", async () => {
    const { captured, install } = captureFetch(CN_RESPONSE);
    install();

    const result = await stripe.createWithdrawalCreditNote(CN_ARGS_DA);

    expect(result).toMatchObject({ ok: true, data: CN_RESPONSE });
    expect(captured.method).toBe("POST");
    const u = new URL(captured.url);
    expect(u.pathname).toBe("/v1/credit_notes");
    expect(captured.bodyParams.get("invoice")).toBe(INVOICE_ID);
    expect(captured.bodyParams.get("lines[0][type]")).toBe("invoice_line_item");
    expect(captured.bodyParams.get("lines[0][invoice_line_item]")).toBe(LINE_ID);
    expect(captured.bodyParams.get("lines[0][amount]")).toBe("967");
    expect(captured.bodyParams.get("refund_amount")).toBe("967");
    expect(captured.bodyParams.get("reason")).toBe("order_change");
    expect(captured.bodyParams.get("metadata[withdrawal_id]")).toBe(WD_UUID);
    expect(captured.bodyParams.get("metadata[subscription]")).toBe(SUB_ID);
  });

  it(`WD-SA-cn-02: Idempotency-Key is exactly 'wd-cn-${WD_UUID}'`, async () => {
    const { captured, install } = captureFetch(CN_RESPONSE);
    install();

    await stripe.createWithdrawalCreditNote(CN_ARGS_DA);

    expect(captured.headers.get("Idempotency-Key")).toBe(`wd-cn-${WD_UUID}`);
  });

  it("WD-SA-cn-03: auth and Stripe-Version headers present", async () => {
    const { captured, install } = captureFetch(CN_RESPONSE);
    install();

    await stripe.createWithdrawalCreditNote(CN_ARGS_DA);

    expect(captured.headers.get("Authorization")).toBe(`Bearer ${STRIPE_KEY_FX}`);
    expect(captured.headers.get("Stripe-Version")).toBe(STRIPE_VERSION);
  });

  it("WD-SA-cn-04: DA memo is 'Fortrydelse af Monitor-abonnement'", async () => {
    const { captured, install } = captureFetch(CN_RESPONSE);
    install();

    await stripe.createWithdrawalCreditNote({ ...CN_ARGS_DA, locale: "da" });

    expect(captured.bodyParams.get("memo")).toBe("Fortrydelse af Monitor-abonnement");
  });

  it("WD-SA-cn-05: EN memo is 'Withdrawal from Monitor subscription'", async () => {
    const { captured, install } = captureFetch(CN_RESPONSE);
    install();

    await stripe.createWithdrawalCreditNote({ ...CN_ARGS_DA, locale: "en" });

    expect(captured.bodyParams.get("memo")).toBe("Withdrawal from Monitor subscription");
  });

  it("WD-SA-cn-06: refundOre=0 → {ok:false,kind:'invalid_response'}; fetch not called", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await stripe.createWithdrawalCreditNote({ ...CN_ARGS_DA, refundOre: 0 });
    expect(result).toMatchObject({ ok: false, kind: "invalid_response" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("WD-SA-cn-07: non-UUID withdrawalId → {ok:false,kind:'invalid_response'}; fetch not called", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await stripe.createWithdrawalCreditNote({ ...CN_ARGS_DA, withdrawalId: "not-a-valid-uuid" });
    expect(result).toMatchObject({ ok: false, kind: "invalid_response" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
