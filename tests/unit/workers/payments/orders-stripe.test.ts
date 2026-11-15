/**
 * Unit tests: workers/payments/orders/stripe.ts — the goods Stripe calls (amendment A1)
 * Journey: payments-s2-3d-purchase
 * Criteria: S2-WH-3 (payment intent read with latest_charge), S2-CAP-13 (capture key
 *   ord-cap-<order id>), S2-ADM-14 (refund key ord-re-<withdrawal id>, metadata), S2-ADM-16
 *   (cancel key ord-cancel-<withdrawal id>, requested_by_customer), S2-SEC-7 (Checkout with the
 *   payments key, URL only on checkout.stripe.com), S2-ADM-15 (S2-T-STR-LIST-01..03: refund lookup)
 *
 * The fetch is injected (createOrderStripeApi's fetchImpl); every request is captured and
 * asserted after the call (an assertion thrown inside the fetch would be swallowed as a network
 * failure by stripeRequest).
 */
import { describe, expect, it, vi } from "vitest";
import { createOrderStripeApi } from "../../../../workers/payments/orders/stripe";
import { buildGoodsCheckoutParams } from "@/lib/payments/orders/checkout-params";

const STRIPE_KEY_FX = "sk_test_unitorders1234";
const PI_ID = "pi_s2orders0000000001";
const ORDER_ID = "00000000-0000-0000-0000-0000000000b1";
const WD_ID = "00000000-0000-0000-0000-0000000000a1";

type Captured = { url: string; method: string; headers: Headers; body: URLSearchParams };

/** A fetch answering `answer` (status 200 by default) and recording each request. */
function fakeFetch(answer: unknown, status = 200): { fetch: typeof fetch; requests: Captured[] } {
  const requests: Captured[] = [];
  return {
    requests,
    fetch: async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: new URLSearchParams(typeof init?.body === "string" ? init.body : ""),
      });
      return new Response(JSON.stringify(answer), { status });
    },
  };
}

describe("S2-WH-3: retrievePaymentIntent — GET /v1/payment_intents/{pi}?expand[0]=latest_charge", () => {
  it("reads the payment intent with its latest charge, with the payments key and the pinned version", async () => {
    const net = fakeFetch({ id: PI_ID, status: "requires_capture" });
    const result = await createOrderStripeApi(STRIPE_KEY_FX, net.fetch).retrievePaymentIntent(PI_ID);
    expect(result).toEqual({ ok: true, data: { id: PI_ID, status: "requires_capture" } });
    expect(net.requests).toHaveLength(1);
    const [request] = net.requests;
    const url = new URL(request!.url);
    expect(`${url.origin}${url.pathname}`).toBe(`https://api.stripe.com/v1/payment_intents/${PI_ID}`);
    expect(url.searchParams.get("expand[0]")).toBe("latest_charge");
    expect(request!.method).toBe("GET");
    expect(request!.headers.get("Authorization")).toBe(`Bearer ${STRIPE_KEY_FX}`);
    expect(request!.headers.get("Stripe-Version")).toBe("2026-10-28.endive");
  });
});

describe("S2-CAP-13: capturePaymentIntent — POST /capture, Idempotency-Key ord-cap-<order id>", () => {
  it("captures the whole authorized amount (no body) under the order's key", async () => {
    const net = fakeFetch({ id: PI_ID, status: "succeeded", amount_received: 24995 });
    const result = await createOrderStripeApi(STRIPE_KEY_FX, net.fetch).capturePaymentIntent(PI_ID, ORDER_ID);
    expect(result).toMatchObject({ ok: true, data: { status: "succeeded" } });
    const [request] = net.requests;
    expect(request!.url).toBe(`https://api.stripe.com/v1/payment_intents/${PI_ID}/capture`);
    expect(request!.method).toBe("POST");
    expect(request!.headers.get("Idempotency-Key")).toBe(`ord-cap-${ORDER_ID}`);
    expect([...request!.body.keys()]).toEqual([]);
  });

  it("answers Stripe's refusal with its status and code", async () => {
    const net = fakeFetch({ error: { type: "invalid_request_error", code: "payment_intent_unexpected_state" } }, 400);
    const result = await createOrderStripeApi(STRIPE_KEY_FX, net.fetch).capturePaymentIntent(PI_ID, ORDER_ID);
    expect(result).toEqual({ ok: false, kind: "http", status: 400, code: "payment_intent_unexpected_state" });
  });
});

describe("S2-ADM-16: cancelPaymentIntent — POST /cancel, requested_by_customer, Idempotency-Key ord-cancel-<wd>", () => {
  it("releases the authorization under the withdrawal's key", async () => {
    const net = fakeFetch({ id: PI_ID, status: "canceled" });
    await createOrderStripeApi(STRIPE_KEY_FX, net.fetch).cancelPaymentIntent(PI_ID, WD_ID);
    const [request] = net.requests;
    expect(request!.url).toBe(`https://api.stripe.com/v1/payment_intents/${PI_ID}/cancel`);
    expect(request!.method).toBe("POST");
    expect(Object.fromEntries(request!.body)).toEqual({ cancellation_reason: "requested_by_customer" });
    expect(request!.headers.get("Idempotency-Key")).toBe(`ord-cancel-${WD_ID}`);
  });
});

