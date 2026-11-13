/**
 * Unit tests: src/lib/payments/stripe.ts — Stripe REST helper.
 * Journey: payments-slice1b-billing  PAY1B-AC35, PAY1B-AC36, PAY1B-AC37, PAY1B-AC38, PAY1B-AC39
 */
import { describe, it, expect, vi } from "vitest";
import {
  STRIPE_API_VERSION,
  encodeStripeForm,
  stripePost,
  createCheckoutSession,
  createBillingPortalSession,
} from "@/lib/payments/stripe";
import { STRIPE_REQUEST_TIMEOUT_MS } from "@/config/payments";

const API_KEY = "sk_test_unit_key";

// ── Helpers ───────────────────────────────────────────────────────────────────

function okFetch(body: unknown, status = 200): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status });
}

function errorFetch(body: unknown, status: number): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status });
}

function rejectFetch(message = "Network failure"): typeof fetch {
  return async () => { throw new TypeError(message); };
}

function rawFetch(text: string, status: number): typeof fetch {
  return async () => new Response(text, { status });
}

// ── PAY1B-AC35: encodeStripeForm ─────────────────────────────────────────────

describe("PAY1B-AC35: encodeStripeForm — encoding rules", () => {
  it("PAY1B-AC35a: flat string values", () => {
    const result = encodeStripeForm({ mode: "subscription", ui_mode: "hosted_page" });
    expect(result.get("mode")).toBe("subscription");
    expect(result.get("ui_mode")).toBe("hosted_page");
  });

  it("PAY1B-AC35b: nested object → a[b][c] key", () => {
    const result = encodeStripeForm({ subscription_data: { metadata: { user_id: "u1" } } });
    expect(result.get("subscription_data[metadata][user_id]")).toBe("u1");
  });

  it("PAY1B-AC35c: array values → indexed a[0], a[1] keys", () => {
    const result = encodeStripeForm({ default_tax_rates: ["txr_1", "txr_2"] });
    expect(result.get("default_tax_rates[0]")).toBe("txr_1");
    expect(result.get("default_tax_rates[1]")).toBe("txr_2");
  });

  it("PAY1B-AC35d: array of objects → a[0][key] keys", () => {
    const result = encodeStripeForm({ line_items: [{ price: "price_yr", quantity: 1 }] });
    expect(result.get("line_items[0][price]")).toBe("price_yr");
    expect(result.get("line_items[0][quantity]")).toBe("1");
  });

  it("PAY1B-AC35e: number values become decimal strings", () => {
    const result = encodeStripeForm({ expires_at: 1234567890, quantity: 1 });
    expect(result.get("expires_at")).toBe("1234567890");
    expect(result.get("quantity")).toBe("1");
  });

  it("PAY1B-AC35f: boolean values become 'true' or 'false'", () => {
    const result = encodeStripeForm({ enabled: true, disabled: false });
    expect(result.get("enabled")).toBe("true");
    expect(result.get("disabled")).toBe("false");
  });

  it("PAY1B-AC35g: undefined values are skipped (key absent)", () => {
    const result = encodeStripeForm({ mode: "subscription", customer: undefined });
    expect(result.has("customer")).toBe(false);
    expect(result.has("mode")).toBe(true);
  });

  it("PAY1B-AC35h: exact encoded string for a compound params object", () => {
    const result = encodeStripeForm({
      mode: "subscription",
      skipped: undefined,
      expires_at: 100,
      line_items: [{ price: "price_yr", quantity: 1 }],
      subscription_data: { default_tax_rates: ["txr_1"] },
      enabled: true,
    });
    // Brackets are percent-encoded by URLSearchParams; keys stay in insertion order.
    expect(result.toString()).toBe(
      "mode=subscription" +
        "&expires_at=100" +
        "&line_items%5B0%5D%5Bprice%5D=price_yr" +
        "&line_items%5B0%5D%5Bquantity%5D=1" +
        "&subscription_data%5Bdefault_tax_rates%5D%5B0%5D=txr_1" +
        "&enabled=true",
    );
  });

  it("PAY1B-AC35i: insertion order is preserved (deterministic)", () => {
    const result = encodeStripeForm({ z: "last", a: "first" });
    const keys = [...result.keys()];
    expect(keys[0]).toBe("z");
    expect(keys[1]).toBe("a");
  });
});

// ── PAY1B-AC36: stripePost headers and request shape ─────────────────────────

