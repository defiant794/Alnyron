/**
 * Unit tests: generic role gate getAreaAccess / requireMyLife
 * (src/services/auth/require-role.ts).
 * Journey: mylife-login  ML-AC2 (mylife_user allowed), ML-AC5 (anonymous),
 * ML-AC6 (admin forbidden in MyLife), ML-AC7 (owner in both), ML-AC8 /
 * ML-AC28 (mylife_user forbidden in admin), ML-AC27 (admin unchanged).
 *
 * requireAdmin() keeps its own suite (tests/integration/admin-auth/require-admin.test.ts).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockGetClaims, mockProfilesSelect, mockRedirect } = vi.hoisted(() => ({
  mockGetClaims: vi.fn(),
  mockProfilesSelect: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: vi.fn(() => ({
    auth: { getClaims: mockGetClaims },
    from: vi.fn(() => ({
      select: vi.fn(() => ({ eq: vi.fn(() => ({ single: mockProfilesSelect })) })),
    })),
  })),
}));

vi.mock("next/navigation", () => ({ redirect: mockRedirect }));

vi.mock("react", async () => {
  const actual = await vi.importActual("react");
  return {
    ...(actual as Record<string, unknown>),
    cache: (fn: (...args: unknown[]) => unknown) => fn,
  };
});

import { getAreaAccess, requireMyLife } from "@/services/auth/require-role";

const TEST_USER_ID = "00000000-0000-0000-0000-000000000099";

function validClaims(email = "user@alnyron.dk") {
  return {
    data: { claims: { sub: TEST_USER_ID, role: "authenticated", email } },
    error: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── getAreaAccess("mylife") ───────────────────────────────────────────────────

describe('getAreaAccess("mylife"): ML-AC2/ML-AC5/ML-AC6/ML-AC7', () => {
  it("ML-AC5: null claims → status:anonymous", async () => {
    mockGetClaims.mockResolvedValue({ data: { claims: null }, error: null });
    const result = await getAreaAccess("mylife");
    expect(result.status).toBe("anonymous");
  });

  it("ML-AC5: getClaims error → status:anonymous", async () => {
    mockGetClaims.mockResolvedValue({ data: null, error: { message: "JWT expired" } });
    const result = await getAreaAccess("mylife");
    expect(result.status).toBe("anonymous");
  });

  it("ML-AC6: profile role=admin → status:forbidden (admin not allowed in mylife)", async () => {
    mockGetClaims.mockResolvedValue(validClaims());
    mockProfilesSelect.mockResolvedValue({ data: { role: "admin" }, error: null });
    const result = await getAreaAccess("mylife");
    expect(result.status).toBe("forbidden");
    if (result.status === "forbidden") expect(result.email).toBe("user@alnyron.dk");
  });

  it("ML-AC2: profile role=mylife_user → status:allowed", async () => {
    mockGetClaims.mockResolvedValue(validClaims("ml@alnyron.dk"));
    mockProfilesSelect.mockResolvedValue({ data: { role: "mylife_user" }, error: null });
    const result = await getAreaAccess("mylife");
    expect(result.status).toBe("allowed");
    if (result.status === "allowed") {
      expect(result.user.role).toBe("mylife_user");
      expect(result.user.email).toBe("ml@alnyron.dk");
      expect(result.user.userId).toBe(TEST_USER_ID);
    }
  });

  it("ML-AC7: profile role=owner → status:allowed (owner allowed in both areas)", async () => {
    mockGetClaims.mockResolvedValue(validClaims("owner@alnyron.dk"));
    mockProfilesSelect.mockResolvedValue({ data: { role: "owner" }, error: null });
    const result = await getAreaAccess("mylife");
    expect(result.status).toBe("allowed");
  });

  it("profile role=null → status:forbidden", async () => {
    mockGetClaims.mockResolvedValue(validClaims());
    mockProfilesSelect.mockResolvedValue({ data: { role: null }, error: null });
    const result = await getAreaAccess("mylife");
    expect(result.status).toBe("forbidden");
  });

  it("no profile row (PGRST116) → status:forbidden", async () => {
    mockGetClaims.mockResolvedValue(validClaims());
    mockProfilesSelect.mockResolvedValue({
      data: null,
      error: { code: "PGRST116", message: "The result contains 0 rows" },
    });
    const result = await getAreaAccess("mylife");
    expect(result.status).toBe("forbidden");
  });

  it("non-PGRST116 DB error THROWS, naming the area (an outage is not a no-access answer)", async () => {
    mockGetClaims.mockResolvedValue(validClaims());
    mockProfilesSelect.mockResolvedValue({
      data: null,
      error: { code: "PGRST301", message: "connection refused" },
    });
    await expect(getAreaAccess("mylife")).rejects.toThrow(
      "MyLife profile lookup failed: connection refused",
    );
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});

// ── getAreaAccess("admin") — privilege-bleed tests ───────────────────────────

describe('getAreaAccess("admin"): ML-AC8/ML-AC28 no privilege bleed, ML-AC27 admin unchanged', () => {
  it("ML-AC8: profile role=mylife_user → status:forbidden in admin area", async () => {
    mockGetClaims.mockResolvedValue(validClaims());
    mockProfilesSelect.mockResolvedValue({ data: { role: "mylife_user" }, error: null });
    const result = await getAreaAccess("admin");
    expect(result.status).toBe("forbidden");
  });

  it("ML-AC27: profile role=admin → status:allowed in admin area", async () => {
    mockGetClaims.mockResolvedValue(validClaims());
    mockProfilesSelect.mockResolvedValue({ data: { role: "admin" }, error: null });
    const result = await getAreaAccess("admin");
    expect(result.status).toBe("allowed");
  });

  it("ML-AC7: profile role=owner → status:allowed in admin area", async () => {
    mockGetClaims.mockResolvedValue(validClaims());
    mockProfilesSelect.mockResolvedValue({ data: { role: "owner" }, error: null });
    const result = await getAreaAccess("admin");
    expect(result.status).toBe("allowed");
  });
});

// ── requireMyLife() ───────────────────────────────────────────────────────────

describe("requireMyLife(): ML-AC2/ML-AC5/ML-AC6/ML-AC7", () => {
  it("ML-AC5: anonymous → redirect to /mylife/login", async () => {
    mockGetClaims.mockResolvedValue({ data: { claims: null }, error: null });
    await expect(requireMyLife()).rejects.toThrow("NEXT_REDIRECT:/mylife/login");
    expect(mockRedirect.mock.calls).toEqual([["/mylife/login"]]);
  });

  it("ML-AC5: getClaims error → redirect to /mylife/login", async () => {
    mockGetClaims.mockResolvedValue({ data: null, error: { message: "JWT expired" } });
    await expect(requireMyLife()).rejects.toThrow("NEXT_REDIRECT:/mylife/login");
  });

  it.each([
    { profileCase: "admin", profile: { data: { role: "admin" }, error: null } },
    { profileCase: "no role", profile: { data: { role: null }, error: null } },
    {
      profileCase: "no profile row",
      profile: { data: null, error: { code: "PGRST116", message: "The result contains 0 rows" } },
    },
  ])("ML-AC6: $profileCase → redirect to /mylife/no-access", async ({ profile }) => {
    mockGetClaims.mockResolvedValue(validClaims());
    mockProfilesSelect.mockResolvedValue(profile);
    await expect(requireMyLife()).rejects.toThrow("NEXT_REDIRECT:/mylife/no-access");
    expect(mockRedirect.mock.calls).toEqual([["/mylife/no-access"]]);
  });

  it("ML-AC2: mylife_user → resolves with the user, no redirect", async () => {
    mockGetClaims.mockResolvedValue(validClaims("ml@alnyron.dk"));
    mockProfilesSelect.mockResolvedValue({ data: { role: "mylife_user" }, error: null });
    await expect(requireMyLife()).resolves.toEqual({
      userId: TEST_USER_ID,
      email: "ml@alnyron.dk",
      role: "mylife_user",
    });
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("ML-AC7: owner → resolves with the user, no redirect", async () => {
    mockGetClaims.mockResolvedValue(validClaims("owner@alnyron.dk"));
    mockProfilesSelect.mockResolvedValue({ data: { role: "owner" }, error: null });
    await expect(requireMyLife()).resolves.toEqual({
      userId: TEST_USER_ID,
      email: "owner@alnyron.dk",
      role: "owner",
    });
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});
