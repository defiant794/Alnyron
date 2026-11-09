/**
 * Unit tests — middleware: Monitor host rewrites + main-host 308 to subdomain.
 * Journey: monitor-ship-routing  SHIP-AC1a..SHIP-AC2f
 *
 * The real session refresh (`@/lib/supabase/middleware`) runs against a mocked
 * `@supabase/ssr` client; rewrites are read from `x-middleware-rewrite`, a
 * pass-through from `x-middleware-next`.
 *
 * Verifies:
 *   SHIP-AC1a: Monitor host '/' → rewrite to exactly '/monitor', updateSession called
 *   SHIP-AC1b: Monitor host '/login' → rewrite to exactly '/monitor/login', updateSession called
 *   SHIP-AC1c: Monitor host '/dashboard' (unauthed) → 307 to exactly /monitor/login?next=%2Fmonitor%2Fdashboard
 *   SHIP-AC1d: Monitor host '/monitor/settings' → served as-is (no double prefix)
 *   SHIP-AC1e: Monitor host '/auth/confirm' → served as-is (auth route passthrough)
 *   SHIP-AC1f/AC1g: Monitor host '/admin*', '/mylife*' → 307 to the Monitor login without a
 *              session, rewritten under /monitor (a 404) with one
 *   SHIP-AC1h: Monitor host paths → handleI18n never called
 *   SHIP-AC2a: Main host '/monitor' → 308 to http://monitor.localhost:3000/
 *   SHIP-AC2b: Main host '/monitor/login?next=...' → 308 with query preserved
 *   SHIP-AC2c: 308 response has Cache-Control: public, max-age=86400
 *   SHIP-AC2d: Main host MyLife paths → session refresh (MyLife login redirect), not 308
 *   SHIP-AC2e: Main host '/da/contact' → i18n branch (not 308, no session refresh)
 *   SHIP-AC2f: MyLife host paths → MyLife branch unchanged
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockGetClaims, mockI18n } = vi.hoisted(() => ({
  mockGetClaims: vi.fn(),
  mockI18n: vi.fn(() => new Response(null, { status: 299, headers: { "x-test-i18n": "1" } })),
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({
    auth: { getClaims: mockGetClaims },
  })),
}));

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

const MONITOR_ORIGIN = "http://monitor.localhost:3000";
const MAIN_ORIGIN = "http://localhost:3000";
const CLAIMS = { sub: "u1", role: "authenticated", email: "mon@test.local" };

function monitorHostRequest(pathname: string, search = ""): NextRequest {
  const url = new URL(pathname + search, MONITOR_ORIGIN);
  return new NextRequest(url, { headers: { host: "monitor.localhost:3000" } });
}

function mainHostRequest(pathname: string, search = ""): NextRequest {
  const url = new URL(pathname + search, MAIN_ORIGIN);
  return new NextRequest(url, { headers: { host: "localhost:3000" } });
}

function myLifeHostRequest(pathname: string): NextRequest {
  const url = new URL(pathname, "http://mylife.localhost");
  return new NextRequest(url, { headers: { host: "mylife.localhost" } });
}

/** The request went on unchanged: no rewrite, no redirect. */
function expectPassedAsIs(response: Response): void {
  expect(response.status).toBe(200);
  expect(response.headers.get("x-middleware-rewrite")).toBeNull();
  expect(response.headers.get("x-middleware-next")).toBe("1");
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetClaims.mockResolvedValue({ data: { claims: null }, error: null });
});

// ── SHIP-AC1a: Monitor host '/' → rewrite '/monitor' ─────────────────────────

