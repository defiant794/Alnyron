/**
 * Unit tests — setPageNav server action (monitor-nav Slice B)
 * Journey: monitor-nav  AC-MONNAV-5
 *
 * Expected module: src/app/admin/(panel)/pages/actions.ts
 * Pattern mirrors admin-reorder-nav.test.ts and admin-set-page-status.test.ts.
 *
 * setPageNav(pageId: string, show: boolean):
 *   - Calls requireAdmin before the RPC
 *   - Unauthenticated caller → action throws without calling the RPC
 *   - Calls admin_set_page_nav({p_page_id, p_show})
 *   - Calls revalidatePublicContent() on success
 *   - Does NOT call revalidatePublicContent() when RPC returns an error
 *   - Non-UUID pageId → {ok: false, error: 'invalid'}, no RPC call
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── vi.hoisted ─────────────────────────────────────────────────────────────────

const { mockRequireAdmin, mockRpc, mockRevalidate } = vi.hoisted(() => ({
  mockRequireAdmin: vi.fn(),
  mockRpc: vi.fn(),
  mockRevalidate: vi.fn(),
}));

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock("@/services/auth/require-admin", () => ({
  requireAdmin: mockRequireAdmin,
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: vi.fn(async () => ({
    rpc: mockRpc,
  })),
}));

vi.mock("@/lib/revalidate", () => ({
  revalidatePublicContent: mockRevalidate,
}));

// ── Module under test ─────────────────────────────────────────────────────────

import { setPageNav } from "@/app/admin/(panel)/pages/actions";

// ── Fixtures ───────────────────────────────────────────────────────────────────

const ADMIN_USER = {
  userId: "00000000-0000-0000-0000-000000000099",
  email: "admin@alnyron.dk",
  role: "owner" as const,
};

const PAGE_ID = "c3d4e5f6-0000-0000-0000-000000000001";

function rpcSuccess() {
  mockRpc.mockResolvedValue({ data: null, error: null });
}

function rpcError(code: string, message: string) {
  mockRpc.mockResolvedValue({ data: null, error: { code, message } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue(ADMIN_USER);
  mockRevalidate.mockResolvedValue(undefined);
});

// ── AC-MONNAV-5f: requireAdmin gate ───────────────────────────────────────────

describe("AC-MONNAV-5f: setPageNav — requireAdmin called before RPC", () => {
  it("AC-MONNAV-5f: requireAdmin() is called before admin_set_page_nav", async () => {
    rpcSuccess();
    await setPageNav(PAGE_ID, true);
    expect(mockRequireAdmin).toHaveBeenCalledOnce();
    const requireOrder = mockRequireAdmin.mock.invocationCallOrder[0]!;
    const rpcOrder = mockRpc.mock.invocationCallOrder[0]!;
    expect(requireOrder).toBeLessThan(rpcOrder);
  });

  it("AC-MONNAV-5g: unauthenticated caller — admin_set_page_nav never called", async () => {
    mockRequireAdmin.mockRejectedValue(new Error("NEXT_REDIRECT:/admin/login"));
    await expect(setPageNav(PAGE_ID, true)).rejects.toThrow("NEXT_REDIRECT:/admin/login");
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

// ── AC-MONNAV-5h: correct RPC arguments ──────────────────────────────────────

describe("AC-MONNAV-5h: setPageNav — calls admin_set_page_nav with exact {p_page_id, p_show}", () => {
  it("AC-MONNAV-5h-true: show=true → {p_page_id, p_show: true}", async () => {
    rpcSuccess();
    await setPageNav(PAGE_ID, true);
    expect(mockRpc).toHaveBeenCalledWith(
      "admin_set_page_nav",
      expect.objectContaining({ p_page_id: PAGE_ID, p_show: true }),
    );
  });

  it("AC-MONNAV-5h-false: show=false → {p_page_id, p_show: false}", async () => {
    rpcSuccess();
    await setPageNav(PAGE_ID, false);
    expect(mockRpc).toHaveBeenCalledWith(
      "admin_set_page_nav",
      expect.objectContaining({ p_page_id: PAGE_ID, p_show: false }),
    );
  });
});

// ── AC-MONNAV-5i: revalidatePublicContent on success ─────────────────────────

describe("AC-MONNAV-5i: setPageNav — revalidatePublicContent on RPC success", () => {
  it("AC-MONNAV-5i: revalidatePublicContent() called when RPC succeeds", async () => {
    rpcSuccess();
    await setPageNav(PAGE_ID, true);
    expect(mockRevalidate).toHaveBeenCalledOnce();
  });

  it("AC-MONNAV-5j: revalidatePublicContent() NOT called when RPC returns an error", async () => {
    rpcError("42501", "forbidden");
    await setPageNav(PAGE_ID, true);
    expect(mockRevalidate).not.toHaveBeenCalled();
  });
});

// ── AC-MONNAV-5k: input validation — pageId must be a valid UUID ──────────────

describe("AC-MONNAV-5k: setPageNav — GUID validation on pageId", () => {
  it("AC-MONNAV-5k: non-UUID pageId → {ok: false, error: 'invalid'}, RPC not called", async () => {
    const result = await setPageNav("not-a-uuid", true);
    expect(result).toMatchObject({ ok: false, error: "invalid" });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("AC-MONNAV-5k-empty: empty pageId → {ok: false, error: 'invalid'}", async () => {
    const result = await setPageNav("", false);
    expect(result).toMatchObject({ ok: false, error: "invalid" });
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

// ── AC-MONNAV-5l: input validation — show must be boolean ────────────────────

describe("AC-MONNAV-5l: setPageNav — boolean validation on show", () => {
  it("AC-MONNAV-5l: non-boolean show (string) → {ok: false, error: 'invalid'}, RPC not called", async () => {
    // Server Actions receive raw FormData values; a non-boolean must be rejected.
    // TypeScript prevents this at compile time but the runtime must guard too.
    const result = await setPageNav(PAGE_ID, "yes" as unknown as boolean);
    expect(result).toMatchObject({ ok: false, error: "invalid" });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("AC-MONNAV-5l-null: null show → {ok: false, error: 'invalid'}", async () => {
    const result = await setPageNav(PAGE_ID, null as unknown as boolean);
    expect(result).toMatchObject({ ok: false, error: "invalid" });
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
