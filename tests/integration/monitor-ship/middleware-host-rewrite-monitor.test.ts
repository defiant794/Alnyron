/**
 * Integration tests: middleware Monitor host rewrite and route isolation.
 * Journey: monitor-ship-routing  SHIP-AC1a..SHIP-AC2f
 *
 * Mirrors tests/integration/mylife-auth/middleware-host-rewrite.test.ts for
 * the Monitor host branch added in Slice C, Run A.
 *
 * Testing approach:
 *   - @supabase/ssr is mocked so getClaims is controllable.
 *   - The real updateSession (lib/supabase/middleware.ts) runs against the mock.
 *   - @/lib/supabase/middleware is NOT mocked — the real auth-check logic runs.
 *   - Rewrites are observable via x-middleware-rewrite; passes via x-middleware-next.
 *
 * Run via: npm run test:integration:e2e-project -- tests/integration/monitor-ship/
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

type SetAll = (
  cookies: { name: string; value: string; options: Record<string, unknown> }[],
  headers: Record<string, string>,
) => void;

const { mockGetClaims, mockHandleI18n, cookieMethods } = vi.hoisted(() => ({
  mockGetClaims: vi.fn(),
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
  parseSiteEnv: vi.fn(() => ({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" })),
}));

import middleware from "@/middleware";

const MONITOR_ORIGIN = "http://monitor.localhost:3000";
const APEX_ORIGIN = "http://localhost:3000";
const CLAIMS = { sub: "u1", role: "authenticated", email: "mon@test.local" };

function monitorReq(path: string): NextRequest {
  return new NextRequest(new URL(path, MONITOR_ORIGIN), {
    headers: { host: "monitor.localhost:3000" },
  });
}

function apexReq(path: string, search = ""): NextRequest {
  return new NextRequest(new URL(path + search, APEX_ORIGIN), {
    headers: { host: "localhost:3000" },
  });
}

/** Asserts the request passed on unchanged (no rewrite, no redirect). */
function expectPassedAsIs(response: Response): void {
  expect(response.status).toBe(200);
  expect(response.headers.get("x-middleware-rewrite")).toBeNull();
  expect(response.headers.get("x-middleware-next")).toBe("1");
}

beforeEach(() => {
  vi.clearAllMocks();
  cookieMethods.setAll = undefined;
  mockGetClaims.mockResolvedValue({ data: { claims: null }, error: null });
});

// ── SHIP-AC1a..SHIP-AC1b: Monitor host rewrites paths into /monitor ───────────

