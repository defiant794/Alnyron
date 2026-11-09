/**
 * Unit tests: /auth/confirm route — Monitor-host forwarding from main host.
 * Journey: monitor-ship-routing  SHIP-AC4a..SHIP-AC4g
 *
 * Verifies:
 *   SHIP-AC4a: main host + type=signup → 307 no-store to monitor host BEFORE verifyOtp
 *              (type=signup alone forwards: without a next, and with a non-Monitor next)
 *   SHIP-AC4b: when NEXT_PUBLIC_SITE_URL=https://alnyron.dk → Location=https://monitor.alnyron.dk/...
 *   SHIP-AC4c: forwarding 307 has Cache-Control: private, no-store
 *   SHIP-AC4d: main host + type=recovery + next=/monitor/reset → forwarded
 *   SHIP-AC4e: main host + type=invite + next=/admin/set-password → NOT forwarded
 *   SHIP-AC4f: Monitor host + type=signup → NOT forwarded (already on monitor host)
 *   SHIP-AC4g: MyLife host + type=signup → pinnedArea=mylife (unaffected)
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

vi.mock("@/config/env", () => ({
  parseSiteEnv: vi.fn(() => ({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" })),
}));

import { GET } from "@/app/auth/confirm/route";
import { parseSiteEnv } from "@/config/env";

const TEST_TOKEN = { token_hash: "tok123", type: "signup" };
const TEST_USER_ID = "00000000-0000-0000-0000-000000000099";
const MONITOR_CONFIRM = "http://monitor.localhost:3000/auth/confirm";

function confirmReq(
  params: Record<string, string>,
  host = "localhost:3000",
): NextRequest {
  const url = new URL("/auth/confirm", `http://${host}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url, { headers: { host } });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(parseSiteEnv).mockReturnValue({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" });
  mockVerifyOtp.mockResolvedValue({
    data: { session: { user: { id: TEST_USER_ID } } },
    error: null,
  });
  mockGetClaims.mockResolvedValue({
    data: { claims: { sub: TEST_USER_ID, role: "authenticated" } },
    error: null,
  });
  mockProfilesSelect.mockResolvedValue({ data: { role: "monitor_user" }, error: null });
});

// ── SHIP-AC4a: main host + type=signup → forward BEFORE verifyOtp ────────────

describe("/auth/confirm: SHIP-AC4a main host type=signup → forward to monitor host", () => {
  it("SHIP-AC4a-1: 307 no-store to exactly the Monitor host's /auth/confirm with the whole query", async () => {
    const response = await GET(
      confirmReq({ ...TEST_TOKEN, next: "/monitor/dashboard" }),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      `${MONITOR_CONFIRM}?token_hash=tok123&type=signup&next=%2Fmonitor%2Fdashboard`,
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("SHIP-AC4a-2: type=signup without a next is forwarded (the type alone pins it to Monitor)", async () => {
    const response = await GET(confirmReq(TEST_TOKEN));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${MONITOR_CONFIRM}?token_hash=tok123&type=signup`);
    expect(mockVerifyOtp).not.toHaveBeenCalled();
  });

  it("SHIP-AC4a-3: Location preserves the full original query string", async () => {
    const response = await GET(
      confirmReq({ ...TEST_TOKEN, next: "/monitor/dashboard" }),
    );
    const location = response.headers.get("location") ?? "";
    const forwarded = new URL(location);
    expect(forwarded.searchParams.get("token_hash")).toBe(TEST_TOKEN.token_hash);
    expect(forwarded.searchParams.get("type")).toBe("signup");
    expect(forwarded.searchParams.get("next")).toBe("/monitor/dashboard");
  });

  it("SHIP-AC4a-4: verifyOtp is NOT called (token forwarded, not consumed)", async () => {
    await GET(confirmReq({ ...TEST_TOKEN, next: "/monitor/dashboard" }));
    expect(mockVerifyOtp).not.toHaveBeenCalled();
  });

  it("SHIP-AC4a-5: type=signup with a non-Monitor next (/admin/x) is still forwarded, query unchanged", async () => {
    const response = await GET(confirmReq({ ...TEST_TOKEN, next: "/admin/x" }));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${MONITOR_CONFIRM}?token_hash=tok123&type=signup&next=%2Fadmin%2Fx`);
    expect(mockVerifyOtp).not.toHaveBeenCalled();
  });
});

// ── SHIP-AC4b: prod site URL → https://monitor.alnyron.dk ────────────────────

describe("/auth/confirm: SHIP-AC4b prod NEXT_PUBLIC_SITE_URL → https://monitor.alnyron.dk", () => {
  beforeEach(() => {
    vi.mocked(parseSiteEnv).mockReturnValue({ NEXT_PUBLIC_SITE_URL: "https://alnyron.dk" });
  });

  it("SHIP-AC4b-1: Location is exactly 'https://monitor.alnyron.dk/auth/confirm' with the query", async () => {
    const response = await GET(
      confirmReq({ ...TEST_TOKEN, next: "/monitor/dashboard" }),
    );
    expect(response.headers.get("location")).toBe(
      "https://monitor.alnyron.dk/auth/confirm?token_hash=tok123&type=signup&next=%2Fmonitor%2Fdashboard",
    );
  });

  it("SHIP-AC4b-2: verifyOtp NOT called in prod forward", async () => {
    await GET(confirmReq({ ...TEST_TOKEN, next: "/monitor/dashboard" }));
    expect(mockVerifyOtp).not.toHaveBeenCalled();
  });
});

// ── SHIP-AC4c: forwarding response is no-store ────────────────────────────────

describe("/auth/confirm: SHIP-AC4c forwarding 307 has Cache-Control: private, no-store", () => {
  it("SHIP-AC4c-1: Cache-Control is 'private, no-store'", async () => {
    const response = await GET(
      confirmReq({ ...TEST_TOKEN, next: "/monitor/dashboard" }),
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});

// ── SHIP-AC4d: main host + type=recovery + next=/monitor/reset → forwarded ───

describe("/auth/confirm: SHIP-AC4d main host type=recovery next=/monitor/reset → forward", () => {
  it("SHIP-AC4d-1: type=recovery + next=/monitor/reset → 307 to exactly the Monitor host's /auth/confirm", async () => {
    const response = await GET(
      confirmReq({
        token_hash: "tok456",
        type: "recovery",
        next: "/monitor/reset",
      }),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      `${MONITOR_CONFIRM}?token_hash=tok456&type=recovery&next=%2Fmonitor%2Freset`,
    );
  });

  it("SHIP-AC4d-2: verifyOtp NOT called for /monitor/reset forward", async () => {
    await GET(
      confirmReq({ token_hash: "tok456", type: "recovery", next: "/monitor/reset" }),
    );
    expect(mockVerifyOtp).not.toHaveBeenCalled();
  });
});

// ── SHIP-AC4e: main host + type=invite + next=/admin/* → NOT forwarded ────────

describe("/auth/confirm: SHIP-AC4e admin links not forwarded to monitor host", () => {
  it("SHIP-AC4e-1: type=invite + next=/admin/set-password → verified on the main host (not forwarded)", async () => {
    mockProfilesSelect.mockResolvedValue({ data: { role: "admin" }, error: null });
    const response = await GET(
      confirmReq({
        token_hash: "tok789",
        type: "invite",
        next: "/admin/set-password",
      }),
    );
    expect(mockVerifyOtp).toHaveBeenCalledWith({ type: "invite", token_hash: "tok789" });
    expect(response.headers.get("location")).toBe("/admin/set-password");
  });

  it("SHIP-AC4e-2: type=recovery + next=/mylife/set-password → verified on the main host (not forwarded)", async () => {
    mockProfilesSelect.mockResolvedValue({ data: { role: "mylife_user" }, error: null });
    const response = await GET(
      confirmReq({
        token_hash: "tokabc",
        type: "recovery",
        next: "/mylife/set-password",
      }),
    );
    expect(mockVerifyOtp).toHaveBeenCalledWith({ type: "recovery", token_hash: "tokabc" });
    expect(response.headers.get("location")).toBe("/mylife/set-password");
  });

  it("SHIP-AC4e-3: a monitor_user's main-host reset (next=/admin/set-password) is verified there and lands on /monitor/reset by role (known limitation: that session stays on the main host)", async () => {
    const response = await GET(
      confirmReq({ token_hash: "tokdef", type: "recovery", next: "/admin/set-password" }),
    );
    expect(mockVerifyOtp).toHaveBeenCalledWith({ type: "recovery", token_hash: "tokdef" });
    expect(response.headers.get("location")).toBe("/monitor/reset");
  });
});

// ── SHIP-AC4f: Monitor host pins to Monitor regardless of next value ──────────

describe("/auth/confirm: SHIP-AC4f Monitor host — links stay in Monitor", () => {
  it("SHIP-AC4f-1: monitor host type=signup + valid token → 307 to /monitor/dashboard", async () => {
    const response = await GET(
      confirmReq({ ...TEST_TOKEN, next: "/monitor/dashboard" }, "monitor.localhost:3000"),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/monitor/dashboard");
    expect(mockVerifyOtp).toHaveBeenCalled();
  });

  it("SHIP-AC4f-3: monitor host type=recovery + next=/monitor/reset → 307 to /monitor/reset", async () => {
    const response = await GET(
      confirmReq(
        { token_hash: "tok-mon-rec", type: "recovery", next: "/monitor/reset" },
        "monitor.localhost:3000",
      ),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/monitor/reset");
    expect(mockVerifyOtp).toHaveBeenCalled();
  });

  it("SHIP-AC4f-4: monitor host type=recovery + next=/admin/set-password → exactly /monitor/reset", async () => {
    const response = await GET(
      confirmReq(
        { token_hash: "tok-mon-cross", type: "recovery", next: "/admin/set-password" },
        "monitor.localhost:3000",
      ),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/monitor/reset");
    expect(mockVerifyOtp).toHaveBeenCalledWith({ type: "recovery", token_hash: "tok-mon-cross" });
  });

  it("SHIP-AC4f-5: monitor host failed OTP → exactly /monitor/login?error=link_invalid", async () => {
    mockVerifyOtp.mockResolvedValue({ data: null, error: { message: "expired" } });
    const response = await GET(
      confirmReq(
        { token_hash: "tok-mon-bad", type: "recovery", next: "/monitor/reset" },
        "monitor.localhost:3000",
      ),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/monitor/login?error=link_invalid");
  });
});

// ── SHIP-AC4g: MyLife host + type=signup → pinnedArea=mylife ─────────────────

describe("/auth/confirm: SHIP-AC4g MyLife host type=signup → pinnedArea=mylife, not forwarded", () => {
  it("SHIP-AC4g-1: mylife host + type=signup + next=/mylife/set-password → verified there, lands on /mylife/set-password", async () => {
    const response = await GET(
      confirmReq({ ...TEST_TOKEN, next: "/mylife/set-password" }, "mylife.localhost:3000"),
    );
    expect(mockVerifyOtp).toHaveBeenCalledWith({ type: "signup", token_hash: "tok123" });
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/mylife/set-password");
  });

  it("SHIP-AC4g-2: mylife host + type=signup without a usable next → /mylife/set-password (not the Monitor dashboard)", async () => {
    const response = await GET(
      confirmReq({ ...TEST_TOKEN, next: "/monitor/dashboard" }, "mylife.localhost:3000"),
    );
    expect(mockVerifyOtp).toHaveBeenCalledWith({ type: "signup", token_hash: "tok123" });
    expect(response.headers.get("location")).toBe("/mylife/set-password");
  });
});
