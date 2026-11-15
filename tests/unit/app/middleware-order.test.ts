/**
 * Unit tests: src/middleware.ts — /order/* path exclusion from next-intl and the
 * `x-order-locale` request header for the /order layout
 * Journey: payments-s2-3d-purchase
 * Criteria: contract §3 — /order and /order/* pass through without next-intl
 *   rewrite into [locale]; the middleware alone passes `?lang=` on to the
 *   layout (`<html lang>`, WCAG 3.1.1), overwriting any client-sent value.
 *
 * Test IDs: S2-T-MW-ORD-00..07
 *
 * Uses the middleware-monitor-subdomain.test.ts mock pattern:
 *   - `default: vi.fn(() => mockI18n)` (createMiddleware factory)
 *   - positive control: /da/contact DOES call i18n (marker status 299)
 *   - negative: /order, /order/thanks, /order/withdraw never get marker 299
 * `NextResponse.next({ request: { headers } })` forwards a request header as the
 * response header `x-middleware-request-<name>`, listed in `x-middleware-override-headers`.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockGetClaims, mockI18n } = vi.hoisted(() => ({
  mockGetClaims: vi.fn(),
  // Status 299 = distinctive i18n-was-called marker
  mockI18n: vi.fn(() => new Response(null, { status: 299, headers: { "x-test-i18n": "1" } })),
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({
    auth: { getClaims: mockGetClaims },
  })),
}));

// Factory pattern: `createMiddleware(routing)` returns `mockI18n`.
// Tests assert that mockI18n is never called for /order paths.
vi.mock("next-intl/middleware", () => ({ default: vi.fn(() => mockI18n) }));

vi.mock("@/i18n/routing", () => ({
  routing: { locales: ["da", "en"], defaultLocale: "da", localePrefix: "as-needed" },
}));

vi.mock("@/config/env", () => ({
  parseSupabasePublicEnv: vi.fn(() => ({
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "test-key",
  })),
  parseSiteEnv: vi.fn(() => ({
    NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
  })),
}));

import middleware from "@/middleware";

const MAIN_ORIGIN = "http://localhost:3000";

function mainRequest(pathname: string): NextRequest {
  const url = new URL(pathname, MAIN_ORIGIN);
  return new NextRequest(url, { headers: { host: "localhost:3000" } });
}

beforeEach(() => { vi.clearAllMocks(); });

// ── Positive control: i18n branch fires for locale-prefixed paths ─────────

describe("S2-T-MW-ORD-00: positive control — /da/contact triggers i18n (marker 299)", () => {
  it("main host /da/contact returns the i18n 299 marker", async () => {
    mockGetClaims.mockResolvedValue({ data: { claims: null } });
    const res = await middleware(mainRequest("/da/contact"));
    expect(res.status).toBe(299);
    expect(res.headers.get("x-test-i18n")).toBe("1");
  });
});

// ── S2-T-MW-ORD-01: /order not rewritten by next-intl ─────────────────────

describe("S2-T-MW-ORD-01: /order — NOT handled by next-intl, no 299 marker", () => {
  it("main host /order does not trigger the i18n branch", async () => {
    mockGetClaims.mockResolvedValue({ data: { claims: null } });
    const res = await middleware(mainRequest("/order"));
    expect(res.status).not.toBe(299);
    expect(res.headers.get("x-test-i18n")).toBeNull();
    // mockI18n (the i18n handler) must not have been called
    expect(mockI18n).not.toHaveBeenCalled();
  });
});

// ── S2-T-MW-ORD-02: /order/thanks not rewritten ───────────────────────────

describe("S2-T-MW-ORD-02: /order/thanks — NOT handled by next-intl", () => {
  it("main host /order/thanks does not trigger the i18n branch", async () => {
    mockGetClaims.mockResolvedValue({ data: { claims: null } });
    const res = await middleware(mainRequest("/order/thanks"));
    expect(res.status).not.toBe(299);
    expect(mockI18n).not.toHaveBeenCalled();
  });
});

// ── S2-T-MW-ORD-03: /order/withdraw not rewritten ────────────────────────

describe("S2-T-MW-ORD-03: /order/withdraw — NOT handled by next-intl", () => {
  it("main host /order/withdraw does not trigger the i18n branch", async () => {
    mockGetClaims.mockResolvedValue({ data: { claims: null } });
    const res = await middleware(mainRequest("/order/withdraw"));
    expect(res.status).not.toBe(299);
    expect(mockI18n).not.toHaveBeenCalled();
  });
});

// ── S2-T-MW-ORD-04: /order/* does not get a next-intl rewrite header ─────

describe("S2-T-MW-ORD-04: /order/error — no x-middleware-rewrite into /da/order/error", () => {
  it("main host /order/error response has no x-middleware-rewrite to a locale-prefixed path", async () => {
    mockGetClaims.mockResolvedValue({ data: { claims: null } });
    const res = await middleware(mainRequest("/order/error"));
    const rewrite = res.headers.get("x-middleware-rewrite") ?? "";
    expect(rewrite).not.toMatch(/^https?:\/\/[^/]+\/da\/order/);
    expect(rewrite).not.toMatch(/^https?:\/\/[^/]+\/en\/order/);
  });
});

/** The `x-order-locale` value the middleware forwarded to the page, or null when it forwarded none. */
function forwardedOrderLocale(res: Response): string | null {
  const overridden = (res.headers.get("x-middleware-override-headers") ?? "").split(",");
  return overridden.includes("x-order-locale") ? res.headers.get("x-middleware-request-x-order-locale") : null;
}

