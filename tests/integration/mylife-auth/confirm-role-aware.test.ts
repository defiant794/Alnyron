/**
 * Integration tests: /auth/confirm role-aware landing after OTP verification.
 * Journey: mylife-login  ML-AC11, ML-AC13, ML-AC14, ML-AC15
 *
 * On the main host, after verifyOtp succeeds the route reads the user's role
 * and corrects a `next` in an area the role may not enter:
 *   ML-AC14: mylife_user + next=/admin/set-password → /mylife/set-password
 *   ML-AC15: admin       + next=/mylife/set-password → /admin/set-password
 *   ML-AC11: mylife_user + next=/mylife/set-password → as given
 *   owner, or a profile outage → `next` as given
 * On the MyLife host (ML-AC11) only MyLife paths are served and no role is read.
 * A failed OTP lands on the login page of the link's area with
 * error=link_invalid (ML-AC13).
 *
 * Every Location is a path (the browser stays on the host it asked, whose
 * host-only session cookies were just set) and every redirect is
 * Cache-Control: private, no-store.
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

vi.mock("react", async () => {
  const actual = await vi.importActual("react");
  return {
    ...(actual as Record<string, unknown>),
    cache: (fn: (...args: unknown[]) => unknown) => fn,
  };
});

import { GET } from "@/app/auth/confirm/route";

const VALID_TOKEN = { token_hash: "abc123", type: "invite" };
const TEST_USER_ID = "00000000-0000-0000-0000-000000000099";
const MYLIFE_HOST = "mylife.localhost:3000";

function confirmReq(params: Record<string, string>, host = "localhost:3000"): NextRequest {
  const url = new URL("/auth/confirm", `http://${host}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url, { headers: { host } });
}

function claimsFor(email: string) {
  return {
    data: { claims: { sub: TEST_USER_ID, role: "authenticated", email } },
    error: null,
  };
}

/** Asserts a 307 to exactly `location` that no cache may keep. */
function expectRedirect(response: Response, location: string) {
  expect(response.status).toBe(307);
  expect(response.headers.get("location")).toBe(location);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyOtp.mockResolvedValue({ data: { session: { user: { id: TEST_USER_ID } } }, error: null });
  mockGetClaims.mockResolvedValue(claimsFor("ml@alnyron.dk"));
  mockProfilesSelect.mockResolvedValue({ data: { role: "mylife_user" }, error: null });
});

// ── Main host: role-aware landing ────────────────────────────────────────────

describe("/auth/confirm (main host): ML-AC14/ML-AC15 a cross-area next is corrected by role", () => {
  it("ML-AC14: mylife_user + next=/admin/set-password lands on /mylife/set-password", async () => {
    const response = await GET(confirmReq({ ...VALID_TOKEN, next: "/admin/set-password" }));
    expectRedirect(response, "/mylife/set-password");
  });

  it("ML-AC15: admin + next=/mylife/set-password lands on /admin/set-password", async () => {
    mockProfilesSelect.mockResolvedValue({ data: { role: "admin" }, error: null });
    const response = await GET(confirmReq({ ...VALID_TOKEN, next: "/mylife/set-password" }));
    expectRedirect(response, "/admin/set-password");
  });

  it("ML-AC11: mylife_user + next=/mylife/set-password lands there", async () => {
    const response = await GET(confirmReq({ ...VALID_TOKEN, next: "/mylife/set-password" }));
    expectRedirect(response, "/mylife/set-password");
  });

  it.each(["/admin/set-password", "/mylife/set-password"])(
    "the owner keeps next=%s (both areas admit the owner)",
    async (next) => {
      mockProfilesSelect.mockResolvedValue({ data: { role: "owner" }, error: null });
      const response = await GET(confirmReq({ ...VALID_TOKEN, next }));
      expectRedirect(response, next);
    },
  );

  it("a profile outage keeps next as given (that page's gate reports it) and is logged", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mockProfilesSelect.mockResolvedValue({
      data: null,
      error: { code: "PGRST301", message: "connection refused" },
    });

    const response = await GET(confirmReq({ ...VALID_TOKEN, next: "/admin/set-password" }));

    expectRedirect(response, "/admin/set-password");
    expect(log).toHaveBeenCalledWith("/auth/confirm role lookup failed", expect.any(Error));
  });
});

// ── MyLife host: only MyLife paths, no role lookup ───────────────────────────

describe("/auth/confirm (MyLife host): ML-AC11 MyLife links land on MyLife pages only", () => {
  it("ML-AC11a: a non-MyLife next lands on /mylife/set-password without reading the role", async () => {
    const response = await GET(confirmReq({ ...VALID_TOKEN, next: "/admin/set-password" }, MYLIFE_HOST));
    expectRedirect(response, "/mylife/set-password");
    expect(mockGetClaims).not.toHaveBeenCalled();
  });

  it("ML-AC11b: an admin following a MyLife link there lands on /mylife/set-password (its gate answers)", async () => {
    mockProfilesSelect.mockResolvedValue({ data: { role: "admin" }, error: null });
    const response = await GET(confirmReq({ ...VALID_TOKEN, next: "/mylife/set-password" }, MYLIFE_HOST));
    expectRedirect(response, "/mylife/set-password");
    expect(mockGetClaims).not.toHaveBeenCalled();
  });

  it("ML-AC11c: no next lands on /mylife/set-password", async () => {
    const response = await GET(confirmReq(VALID_TOKEN, MYLIFE_HOST));
    expectRedirect(response, "/mylife/set-password");
  });
});

// ── ML-AC13: a failed OTP lands on the area's login page ─────────────────────

describe("/auth/confirm: ML-AC13 a failed OTP goes to the login page of the link's area", () => {
  beforeEach(() => {
    mockVerifyOtp.mockResolvedValue({ data: null, error: { message: "Token expired" } });
  });

  it("ML-AC13a: next under /mylife/ → /mylife/login?error=link_invalid", async () => {
    const response = await GET(confirmReq({ ...VALID_TOKEN, next: "/mylife/set-password" }));
    expectRedirect(response, "/mylife/login?error=link_invalid");
  });

  it("ML-AC13b: next under /admin/ → /admin/login?error=link_invalid", async () => {
    const response = await GET(confirmReq({ ...VALID_TOKEN, next: "/admin/set-password" }));
    expectRedirect(response, "/admin/login?error=link_invalid");
  });

  it("ML-AC13c: the MyLife host without next → /mylife/login?error=link_invalid", async () => {
    const response = await GET(confirmReq(VALID_TOKEN, MYLIFE_HOST));
    expectRedirect(response, "/mylife/login?error=link_invalid");
  });

  it("ML-AC13d: the MyLife host with an /admin/ next still → /mylife/login?error=link_invalid", async () => {
    const response = await GET(confirmReq({ ...VALID_TOKEN, next: "/admin/set-password" }, MYLIFE_HOST));
    expectRedirect(response, "/mylife/login?error=link_invalid");
  });
});
