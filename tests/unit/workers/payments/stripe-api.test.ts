/**
 * Unit tests: workers/payments/stripe-api.ts — createStripeApi
 * Journey: payments-slice1c-webhook
 * Criteria: WH-AC24a..WH-AC24g (WH-AC24f auth headers, WH-AC24g timeout),
 *           WH-AC24b-A11, WH-AC24b-A9, WH-AC24c-A9, WH-AC24d-A9, WH-AC24d-A22-backstop,
 *           WH-AC24h1..6 (A19).
 */
import { describe, expect, it, vi } from "vitest";
import { createStripeApi, type StripeApi } from "../../../../workers/payments/stripe-api";
import { STRIPE_API_VERSION } from "@/lib/payments/stripe";
import { STRIPE_REQUEST_TIMEOUT_MS } from "@/config/payments";

const STRIPE_KEY_FX = "sk_test_stripe_api_unit";

type CapturedRequest = { url: string; method: string; headers: Record<string, string>; body: string };

function capturingFetch(result: unknown = { id: "obj_1" }, status = 200): {
  fetch: typeof fetch;
  calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(init?.headers);
    const headerMap: Record<string, string> = {};
    headers.forEach((v, k) => { headerMap[k] = v; });
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: headerMap,
      body: typeof init?.body === "string" ? init.body : "",
    });
    return new Response(JSON.stringify(result), { status });
  };
  return { fetch: fetchImpl, calls };
}

// ── WH-AC24a: retrieveSubscription ───────────────────────────────────────────

describe("WH-AC24a: retrieveSubscription makes GET /v1/subscriptions/{id}", () => {
  it("WH-AC24a1: correct URL and method", async () => {
    const { fetch: fetchImpl, calls } = capturingFetch({ id: "sub_test001" });
    const api = createStripeApi(STRIPE_KEY_FX, fetchImpl);
    await api.retrieveSubscription("sub_test001");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toContain("/v1/subscriptions/sub_test001");
  });

  it("WH-AC24a2: bad sub id (not ^sub_[A-Za-z0-9]+$) → invalid_response without a request", async () => {
    const { fetch: fetchImpl, calls } = capturingFetch();
    const api = createStripeApi(STRIPE_KEY_FX, fetchImpl);
    const result = await api.retrieveSubscription("cus_bad_id");
    expect(calls).toHaveLength(0); // no request made
    expect(result).toEqual({ ok: false, kind: "invalid_response" });
  });

  it("WH-AC24a3: Authorization and Stripe-Version headers present", async () => {
    const { fetch: fetchImpl, calls } = capturingFetch({ id: "sub_test001" });
    const api = createStripeApi(STRIPE_KEY_FX, fetchImpl);
    await api.retrieveSubscription("sub_test001");
    expect(calls[0]!.headers["authorization"]).toBe(`Bearer ${STRIPE_KEY_FX}`);
    // Version pinned via import — no duplicate literal.
    expect(calls[0]!.headers["stripe-version"]).toBe(STRIPE_API_VERSION);
  });
});

// ── WH-AC24b: cancelSubscription ─────────────────────────────────────────────

describe("WH-AC24b: cancelSubscription makes DELETE /v1/subscriptions/{id}", () => {
  it("WH-AC24b-A11: cancelSubscription sends no Idempotency-Key", async () => {
    // A11: Stripe ignores Idempotency-Key on DELETE; must NOT send it.
    const { fetch: fetchImpl, calls } = capturingFetch({ id: "sub_test001", status: "canceled" });
    const api = createStripeApi(STRIPE_KEY_FX, fetchImpl);
    await api.cancelSubscription("sub_test001");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toContain("/v1/subscriptions/sub_test001");
    // A11: Stripe ignores Idempotency-Key on DELETE; must NOT send it.
    expect(calls[0]!.headers["idempotency-key"]).toBeUndefined();
  });

  it("WH-AC24b-A9: cancelSubscription body includes cancellation_details[comment]=duplicate_subscription", async () => {
    const { fetch: fetchImpl, calls } = capturingFetch({ id: "sub_test001", status: "canceled" });
    const api = createStripeApi(STRIPE_KEY_FX, fetchImpl);
    await api.cancelSubscription("sub_test001");
    const params = new URLSearchParams(calls[0]!.body);
    expect(params.get("cancellation_details[comment]")).toBe("duplicate_subscription");
  });
  it("WH-AC24b2: bad sub id → invalid_response without a request", async () => {
    const { fetch: fetchImpl, calls } = capturingFetch();
    const api = createStripeApi(STRIPE_KEY_FX, fetchImpl);
    const result = await api.cancelSubscription("pi_bad");
    expect(calls).toHaveLength(0);
    expect(result).toEqual({ ok: false, kind: "invalid_response" });
  });
});