describe("middleware — SHIP-AC1a: Monitor host '/' → rewritten to /monitor through updateSession", () => {
  it("SHIP-AC1a-mw1: Monitor host '/' → 200 rewritten to exactly http://monitor.localhost:3000/monitor", async () => {
    const response = await middleware(monitorHostRequest("/"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-rewrite")).toBe(`${MONITOR_ORIGIN}/monitor`);
  });

  it("SHIP-AC1a-mw2: Monitor host '/' → getClaims called (updateSession runs)", async () => {
    await middleware(monitorHostRequest("/"));
    expect(mockGetClaims).toHaveBeenCalledTimes(1);
  });

  it("SHIP-AC1a-mw3: Monitor host '/' → handleI18n never called", async () => {
    await middleware(monitorHostRequest("/"));
    expect(mockI18n).not.toHaveBeenCalled();
  });
});

// ── SHIP-AC1b: Monitor host '/login' → rewrite '/monitor/login' ──────────────

describe("middleware — SHIP-AC1b: Monitor host '/login' → rewritten to /monitor/login", () => {
  it("SHIP-AC1b-mw1: Monitor host '/login' → 200 rewritten to exactly http://monitor.localhost:3000/monitor/login", async () => {
    const response = await middleware(monitorHostRequest("/login"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-rewrite")).toBe(`${MONITOR_ORIGIN}/monitor/login`);
  });

  it("SHIP-AC1b-mw2: Monitor host '/login' → getClaims called", async () => {
    await middleware(monitorHostRequest("/login"));
    expect(mockGetClaims).toHaveBeenCalledTimes(1);
  });
});

// ── SHIP-AC1c: Monitor host '/dashboard' (unauthed) → 307 ────────────────────

describe("middleware — SHIP-AC1c: Monitor host '/dashboard' unauthed → 307 to /monitor/login", () => {
  it("SHIP-AC1c-mw1: Monitor host '/dashboard' unauthed → 307", async () => {
    const response = await middleware(monitorHostRequest("/dashboard"));
    expect(response.status).toBe(307);
  });

  it("SHIP-AC1c-mw2: 307 location is exactly /monitor/login?next=%2Fmonitor%2Fdashboard on the Monitor host", async () => {
    const response = await middleware(monitorHostRequest("/dashboard"));
    expect(response.headers.get("location")).toBe(`${MONITOR_ORIGIN}/monitor/login?next=%2Fmonitor%2Fdashboard`);
  });
});

// ── SHIP-AC1d: Monitor host '/monitor/settings' → served as-is ───────────────

describe("middleware — SHIP-AC1d: Monitor host '/monitor/settings' → served as-is", () => {
  it("SHIP-AC1d-mw1: unauthed → 307 to exactly /monitor/login?next=%2Fmonitor%2Fsettings (no /monitor/monitor prefix)", async () => {
    const response = await middleware(monitorHostRequest("/monitor/settings"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${MONITOR_ORIGIN}/monitor/login?next=%2Fmonitor%2Fsettings`);
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("SHIP-AC1d-mw2: with a session → passed on as-is (no rewrite)", async () => {
    mockGetClaims.mockResolvedValue({ data: { claims: CLAIMS }, error: null });
    expectPassedAsIs(await middleware(monitorHostRequest("/monitor/settings")));
  });

  it("SHIP-AC1d-mw3: Monitor host '/monitor/settings' → handleI18n never called", async () => {
    await middleware(monitorHostRequest("/monitor/settings"));
    expect(mockI18n).not.toHaveBeenCalled();
  });
});

// ── SHIP-AC1e: Monitor host '/auth/confirm' → passthrough ────────────────────

describe("middleware — SHIP-AC1e: Monitor host '/auth/confirm' → auth route passthrough", () => {
  it("SHIP-AC1e-mw1: Monitor host '/auth/confirm' → getClaims called (updateSession runs)", async () => {
    await middleware(monitorHostRequest("/auth/confirm"));
    expect(mockGetClaims).toHaveBeenCalledTimes(1);
  });

  it("SHIP-AC1e-mw2: Monitor host '/auth/confirm' → passed on as-is (no rewrite, no redirect)", async () => {
    expectPassedAsIs(await middleware(monitorHostRequest("/auth/confirm", "?token_hash=t&type=signup")));
  });
});

// ── SHIP-AC1f/AC1g: Monitor host '/admin*', '/mylife*' → under /monitor ─────

describe("middleware — SHIP-AC1f/AC1g: Monitor host '/admin' and '/mylife' are served under /monitor", () => {
  for (const path of ["/admin", "/admin/login", "/mylife", "/mylife/login"]) {
    it(`SHIP-AC1f/1g-mw1: '${path}' without a session → 307 to exactly the Monitor login with next=/monitor${path}`, async () => {
      const response = await middleware(monitorHostRequest(path));
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(
        `${MONITOR_ORIGIN}/monitor/login?${new URLSearchParams({ next: `/monitor${path}` })}`,
      );
    });

    it(`SHIP-AC1f/1g-mw2: '${path}' with a session → rewritten to exactly /monitor${path} (no such route: a 404)`, async () => {
      mockGetClaims.mockResolvedValue({ data: { claims: CLAIMS }, error: null });
      const response = await middleware(monitorHostRequest(path));
      expect(response.status).toBe(200);
      expect(response.headers.get("x-middleware-rewrite")).toBe(`${MONITOR_ORIGIN}/monitor${path}`);
    });
  }
});

// ── SHIP-AC1h: Monitor host → handleI18n never called for any path ───────────

describe("middleware — SHIP-AC1h: Monitor host → handleI18n never called", () => {
  for (const path of ["/", "/login", "/signup", "/dashboard", "/monitor/settings", "/admin"]) {
    it(`SHIP-AC1h-mw: Monitor host '${path}' → handleI18n not called`, async () => {
      await middleware(monitorHostRequest(path));
      expect(mockI18n).not.toHaveBeenCalled();
    });
  }
});

// ── SHIP-AC2a: Main host '/monitor' → 308 to monitor subdomain ───────────────

describe("middleware — SHIP-AC2a: main host '/monitor' → 308 to monitor subdomain", () => {
  it("SHIP-AC2a-mw1: main host '/monitor' → 308", async () => {
    const response = await middleware(mainHostRequest("/monitor"));
    expect(response.status).toBe(308);
  });

  it("SHIP-AC2a-mw2: 308 Location is 'http://monitor.localhost:3000/'", async () => {
    const response = await middleware(mainHostRequest("/monitor"));
    expect(response.headers.get("location")).toBe(`${MONITOR_ORIGIN}/`);
  });

  it("SHIP-AC2a-mw3: main host '/monitor/login' → 308", async () => {
    const response = await middleware(mainHostRequest("/monitor/login"));
    expect(response.status).toBe(308);
  });

  it("SHIP-AC2a-mw4: '/monitor/login' → 308 to 'http://monitor.localhost:3000/monitor/login'", async () => {
    const response = await middleware(mainHostRequest("/monitor/login"));
    expect(response.headers.get("location")).toBe(`${MONITOR_ORIGIN}/monitor/login`);
  });
});

// ── SHIP-AC2b: 308 preserves query string ────────────────────────────────────

describe("middleware — SHIP-AC2b: 308 preserves query string", () => {
  it("SHIP-AC2b-mw1: '/monitor/login?next=%2Fmonitor%2Fdashboard' → 308 to the same path and query on the Monitor host", async () => {
    const response = await middleware(mainHostRequest("/monitor/login", "?next=%2Fmonitor%2Fdashboard"));
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(`${MONITOR_ORIGIN}/monitor/login?next=%2Fmonitor%2Fdashboard`);
  });
});

// ── SHIP-AC2c: 308 Cache-Control ─────────────────────────────────────────────

describe("middleware — SHIP-AC2c: 308 response has Cache-Control: public, max-age=86400", () => {
  it("SHIP-AC2c-mw1: '/monitor' 308 → Cache-Control: public, max-age=86400", async () => {
    const response = await middleware(mainHostRequest("/monitor"));
    expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
  });
});

// ── SHIP-AC2d: MyLife paths on main host keep the session-refresh branch ─────

describe("middleware — SHIP-AC2d: main host MyLife paths → session refresh, not 308", () => {
  it("SHIP-AC2d-mw1: main host '/mylife/login' (public) → getClaims called, passed on as-is", async () => {
    const response = await middleware(mainHostRequest("/mylife/login"));
    expect(mockGetClaims).toHaveBeenCalledTimes(1);
    expectPassedAsIs(response);
    expect(mockI18n).not.toHaveBeenCalled();
  });

  it("SHIP-AC2d-mw2: main host '/mylife/set-password' unauthed → 307 to exactly /mylife/login?next=… on the main host", async () => {
    const response = await middleware(mainHostRequest("/mylife/set-password"));
    expect(mockGetClaims).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${MAIN_ORIGIN}/mylife/login?next=%2Fmylife%2Fset-password`);
  });
});

// ── SHIP-AC2e: Non-monitor main paths take i18n branch ───────────────────────

describe("middleware — SHIP-AC2e: main host non-monitor paths → i18n branch", () => {
  it("SHIP-AC2e-mw1: main host '/da/contact' → handleI18n's response, no session refresh", async () => {
    const request = mainHostRequest("/da/contact");
    const response = await middleware(request);
    expect(mockI18n).toHaveBeenCalledTimes(1);
    expect(mockI18n).toHaveBeenCalledWith(request);
    expect(response.status).toBe(299);
    expect(response.headers.get("x-test-i18n")).toBe("1");
    expect(mockGetClaims).not.toHaveBeenCalled();
  });
});

// ── SHIP-AC2f: MyLife host paths → MyLife branch unchanged ───────────────────

describe("middleware — SHIP-AC2f: MyLife host paths follow MyLife branch", () => {
  it("SHIP-AC2f-mw1: MyLife host '/' with a session → 200 rewritten to exactly http://mylife.localhost/mylife", async () => {
    mockGetClaims.mockResolvedValue({ data: { claims: CLAIMS }, error: null });
    const response = await middleware(myLifeHostRequest("/"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-rewrite")).toBe("http://mylife.localhost/mylife");
  });

  it("SHIP-AC2f-mw1b: MyLife host '/' without a session → 307 to exactly the MyLife login on the MyLife host", async () => {
    const response = await middleware(myLifeHostRequest("/"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://mylife.localhost/mylife/login");
  });

  it("SHIP-AC2f-mw2: MyLife host '/login' → getClaims called (updateSession runs)", async () => {
    await middleware(myLifeHostRequest("/login"));
    expect(mockGetClaims).toHaveBeenCalledTimes(1);
  });

  it("SHIP-AC2f-mw3: MyLife host paths → handleI18n never called", async () => {
    await middleware(myLifeHostRequest("/login"));
    expect(mockI18n).not.toHaveBeenCalled();
  });
});
