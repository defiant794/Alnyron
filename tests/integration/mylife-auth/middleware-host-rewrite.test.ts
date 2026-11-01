/**
 * Integration tests: middleware MyLife host rewrite and route isolation.
 * Journey: mylife-login  ML-AC5, ML-AC9, ML-AC17, ML-AC18, ML-AC20
 *
 * - The MyLife host rewrites every path into /mylife (`x-middleware-rewrite`),
 *   except paths already under /mylife and /auth/*, which pass on as they are
 *   (`x-middleware-next: 1`, no rewrite).
 * - A protected MyLife path without a session gets a 307 to /mylife/login on
 *   the same host, carrying `next` only when safeNext accepts it.
 * - MyLife paths never reach next-intl.
 * - The session refresh's cookies and no-cache headers reach the rewrite and
 *   the 307.
 *
 * The mocked Supabase client calls the middleware's real `setAll` the way
 * @supabase/ssr does on a refresh, so the copying logic is production code.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

type SetAll = (
  cookies: { name: string; value: string; options: Record<string, unknown> }[],
  headers: Record<string, string>,
) => void;

const { mockGetClaims, mockHandleI18n, cookieMethods } = vi.hoisted(() => ({
  mockGetClaims: vi.fn(),
  // Replaces the per-request i18n handler (return value of createMiddleware(routing)).
  mockHandleI18n: vi.fn(() => new Response(null, { status: 200 })),
  cookieMethods: { setAll: undefined as SetAll | undefined },
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn((_url: string, _key: string, options: { cookies: { setAll: SetAll } }) => {
    cookieMethods.setAll = options.cookies.setAll;
    return { auth: { getClaims: mockGetClaims } };
  }),
}));
vi.mock("next-intl/middleware", () => ({ default: vi.fn(() => mockHandleI18n) }));
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

const MYLIFE_ORIGIN = "http://mylife.localhost:3000";
const APEX_ORIGIN = "http://localhost:3000";
const NO_STORE = "private, no-cache, no-store, must-revalidate, max-age=0";
const CLAIMS = { sub: "u1", role: "authenticated", email: "ml@test.local" };

function mylifeReq(path: string): NextRequest {
  return new NextRequest(new URL(path, MYLIFE_ORIGIN), { headers: { host: "mylife.localhost:3000" } });
}

function apexReq(path: string): NextRequest {
  return new NextRequest(new URL(path, APEX_ORIGIN), { headers: { host: "localhost:3000" } });
}

/** getClaims that first refreshes (or clears) the session cookie, like @supabase/ssr. */
function claimsAfterRefresh(claims: typeof CLAIMS | null, cookieValue: string) {
  mockGetClaims.mockImplementation(async () => {
    cookieMethods.setAll?.(
      [{ name: "sb-test-auth-token", value: cookieValue, options: { path: "/", maxAge: cookieValue ? 3600 : 0 } }],
      { "Cache-Control": NO_STORE, Expires: "0", Pragma: "no-cache" },
    );
    return { data: { claims }, error: null };
  });
}

/** Asserts the request passed on unchanged: no rewrite, no redirect. */
function expectPassedAsIs(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get("x-middleware-rewrite")).toBeNull();
  expect(response.headers.get("x-middleware-next")).toBe("1");
}

beforeEach(() => {
  vi.clearAllMocks();
  cookieMethods.setAll = undefined;
  mockGetClaims.mockResolvedValue({ data: { claims: null }, error: null });
});

// ── ML-AC17: the MyLife host rewrites paths into /mylife ─────────────────────

