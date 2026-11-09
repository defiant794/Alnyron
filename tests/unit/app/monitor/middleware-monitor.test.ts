/**
 * Unit tests — middleware: monitor route protection on the Monitor host.
 * Journey: monitor-web-area  MON-AC44, MON-AC50, MON-AC61
 *
 * Tests run against the canonical Monitor host (monitor.localhost:3000).
 * Main-host /monitor* → 308 behavior is covered in middleware-monitor-subdomain.test.ts.
 *
 * Verifies:
 *   - Unauthenticated GET /monitor/dashboard → 307 to /monitor/login?next=...
 *   - Unauthenticated GET /monitor/settings  → 307 to /monitor/login?next=...
 *   - Public paths (/monitor, /monitor/login, /monitor/signup,
 *     /monitor/forgot-password) pass through without 307; getClaims is called
 *     (updateSession runs — session refresh).
 *   - /monitor/* goes through updateSession, never handleI18n (MON-AC50/MON-AC61).
 *
 * Mirrors tests/integration/admin-auth/middleware-protection.test.ts.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockGetClaims, mockI18n } = vi.hoisted(() => ({
  mockGetClaims: vi.fn(),
  // Status 299 = distinctive marker; x-test-i18n header lets tests prove
  // that the i18n branch was or was not taken for a given path.
  mockI18n: vi.fn(() => new Response(null, { status: 299, headers: { "x-test-i18n": "1" } })),
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({
    auth: { getClaims: mockGetClaims },
  })),
}));

// Trackable mock — monitor paths must not call it.
vi.mock("next-intl/middleware", () => ({ default: mockI18n }));

vi.mock("@/i18n/routing", () => ({
  routing: { locales: ["da", "en"], defaultLocale: "da", localePrefix: "as-needed" },
}));

vi.mock("@/config/env", () => ({
  parseSupabasePublicEnv: vi.fn(() => ({
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "test-publishable-key",
  })),
  parsePublicEnv: vi.fn(() => ({
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "test-publishable-key",
    NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
  })),
  parseSiteEnv: vi.fn(() => ({
    NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
  })),
}));

import middleware from "@/middleware";

function monitorRequest(pathname: string): NextRequest {
  const url = new URL(pathname, "http://monitor.localhost:3000");
  return new NextRequest(url, { headers: { host: "monitor.localhost:3000" } });
}

describe("middleware — MON-AC44/MON-AC50/MON-AC61: monitor route protection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no valid session (unauthenticated)
    mockGetClaims.mockResolvedValue({ data: { claims: null }, error: null });
  });

  // ── Protected paths redirect to login ────────────────────────────────────────

  it("MON-AC44a: GET /monitor/dashboard without session → 307 to /monitor/login", async () => {
    const response = await middleware(monitorRequest("/monitor/dashboard"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/monitor/login");
  });

  it("MON-AC44b: GET /monitor/settings without session → 307 to /monitor/login", async () => {
    const response = await middleware(monitorRequest("/monitor/settings"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/monitor/login");
  });

  it("MON-AC44c: GET /monitor/monitors/new without session → 307 to /monitor/login", async () => {
    const response = await middleware(monitorRequest("/monitor/monitors/new"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/monitor/login");
  });

  it("MON-AC44d: redirect includes next= param for /monitor/ paths (safeNext accepts them)", async () => {
    const response = await middleware(monitorRequest("/monitor/dashboard"));
    const location = response.headers.get("location") ?? "";
    expect(location).toContain("next=");
    expect(location).toContain("%2Fmonitor%2Fdashboard");
  });

  // ── Public paths pass through ─────────────────────────────────────────────────

  it("MON-AC44e: GET /monitor/login without session → passes through; getClaims reached", async () => {
    const response = await middleware(monitorRequest("/monitor/login"));
    expect(response.status).not.toBe(307);
    expect(mockGetClaims).toHaveBeenCalled();
  });

  it("MON-AC44f: GET /monitor/signup without session → passes through; getClaims reached", async () => {
    const response = await middleware(monitorRequest("/monitor/signup"));
    expect(response.status).not.toBe(307);
    expect(mockGetClaims).toHaveBeenCalled();
  });

  it("MON-AC44g: GET /monitor/forgot-password without session → passes through; getClaims reached", async () => {
    const response = await middleware(monitorRequest("/monitor/forgot-password"));
    expect(response.status).not.toBe(307);
    expect(mockGetClaims).toHaveBeenCalled();
  });

  it("MON-AC44h: GET /monitor (home/landing) without session → passes through; i18n branch NOT taken", async () => {
    const response = await middleware(monitorRequest("/monitor"));
    expect(response.status).not.toBe(307);
    // Monitor branch runs updateSession, not handleI18n
    expect(mockI18n).not.toHaveBeenCalled();
    expect(mockGetClaims).toHaveBeenCalled();
  });

  // ── MON-AC50: updateSession branch, never handleI18n ─────────────────────────

  it("MON-AC50a: GET /monitor/dashboard goes through updateSession, mockI18n never called", async () => {
    await middleware(monitorRequest("/monitor/dashboard"));
    expect(mockI18n).not.toHaveBeenCalled();
    expect(mockGetClaims).toHaveBeenCalled();
  });

  it("MON-AC50b: GET /monitor/signup goes through updateSession, mockI18n never called", async () => {
    await middleware(monitorRequest("/monitor/signup"));
    expect(mockI18n).not.toHaveBeenCalled();
    expect(mockGetClaims).toHaveBeenCalled();
  });

  it("MON-AC50c: GET /monitor/login redirect location is /monitor/login not /da/monitor/login", async () => {
    // Additional guard: if middleware incorrectly routes /monitor/dashboard through i18n,
    // the 307 would point to /da/monitor/dashboard. Assert the exact path instead.
    const response = await middleware(monitorRequest("/monitor/dashboard"));
    const url = new URL(response.headers.get("location") ?? "http://x", "http://localhost:3000");
    expect(url.pathname).toBe("/monitor/login");
    expect(url.searchParams.get("next")).toBe("/monitor/dashboard");
  });
});