// ── WH-AC24c: listInvoicePayments ────────────────────────────────────────────

describe("WH-AC24c: listInvoicePayments makes GET /v1/invoice_payments?invoice=<id>", () => {
  it("WH-AC24c1: correct URL with query param and GET method", async () => {
    const { fetch: fetchImpl, calls } = capturingFetch({ data: [] });
    const api = createStripeApi(STRIPE_KEY_FX, fetchImpl);
    await api.listInvoicePayments("in_test001");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toContain("/v1/invoice_payments");
    expect(calls[0]!.url).toContain("invoice=in_test001");
  });

  it("WH-AC24c-A9: listInvoicePayments URL includes limit=100", async () => {
    const { fetch: fetchImpl, calls } = capturingFetch({ data: [] });
    const api = createStripeApi(STRIPE_KEY_FX, fetchImpl);
    await api.listInvoicePayments("in_test001");
    expect(calls[0]!.url).toContain("limit=100");
  });

  it("WH-AC24c2: bad invoice id (not ^in_[A-Za-z0-9]+$) → invalid_response without request", async () => {
    const { fetch: fetchImpl, calls } = capturingFetch();
    const api = createStripeApi(STRIPE_KEY_FX, fetchImpl);
    const result = await api.listInvoicePayments("sub_not_invoice");
    expect(calls).toHaveLength(0);
    expect(result).toEqual({ ok: false, kind: "invalid_response" });
  });
});

// ── WH-AC24d: createRefund ────────────────────────────────────────────────────

describe("WH-AC24d: createRefund makes POST /v1/refunds with correct params and Idempotency-Key", () => {
  it("WH-AC24d1: POST method, Idempotency-Key: dup-refund-<pi>", async () => {
    const { fetch: fetchImpl, calls } = capturingFetch({ id: "re_test001" });
    const api = createStripeApi(STRIPE_KEY_FX, fetchImpl);
    await api.createRefund("pi_test001", "sub_test001", 9500);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toContain("/v1/refunds");
    expect(calls[0]!.headers["idempotency-key"]).toBe("dup-refund-pi_test001");
  });

  it("WH-AC24d2: body has exact URLSearchParams: payment_intent, reason, amount, metadata fields", async () => {
    const { fetch: fetchImpl, calls } = capturingFetch({ id: "re_test001" });
    const api = createStripeApi(STRIPE_KEY_FX, fetchImpl);
    await api.createRefund("pi_test001", "sub_test001", 9500);
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body))).toEqual({
      payment_intent: "pi_test001",
      reason: "duplicate",
      "metadata[reason]": "duplicate_subscription",
      "metadata[subscription]": "sub_test001",
      amount: "9500",
    });
  });

  it("WH-AC24d-A9: createRefund body `amount` equals the integer passed (A22)", async () => {
    const { fetch: fetchImpl, calls } = capturingFetch({ id: "re_test001" });
    const api = createStripeApi(STRIPE_KEY_FX, fetchImpl);
    await api.createRefund("pi_test001", "sub_test001", 7500);
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body))).toMatchObject({ amount: "7500" });
  });

  it("WH-AC24d3: bad pi id (not ^pi_[A-Za-z0-9]+$) → invalid_response without request", async () => {
    const { fetch: fetchImpl, calls } = capturingFetch();
    const api = createStripeApi(STRIPE_KEY_FX, fetchImpl);
    const result = await api.createRefund("in_not_pi", "sub_test001", 9500);
    expect(calls).toHaveLength(0);
    expect(result).toEqual({ ok: false, kind: "invalid_response" });
  });

  it("WH-AC24d4: bad subscription id on createRefund → invalid_response without request", async () => {
    const { fetch: fetchImpl, calls } = capturingFetch();
    const api = createStripeApi(STRIPE_KEY_FX, fetchImpl);
    const result = await api.createRefund("pi_test001", "not_a_valid_sub", 9500);
    expect(calls).toHaveLength(0);
    expect(result).toEqual({ ok: false, kind: "invalid_response" });
  });

  it.each([0, -100, 9.5, Number.MAX_SAFE_INTEGER + 1])(
    "WH-AC24d-A22-backstop: amount %s (not a positive safe integer) → invalid_response without request",
    async (amount) => {
      const { fetch: fetchImpl, calls } = capturingFetch();
      const api = createStripeApi(STRIPE_KEY_FX, fetchImpl);
      const result = await api.createRefund("pi_test001", "sub_test001", amount);
      expect(calls).toHaveLength(0);
      expect(result).toEqual({ ok: false, kind: "invalid_response" });
    },
  );
});