describe("middleware: ML-AC17 the MyLife host rewrites paths into /mylife", () => {
  it("ML-AC17r: /login is served from /mylife/login on the same host", async () => {
    const response = await middleware(mylifeReq("/login"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-rewrite")).toBe(`${MYLIFE_ORIGIN}/mylife/login`);
  });

  it("ML-AC17s: /forgot-password is served from /mylife/forgot-password", async () => {
    const response = await middleware(mylifeReq("/forgot-password"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-rewrite")).toBe(`${MYLIFE_ORIGIN}/mylife/forgot-password`);
  });

  it("ML-AC17t: a path already under /mylife is served as it is (no double prefix)", async () => {
    expectPassedAsIs(await middleware(mylifeReq("/mylife/login")));
  });

  it("ML-AC17u: / without a session is a 307 to /mylife/login on the same host, without next", async () => {
    const response = await middleware(mylifeReq("/"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${MYLIFE_ORIGIN}/mylife/login`);
  });

  it("ML-AC17v: / with a session is served from /mylife", async () => {
    mockGetClaims.mockResolvedValue({ data: { claims: CLAIMS }, error: null });
    const response = await middleware(mylifeReq("/"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-rewrite")).toBe(`${MYLIFE_ORIGIN}/mylife`);
  });

  it("ML-AC17w: the query string survives the rewrite", async () => {
    const response = await middleware(mylifeReq("/login?error=link_invalid"));
    expect(response.headers.get("x-middleware-rewrite")).toBe(
      `${MYLIFE_ORIGIN}/mylife/login?error=link_invalid`,
    );
  });

  it("ML-AC17x: the MyLife host never reaches next-intl", async () => {
    await middleware(mylifeReq("/login"));
    await middleware(mylifeReq("/"));
    expect(mockHandleI18n).not.toHaveBeenCalled();
  });
});

// ── ML-AC9: /admin on the MyLife host is not the admin panel ─────────────────

describe("middleware: ML-AC9 /admin on the MyLife host is not the admin panel", () => {
  it("ML-AC9a: without a session it is a 307 to the MyLife login with next=/mylife/admin", async () => {
    const response = await middleware(mylifeReq("/admin"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${MYLIFE_ORIGIN}/mylife/login?next=%2Fmylife%2Fadmin`);
  });

  it("ML-AC9b: with a session it is served from /mylife/admin (a 404), never /admin", async () => {
    mockGetClaims.mockResolvedValue({ data: { claims: CLAIMS }, error: null });
    const response = await middleware(mylifeReq("/admin"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-rewrite")).toBe(`${MYLIFE_ORIGIN}/mylife/admin`);
  });
});

// ── ML-AC9/ML-AC17: the trailing-dot FQDN host is the MyLife host too ────────

describe("middleware: ML-AC9 the trailing-dot MyLife host does not serve the admin login", () => {
  const FQDN_ORIGIN = "http://mylife.localhost.:3000";

  function fqdnReq(path: string): NextRequest {
    return new NextRequest(new URL(path, FQDN_ORIGIN), { headers: { host: "mylife.localhost.:3000" } });
  }

  it("ML-AC9c: /admin/login without a session is a 307 to the MyLife login, never the admin login", async () => {
    const response = await middleware(fqdnReq("/admin/login"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${FQDN_ORIGIN}/mylife/login?next=%2Fmylife%2Fadmin%2Flogin`);
    expect(mockHandleI18n).not.toHaveBeenCalled();
  });

  it("ML-AC9d: /admin/login with a session is served from /mylife/admin/login (a 404), never /admin/login", async () => {
    mockGetClaims.mockResolvedValue({ data: { claims: CLAIMS }, error: null });
    const response = await middleware(fqdnReq("/admin/login"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-rewrite")).toBe(`${FQDN_ORIGIN}/mylife/admin/login`);
  });

  it("ML-AC17q: /login is served from /mylife/login", async () => {
    const response = await middleware(fqdnReq("/login"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-rewrite")).toBe(`${FQDN_ORIGIN}/mylife/login`);
  });
});

// ── ML-AC20: /auth/* on the MyLife host passes through ───────────────────────

describe("middleware: ML-AC20 /auth/confirm passes through on the MyLife host", () => {
  it("ML-AC20: /auth/confirm is neither rewritten nor redirected, but refreshes the session", async () => {
    const response = await middleware(mylifeReq("/auth/confirm?token_hash=abc&type=invite"));
    expectPassedAsIs(response);
    expect(mockGetClaims).toHaveBeenCalledTimes(1);
  });
});

// ── ML-AC18: /mylife on the main host → auth branch, never next-intl ─────────

describe("middleware: ML-AC18 main-host /mylife paths take the auth branch, not next-intl", () => {
  it("ML-AC18a: /mylife/login refreshes the session and passes on; next-intl is not called", async () => {
    const response = await middleware(apexReq("/mylife/login"));
    expectPassedAsIs(response);
    expect(mockGetClaims).toHaveBeenCalledTimes(1);
    expect(mockHandleI18n).not.toHaveBeenCalled();
  });

  it("ML-AC18b: /mylife without a session is a 307 to /mylife/login (never /da/mylife)", async () => {
    const response = await middleware(apexReq("/mylife"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${APEX_ORIGIN}/mylife/login`);
    expect(mockHandleI18n).not.toHaveBeenCalled();
  });
});

// ── ML-AC5: protected MyLife paths need a session ────────────────────────────

describe("middleware: ML-AC5 protected MyLife paths redirect visitors without a session", () => {
  it("ML-AC5a: /mylife/set-password is a 307 to /mylife/login carrying next exactly", async () => {
    const response = await middleware(apexReq("/mylife/set-password"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      `${APEX_ORIGIN}/mylife/login?next=%2Fmylife%2Fset-password`,
    );
  });

  it("ML-AC5d: /mylife/login and /mylife/forgot-password are public", async () => {
    expectPassedAsIs(await middleware(apexReq("/mylife/login")));
    expectPassedAsIs(await middleware(apexReq("/mylife/forgot-password")));
  });

  it("ML-AC5c: a signed-in request for a protected path passes on", async () => {
    mockGetClaims.mockResolvedValue({ data: { claims: CLAIMS }, error: null });
    expectPassedAsIs(await middleware(apexReq("/mylife/set-password")));
  });
});

// ── ML-AC17: the session refresh survives the rewrite and the 307 ────────────

describe("middleware: ML-AC17 session refresh on the MyLife host", () => {
  it("ML-AC17y: the rewrite carries the refreshed cookie and the no-cache headers", async () => {
    claimsAfterRefresh(CLAIMS, "refreshed-token");

    const response = await middleware(mylifeReq("/login"));

    expect(response.headers.get("x-middleware-rewrite")).toBe(`${MYLIFE_ORIGIN}/mylife/login`);
    expect(response.headers.get("set-cookie")).toContain("sb-test-auth-token=refreshed-token");
    expect(response.headers.get("cache-control")).toBe(NO_STORE);
    expect(response.headers.get("expires")).toBe("0");
    expect(response.headers.get("pragma")).toBe("no-cache");
  });

  it("ML-AC17z: the 307 to the MyLife login carries the cleared cookie and the no-cache headers", async () => {
    claimsAfterRefresh(null, "");

    const response = await middleware(mylifeReq("/"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${MYLIFE_ORIGIN}/mylife/login`);
    expect(response.headers.get("set-cookie")).toContain("sb-test-auth-token=;");
    expect(response.headers.get("cache-control")).toBe(NO_STORE);
    expect(response.headers.get("expires")).toBe("0");
    expect(response.headers.get("pragma")).toBe("no-cache");
  });
});
