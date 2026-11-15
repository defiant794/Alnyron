/**
 * Unit tests: src/app/api/checkout/item/route.ts — POST /api/checkout/item
 * Journey: payments-s2-3d-purchase
 * Criteria: S2-CHK-1..3, S2-SEC-7 (web layer)
 *
 * Test IDs: S2-T-ROUTE-01..15
 *
 * Security behaviours tested at runtime (contract §3):
 *   - Origin 403 (missing / foreign Origin)
 *   - Rate limiter missing/throws/success:false → 303 /order/error?lang=<locale>&reason=busy
 *   - Zod failures → 303 /order/error?lang=da
 *   - Binding missing/throws/{ok:false}/non-Stripe URL → 303 /order/error
 *   - STRIPE_CHECKOUT_KEY / getStripeEnv never read by this route
 *   - Exact rate-limiter key: goods-checkout:<ip> / goods-checkout:unknown
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// ── vi.hoisted ──────────────────────────────────────────────────────────────

const {
  mockGetSession,
  mockGetCloudflareContext,
  mockLimit,
  mockOrdersStartCheckout,
  mockParseSiteEnv,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockGetCloudflareContext: vi.fn(),
  mockLimit: vi.fn(),
  mockOrdersStartCheckout: vi.fn(),
  mockParseSiteEnv: vi.fn(),
}));

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: vi.fn(() => ({
    auth: { getSession: mockGetSession },
  })),
}));

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: mockGetCloudflareContext,
}));

vi.mock("@/config/env", async (importOriginal) => {
  // Exception: vi.mock factory is hoisted; must dynamically import the original here.
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, parseSiteEnv: mockParseSiteEnv };
});

// Security guard: STRIPE_CHECKOUT_KEY / getStripeEnv must NEVER be imported by this route.
vi.mock("@/config/stripe-env", () => ({
  getStripeEnv: vi.fn(() => { throw new Error("getStripeEnv must not be called by the goods route"); }),
}));

// ── Module under test ───────────────────────────────────────────────────────

import { POST } from "@/app/api/checkout/item/route";

// ── Helpers ────────────────────────────────────────────────────────────────

const SITE_ORIGIN = "https://alnyron.dk";
const ITEM_ID = "00000000-0000-0000-0000-000000000001";
const STRIPE_URL = "https://checkout.stripe.com/pay/cs_test_live123";
const TEST_IP = "203.0.113.42";

function makeRequest(overrides: {
  origin?: string | null;
  body?: Record<string, string>;
  cfConnectingIp?: string | null;
} = {}): Request {
  const {
    origin = SITE_ORIGIN,
    body = { item_id: ITEM_ID, locale: "da" },
    cfConnectingIp = TEST_IP,
  } = overrides;
  const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
  if (origin !== null) headers.set("origin", origin);
  if (cfConnectingIp !== null) headers.set("cf-connecting-ip", cfConnectingIp);
  return new Request("https://alnyron.dk/api/checkout/item", {
    method: "POST",
    headers,
    body: new URLSearchParams(body).toString(),
  });
}

/** Parse a 303 Location header as a URL relative to SITE_ORIGIN. */
function parseRedirect(res: Response): { pathname: string; params: [string, string][] } {
  const loc = res.headers.get("location") ?? "";
  const url = new URL(loc, SITE_ORIGIN);
  return { pathname: url.pathname, params: [...url.searchParams.entries()] };
}

function setupDefaultEnv(): void {
  mockParseSiteEnv.mockReturnValue({ NEXT_PUBLIC_SITE_URL: SITE_ORIGIN });
  mockGetCloudflareContext.mockReturnValue({
    env: {
      BILLING_RATE_LIMITER: { limit: mockLimit },
      ORDERS: { startCheckout: mockOrdersStartCheckout },
    },
  });
  mockLimit.mockResolvedValue({ success: true });
  mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
  mockOrdersStartCheckout.mockResolvedValue({ ok: true, url: STRIPE_URL });
}

beforeEach(() => { vi.clearAllMocks(); });

// ── S2-T-ROUTE-01: Origin missing → 403 empty body ───────────────────────

describe("S2-T-ROUTE-01: POST /api/checkout/item — missing Origin → 403, empty body", () => {
  it("returns 403 with empty body when Origin header is absent", async () => {
    setupDefaultEnv();
    const res = await POST(makeRequest({ origin: null }));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("");
  });
});

// ── S2-T-ROUTE-02: Origin foreign → 403 empty body ───────────────────────

describe("S2-T-ROUTE-02: POST /api/checkout/item — foreign Origin → 403, empty body", () => {
  it("returns 403 with empty body when Origin does not equal siteOrigin", async () => {
    setupDefaultEnv();
    const res = await POST(makeRequest({ origin: "https://evil.example.com" }));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("");
  });
});

// ── S2-T-ROUTE-03: Rate limiter missing → 303 lang=da&reason=busy ─────────

