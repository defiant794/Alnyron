/**
 * Integration tests — middleware: admin route protection
 * Journey: admin-auth  AC-ADMINAUTH-04
 *
 * Tests that the middleware:
 *   - redirects any unauthenticated request for a protected /admin/* route
 *     to /admin/login with HTTP 307, and
 *   - passes through /admin/login and /admin/forgot-password while still
 *     calling getClaims (so existing session cookies are refreshed).
 *
 * Testing approach — the redirect logic stays in production code, not the test:
 *   - @supabase/ssr is mocked via vi.hoisted so getClaims returns { claims: null }
 *     (unauthenticated).  The real updateSession (lib/supabase/middleware.ts) uses
 *     this mocked client, so the auth-check logic is in the code.
 *   - @/config/env is mocked so parseSupabasePublicEnv() returns test-safe values
 *     without needing real env vars.
 *   - @/lib/supabase/middleware is NOT mocked — the real updateSession runs.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── vi.hoisted: initialise refs before any vi.mock factory runs ───────────────
const { mockGetClaims } = vi.hoisted(() => ({
  mockGetClaims: vi.fn(),
}));

// Mock @supabase/ssr.
vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({
    auth: { getClaims: mockGetClaims },
  })),
}));

// next-intl/middleware and its transitive next-intl/routing import use ESM that
// the integration project's Node env cannot process without server.deps.inline.
// Mock both so the middleware module loads without requiring next-intl at runtime.
vi.mock("next-intl/middleware", () => ({
  default: vi.fn(() => ({ headers: new Headers(), status: 200 })),
}));

vi.mock("@/i18n/routing", () => ({
  routing: { locales: ["da", "en"], defaultLocale: "da", localePrefix: "as-needed" },
}));


// Mock env so parseSupabasePublicEnv() does not throw when @/lib/supabase/middleware
// calls it during test runs (no real env vars required in CI).
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
}));

// Static import after mocks are declared — vi.mock is hoisted above it.
import middleware from "@/middleware";

// ── Helpers ───────────────────────────────────────────────────────────────────
// adminRequest has 4 call sites — kept as a named helper (lockstep base URL).

function adminRequest(pathname: string): NextRequest {
  return new NextRequest(new URL(pathname, "http://localhost:3000"));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("middleware — AC-ADMINAUTH-04: admin route protection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no valid session (unauthenticated).
    mockGetClaims.mockResolvedValue({ data: { claims: null }, error: null });
  });

  it("AC-ADMINAUTH-04a: GET /admin/dashboard without session → 307 to /admin/login", async () => {
    const response = await middleware(adminRequest("/admin/dashboard"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/admin/login");
  });

  it("AC-ADMINAUTH-04b: GET /admin/settings without session → 307 to /admin/login", async () => {
    const response = await middleware(adminRequest("/admin/settings"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/admin/login");
  });

  it("AC-ADMINAUTH-04c: GET /admin/login without session → passes through; getClaims reached", async () => {
    // The login page is never blocked (that would be circular). But updateSession
    // still runs to refresh any existing cookie — confirmed by getClaims being called.
    const response = await middleware(adminRequest("/admin/login"));

    expect(response.status).not.toBe(307);
    expect(mockGetClaims).toHaveBeenCalled();
  });

  it("AC-ADMINAUTH-04d: GET /admin/forgot-password without session → passes through; getClaims reached", async () => {
    const response = await middleware(adminRequest("/admin/forgot-password"));

    expect(response.status).not.toBe(307);
    expect(mockGetClaims).toHaveBeenCalled();
  });
});