describe("PAY1B-AC36: stripePost — headers, method, AbortSignal, never throws", () => {
  it("PAY1B-AC36a: sends POST to the correct Stripe URL", async () => {
    let capturedUrl = "";
    const captureFetch: typeof fetch = async (url) => {
      capturedUrl = url as string;
      return new Response(JSON.stringify({ id: "obj_1" }), { status: 200 });
    };
    await stripePost(API_KEY, "/checkout/sessions", { mode: "subscription" }, captureFetch);
    expect(capturedUrl).toBe("https://api.stripe.com/v1/checkout/sessions");
  });

  it("PAY1B-AC36b: sends Authorization: Bearer header", async () => {
    let authHeader = "";
    const captureFetch: typeof fetch = async (_url, opts) => {
      const headers = new Headers(opts!.headers as HeadersInit);
      authHeader = headers.get("Authorization") ?? "";
      return new Response(JSON.stringify({}), { status: 200 });
    };
    await stripePost(API_KEY, "/test", {}, captureFetch);
    expect(authHeader).toBe(`Bearer ${API_KEY}`);
  });

  it("PAY1B-AC36c: sends Stripe-Version pinned to '2026-10-28.endive'", async () => {
    let stripeVersionHeader = "";
    const captureFetch: typeof fetch = async (_url, opts) => {
      const headers = new Headers(opts!.headers as HeadersInit);
      stripeVersionHeader = headers.get("Stripe-Version") ?? "";
      return new Response(JSON.stringify({}), { status: 200 });
    };
    await stripePost(API_KEY, "/test", {}, captureFetch);
    expect(stripeVersionHeader).toBe("2026-10-28.endive");
    expect(stripeVersionHeader).toBe(STRIPE_API_VERSION);
  });

  it("PAY1B-AC36d: Content-Type is application/x-www-form-urlencoded", async () => {
    let contentType = "";
    const captureFetch: typeof fetch = async (_url, opts) => {
      const headers = new Headers(opts!.headers as HeadersInit);
      contentType = headers.get("Content-Type") ?? "";
      return new Response(JSON.stringify({}), { status: 200 });
    };
    await stripePost(API_KEY, "/test", {}, captureFetch);
    expect(contentType).toBe("application/x-www-form-urlencoded");
  });

  it("PAY1B-AC36e: method is POST", async () => {
    let method = "";
    const captureFetch: typeof fetch = async (_url, opts) => {
      method = opts!.method as string;
      return new Response(JSON.stringify({}), { status: 200 });
    };
    await stripePost(API_KEY, "/test", {}, captureFetch);
    expect(method).toBe("POST");
  });

  it("PAY1B-AC36f: AbortSignal is present in the request options", async () => {
    let signal: AbortSignal | undefined;
    const captureFetch: typeof fetch = async (_url, opts) => {
      signal = opts!.signal as AbortSignal | undefined;
      return new Response(JSON.stringify({}), { status: 200 });
    };
    await stripePost(API_KEY, "/test", {}, captureFetch);
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("PAY1B-AC36g: AbortSignal.timeout is called with STRIPE_REQUEST_TIMEOUT_MS (10_000); signal is passed to fetch", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    try {
      let capturedSignal: AbortSignal | null = null;
      const captureFetch: typeof fetch = async (_url, opts) => {
        capturedSignal = (opts!.signal as AbortSignal | null | undefined) ?? null;
        return new Response(JSON.stringify({}), { status: 200 });
      };
      await stripePost(API_KEY, "/test", {}, captureFetch);
      expect(spy).toHaveBeenCalledExactlyOnceWith(STRIPE_REQUEST_TIMEOUT_MS);
      // The signal passed to fetch must be the one AbortSignal.timeout returned
      expect(capturedSignal).toBe(spy.mock.results[0]?.value);
    } finally {
      spy.mockRestore();
    }
  });
});

// ── PAY1B-AC37: stripePost result union ──────────────────────────────────────

describe("PAY1B-AC37: stripePost — result union, never throws", () => {
  it("PAY1B-AC37a: 2xx → {ok:true, data}", async () => {
    const result = await stripePost<{ id: string }>(
      API_KEY, "/test", {}, okFetch({ id: "obj_1" }),
    );
    expect(result).toEqual({ ok: true, data: { id: "obj_1" } });
  });

  it("PAY1B-AC37b: 4xx with Stripe error JSON → {ok:false, kind:'http', status, code from error.code}", async () => {
    const result = await stripePost(
      API_KEY, "/test", {},
      errorFetch({ error: { code: "card_declined", type: "card_error", message: "Card declined" } }, 402),
    );
    expect(result).toEqual({ ok: false, kind: "http", status: 402, code: "card_declined" });
  });

  it("PAY1B-AC37c: 4xx with Stripe error JSON → code falls back to error.type when error.code absent", async () => {
    const result = await stripePost(
      API_KEY, "/test", {},
      errorFetch({ error: { type: "invalid_request_error", message: "Bad param" } }, 400),
    );
    expect(result).toEqual({ ok: false, kind: "http", status: 400, code: "invalid_request_error" });
  });

  it("PAY1B-AC37d: 5xx with non-JSON body → {ok:false, kind:'http', status, code:null}", async () => {
    const result = await stripePost(
      API_KEY, "/test", {},
      rawFetch("Internal Server Error", 500),
    );
    expect(result).toEqual({ ok: false, kind: "http", status: 500, code: null });
  });

  it("PAY1B-AC37e: fetch throws (network error) → {ok:false, kind:'network'}", async () => {
    const result = await stripePost(API_KEY, "/test", {}, rejectFetch("ECONNREFUSED"));
    expect(result).toEqual({ ok: false, kind: "network" });
  });

  it("PAY1B-AC37f: the response body cannot be read (stream error) → {ok:false, kind:'network'}, no throw", async () => {
    const unreadable: typeof fetch = async () => {
      const response = new Response("{}", { status: 200 });
      vi.spyOn(response, "text").mockRejectedValue(new TypeError("body stream errored"));
      return response;
    };
    const result = await stripePost(API_KEY, "/test", {}, unreadable);
    expect(result).toEqual({ ok: false, kind: "network" });
  });

  // B2: a success whose body is not a JSON object is no usable answer.
  it.each([
    ["a non-JSON body", "<html>OK</html>"],
    ["a JSON array", '[{"id":"cs_test_x"}]'],
    ["JSON null", "null"],
    ["a JSON string", '"cs_test_x"'],
  ])("PAY1B-AC37g: 2xx with %s → {ok:false, kind:'invalid_response'}", async (_label, text) => {
    const result = await stripePost(API_KEY, "/test", {}, rawFetch(text, 200));
    expect(result).toEqual({ ok: false, kind: "invalid_response" });
  });
});

// ── PAY1B-AC38: createCheckoutSession invalid_response guard ─────────────────

describe("PAY1B-AC38: createCheckoutSession — invalid_response for wrong url/id", () => {
  it("PAY1B-AC38a: url not starting with https://checkout.stripe.com/ → invalid_response", async () => {
    const result = await createCheckoutSession(
      API_KEY,
      { mode: "subscription" },
      okFetch({ id: "cs_test_x", url: "https://evil.com/hijack" }),
    );
    expect(result).toEqual({ ok: false, kind: "invalid_response" });
  });

  it("PAY1B-AC38b: id not starting with cs_ → invalid_response", async () => {
    const result = await createCheckoutSession(
      API_KEY,
      { mode: "subscription" },
      okFetch({ id: "pi_bad_id", url: "https://checkout.stripe.com/c/pay/cs_test_x" }),
    );
    expect(result).toEqual({ ok: false, kind: "invalid_response" });
  });

  // Stripe does not document the hosted Checkout path; both shapes have been observed (B17).
  it.each(["c", "g"])(
    "PAY1B-AC38c: both conditions met (id starts cs_, url starts https://checkout.stripe.com/) → ok:true " +
      "(path /%s/pay/cs_test_…)",
    async (segment) => {
      const url = `https://checkout.stripe.com/${segment}/pay/cs_test_valid_session`;
      const result = await createCheckoutSession(
        API_KEY,
        { mode: "subscription" },
        okFetch({ id: "cs_test_valid_session", url }),
      );
      expect(result).toEqual({ ok: true, data: { id: "cs_test_valid_session", url } });
    },
  );

  it("PAY1B-AC38d: missing url field → invalid_response", async () => {
    const result = await createCheckoutSession(
      API_KEY, { mode: "subscription" }, okFetch({ id: "cs_test_x" }),
    );
    expect(result).toEqual({ ok: false, kind: "invalid_response" });
  });
});

// ── PAY1B-AC39: createBillingPortalSession invalid_response guard ─────────────

describe("PAY1B-AC39: createBillingPortalSession — invalid_response for wrong url", () => {
  it("PAY1B-AC39a: url not starting with https://billing.stripe.com/ → invalid_response", async () => {
    const result = await createBillingPortalSession(
      API_KEY,
      { customer: "cus_1" },
      okFetch({ url: "https://evil.com/portal" }),
    );
    expect(result).toEqual({ ok: false, kind: "invalid_response" });
  });

  it("PAY1B-AC39b: valid billing.stripe.com url → ok:true", async () => {
    const result = await createBillingPortalSession(
      API_KEY,
      { customer: "cus_1" },
      okFetch({ url: "https://billing.stripe.com/p/session/test_123" }),
    );
    expect(result).toEqual({
      ok: true,
      data: { url: "https://billing.stripe.com/p/session/test_123" },
    });
  });

  it("PAY1B-AC39c: missing url field → invalid_response", async () => {
    const result = await createBillingPortalSession(
      API_KEY, { customer: "cus_1" }, okFetch({}),
    );
    expect(result).toEqual({ ok: false, kind: "invalid_response" });
  });

  it("PAY1B-AC39d: B7 — the API 2026-10-28.endive portal URL (/p/session?secret=test_…) → ok:true", async () => {
    const result = await createBillingPortalSession(
      API_KEY,
      { customer: "cus_1" },
      okFetch({ url: "https://billing.stripe.com/p/session?secret=test_unitportal" }),
    );
    expect(result).toEqual({
      ok: true,
      data: { url: "https://billing.stripe.com/p/session?secret=test_unitportal" },
    });
  });
});