describe("S2-T-ROUTE-03: POST /api/checkout/item — BILLING_RATE_LIMITER missing → fail closed busy", () => {
  it("303 to /order/error?lang=da&reason=busy when binding is absent, rate limiter key is goods-checkout:ip", async () => {
    mockParseSiteEnv.mockReturnValue({ NEXT_PUBLIC_SITE_URL: SITE_ORIGIN });
    mockGetCloudflareContext.mockReturnValue({
      env: { ORDERS: { startCheckout: mockOrdersStartCheckout } },
    });
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
    const res = await POST(makeRequest());
    expect(res.status).toBe(303);
    const { pathname, params } = parseRedirect(res);
    expect(pathname).toBe("/order/error");
    expect(params).toEqual([["lang", "da"], ["reason", "busy"]]);
  });
});

// ── S2-T-ROUTE-04: Rate limiter throws → fail closed busy ────────────────

describe("S2-T-ROUTE-04: POST /api/checkout/item — rate limiter throws → fail closed busy", () => {
  it("303 to /order/error?lang=da&reason=busy when limiter.limit throws", async () => {
    setupDefaultEnv();
    mockLimit.mockRejectedValue(new Error("limiter down"));
    const res = await POST(makeRequest());
    expect(res.status).toBe(303);
    const { pathname, params } = parseRedirect(res);
    expect(pathname).toBe("/order/error");
    expect(params).toEqual([["lang", "da"], ["reason", "busy"]]);
  });

  it("rate limiter is keyed goods-checkout:<ip> for a known IP", async () => {
    setupDefaultEnv();
    // success path so limiter is called; we just check the key
    const res = await POST(makeRequest({ cfConnectingIp: TEST_IP }));
    expect(res.status).toBe(303); // redirects to Stripe if all ok
    // key is verified by the fact that limit was called with the right key
    expect(mockLimit).toHaveBeenCalledWith({ key: `goods-checkout:${TEST_IP}` });
  });

  it("rate limiter uses goods-checkout:unknown when cf-connecting-ip is absent", async () => {
    setupDefaultEnv();
    await POST(makeRequest({ cfConnectingIp: null }));
    expect(mockLimit).toHaveBeenCalledWith({ key: "goods-checkout:unknown" });
  });
});

// ── S2-T-ROUTE-05: Rate limiter success:false → fail closed busy ──────────

describe("S2-T-ROUTE-05: POST /api/checkout/item — rate limiter success:false → fail closed busy", () => {
  it("303 to /order/error?lang=da&reason=busy when limiter returns {success:false}", async () => {
    setupDefaultEnv();
    mockLimit.mockResolvedValue({ success: false });
    const res = await POST(makeRequest());
    expect(res.status).toBe(303);
    const { pathname, params } = parseRedirect(res);
    expect(pathname).toBe("/order/error");
    expect(params).toEqual([["lang", "da"], ["reason", "busy"]]);
  });
});

// ── S2-T-ROUTE-06: Zod invalid item_id → 303 /order/error?lang=da ─────────

describe("S2-T-ROUTE-06: POST /api/checkout/item — invalid item_id → 303 /order/error?lang=da", () => {
  it("303 to /order/error?lang=da (no reason) when item_id is not a UUID", async () => {
    setupDefaultEnv();
    const res = await POST(makeRequest({ body: { item_id: "not-a-uuid", locale: "da" } }));
    expect(res.status).toBe(303);
    const { pathname, params } = parseRedirect(res);
    expect(pathname).toBe("/order/error");
    expect(params).toEqual([["lang", "da"]]);
  });
});

// ── S2-T-ROUTE-07: Zod invalid locale → 303 /order/error?lang=da ─────────

describe("S2-T-ROUTE-07: POST /api/checkout/item — invalid locale → 303 /order/error?lang=da", () => {
  it("303 to /order/error?lang=da when locale is not da or en", async () => {
    setupDefaultEnv();
    const res = await POST(makeRequest({ body: { item_id: ITEM_ID, locale: "fr" } }));
    expect(res.status).toBe(303);
    const { pathname, params } = parseRedirect(res);
    expect(pathname).toBe("/order/error");
    expect(params).toEqual([["lang", "da"]]);
  });
});

// ── S2-T-ROUTE-08: ORDERS binding missing → 303 reason=unavailable ────────

describe("S2-T-ROUTE-08: POST /api/checkout/item — ORDERS binding missing → 303 reason=unavailable", () => {
  it("303 to /order/error?lang=da&reason=unavailable when ORDERS binding is absent", async () => {
    mockParseSiteEnv.mockReturnValue({ NEXT_PUBLIC_SITE_URL: SITE_ORIGIN });
    mockLimit.mockResolvedValue({ success: true });
    mockGetCloudflareContext.mockReturnValue({
      env: { BILLING_RATE_LIMITER: { limit: mockLimit } },
    });
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
    const res = await POST(makeRequest());
    expect(res.status).toBe(303);
    const { pathname, params } = parseRedirect(res);
    expect(pathname).toBe("/order/error");
    expect(params).toEqual([["lang", "da"], ["reason", "unavailable"]]);
  });
});

