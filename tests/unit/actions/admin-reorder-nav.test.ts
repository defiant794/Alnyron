/**
 * Unit tests — reorderNav server action (F1.2 pages editor)
 * Journey: pages-editor  AC-PAGES-14, 15, 16
 *
 * Expected module: src/app/admin/(panel)/pages/actions.ts
 *
 * admin_reorder_nav(p_page_ids uuid[]) sets nav_order = (1000 + ordinal*10) for
 * each page in the supplied array; pages outside the array are not touched.
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

import { reorderNav } from "@/app/admin/(panel)/pages/actions";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ADMIN_USER = {
  userId: "00000000-0000-0000-0000-000000000099",
  email: "admin@alnyron.dk",
  role: "owner" as const,
};

const PAGE_IDS = [
  "00000000-0000-0000-0000-000000000001",
  "00000000-0000-0000-0000-000000000002",
  "00000000-0000-0000-0000-000000000003",
];

// ── Helpers ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue(ADMIN_USER);
  mockRevalidate.mockResolvedValue(undefined);
  mockRpc.mockResolvedValue({ data: null, error: null });
});

// ── AC-PAGES-14: requireAdmin gate ────────────────────────────────────────────

describe("AC-PAGES-14: reorderNav — requireAdmin called before RPC", () => {
  it("AC-PAGES-14: requireAdmin() is called before admin_reorder_nav", async () => {
    await reorderNav(PAGE_IDS);
    expect(mockRequireAdmin).toHaveBeenCalledOnce();
    const requireOrder = mockRequireAdmin.mock.invocationCallOrder[0]!;
    const rpcOrder = mockRpc.mock.invocationCallOrder[0]!;
    expect(requireOrder).toBeLessThan(rpcOrder);
  });

  it("AC-PAGES-14b: unauthenticated caller — admin_reorder_nav never called", async () => {
    mockRequireAdmin.mockRejectedValue(new Error("NEXT_REDIRECT:/admin/login"));
    await expect(reorderNav(PAGE_IDS)).rejects.toThrow("NEXT_REDIRECT:/admin/login");
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

// ── AC-PAGES-15: correct RPC arguments ───────────────────────────────────────

describe("AC-PAGES-15: reorderNav — calls admin_reorder_nav with exact page ID array", () => {
  it("AC-PAGES-15: passes the ordered page IDs array as p_page_ids to the RPC", async () => {
    await reorderNav(PAGE_IDS);
    expect(mockRpc).toHaveBeenCalledWith(
      "admin_reorder_nav",
      expect.objectContaining({ p_page_ids: PAGE_IDS }),
    );
  });

  it("AC-PAGES-15b: order is preserved — first ID in array → lowest nav_order", async () => {
    const reversedIds = [...PAGE_IDS].reverse();
    await reorderNav(reversedIds);
    expect(mockRpc).toHaveBeenCalledWith(
      "admin_reorder_nav",
      expect.objectContaining({ p_page_ids: reversedIds }),
    );
    // Confirm it's not the original order
    expect(mockRpc.mock.calls[0]![1]!.p_page_ids[0]).toBe(reversedIds[0]);
  });
});

// ── AC-PAGES-16: revalidatePublicContent on success ──────────────────────────

describe("AC-PAGES-16: reorderNav — revalidates public content after successful reorder", () => {
  it("AC-PAGES-16: revalidatePublicContent() called when RPC succeeds", async () => {
    await reorderNav(PAGE_IDS);
    expect(mockRevalidate).toHaveBeenCalledOnce();
  });

  it("AC-PAGES-16b: revalidatePublicContent() NOT called when RPC returns an error", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "42501", message: "forbidden" } });
    await reorderNav(PAGE_IDS);
    expect(mockRevalidate).not.toHaveBeenCalled();
  });
});
