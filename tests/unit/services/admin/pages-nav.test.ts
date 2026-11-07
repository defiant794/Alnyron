/**
 * Unit tests — savePageNav (new) + getSystemPageForEdit area-null guard (Slice B)
 * Journey: monitor-nav  AC-MONNAV-4, AC-MONNAV-5
 *
 * Expected module: src/services/admin/pages.ts
 *
 * savePageNav(pageId, show):
 *   - Calls admin_set_page_nav with {p_page_id, p_show}
 *   - Returns {ok: true} on success
 *   - Maps RPC errors through the existing failure() helper
 *   - Validates pageId as UUID; non-UUID → {ok: false, error: 'invalid'} without calling RPC
 *
 * getSystemPageForEdit:
 *   - Returns null for an area page (SYSTEM_PAGE_IS_AREA[system_key] === true), e.g. monitor
 *   - Returns non-null for a content page (home, contact, privacy)
 *   - The existing null-for-invalid-uuid and null-for-no-system_key guards still hold
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── vi.hoisted ─────────────────────────────────────────────────────────────────

const { mockRpc, mockMaybeSingle } = vi.hoisted(() => {
  const mockMaybeSingle = vi.fn();
  return {
    mockRpc: vi.fn(),
    mockMaybeSingle,
  };
});

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: vi.fn(async () => ({
    rpc: mockRpc,
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: mockMaybeSingle,
        })),
      })),
    })),
  })),
}));

// Mock the config to include SYSTEM_PAGE_IS_AREA (the web-developer will add it).
// Without this mock the import of system-pages would succeed but IS_AREA would be
// undefined, masking whether the service actually reads it.
vi.mock("@/config/system-pages", () => ({
  SYSTEM_PAGE_PATHNAMES: { home: "/", contact: "/contact", privacy: "/privacy", monitor: "/monitor" },
  SYSTEM_PAGE_HAS_BODY: { home: false, contact: false, privacy: true, monitor: false },
  SYSTEM_PAGE_IS_AREA: { home: false, contact: false, privacy: false, monitor: true },
  MULTILINE_CONTENT_FIELDS: {},
  PAGE_TEXT_LIMITS: { title: 160, lead: 600, body_md: 50_000, seo_title: 70, seo_description: 160 },
}));

// ── Modules under test ─────────────────────────────────────────────────────────

import { savePageNav, getSystemPageForEdit } from "@/services/admin/pages";

// ── Fixtures ───────────────────────────────────────────────────────────────────

const PAGE_ID = "b2c3d4e5-0000-0000-0000-000000000001";

function rpcSuccess() {
  mockRpc.mockResolvedValue({ data: null, error: null });
}

function rpcError(code: string, message: string) {
  mockRpc.mockResolvedValue({ data: null, error: { code, message } });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── AC-MONNAV-5a: savePageNav calls correct RPC and args ──────────────────────

describe("AC-MONNAV-5a: savePageNav — calls admin_set_page_nav with p_page_id + p_show", () => {
  it("AC-MONNAV-5a: show=true passes {p_page_id, p_show: true} to the RPC", async () => {
    rpcSuccess();
    await savePageNav(PAGE_ID, true);
    expect(mockRpc).toHaveBeenCalledWith(
      "admin_set_page_nav",
      expect.objectContaining({ p_page_id: PAGE_ID, p_show: true }),
    );
  });

  it("AC-MONNAV-5b: show=false passes {p_page_id, p_show: false} to the RPC", async () => {
    rpcSuccess();
    await savePageNav(PAGE_ID, false);
    expect(mockRpc).toHaveBeenCalledWith(
      "admin_set_page_nav",
      expect.objectContaining({ p_page_id: PAGE_ID, p_show: false }),
    );
  });
});

// ── AC-MONNAV-5c: savePageNav returns ok on success ───────────────────────────

describe("AC-MONNAV-5c: savePageNav — returns {ok: true} on RPC success", () => {
  it("AC-MONNAV-5c: RPC success → {ok: true}", async () => {
    rpcSuccess();
    const result = await savePageNav(PAGE_ID, true);
    expect(result).toMatchObject({ ok: true });
  });
});

// ── AC-MONNAV-5d: savePageNav maps RPC errors ─────────────────────────────────

describe("AC-MONNAV-5d: savePageNav — RPC errors mapped via failure helper", () => {
  it("AC-MONNAV-5d-forbidden: 42501 → {ok: false, error: 'forbidden'}", async () => {
    rpcError("42501", "forbidden");
    const result = await savePageNav(PAGE_ID, true);
    expect(result).toMatchObject({ ok: false, error: "forbidden" });
  });

  it("AC-MONNAV-5d-notfound: P0002 → {ok: false, error: 'not-found'}", async () => {
    rpcError("P0002", "page_not_found");
    const result = await savePageNav(PAGE_ID, true);
    expect(result).toMatchObject({ ok: false, error: "not-found" });
  });

  it("AC-MONNAV-5d-generic: unknown code → {ok: false, error: 'failed'}", async () => {
    rpcError("XXXXX", "something went wrong");
    const result = await savePageNav(PAGE_ID, true);
    expect(result).toMatchObject({ ok: false, error: "failed" });
  });
});

// ── AC-MONNAV-5e: savePageNav validates pageId as UUID ────────────────────────

describe("AC-MONNAV-5e: savePageNav — non-UUID pageId → invalid without RPC call", () => {
  it("AC-MONNAV-5e: non-UUID → {ok: false, error: 'invalid'}, RPC not called", async () => {
    const result = await savePageNav("not-a-uuid", true);
    expect(result).toMatchObject({ ok: false, error: "invalid" });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("AC-MONNAV-5e-empty: empty string → {ok: false, error: 'invalid'}", async () => {
    const result = await savePageNav("", true);
    expect(result).toMatchObject({ ok: false, error: "invalid" });
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

// ── AC-MONNAV-4: getSystemPageForEdit returns null for area pages ──────────────

describe("AC-MONNAV-4: getSystemPageForEdit — null for area page (monitor)", () => {
  it("AC-MONNAV-4a: returns null when page has system_key='monitor' (area page)", async () => {
    // The service must check SYSTEM_PAGE_IS_AREA[system_key] and return null
    // for area pages — blocking the editor route for Monitor.
    mockMaybeSingle.mockResolvedValue({
      data: {
        id: PAGE_ID,
        system_key: "monitor",
        show_in_nav: false,
        page_translations: [],
      },
      error: null,
    });

    const result = await getSystemPageForEdit(PAGE_ID);
    expect(result).toBeNull();
  });

  it("AC-MONNAV-4b: returns non-null for a content page (contact) — guard does not over-fire", async () => {
    // contact is NOT an area page; getSystemPageForEdit must return its data.
    mockMaybeSingle.mockResolvedValue({
      data: {
        id: PAGE_ID,
        system_key: "contact",
        show_in_nav: true,
        page_translations: [
          { locale: "da", title: "Kontakt", lead: "", body_md: "", seo_title: "", seo_description: "", content: null },
        ],
      },
      error: null,
    });

    const result = await getSystemPageForEdit(PAGE_ID);
    expect(result).not.toBeNull();
    expect(result?.systemKey).toBe("contact");
  });
});
