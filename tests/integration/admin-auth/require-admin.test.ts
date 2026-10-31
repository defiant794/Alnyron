/**
 * Integration tests — requireAdmin() / getAdminAccess() DAL
 * Journey: admin-auth  AC-ADMINAUTH-05 / AC-ADMINAUTH-06
 *
 * requireAdmin() is the second protection layer called at the top of every
 * admin page and Server Action.  Tests use mocked Supabase client (no DB
 * connection needed) and mocked next/navigation redirect.
 *
 * Supabase client chain:
 *   createServerClient()  →  auth.getClaims()  →  from("profiles").select("role").eq(...).single()
 *
 * A non-PGRST116 profile error THROWS (AC-ADMINAUTH-05g); only the
 * "no row" code (PGRST116) is treated as "no access".
 *
 * React `cache` is mocked as identity so requireAdmin() runs fresh on each call.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// ── vi.hoisted ────────────────────────────────────────────────────────────────

const { mockGetClaims, mockProfilesSelect, mockRedirect } = vi.hoisted(() => ({
  mockGetClaims: vi.fn(),
  mockProfilesSelect: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: vi.fn(() => ({
    auth: { getClaims: mockGetClaims },
    from: vi.fn(() => ({
      select: vi.fn(() => ({ eq: vi.fn(() => ({ single: mockProfilesSelect })) })),
    })),
  })),
}));

vi.mock("next/navigation", () => ({ redirect: mockRedirect }));

// React cache: identity in tests (no render context; avoids cross-test memoisation).
vi.mock("react", async () => {
  const actual = await vi.importActual("react");
  return {
    ...(actual as Record<string, unknown>),
    cache: (fn: (...args: unknown[]) => unknown) => fn,
  };
});

// ── Module under test ────────────────────────────────────────────────────────

import { requireAdmin } from "@/services/auth/require-admin";

// ── Helpers ───────────────────────────────────────────────────────────────────

const TEST_USER_ID = "00000000-0000-0000-0000-000000000099";

function validClaims() {
  return {
    data: { claims: { sub: TEST_USER_ID, role: "authenticated", email: "admin@alnyron.dk" } },
    error: null,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("requireAdmin — AC-ADMINAUTH-05/06: DAL access control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── AC-ADMINAUTH-05: non-admin callers are blocked ──────────────────────────

  it("AC-ADMINAUTH-05a: no session (claims null) → redirect to /admin/login", async () => {
    mockGetClaims.mockResolvedValue({ data: { claims: null }, error: null });

    await expect(requireAdmin()).rejects.toThrow("NEXT_REDIRECT:/admin/login");
    expect(mockRedirect).toHaveBeenCalledWith("/admin/login");
  });

  it("AC-ADMINAUTH-05b: getClaims error → redirect to /admin/login", async () => {
    mockGetClaims.mockResolvedValue({ data: null, error: { message: "JWT expired" } });

    await expect(requireAdmin()).rejects.toThrow("NEXT_REDIRECT:/admin/login");
    expect(mockRedirect).toHaveBeenCalledWith("/admin/login");
  });

  it("AC-ADMINAUTH-05c: profile role = null → redirect to /admin/no-access", async () => {
    mockGetClaims.mockResolvedValue(validClaims());
    mockProfilesSelect.mockResolvedValue({ data: { role: null }, error: null });

    await expect(requireAdmin()).rejects.toThrow("NEXT_REDIRECT:/admin/no-access");
    expect(mockRedirect).toHaveBeenCalledWith("/admin/no-access");
  });

  it("AC-ADMINAUTH-05d: profile role = mylife_user → redirect to /admin/no-access", async () => {
    mockGetClaims.mockResolvedValue(validClaims());
    mockProfilesSelect.mockResolvedValue({ data: { role: "mylife_user" }, error: null });

    await expect(requireAdmin()).rejects.toThrow("NEXT_REDIRECT:/admin/no-access");
    expect(mockRedirect).toHaveBeenCalledWith("/admin/no-access");
  });

  it("AC-ADMINAUTH-05e: no profile row (PGRST116) → redirect to /admin/no-access", async () => {
    // Catches callers whose JWT is valid but whose profiles row was deleted or
    // never created.  single() returns PGRST116 when 0 rows match the query.
    mockGetClaims.mockResolvedValue(validClaims());
    mockProfilesSelect.mockResolvedValue({
      data: null,
      error: { code: "PGRST116", message: "The result contains 0 rows" },
    });

    await expect(requireAdmin()).rejects.toThrow("NEXT_REDIRECT:/admin/no-access");
    expect(mockRedirect).toHaveBeenCalledWith("/admin/no-access");
  });

  it("AC-ADMINAUTH-05g: non-PGRST116 profile error THROWS (not redirect)", async () => {
    // A DB outage or permission error must not silently downgrade to "no access".
    mockGetClaims.mockResolvedValue(validClaims());
    mockProfilesSelect.mockResolvedValue({
      data: null,
      error: { code: "PGRST301", message: "connection refused" },
    });

    // Must throw — not redirect to /admin/no-access.
    await expect(requireAdmin()).rejects.toThrow("Admin profile lookup failed");
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  // ── AC-ADMINAUTH-06: admin/owner callers pass through ───────────────────────

  it("AC-ADMINAUTH-06a: profile role = admin → resolves without redirecting", async () => {
    mockGetClaims.mockResolvedValue(validClaims());
    mockProfilesSelect.mockResolvedValue({ data: { role: "admin" }, error: null });

    await expect(requireAdmin()).resolves.toBeDefined();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("AC-ADMINAUTH-06b: profile role = owner → resolves without redirecting", async () => {
    mockGetClaims.mockResolvedValue(validClaims());
    mockProfilesSelect.mockResolvedValue({ data: { role: "owner" }, error: null });

    await expect(requireAdmin()).resolves.toBeDefined();
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});
