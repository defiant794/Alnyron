/**
 * Integration tests: middleware admin branch, session refresh side of
 * AC-ADMINAUTH-04 (middleware-protection.test.ts covers the redirect itself).
 *
 * The mocked Supabase client calls the middleware's real `setAll` the way
 * @supabase/ssr does on a refresh (new or cleared cookies + no-cache
 * headers), so the copying logic under test is production code.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type SetAll = (
  cookies: { name: string; value: string; options: Record<string, unknown> }[],
  headers: Record<string, string>,
) => void;

const { mockGetClaims, cookieMethods } = vi.hoisted(() => ({
  mockGetClaims: vi.fn(),
  cookieMethods: { setAll: undefined as SetAll | undefined },
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn((_url: string, _key: string, options: { cookies: { setAll: SetAll } }) => {
    cookieMethods.setAll = options.cookies.setAll;
    return { auth: { getClaims: mockGetClaims } };
  }),
}));
// createMiddleware(routing) returns the public handler; it is called for /kontakt below.
vi.mock("next-intl/middleware", () => ({
  default: vi.fn(() => vi.fn(() => new Response(null, { status: 200 }))),
}));
vi.mock("@/i18n/routing", () => ({
  routing: { locales: ["da", "en"], defaultLocale: "da", localePrefix: "as-needed" },
}));
vi.mock("@/config/env", () => ({
  parseSupabasePublicEnv: vi.fn(() => ({
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "test-publishable-key",
  })),
}));

import middleware from "@/middleware";

const NO_STORE = "private, no-cache, no-store, must-revalidate, max-age=0";

/** getClaims that first refreshes (or clears) the session cookie, like @supabase/ssr. */
function claimsAfterRefresh(claims: Record<string, unknown> | null, cookieValue: string) {
  mockGetClaims.mockImplementation(async () => {
    cookieMethods.setAll?.(
      [{ name: "sb-test-auth-token", value: cookieValue, options: { path: "/", maxAge: cookieValue ? 3600 : 0 } }],
      { "Cache-Control": NO_STORE, Expires: "0", Pragma: "no-cache" },
    );
    return { data: { claims }, error: null };
  });
}

const request = (path: string) => new NextRequest(new URL(path, "http://localhost:3000"));

describe("middleware: AC-ADMINAUTH-04 session refresh on admin routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cookieMethods.setAll = undefined;
  });

  it("AC-ADMINAUTH-04e: the 307 to login carries the cleared auth cookie and the no-cache headers", async () => {
    claimsAfterRefresh(null, "");

    const response = await middleware(request("/admin/settings"));

    expect(response.status).toBe(307);
    expect(response.headers.get("set-cookie")).toContain("sb-test-auth-token=");
    expect(response.headers.get("cache-control")).toBe(NO_STORE);
    expect(response.headers.get("expires")).toBe("0");
    expect(response.headers.get("pragma")).toBe("no-cache");
  });

  it("AC-ADMINAUTH-04f: the redirect keeps the requested admin path as a guarded next param", async () => {
    mockGetClaims.mockResolvedValue({ data: { claims: null }, error: null });

    const withQuery = await middleware(request("/admin/settings?tab=social"));
    expect(new URL(withQuery.headers.get("location") ?? "").searchParams.get("next")).toBe(
      "/admin/settings?tab=social",
    );

    // `/admin` itself is not an accepted next target: plain login URL.
    const root = await middleware(request("/admin"));
    expect(new URL(root.headers.get("location") ?? "").search).toBe("");
  });

  it("AC-ADMINAUTH-04g: a signed-in request passes through with the refreshed cookie and no-cache headers", async () => {
    claimsAfterRefresh({ sub: "u1" }, "refreshed-token");

    const response = await middleware(request("/admin/settings"));

    expect(response.status).not.toBe(307);
    expect(response.headers.get("set-cookie")).toContain("sb-test-auth-token=refreshed-token");
    expect(response.headers.get("cache-control")).toBe(NO_STORE);
  });

  it("AC-ADMINAUTH-04h: /auth/* refreshes the session but is never redirected", async () => {
    mockGetClaims.mockResolvedValue({ data: { claims: null }, error: null });

    const response = await middleware(request("/auth/confirm?token_hash=x&type=invite"));

    expect(response.status).not.toBe(307);
    expect(mockGetClaims).toHaveBeenCalled();
  });

  it("AC-ADMINAUTH-04i: public routes never create a Supabase client (stay cookie-free)", async () => {
    await middleware(request("/kontakt"));

    expect(mockGetClaims).not.toHaveBeenCalled();
    expect(cookieMethods.setAll).toBeUndefined();
  });
});
