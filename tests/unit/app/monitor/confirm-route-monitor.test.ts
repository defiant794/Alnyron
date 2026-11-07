/**
 * Unit tests: /auth/confirm route — type=signup branch for monitor area.
 * Journey: monitor-web-area  MON-AC11, MON-AC12, MON-AC13, MON-AC62, MON-AC63
 *
 * Verifies:
 *   MON-AC11: type=signup + valid token + next=/monitor/dashboard
 *             → session created → 307 /monitor/dashboard
 *   MON-AC12: type=signup + invalid/expired token
 *             → 307 /monitor/login?error=link_invalid
 *   MON-AC13: type=signup + cross-area next=/admin/set-password (monitor_user)
 *             → stays in Monitor: 307 /monitor/dashboard (never /admin/set-password)
 *   MON-AC62: CONFIRM_TYPES includes "signup"
 *   MON-AC63: type=signup without usable next → the fixed Monitor landing
 *             /monitor/dashboard (role-independent: no profile lookup)
 *
 * Mirrors tests/integration/mylife-auth/confirm-role-aware.test.ts.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockVerifyOtp, mockGetClaims, mockProfilesSelect } = vi.hoisted(() => ({
  mockVerifyOtp: vi.fn(),
  mockGetClaims: vi.fn(),
  mockProfilesSelect: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: vi.fn(() => ({
    auth: { verifyOtp: mockVerifyOtp, getClaims: mockGetClaims },
    from: vi.fn(() => ({
      select: vi.fn(() => ({ eq: vi.fn(() => ({ single: mockProfilesSelect })) })),
    })),
  })),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

import { GET } from "@/app/auth/confirm/route";
// A route.ts may export only route handlers and segment options (Next's
// generated route type check rejects anything else), so the confirm types
// live beside it.
import { CONFIRM_TYPES } from "@/app/auth/confirm/confirm-types";

const SIGNUP_TOKEN = { token_hash: "abc123", type: "signup" };
const TEST_USER_ID = "00000000-0000-0000-0000-000000000099";

function confirmReq(params: Record<string, string>, host = "localhost:3000"): NextRequest {
  const url = new URL("/auth/confirm", `http://${host}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url, { headers: { host } });
}

function expectRedirect(response: Response, location: string) {
  expect(response.status).toBe(307);
  expect(response.headers.get("location")).toBe(location);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyOtp.mockResolvedValue({
    data: { session: { user: { id: TEST_USER_ID } } },
    error: null,
  });
  mockGetClaims.mockResolvedValue({
    data: { claims: { sub: TEST_USER_ID, role: "authenticated", email: "mon@test.local" } },
    error: null,
  });
  mockProfilesSelect.mockResolvedValue({ data: { role: "monitor_user" }, error: null });
});

// ── MON-AC62: CONFIRM_TYPES includes "signup" ─────────────────────────────────

describe("CONFIRM_TYPES — MON-AC62: 'signup' is an accepted confirm type", () => {
  it("MON-AC62a: CONFIRM_TYPES Set includes 'signup'", () => {
    expect(CONFIRM_TYPES.has("signup")).toBe(true);
  });
});

// ── MON-AC11: valid signup token → redirect to next ──────────────────────────

describe("/auth/confirm: MON-AC11 valid signup token lands on /monitor/dashboard", () => {
  it("MON-AC11b: type=signup + next=/monitor/dashboard → 307 /monitor/dashboard", async () => {
    const response = await GET(
      confirmReq({ ...SIGNUP_TOKEN, next: "/monitor/dashboard" }),
    );
    expectRedirect(response, "/monitor/dashboard");
  });

  it("MON-AC11c: type=signup + next=/monitor/monitors/new → 307 /monitor/monitors/new", async () => {
    const response = await GET(
      confirmReq({ ...SIGNUP_TOKEN, next: "/monitor/monitors/new" }),
    );
    expectRedirect(response, "/monitor/monitors/new");
  });
});

// ── MON-AC63: type=signup without usable next → fixed Monitor landing ────────

describe("/auth/confirm: MON-AC63 no usable next → the Monitor landing, whatever the role", () => {
  it("MON-AC63a: type=signup, no next, monitor_user → /monitor/dashboard", async () => {
    const response = await GET(confirmReq(SIGNUP_TOKEN));
    expectRedirect(response, "/monitor/dashboard");
  });

  it("MON-AC63b: type=signup, no next, owner → /monitor/dashboard without a role lookup", async () => {
    // A signup link is pinned to Monitor: its landing (AREA_CONFIG.monitor.landing)
    // does not depend on the role, so the profile is never read; the dashboard's
    // own gate answers a role Monitor does not admit.
    mockProfilesSelect.mockResolvedValue({ data: { role: "owner" }, error: null });
    const response = await GET(confirmReq(SIGNUP_TOKEN));
    expectRedirect(response, "/monitor/dashboard");
    expect(mockProfilesSelect).not.toHaveBeenCalled();
  });
});

// ── MON-AC13: cross-area next is redirected to the Monitor landing for type=signup ─
// type=signup is a Monitor public-signup confirmation. A cross-area next (e.g.
// /admin/set-password) is blocked and the user lands on the Monitor landing
// (/monitor/dashboard), NOT /monitor/reset: the account chose its password at
// signup. (/monitor/reset is where recovery links land.)

describe("/auth/confirm: MON-AC13 cross-area next → /monitor/dashboard for type=signup", () => {
  it("MON-AC13e: monitor_user + type=signup + next=/admin/set-password → /monitor/dashboard", async () => {
    const response = await GET(
      confirmReq({ ...SIGNUP_TOKEN, next: "/admin/set-password" }),
    );
    expectRedirect(response, "/monitor/dashboard");
  });

  it("MON-AC13f: monitor_user + type=signup + next=/mylife/set-password → /monitor/dashboard", async () => {
    const response = await GET(
      confirmReq({ ...SIGNUP_TOKEN, next: "/mylife/set-password" }),
    );
    expectRedirect(response, "/monitor/dashboard");
  });

  it("MON-AC13g: mockVerifyOtp was called with token_hash and type=signup", async () => {
    await GET(confirmReq({ ...SIGNUP_TOKEN, next: "/monitor/dashboard" }));
    expect(mockVerifyOtp).toHaveBeenCalledWith(
      expect.objectContaining({ token_hash: SIGNUP_TOKEN.token_hash, type: "signup" }),
    );
  });
});

// ── MON-AC12: invalid/expired token → /monitor/login?error=link_invalid ──────

describe("/auth/confirm: MON-AC12 failed OTP → /monitor/login?error=link_invalid", () => {
  beforeEach(() => {
    mockVerifyOtp.mockResolvedValue({ data: null, error: { message: "Token expired" } });
  });

  it("MON-AC12b: type=signup + next=/monitor/dashboard + bad token → /monitor/login?error=link_invalid", async () => {
    const response = await GET(
      confirmReq({ ...SIGNUP_TOKEN, next: "/monitor/dashboard" }),
    );
    expectRedirect(response, "/monitor/login?error=link_invalid");
  });

  it("MON-AC12c: type=signup + no next + bad token → /monitor/login?error=link_invalid", async () => {
    const response = await GET(confirmReq(SIGNUP_TOKEN));
    expectRedirect(response, "/monitor/login?error=link_invalid");
  });
});