// ── S2-T-ROUTE-09: ORDERS.startCheckout throws → 303 reason=unavailable ──

describe("S2-T-ROUTE-09: POST /api/checkout/item — ORDERS.startCheckout throws → reason=unavailable", () => {
  it("303 to /order/error?lang=da&reason=unavailable when startCheckout throws", async () => {
    setupDefaultEnv();
    mockOrdersStartCheckout.mockRejectedValue(new Error("Worker down"));
    const res = await POST(makeRequest());
    expect(res.status).toBe(303);
    const { pathname, params } = parseRedirect(res);
    expect(pathname).toBe("/order/error");
    expect(params).toEqual([["lang", "da"], ["reason", "unavailable"]]);
  });
});

// ── S2-T-ROUTE-10: {ok:false, reason:'not_purchasable'} → 303 not_purchasable

describe("S2-T-ROUTE-10: POST /api/checkout/item — {ok:false, reason:'not_purchasable'}", () => {
  it("303 to /order/error?lang=da&reason=not_purchasable", async () => {
    setupDefaultEnv();
    mockOrdersStartCheckout.mockResolvedValue({ ok: false, reason: "not_purchasable" });
    const res = await POST(makeRequest());
    expect(res.status).toBe(303);
    const { pathname, params } = parseRedirect(res);
    expect(pathname).toBe("/order/error");
    expect(params).toEqual([["lang", "da"], ["reason", "not_purchasable"]]);
  });
});

// ── S2-T-ROUTE-11: non-Stripe URL → 303 reason=unavailable ───────────────

describe("S2-T-ROUTE-11: POST /api/checkout/item — non-Stripe URL refused → reason=unavailable", () => {
  it("303 to /order/error?lang=da&reason=unavailable when url origin != checkout.stripe.com", async () => {
    setupDefaultEnv();
    mockOrdersStartCheckout.mockResolvedValue({ ok: true, url: "https://evil.example.com/pay" });
    const res = await POST(makeRequest());
    expect(res.status).toBe(303);
    const { pathname, params } = parseRedirect(res);
    expect(pathname).toBe("/order/error");
    expect(params).toEqual([["lang", "da"], ["reason", "unavailable"]]);
  });
});

// ── S2-T-ROUTE-12: Stripe URL → 303 to that exact URL ────────────────────

describe("S2-T-ROUTE-12: POST /api/checkout/item — Stripe URL → 303 to Stripe Checkout", () => {
  it("303 to exactly the Stripe Checkout URL when ORDERS returns {ok:true, url}", async () => {
    setupDefaultEnv();
    const res = await POST(makeRequest());
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(STRIPE_URL);
  });
});

// ── S2-T-ROUTE-13: access token passed when session present ───────────────

describe("S2-T-ROUTE-13: POST /api/checkout/item — access token from getSession forwarded", () => {
  it("calls ORDERS.startCheckout with exact {itemId, locale, accessToken}", async () => {
    setupDefaultEnv();
    const ACCESS_TOKEN = "eyJhbGciOiJIUzI1NiJ9.test-access-token";
    mockGetSession.mockResolvedValue({
      data: { session: { access_token: ACCESS_TOKEN } },
      error: null,
    });
    await POST(makeRequest({ body: { item_id: ITEM_ID, locale: "da" } }));
    expect(mockOrdersStartCheckout).toHaveBeenCalledWith({
      itemId: ITEM_ID,
      locale: "da",
      accessToken: ACCESS_TOKEN,
    });
  });
});

// ── S2-T-ROUTE-14: guest checkout — no accessToken key ───────────────────

describe("S2-T-ROUTE-14: POST /api/checkout/item — no session → guest, no accessToken key", () => {
  it("calls ORDERS.startCheckout with exactly {itemId, locale} and no accessToken key", async () => {
    setupDefaultEnv();
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
    await POST(makeRequest({ body: { item_id: ITEM_ID, locale: "da" } }));
    expect(mockOrdersStartCheckout).toHaveBeenCalledWith({ itemId: ITEM_ID, locale: "da" });
  });
});

// ── S2-T-ROUTE-15: locale=en forwarded in error redirect ──────────────────

describe("S2-T-ROUTE-15: POST /api/checkout/item — locale=en forwarded in error redirect", () => {
  it("303 error redirect carries lang=en when locale=en in form", async () => {
    setupDefaultEnv();
    mockOrdersStartCheckout.mockResolvedValue({ ok: false, reason: "not_purchasable" });
    const res = await POST(makeRequest({ body: { item_id: ITEM_ID, locale: "en" } }));
    expect(res.status).toBe(303);
    const { pathname, params } = parseRedirect(res);
    expect(pathname).toBe("/order/error");
    expect(params).toEqual([["lang", "en"], ["reason", "not_purchasable"]]);
  });
});