describe("middleware: SHIP-AC1a/AC1b Monitor host rewrites paths into /monitor", () => {
  it("SHIP-AC1a-int1: / without a session → 200 rewritten to /monitor (public landing)", async () => {
    // /monitor is a public path (MONITOR_PUBLIC_PATHS); updateSession passes through without 307.
    const response = await middleware(monitorReq("/"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-rewrite")).toBe(`${MONITOR_ORIGIN}/monitor`);
  });

  it("SHIP-AC1c-int1: /dashboard without a session → 307 to /monitor/login?next=... (exact)", async () => {
    // /dashboard is a protected path; rewritten to /monitor/dashboard then auth-guarded.
    const response = await middleware(monitorReq("/dashboard"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      `${MONITOR_ORIGIN}/monitor/login?next=%2Fmonitor%2Fdashboard`,
    );
  });

  it("SHIP-AC1a-int2: / with a session → 200 rewritten to /monitor", async () => {
    mockGetClaims.mockResolvedValue({ data: { claims: CLAIMS }, error: null });
    const response = await middleware(monitorReq("/"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-rewrite")).toBe(`${MONITOR_ORIGIN}/monitor`);
  });

  it("SHIP-AC1b-int1: /login → 200 rewritten to /monitor/login", async () => {
    const response = await middleware(monitorReq("/login"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-rewrite")).toBe(`${MONITOR_ORIGIN}/monitor/login`);
  });

  it("SHIP-AC1b-int2: /signup → 200 rewritten to /monitor/signup", async () => {
    const response = await middleware(monitorReq("/signup"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-rewrite")).toBe(`${MONITOR_ORIGIN}/monitor/signup`);
  });

  it("SHIP-AC1d-int1: /monitor/settings served as-is (no double prefix) → 307 to login", async () => {
    const response = await middleware(monitorReq("/monitor/settings"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      `${MONITOR_ORIGIN}/monitor/login?next=%2Fmonitor%2Fsettings`,
    );
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
  });
});

// ── SHIP-AC1f/AC1g: /admin and /mylife on Monitor host become /monitor/admin ──

describe("middleware: SHIP-AC1f/AC1g /admin and /mylife are not served on Monitor host", () => {
  it("SHIP-AC1f-int1: /admin/login without a session → 307 to /monitor/login (not /admin/login)", async () => {
    const response = await middleware(monitorReq("/admin"));
    expect(response.status).toBe(307);
    // Must redirect to /monitor/login, not /admin/login
    expect(response.headers.get("location")).toContain("/monitor/login");
    expect(response.headers.get("location")).not.toContain("/admin/login");
  });

  it("SHIP-AC1f-int2: /admin with session → rewritten to /monitor/admin (a 404, not the admin panel)", async () => {
    mockGetClaims.mockResolvedValue({ data: { claims: CLAIMS }, error: null });
    const response = await middleware(monitorReq("/admin"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-rewrite")).toBe(`${MONITOR_ORIGIN}/monitor/admin`);
  });

  it("SHIP-AC1g-int1: /mylife with session → rewritten to /monitor/mylife (a 404)", async () => {
    mockGetClaims.mockResolvedValue({ data: { claims: CLAIMS }, error: null });
    const response = await middleware(monitorReq("/mylife"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-rewrite")).toBe(`${MONITOR_ORIGIN}/monitor/mylife`);
  });
});

// ── SHIP-AC1e: /auth/* on Monitor host passes through ────────────────────────

describe("middleware: SHIP-AC1e /auth/confirm passes through on Monitor host", () => {
  it("SHIP-AC1e-int1: /auth/confirm → 200, served as-is (auth route passthrough)", async () => {
    const response = await middleware(monitorReq("/auth/confirm"));
    expectPassedAsIs(response);
  });
});

// ── SHIP-AC1h: Monitor host never reaches next-intl ──────────────────────────

describe("middleware: SHIP-AC1h Monitor host never reaches next-intl", () => {
  it("SHIP-AC1h-int1: neither /login nor / on Monitor host reaches next-intl", async () => {
    await middleware(monitorReq("/login"));
    await middleware(monitorReq("/"));
    expect(mockHandleI18n).not.toHaveBeenCalled();
  });
});

// ── SHIP-AC2a: main host /monitor → 308 to Monitor subdomain ─────────────────

describe("middleware: SHIP-AC2a main host /monitor → 308 to Monitor subdomain", () => {
  it("SHIP-AC2a-int1: /monitor → 308 to http://monitor.localhost:3000/", async () => {
    const response = await middleware(apexReq("/monitor"));
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(`${MONITOR_ORIGIN}/`);
  });

  it("SHIP-AC2a-int2: /monitor/login → 308 to http://monitor.localhost:3000/monitor/login", async () => {
    const response = await middleware(apexReq("/monitor/login"));
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(`${MONITOR_ORIGIN}/monitor/login`);
  });
});

// ── SHIP-AC2b: 308 preserves query string ────────────────────────────────────

describe("middleware: SHIP-AC2b 308 preserves query string", () => {
  it("SHIP-AC2b-int1: /monitor/login?next=%2Fmonitor%2Fdashboard → 308 exact Location", async () => {
    const response = await middleware(apexReq("/monitor/login", "?next=%2Fmonitor%2Fdashboard"));
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(
      `${MONITOR_ORIGIN}/monitor/login?next=%2Fmonitor%2Fdashboard`,
    );
  });
});
// ── SHIP-AC2c: 308 Cache-Control ─────────────────────────────────────────────

describe("middleware: SHIP-AC2c 308 Cache-Control is public, max-age=86400", () => {
  it("SHIP-AC2c-int1: Cache-Control on 308 redirect", async () => {
    const response = await middleware(apexReq("/monitor"));
    expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
  });
});

// ── SHIP-AC2f: MyLife host paths not affected by Monitor changes ──────────────

describe("middleware: SHIP-AC2f MyLife host follows its own branch", () => {
  function mylifeReq(path: string): NextRequest {
    return new NextRequest(new URL(path, "http://mylife.localhost:3000"), {
      headers: { host: "mylife.localhost:3000" },
    });
  }

  it("SHIP-AC2f-int1: MyLife host /login → rewritten to /mylife/login (not monitor)", async () => {
    const response = await middleware(mylifeReq("/login"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-rewrite")).toContain("/mylife/login");
    expect(response.headers.get("x-middleware-rewrite")).not.toContain("/monitor");
  });

  it("SHIP-AC2f-int2: MyLife host paths → not 308", async () => {
    const response = await middleware(mylifeReq("/login"));
    expect(response.status).not.toBe(308);
  });
});
