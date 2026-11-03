/**
 * Unit tests — admin catalog service (F2.1 catalog-model)
 * Journey: catalog-model  AC-CAT-46, AC-CAT-81, AC-CAT-82, AC-CAT-83, AC-CAT-84, AC-CAT-85, AC-CAT-86, AC-CAT-87, AC-CAT-88;
 * security hardening (f21-security-1 L1/L3) AC-CAT-S15, AC-CAT-S16
 *
 * Module: src/services/admin/catalog.ts
 *
 * Mocks: @/lib/supabase/server (createServerClient)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ITEMS_REORDER_MAX } from "@/config/catalog";

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockRpc = vi.fn();
const mockStorageRemove = vi.fn();
const mockStorageFrom = vi.fn(() => ({ remove: mockStorageRemove }));

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: vi.fn(async () => ({
    rpc: mockRpc,
    storage: { from: mockStorageFrom },
  })),
}));

// ── Module under test ─────────────────────────────────────────────────────────

import {
  catalogActionError,
  saveCategory,
  setCategoryStatus,
  saveItem,
  setItemStatus,
  reorderItems,
  deleteItem,
} from "@/services/admin/catalog";

// ── Fixtures ──────────────────────────────────────────────────────────────────

// RFC 4122-compliant v4 UUIDs (version nibble '4', variant nibble '8'-'b').
const VALID_UUID = "123e4567-e89b-12d3-a456-426614174000";
const VALID_CAT_UUID = "550e8400-e29b-41d4-a716-446655440001";
const VALID_ITEM_UUID = "550e8400-e29b-41d4-a716-446655440002";

const VALID_SAVE_CATEGORY_INPUT = {
  kind: "apps",
  translations: {
    da: { title: "Test Kategori", description: "", seo_title: "", seo_description: "" },
  },
};

const VALID_SAVE_ITEM_INPUT = {
  category_id: VALID_CAT_UUID,
  price_type: null,
  price_amount: null,
  external_links: {},
  translations: {
    da: { slug: "test-item", title: "Test Item", summary: "", body_md: "", seo_title: "", seo_description: "" },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ── AC-CAT-81: invalid input never calls RPC ──────────────────────────────────

describe("AC-CAT-81: invalid input never calls any RPC", () => {
  it("saveCategory with no translations returns invalid without calling RPC", async () => {
    const result = await saveCategory({});
    expect(result).toEqual({ ok: false, error: "invalid" });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("saveCategory with blank DA title returns error without calling RPC", async () => {
    const input = { ...VALID_SAVE_CATEGORY_INPUT, translations: { da: { title: "  ", description: "", seo_title: "", seo_description: "" } } };
    const result = await saveCategory(input);
    expect(result.ok).toBe(false);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("setCategoryStatus with invalid UUID returns invalid without calling RPC", async () => {
    const result = await setCategoryStatus("not-a-uuid", "published");
    expect(result).toEqual({ ok: false, error: "invalid" });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("saveItem without category_id (insert) returns invalid without calling RPC", async () => {
    const result = await saveItem({ translations: { da: { slug: "s", title: "T", summary: "", body_md: "", seo_title: "", seo_description: "" } } });
    expect(result.ok).toBe(false);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("setItemStatus with invalid UUID returns invalid without calling RPC", async () => {
    const result = await setItemStatus("not-a-uuid", "published");
    expect(result).toEqual({ ok: false, error: "invalid" });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("reorderItems with non-array itemIds returns invalid without calling RPC", async () => {
    const result = await reorderItems(VALID_CAT_UUID, "not-an-array");
    expect(result.ok).toBe(false);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("reorderItems with an exact duplicate item id returns invalid without calling RPC", async () => {
    const result = await reorderItems(VALID_CAT_UUID, [VALID_ITEM_UUID, VALID_UUID, VALID_ITEM_UUID]);
    expect(result).toEqual({ ok: false, error: "invalid" });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("reorderItems with a case-variant duplicate item id returns invalid without calling RPC", async () => {
    const mixedCase = "123E4567-E89B-12D3-A456-426614174000";
    const result = await reorderItems(VALID_CAT_UUID, [VALID_UUID, VALID_ITEM_UUID, mixedCase]);
    expect(result).toEqual({ ok: false, error: "invalid" });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("deleteItem with invalid UUID returns invalid without calling RPC", async () => {
    const result = await deleteItem("not-a-uuid");
    expect(result).toEqual({ ok: false, error: "invalid" });
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

// ── AC-CAT-82: saveCategory calls admin_save_category ────────────────────────

describe("AC-CAT-82: saveCategory calls admin_save_category RPC", () => {
  it("calls admin_save_category with the parsed payload and returns {ok:true, id}", async () => {
    mockRpc.mockResolvedValue({ data: VALID_CAT_UUID, error: null });

    const result = await saveCategory(VALID_SAVE_CATEGORY_INPUT);

    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith("admin_save_category", {
      payload: {
        kind: "apps",
        translations: {
          da: { title: "Test Kategori", description: "", seo_title: "", seo_description: "" },
        },
      },
    });
    expect(result).toEqual({ ok: true, id: VALID_CAT_UUID });
  });

  it("strips keys the schema does not know before calling the RPC", async () => {
    mockRpc.mockResolvedValue({ data: VALID_CAT_UUID, error: null });

    await saveCategory({
      id: VALID_CAT_UUID,
      kind: "services",
      featured: true,
      nav_order: 5,
      status: "published",
      updated_by: VALID_UUID,
      translations: {
        da: { title: "Ydelser", description: "", seo_title: "", seo_description: "", slug: "ydelser", category_id: VALID_UUID },
        en: { title: "Services", description: "", seo_title: "", seo_description: "", slug: "services" },
        de: { title: "Dienste", description: "", seo_title: "", seo_description: "" },
      },
    });

    expect(mockRpc).toHaveBeenCalledWith("admin_save_category", {
      payload: {
        id: VALID_CAT_UUID,
        kind: "services",
        featured: true,
        nav_order: 5,
        translations: {
          da: { title: "Ydelser", description: "", seo_title: "", seo_description: "", slug: "ydelser" },
          en: { title: "Services", description: "", seo_title: "", seo_description: "", slug: "services" },
        },
      },
    });
  });

  it("returns {ok:false, error:'da-title-required'} when RPC returns 23514 with da_title constraint", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "23514", message: "category_translations_da_title" } });

    const result = await saveCategory(VALID_SAVE_CATEGORY_INPUT);

    expect(result).toEqual({ ok: false, error: "da-title-required" });
  });

  it("returns {ok:false, error:'slug-taken'} when RPC returns 23505", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "23505", message: "duplicate slug" } });

    const result = await saveCategory(VALID_SAVE_CATEGORY_INPUT);

    expect(result).toEqual({ ok: false, error: "slug-taken" });
  });

  it("returns {ok:false, error:'not-found'} when RPC returns P0002", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "P0002", message: "category_not_found" } });

    const result = await saveCategory(VALID_SAVE_CATEGORY_INPUT);

    expect(result).toEqual({ ok: false, error: "not-found" });
  });
});

// ── AC-CAT-83: setCategoryStatus calls admin_set_category_status ─────────────

describe("AC-CAT-83: setCategoryStatus calls admin_set_category_status RPC", () => {
  it("calls admin_set_category_status with correct args", async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });

    const result = await setCategoryStatus(VALID_CAT_UUID, "published");

    expect(mockRpc).toHaveBeenCalledTimes(1);
    const [rpcName, rpcArgs] = mockRpc.mock.calls[0]!;
    expect(rpcName).toBe("admin_set_category_status");
    expect(rpcArgs).toMatchObject({ p_category_id: VALID_CAT_UUID, p_status: "published" });
    expect(result).toEqual({ ok: true });
  });

  it("returns {ok:false, error:'missing-slugs'} when RPC returns P0001 missing_slugs", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "missing_slugs" } });

    const result = await setCategoryStatus(VALID_CAT_UUID, "published");

    expect(result).toEqual({ ok: false, error: "missing-slugs" });
  });
});

// ── AC-CAT-84: saveItem calls admin_save_item ─────────────────────────────────

describe("AC-CAT-84: saveItem calls admin_save_item RPC", () => {
  it("calls admin_save_item with the parsed payload (price_currency defaulted to DKK) and returns {ok:true, id}", async () => {
    mockRpc.mockResolvedValue({ data: VALID_ITEM_UUID, error: null });

    const result = await saveItem(VALID_SAVE_ITEM_INPUT);

    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith("admin_save_item", {
      payload: {
        category_id: VALID_CAT_UUID,
        price_type: null,
        price_amount: null,
        price_currency: "DKK",
        external_links: {},
        translations: {
          da: { slug: "test-item", title: "Test Item", summary: "", body_md: "", seo_title: "", seo_description: "" },
        },
      },
    });
    expect(result).toEqual({ ok: true, id: VALID_ITEM_UUID });
  });

  it("strips keys the schema does not know and defaults media alt_en before calling the RPC", async () => {
    mockRpc.mockResolvedValue({ data: VALID_ITEM_UUID, error: null });

    await saveItem({
      id: VALID_ITEM_UUID,
      featured: true,
      status: "published",
      sort_order: 1,
      published_at: "2026-01-01T00:00:00Z",
      price_type: "from",
      price_amount: 12000,
      external_links: { website: "https://example.com" },
      translations: {
        da: { slug: "app", title: "App", summary: "", body_md: "", seo_title: "", seo_description: "", item_id: VALID_UUID },
      },
      media: [{ id: VALID_UUID, alt_da: "Skærmbillede", sort_order: 10, storage_path: "items/x/y.webp" }],
    });

    expect(mockRpc).toHaveBeenCalledWith("admin_save_item", {
      payload: {
        id: VALID_ITEM_UUID,
        featured: true,
        price_type: "from",
        price_amount: 12000,
        price_currency: "DKK",
        external_links: { website: "https://example.com" },
        translations: {
          da: { slug: "app", title: "App", summary: "", body_md: "", seo_title: "", seo_description: "" },
        },
        media: [{ id: VALID_UUID, alt_da: "Skærmbillede", alt_en: "", sort_order: 10 }],
      },
    });
  });

  it("returns {ok:false, error:'price-invalid'} when RPC returns 23514 items_price_consistent", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "23514", message: "items_price_consistent" } });

    const result = await saveItem(VALID_SAVE_ITEM_INPUT);

    expect(result).toEqual({ ok: false, error: "price-invalid" });
  });

  it("returns {ok:false, error:'links-invalid'} when RPC returns 23514 items_external_links_valid", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "23514", message: "items_external_links_valid" } });

    const result = await saveItem(VALID_SAVE_ITEM_INPUT);

    expect(result).toEqual({ ok: false, error: "links-invalid" });
  });

  it("returns {ok:false, error:'not-found'} when RPC returns 23503 (unknown category)", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "23503", message: "foreign key violation" } });

    const result = await saveItem(VALID_SAVE_ITEM_INPUT);

    expect(result).toEqual({ ok: false, error: "not-found" });
  });
});

// ── AC-CAT-85: setItemStatus calls admin_set_item_status ─────────────────────

describe("AC-CAT-85: setItemStatus calls admin_set_item_status RPC", () => {
  it("calls admin_set_item_status with correct args", async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });

    const result = await setItemStatus(VALID_ITEM_UUID, "published");

    expect(mockRpc).toHaveBeenCalledTimes(1);
    const [rpcName, rpcArgs] = mockRpc.mock.calls[0]!;
    expect(rpcName).toBe("admin_set_item_status");
    expect(rpcArgs).toMatchObject({ p_item_id: VALID_ITEM_UUID, p_status: "published" });
    expect(result).toEqual({ ok: true });
  });

  it("returns {ok:false, error:'missing-translations'} when RPC returns P0001 missing_translations", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "missing_translations" } });

    const result = await setItemStatus(VALID_ITEM_UUID, "published");

    expect(result).toEqual({ ok: false, error: "missing-translations" });
  });
});

// ── AC-CAT-86: reorderItems calls admin_reorder_items ────────────────────────

describe("AC-CAT-86: reorderItems calls admin_reorder_items RPC", () => {
  it("calls admin_reorder_items with p_category_id and p_item_ids", async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    const ids = [VALID_ITEM_UUID, VALID_UUID];

    const result = await reorderItems(VALID_CAT_UUID, ids);

    expect(mockRpc).toHaveBeenCalledTimes(1);
    const [rpcName, rpcArgs] = mockRpc.mock.calls[0]!;
    expect(rpcName).toBe("admin_reorder_items");
    expect(rpcArgs).toMatchObject({ p_category_id: VALID_CAT_UUID, p_item_ids: ids });
    expect(result).toEqual({ ok: true });
  });

  it("calls admin_reorder_items for distinct mixed-case ids (no repeat after lower-casing)", async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    const ids = ["550E8400-E29B-41D4-A716-446655440002", VALID_UUID, VALID_CAT_UUID];

    const result = await reorderItems(VALID_CAT_UUID, ids);

    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith("admin_reorder_items", { p_category_id: VALID_CAT_UUID, p_item_ids: ids });
    expect(result).toEqual({ ok: true });
  });
});

// ── AC-CAT-87 & AC-CAT-88: deleteItem ────────────────────────────────────────

describe("AC-CAT-87: deleteItem calls storage.remove when paths returned", () => {
  it("calls storage.from('media').remove with returned paths", async () => {
    const paths = [`items/${VALID_ITEM_UUID}/a.webp`, `items/${VALID_ITEM_UUID}/b.webp`];
    mockRpc.mockResolvedValue({ data: paths, error: null });
    mockStorageRemove.mockResolvedValue({ error: null });

    const result = await deleteItem(VALID_ITEM_UUID);

    expect(mockRpc).toHaveBeenCalledWith("admin_delete_item", expect.objectContaining({ p_item_id: VALID_ITEM_UUID }));
    expect(mockStorageFrom).toHaveBeenCalledWith("media");
    expect(mockStorageRemove).toHaveBeenCalledWith(paths);
    expect(result).toEqual({ ok: true });
  });

  it("still returns {ok:true} when storage.remove fails", async () => {
    const paths = [`items/${VALID_ITEM_UUID}/a.webp`];
    mockRpc.mockResolvedValue({ data: paths, error: null });
    mockStorageRemove.mockResolvedValue({ error: { message: "storage error" } });

    const result = await deleteItem(VALID_ITEM_UUID);

    expect(result).toEqual({ ok: true });
  });
});

describe("AC-CAT-88: deleteItem does not call storage.remove when paths is empty", () => {
  it("returns {ok:true} and does not call storage when RPC returns empty array", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });

    const result = await deleteItem(VALID_ITEM_UUID);

    expect(result).toEqual({ ok: true });
    expect(mockStorageRemove).not.toHaveBeenCalled();
  });

  it("returns {ok:true} and does not call storage when RPC returns null/empty data", async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });

    const result = await deleteItem(VALID_ITEM_UUID);

    expect(result).toEqual({ ok: true });
    expect(mockStorageRemove).not.toHaveBeenCalled();
  });
});

// ── AC-CAT-46: catalogActionError error map ───────────────────────────────────

describe("AC-CAT-46: catalogActionError maps Postgres codes to CatalogActionError", () => {
  it("23505 maps to slug-taken", () => {
    expect(catalogActionError({ code: "23505", message: "duplicate key" })).toBe("slug-taken");
  });

  it("23505 with media_storage_path_key in message maps to invalid", () => {
    expect(catalogActionError({ code: "23505", message: "Key (storage_path)=(media_storage_path_key) already exists." })).toBe("invalid");
  });

  it("23514 with category_translations_da_title maps to da-title-required", () => {
    expect(catalogActionError({ code: "23514", message: "category_translations_da_title" })).toBe("da-title-required");
  });

  it("23514 with item_translations_da_title maps to da-title-required", () => {
    expect(catalogActionError({ code: "23514", message: "item_translations_da_title" })).toBe("da-title-required");
  });

  it("23514 with routes_slug_format maps to slug-invalid", () => {
    expect(catalogActionError({ code: "23514", message: "routes_slug_format" })).toBe("slug-invalid");
  });

  it("23514 with routes_slug_reserved maps to slug-invalid", () => {
    expect(catalogActionError({ code: "23514", message: "routes_slug_reserved" })).toBe("slug-invalid");
  });

  it("23514 with item_translations_slug_check maps to slug-invalid", () => {
    expect(catalogActionError({ code: "23514", message: "item_translations_slug_check" })).toBe("slug-invalid");
  });

  it("23514 with media_alt_da_check maps to alt-required", () => {
    expect(catalogActionError({ code: "23514", message: "media_alt_da_check" })).toBe("alt-required");
  });

  it("23514 with items_price_consistent maps to price-invalid", () => {
    expect(catalogActionError({ code: "23514", message: "items_price_consistent" })).toBe("price-invalid");
  });

  it("23514 with items_external_links_valid maps to links-invalid", () => {
    expect(catalogActionError({ code: "23514", message: "items_external_links_valid" })).toBe("links-invalid");
  });

  it("23514 with unknown constraint maps to invalid", () => {
    expect(catalogActionError({ code: "23514", message: "some_other_constraint" })).toBe("invalid");
  });

  it("23503 maps to not-found", () => {
    expect(catalogActionError({ code: "23503", message: "foreign key violation" })).toBe("not-found");
  });

  it("P0001 missing_slugs maps to missing-slugs", () => {
    expect(catalogActionError({ code: "P0001", message: "missing_slugs" })).toBe("missing-slugs");
  });

  it("P0001 missing_translations maps to missing-translations", () => {
    expect(catalogActionError({ code: "P0001", message: "missing_translations" })).toBe("missing-translations");
  });

  it("P0001 too_many_media maps to too-many-media", () => {
    expect(catalogActionError({ code: "P0001", message: "too_many_media" })).toBe("too-many-media");
  });

  it("P0001 unknown message maps to failed", () => {
    expect(catalogActionError({ code: "P0001", message: "unknown_error" })).toBe("failed");
  });

  it("P0002 maps to not-found", () => {
    expect(catalogActionError({ code: "P0002", message: "item_not_found" })).toBe("not-found");
  });

  it("22P02 maps to not-found", () => {
    expect(catalogActionError({ code: "22P02", message: "invalid input syntax for type uuid" })).toBe("not-found");
  });

  it("22023 maps to invalid (invalid_media_path, media_type_mismatch, kind_required, category_required)", () => {
    for (const message of ["invalid_media_path", "media_type_mismatch", "kind_required", "category_required"]) {
      expect(catalogActionError({ code: "22023", message })).toBe("invalid");
    }
  });

  it("42501 maps to forbidden", () => {
    expect(catalogActionError({ code: "42501", message: "forbidden" })).toBe("forbidden");
  });

  it("unknown code maps to failed", () => {
    expect(catalogActionError({ code: "08006", message: "connection failure" })).toBe("failed");
  });
});

// ── AC-CAT-S15: the hardening constraints and RPC bounds map to invalid / too-many-media ──

describe("AC-CAT-S15: catalogActionError maps the hardening constraints and bounds", () => {
  it("23514 on media_storage_path_valid / media_mime_matches_path / media_alt_*_length maps to invalid", () => {
    for (const constraint of [
      "media_storage_path_valid",
      "media_mime_matches_path",
      "media_alt_da_length",
      "media_alt_en_length",
    ]) {
      const message = `new row for relation "media" violates check constraint "${constraint}"`;
      expect(catalogActionError({ code: "23514", message })).toBe("invalid");
    }
  });

  it("22023 too_many_items (admin_reorder_items bound) maps to invalid", () => {
    expect(catalogActionError({ code: "22023", message: "too_many_items" })).toBe("invalid");
  });

  it("saveItem maps the RPC's P0001 too_many_media (media list bound) to too-many-media", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "too_many_media" } });
    expect(await saveItem({ ...VALID_SAVE_ITEM_INPUT, id: VALID_ITEM_UUID })).toEqual({ ok: false, error: "too-many-media" });
  });
});

// ── AC-CAT-S16: reorderItems is bounded before the RPC ────────────────────────

describe("AC-CAT-S16: reorderItems accepts at most ITEMS_REORDER_MAX ids", () => {
  /** `count` distinct v4-shaped uuids. */
  const uuids = (count: number) =>
    Array.from({ length: count }, (_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`);

  it("returns invalid for ITEMS_REORDER_MAX + 1 ids without calling the RPC", async () => {
    const result = await reorderItems(VALID_CAT_UUID, uuids(ITEMS_REORDER_MAX + 1));
    expect(result).toEqual({ ok: false, error: "invalid" });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("calls admin_reorder_items with exactly ITEMS_REORDER_MAX ids", async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    const ids = uuids(ITEMS_REORDER_MAX);
    expect(await reorderItems(VALID_CAT_UUID, ids)).toEqual({ ok: true });
    expect(mockRpc).toHaveBeenCalledWith("admin_reorder_items", { p_category_id: VALID_CAT_UUID, p_item_ids: ids });
  });

  it("maps the RPC's 22023 too_many_items to invalid", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "22023", message: "too_many_items" } });
    expect(await reorderItems(VALID_CAT_UUID, [VALID_ITEM_UUID])).toEqual({ ok: false, error: "invalid" });
  });
});