// ── S2-T-MW-ORD-05: a single ?lang= is forwarded ─────────────────────────

describe("S2-T-MW-ORD-05: /order/* — a single supported ?lang= is forwarded as x-order-locale", () => {
  it.each([
    ["/order/thanks?lang=en", "en"],
    ["/order/withdraw?lang=da", "da"],
    ["/order/error?reason=busy&lang=en", "en"],
  ])("%s → x-order-locale %s", async (path, expected) => {
    const res = await middleware(mainRequest(path));
    expect(forwardedOrderLocale(res)).toBe(expected);
    expect(mockI18n).not.toHaveBeenCalled();
  });

  it("no ?lang= → x-order-locale da", async () => {
    const res = await middleware(mainRequest("/order/thanks"));
    expect(forwardedOrderLocale(res)).toBe("da");
  });
});

// ── S2-T-MW-ORD-06: a client-sent x-order-locale is overwritten ──────────

describe("S2-T-MW-ORD-06: /order/* — a client-sent x-order-locale is overwritten", () => {
  it.each([
    ["/order/thanks", "en", "da"],
    ["/order/thanks?lang=da", "en", "da"],
    ["/order/withdraw?lang=en", "da", "en"],
  ])("%s with a spoofed header %s → %s", async (path, spoofed, expected) => {
    const request = new NextRequest(new URL(path, MAIN_ORIGIN), {
      headers: { host: "localhost:3000", "x-order-locale": spoofed },
    });
    const res = await middleware(request);
    expect(forwardedOrderLocale(res)).toBe(expected);
  });
});

// ── S2-T-MW-ORD-07: a repeated or unknown ?lang= is Danish ───────────────

describe("S2-T-MW-ORD-07: /order/* — a repeated or unsupported ?lang= is Danish", () => {
  it.each([
    "/order/thanks?lang=en&lang=en",
    "/order/thanks?lang=en&lang=da",
    "/order/thanks?lang=de",
    "/order/thanks?lang=EN",
    "/order/thanks?lang=",
  ])("%s → x-order-locale da", async (path) => {
    const res = await middleware(mainRequest(path));
    expect(forwardedOrderLocale(res)).toBe("da");
  });
});