// ── WH-AC24e: id prefix validation ───────────────────────────────────────────

describe("WH-AC24e: each id is validated against its prefix regex before making a request", () => {
  it.each([
    { method: "retrieveSubscription" as const, badId: "in_wrong_prefix" },
    { method: "cancelSubscription" as const, badId: "cus_wrong_prefix" },
    { method: "listInvoicePayments" as const, badId: "sub_wrong_prefix" },
  ])("WH-AC24e: $method with bad id → invalid_response, no request", async ({ method, badId }) => {
    const { fetch: fetchImpl, calls } = capturingFetch();
    const api = createStripeApi(STRIPE_KEY_FX, fetchImpl);
    const result = await api[method](badId);
    expect(calls).toHaveLength(0);
    expect(result).toEqual({ ok: false, kind: "invalid_response" });
  });
});

// ── WH-AC24f: all requests carry Authorization + Stripe-Version ──────────────

describe("WH-AC24f: all StripeApi calls carry Authorization: Bearer and Stripe-Version headers", () => {
  it.each([
    {
      label: "retrieveSubscription",
      call: (api: StripeApi) => api.retrieveSubscription("sub_authtest"),
      mockResult: { id: "sub_authtest" },
    },
    {
      label: "cancelSubscription",
      call: (api: StripeApi) => api.cancelSubscription("sub_authtest"),
      mockResult: { id: "sub_authtest", status: "canceled" },
    },
    {
      label: "listInvoicePayments",
      call: (api: StripeApi) => api.listInvoicePayments("in_authtest"),
      mockResult: { data: [] },
    },
    {
      label: "createRefund",
      call: (api: StripeApi) => api.createRefund("pi_authtest", "sub_authtest", 9500),
      mockResult: { id: "re_authtest" },
    },
    {
      label: "markDuplicateSubscription",
      call: (api: StripeApi) => api.markDuplicateSubscription("sub_authtest"),
      mockResult: { id: "sub_authtest" },
    },
  ])("WH-AC24f: $label sends Authorization and Stripe-Version", async ({ call, mockResult }) => {
    const { fetch: fetchImpl, calls } = capturingFetch(mockResult);
    const api = createStripeApi(STRIPE_KEY_FX, fetchImpl);
    await call(api);
    expect(calls[0]!.headers["authorization"]).toBe(`Bearer ${STRIPE_KEY_FX}`);
    // Version pinned via import — no duplicate literal.
    expect(calls[0]!.headers["stripe-version"]).toBe(STRIPE_API_VERSION);
  });
});

// ── Timeout: AbortSignal.timeout(STRIPE_REQUEST_TIMEOUT_MS) ──────────────────