describe("S2-ADM-14: createOrderRefund — POST /v1/refunds, metadata, Idempotency-Key ord-re-<wd>", () => {
  it("refunds the amount of the payment intent with the withdrawal and order number in its metadata", async () => {
    const net = fakeFetch({ id: "re_s2orders0000000001", status: "succeeded" });
    await createOrderStripeApi(STRIPE_KEY_FX, net.fetch).createOrderRefund({
      paymentIntentId: PI_ID,
      amountOre: 20000,
      withdrawalId: WD_ID,
      orderNumber: 1001,
    });
    const [request] = net.requests;
    expect(request!.url).toBe("https://api.stripe.com/v1/refunds");
    expect(Object.fromEntries(request!.body)).toEqual({
      payment_intent: PI_ID,
      amount: "20000",
      "metadata[order_withdrawal_id]": WD_ID,
      "metadata[order_number]": "1001",
    });
    expect(request!.headers.get("Idempotency-Key")).toBe(`ord-re-${WD_ID}`);
  });
});

describe("S2-ADM-15 (S2-T-STR-LIST-01): listPaymentIntentRefunds — validated GET and parsed refunds", () => {
  it("reads all refunds for the PI, with limit=100, no body or Idempotency-Key, and parses their metadata and statuses", async () => {
    const refunds = ["succeeded", "pending", "failed", "canceled", "requires_action"].map((status, index) => ({
      id: `re_s2orders${index}`,
      status,
      metadata: { order_withdrawal_id: WD_ID, order_number: "1001" },
    }));
    const net = fakeFetch({ object: "list", data: refunds, has_more: false });

    await expect(createOrderStripeApi(STRIPE_KEY_FX, net.fetch).listPaymentIntentRefunds(PI_ID)).resolves.toEqual({
      ok: true, data: refunds,
    });
    expect(net.requests).toHaveLength(1);
    expect(net.requests[0]!.url).toBe(`https://api.stripe.com/v1/refunds?payment_intent=${PI_ID}&limit=100`);
    expect(net.requests[0]!.method).toBe("GET");
    expect([...net.requests[0]!.body]).toEqual([]);
    expect(net.requests[0]!.headers.get("Idempotency-Key")).toBeNull();
    expect(net.requests[0]!.headers.get("Authorization")).toBe(`Bearer ${STRIPE_KEY_FX}`);
    expect(net.requests[0]!.headers.get("Stripe-Version")).toBe("2026-10-28.endive");
  });

  it("accepts an empty complete list and refunds without withdrawal metadata", async () => {
    for (const data of [[], [{ id: "re_dashboard", status: "succeeded", metadata: {} }]]) {
      const net = fakeFetch({ object: "list", data, has_more: false });
      await expect(createOrderStripeApi(STRIPE_KEY_FX, net.fetch).listPaymentIntentRefunds(PI_ID)).resolves.toEqual({
        ok: true, data,
      });
    }
  });

  it.each(["ch_notapi", "pi_x/../../v1/refunds", "pi_x?payment_intent=pi_other", "pi_", ""])("rejects invalid PI %s before fetch", async (pi) => {
    const fetchSpy = vi.fn<typeof fetch>();
    await expect(createOrderStripeApi(STRIPE_KEY_FX, fetchSpy).listPaymentIntentRefunds(pi)).resolves.toEqual({
      ok: false, kind: "invalid_response",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("S2-ADM-15 (S2-T-STR-LIST-02): malformed or incomplete lists fail closed", () => {
  const valid = { id: "re_s2orders1", status: "succeeded", metadata: { order_withdrawal_id: WD_ID } };
  const invalidRefunds: [string, unknown][] = [
    ["null refund", null],
    ["missing refund id", { status: "succeeded", metadata: {} }],
    ["invalid refund id", { ...valid, id: "ch_notrefund" }],
    ["refund id with path", { ...valid, id: "re_x/other" }],
    ["missing status", { id: valid.id, metadata: {} }],
    ["unknown status", { ...valid, status: "processing" }],
    ["non-string status", { ...valid, status: 1 }],
    ["missing metadata", { id: valid.id, status: "succeeded" }],
    ["null metadata", { ...valid, metadata: null }],
    ["array metadata", { ...valid, metadata: [] }],
    ["non-string metadata", { ...valid, metadata: { order_withdrawal_id: 123 } }],
  ];
  it.each<[string, unknown]>([
    ["missing data", { object: "list", has_more: false }],
    ["non-array data", { object: "list", data: {}, has_more: false }],
    ["wrong list object", { object: "refund", data: [], has_more: false }],
    ["missing completeness", { object: "list", data: [] }],
    ["incomplete page", { object: "list", data: [valid], has_more: true }],
    ["non-boolean completeness", { object: "list", data: [], has_more: "false" }],
    ...invalidRefunds.map(([label, invalid]): [string, unknown] => [
      label, { object: "list", data: [valid, invalid], has_more: false },
    ]),
  ])("%s → invalid_response (no partial list)", async (_label, answer) => {
    const net = fakeFetch(answer);
    await expect(createOrderStripeApi(STRIPE_KEY_FX, net.fetch).listPaymentIntentRefunds(PI_ID)).resolves.toEqual({
      ok: false, kind: "invalid_response",
    });
    expect(net.requests).toHaveLength(1);
  });

  it("rejects malformed JSON", async () => {
    const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(new Response("{"));
    await expect(createOrderStripeApi(STRIPE_KEY_FX, fetchSpy).listPaymentIntentRefunds(PI_ID)).resolves.toEqual({
      ok: false, kind: "invalid_response",
    });
  });
});

describe("S2-ADM-15 (S2-T-STR-LIST-03): list errors retain the transport failure", () => {
  it.each([400, 402, 403, 429, 503])("returns HTTP %s without treating it as an empty list", async (status) => {
    const net = fakeFetch({ error: { code: "stripe_error" } }, status);
    await expect(createOrderStripeApi(STRIPE_KEY_FX, net.fetch).listPaymentIntentRefunds(PI_ID)).resolves.toEqual({
      ok: false, kind: "http", status, code: "stripe_error",
    });
    expect(net.requests).toHaveLength(1);
  });

  it("returns a network failure without treating it as an empty list", async () => {
    const fetchSpy = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("network"));
    await expect(createOrderStripeApi(STRIPE_KEY_FX, fetchSpy).listPaymentIntentRefunds(PI_ID)).resolves.toEqual({
      ok: false, kind: "network",
    });
  });
});

describe("ids and amounts are checked before any request (invalid_response, no fetch)", () => {
  const fetchSpy = vi.fn<typeof fetch>();
  const api = createOrderStripeApi(STRIPE_KEY_FX, fetchSpy);

  it.each([
    ["retrieve: a non-pi_ id", () => api.retrievePaymentIntent("ch_notapi")],
    ["retrieve: a path in the id", () => api.retrievePaymentIntent("pi_x/../../v1/refunds")],
    ["capture: a non-uuid order", () => api.capturePaymentIntent(PI_ID, "1001")],
    ["cancel: a non-uuid withdrawal", () => api.cancelPaymentIntent(PI_ID, "wd-1")],
    ["refund: zero øre", () => api.createOrderRefund({ paymentIntentId: PI_ID, amountOre: 0, withdrawalId: WD_ID, orderNumber: 1001 })],
    ["refund: a fraction", () => api.createOrderRefund({ paymentIntentId: PI_ID, amountOre: 1.5, withdrawalId: WD_ID, orderNumber: 1001 })],
    ["refund: a bad order number", () => api.createOrderRefund({ paymentIntentId: PI_ID, amountOre: 100, withdrawalId: WD_ID, orderNumber: -1 })],
  ])("%s", async (_label, call) => {
    await expect(call()).resolves.toEqual({ ok: false, kind: "invalid_response" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("S2-SEC-7: createGoodsCheckoutSession — POST /v1/checkout/sessions with the payments key", () => {
  const params = buildGoodsCheckoutParams({
    offer: { item_id: ORDER_ID, price_ore: 24995, title: "Testfigur", section_slug: "figures", item_slug: "test", locale: "da" },
    locale: "da",
    siteOrigin: "https://alnyron.dk",
    taxRateId: "txr_1Ub3CpFIgZG2PjS18JkfB0FE",
    nowSeconds: 1_800_000_000,
    account: null,
  });

  it("posts the goods parameters (manual capture) without an Idempotency-Key and answers the session url", async () => {
    const net = fakeFetch({ id: "cs_test_s2orders0001", url: "https://checkout.stripe.com/c/pay/cs_test_s2orders0001" });
    const result = await createOrderStripeApi(STRIPE_KEY_FX, net.fetch).createGoodsCheckoutSession(params);
    expect(result).toEqual({
      ok: true,
      data: { id: "cs_test_s2orders0001", url: "https://checkout.stripe.com/c/pay/cs_test_s2orders0001" },
    });
    const [request] = net.requests;
    expect(request!.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(request!.headers.get("Authorization")).toBe(`Bearer ${STRIPE_KEY_FX}`);
    expect(request!.headers.get("Idempotency-Key")).toBeNull();
    expect(request!.body.get("payment_intent_data[capture_method]")).toBe("manual");
    expect(request!.body.get("line_items[0][tax_rates][0]")).toBe("txr_1Ub3CpFIgZG2PjS18JkfB0FE");
    expect(request!.body.has("invoice_creation[enabled]")).toBe(false);
  });

  it("a session url off checkout.stripe.com is an invalid_response", async () => {
    const net = fakeFetch({ id: "cs_test_s2orders0001", url: "https://evil.example/pay" });
    await expect(createOrderStripeApi(STRIPE_KEY_FX, net.fetch).createGoodsCheckoutSession(params)).resolves.toEqual({
      ok: false,
      kind: "invalid_response",
    });
  });
});
