/**
 * Unit tests — setPageStatus server action (F1.2 pages editor)
 * Journey: pages-editor  AC-PAGES-11, 12, 13, 07, S01
 *
 * Expected module: src/app/admin/(panel)/pages/actions.ts
 *
 * Key DB facts (from migrations):
 *  - admin_set_page_status(p_page_id, p_status) — raises:
 *      P0001 / message 'missing_slugs'             (custom page, <2 locale routes, publish attempt)
 *      P0002 / message 'page_not_found'             (id not found)
 *      42501 / message 'forbidden'                  (is_admin() = false)
 *      23514 / message 'system pages are always published'
 *                                                   (pages_system_guard trigger, system page → draft)
 *  - Note: missing_slugs is raised with errcode P0001 and the message IS
 *    'missing_slugs' (not a hint). The action must match on error.message.
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

import { setPageStatus } from "@/app/admin/(panel)/pages/actions";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ADMIN_USER = {
  userId: "00000000-0000-0000-0000-000000000099",
  email: "admin@alnyron.dk",
  role: "owner" as const,
};

const PAGE_ID = "b2c3d4e5-0000-0000-0000-000000000001";

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── AC-PAGES-11: requireAdmin gate ────────────────────────────────────────────

describe("AC-PAGES-11: setPageStatus — requireAdmin called before RPC", () => {
  it("AC-PAGES-11: requireAdmin() is called before admin_set_page_status", async () => {
    rpcSuccess();
    await setPageStatus(PAGE_ID, "published");
    expect(mockRequireAdmin).toHaveBeenCalledOnce();
    const requireOrder = mockRequireAdmin.mock.invocationCallOrder[0]!;
    const rpcOrder = mockRpc.mock.invocationCallOrder[0]!;
    expect(requireOrder).toBeLessThan(rpcOrder);
  });

  it("AC-PAGES-11b: unauthenticated caller — admin_set_page_status never called", async () => {
    mockRequireAdmin.mockRejectedValue(new Error("NEXT_REDIRECT:/admin/login"));
    await expect(setPageStatus(PAGE_ID, "published")).rejects.toThrow("NEXT_REDIRECT:/admin/login");
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

// ── AC-PAGES-12: correct RPC arguments ───────────────────────────────────────

describe("AC-PAGES-12: setPageStatus — calls admin_set_page_status with correct arguments", () => {
  it("AC-PAGES-12a: status 'published' — calls RPC with matching p_page_id and p_status", async () => {
    rpcSuccess();
    await setPageStatus(PAGE_ID, "published");
    expect(mockRpc).toHaveBeenCalledWith(
      "admin_set_page_status",
      expect.objectContaining({ p_page_id: PAGE_ID, p_status: "published" }),
    );
  });

  it("AC-PAGES-12b: status 'draft' — calls RPC with p_status 'draft'", async () => {
    rpcSuccess();
    await setPageStatus(PAGE_ID, "draft");
    expect(mockRpc).toHaveBeenCalledWith(
      "admin_set_page_status",
      expect.objectContaining({ p_page_id: PAGE_ID, p_status: "draft" }),
    );
  });
});

// ── AC-PAGES-13: revalidatePublicContent on success ──────────────────────────

describe("AC-PAGES-13: setPageStatus — revalidates public content after successful status change", () => {
  it("AC-PAGES-13: revalidatePublicContent() called when RPC succeeds", async () => {
    rpcSuccess();
    await setPageStatus(PAGE_ID, "published");
    expect(mockRevalidate).toHaveBeenCalledOnce();
  });

  it("AC-PAGES-13b: revalidatePublicContent() NOT called when RPC returns an error", async () => {
    rpcError("P0001", "missing_slugs");
    await setPageStatus(PAGE_ID, "published");
    expect(mockRevalidate).not.toHaveBeenCalled();
  });
});

// ── AC-PAGES-07: P0001 message 'missing_slugs' → missing-slugs error ─────────

describe("AC-PAGES-07: setPageStatus — P0001 'missing_slugs' → missing-slugs error (custom pages)", () => {
  it("AC-PAGES-07: RPC error P0001 with message 'missing_slugs' → result { error: 'missing-slugs' }", async () => {
    // admin_set_page_status raises this when publishing a custom page that does
    // not yet have routes for both DA and EN locales.
    // The error code is P0001 and the MESSAGE is 'missing_slugs' (not a hint).
    rpcError("P0001", "missing_slugs");
    const result = await setPageStatus(PAGE_ID, "published");
    expect(result).toMatchObject({ error: "missing-slugs" });
  });
});

// ── AC-PAGES-S01: 23514 'system pages are always published' ──────────────────

describe("AC-PAGES-S01: setPageStatus — 23514 'system pages are always published' → system-always-published error", () => {
  it("AC-PAGES-S01: RPC 23514 with pages_system_guard message → result { error: 'system-always-published' }", async () => {
    // pages_system_guard trigger fires (errcode 23514) when any UPDATE sets
    // status <> 'published' on a row where system_key is not null.
    // The trigger message is exactly: 'system pages are always published'.
    rpcError("23514", "system pages are always published");
    const result = await setPageStatus(PAGE_ID, "draft");
    expect(result).toMatchObject({ error: "system-always-published" });
  });
});

// ── L1 security: non-GUID id → invalid ───────────────────────────────────────

describe("L1-PAGES-STATUS-SEC: setPageStatus — GUID validation", () => {
  it("L1-PAGES-STATUS-SEC-01: non-GUID id → invalid, admin_set_page_status NOT called", async () => {
    const result = await setPageStatus("not-a-uuid", "published");
    expect(result).toMatchObject({ error: "invalid" });
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