describe("WH-AC24g: all StripeApi methods use AbortSignal.timeout(STRIPE_REQUEST_TIMEOUT_MS)", () => {
  it.each([
    {
      label: "retrieveSubscription",
      call: (api: StripeApi) => api.retrieveSubscription("sub_timeouttest"),
      mockResult: { id: "sub_timeouttest" },
    },
    {
      label: "cancelSubscription",
      call: (api: StripeApi) => api.cancelSubscription("sub_timeouttest"),
      mockResult: { id: "sub_timeouttest", status: "canceled" },
    },
    {
      label: "listInvoicePayments",
      call: (api: StripeApi) => api.listInvoicePayments("in_timeouttest"),
      mockResult: { data: [] },
    },
    {
      label: "createRefund",
      call: (api: StripeApi) => api.createRefund("pi_timeouttest", "sub_timeouttest", 9500),
      mockResult: { id: "re_timeouttest" },
    },
    {
      label: "markDuplicateSubscription",
      call: (api: StripeApi) => api.markDuplicateSubscription("sub_timeouttest"),
      mockResult: { id: "sub_timeouttest" },
    },
  ])("WH-AC24g: $label uses AbortSignal.timeout(STRIPE_REQUEST_TIMEOUT_MS)", async ({ call, mockResult }) => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    try {
      const { fetch: fetchImpl } = capturingFetch(mockResult);
      const api = createStripeApi(STRIPE_KEY_FX, fetchImpl);
      await call(api);
      expect(spy).toHaveBeenCalledWith(STRIPE_REQUEST_TIMEOUT_MS);
    } finally {
      spy.mockRestore();
    }
  });
});

// ── WH-AC24h: markDuplicateSubscription (A19) ────────────────────────────────

describe("WH-AC24h: markDuplicateSubscription makes POST /v1/subscriptions/{id} with dup marker (A19)", () => {
  it("WH-AC24h1: method is POST, URL contains /v1/subscriptions/{id}", async () => {
    const { fetch: fetchImpl, calls } = capturingFetch({ id: "sub_mrktest" });
    const api = createStripeApi(STRIPE_KEY_FX, fetchImpl);
    await api.markDuplicateSubscription("sub_mrktest");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toContain("/v1/subscriptions/sub_mrktest");
  });

  it("WH-AC24h2: body has exact URLSearchParams: metadata[duplicate_subscription]=true only", async () => {
    const { fetch: fetchImpl, calls } = capturingFetch({ id: "sub_mrktest" });
    const api = createStripeApi(STRIPE_KEY_FX, fetchImpl);
    await api.markDuplicateSubscription("sub_mrktest");
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body))).toEqual({
      "metadata[duplicate_subscription]": "true",
    });
  });

  it("WH-AC24h3: Idempotency-Key is dup-mark-{id}", async () => {
    const { fetch: fetchImpl, calls } = capturingFetch({ id: "sub_mrktest" });
    const api = createStripeApi(STRIPE_KEY_FX, fetchImpl);
    await api.markDuplicateSubscription("sub_mrktest");
    expect(calls[0]!.headers["idempotency-key"]).toBe("dup-mark-sub_mrktest");
  });

  it("WH-AC24h4: bad sub id → invalid_response without request (id guard)", async () => {
    const { fetch: fetchImpl, calls } = capturingFetch();
    const api = createStripeApi(STRIPE_KEY_FX, fetchImpl);
    const result = await api.markDuplicateSubscription("cus_bad_id");
    expect(calls).toHaveLength(0);
    expect(result).toEqual({ ok: false, kind: "invalid_response" });
  });

  it("WH-AC24h5: carries Authorization and Stripe-Version headers", async () => {
    const { fetch: fetchImpl, calls } = capturingFetch({ id: "sub_mrkauth" });
    const api = createStripeApi(STRIPE_KEY_FX, fetchImpl);
    await api.markDuplicateSubscription("sub_mrkauth");
    expect(calls[0]!.headers["authorization"]).toBe(`Bearer ${STRIPE_KEY_FX}`);
    expect(calls[0]!.headers["stripe-version"]).toBe(STRIPE_API_VERSION);
  });

  it("WH-AC24h6: uses AbortSignal.timeout(STRIPE_REQUEST_TIMEOUT_MS)", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    try {
      const { fetch: fetchImpl } = capturingFetch({ id: "sub_mrktout" });
      const api = createStripeApi(STRIPE_KEY_FX, fetchImpl);
      await api.markDuplicateSubscription("sub_mrktout");
      expect(spy).toHaveBeenCalledWith(STRIPE_REQUEST_TIMEOUT_MS);
    } finally {
      spy.mockRestore();
    }
  });
});
