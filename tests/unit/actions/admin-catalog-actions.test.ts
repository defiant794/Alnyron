/**
 * Unit tests — catalog admin server actions (F2.3 catalog-admin)
 * Journey: catalog-admin
 * Acceptance IDs: AC-CATADM-07, AC-CATADM-19, AC-CATADM-33, AC-CATADM-50,
 * F23-SEC-L1 (security review Low: the orphan sweep runs before every upload URL)
 *
 * Mirrors tests/unit/actions/admin-save-page.test.ts.
 * Tests the thin `requireAdmin() → service → revalidatePublicContent()` wiring
 * of the catalog action files:
 *   src/app/admin/(panel)/catalog/categories/[id]/actions.ts
 *   src/app/admin/(panel)/catalog/items/actions.ts
 *   src/app/admin/(panel)/catalog/items/[id]/media-actions.ts
 *
 * requireAdmin() NEVER returns `forbidden` — it throws/redirects to
 * /admin/no-access. Tests assert the action propagates the throw and the
 * underlying service is NEVER called.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── vi.hoisted ─────────────────────────────────────────────────────────────────

const {
  mockRequireAdmin,
  mockSaveCategory,
  mockSetCategoryStatus,
  mockSaveItem,
  mockSetItemStatus,
  mockReorderItems,
  mockDeleteItem,
  mockCreateMediaUpload,
  mockAttachMedia,
  mockRemoveOrphanMedia,
  mockDetachMedia,
  mockRevalidate,
} = vi.hoisted(() => ({
  mockRequireAdmin: vi.fn(),
  mockSaveCategory: vi.fn(),
  mockSetCategoryStatus: vi.fn(),
  mockSaveItem: vi.fn(),
  mockSetItemStatus: vi.fn(),
  mockReorderItems: vi.fn(),
  mockDeleteItem: vi.fn(),
  mockCreateMediaUpload: vi.fn(),
  mockAttachMedia: vi.fn(),
  mockRemoveOrphanMedia: vi.fn(),
  mockDetachMedia: vi.fn(),
  mockRevalidate: vi.fn(),
}));

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock("@/services/auth/require-admin", () => ({
  requireAdmin: mockRequireAdmin,
}));

vi.mock("@/services/admin/catalog", () => ({
  saveCategory: mockSaveCategory,
  setCategoryStatus: mockSetCategoryStatus,
  saveItem: mockSaveItem,
  setItemStatus: mockSetItemStatus,
  reorderItems: mockReorderItems,
  deleteItem: mockDeleteItem,
}));

vi.mock("@/services/admin/media", () => ({
  createMediaUpload: mockCreateMediaUpload,
  attachMedia: mockAttachMedia,
  removeOrphanMedia: mockRemoveOrphanMedia,
  detachMedia: mockDetachMedia,
}));

vi.mock("@/lib/revalidate", () => ({
  revalidatePublicContent: mockRevalidate,
}));

// ── Modules under test ────────────────────────────────────────────────────────

import {
  saveCategoryAction,
  setCategoryStatusAction,
  reorderItemsAction,
} from "@/app/admin/(panel)/catalog/categories/[id]/actions";

import {
  saveItemAction,
  setItemStatusAction,
  deleteItemAction,
} from "@/app/admin/(panel)/catalog/items/actions";

import {
  createMediaUploadAction,
  attachMediaAction,
  detachMediaAction,
} from "@/app/admin/(panel)/catalog/items/[id]/media-actions";
import type { MediaAttachInput } from "@/components/admin/MediaManager";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const VALID_CAT_UUID = "550e8400-e29b-41d4-a716-446655440001";
const VALID_ITEM_UUID = "550e8400-e29b-41d4-a716-446655440002";
const VALID_MEDIA_UUID = "550e8400-e29b-41d4-a716-446655440003";

const VALID_CATEGORY_INPUT = {
  id: VALID_CAT_UUID,
  da: { title: "Ydelser", slug: "ydelser", description: "", seo_title: "", seo_description: "" },
};

const VALID_ITEM_INPUT = {
  id: VALID_ITEM_UUID,
  category_id: VALID_CAT_UUID,
  da: { title: "Webudvikling", slug: "webudvikling", summary: "", body_md: "", seo_title: "", seo_description: "" },
  price_type: null as null,
  price_amount: null as null,
  external_links: {},
  featured: false,
  media: [],
};

/** The payload MediaManager sends once the upload is stored (`attachMediaSchema`). */
const VALID_ATTACH_INPUT: MediaAttachInput = {
  itemId: VALID_ITEM_UUID,
  path: `items/${VALID_ITEM_UUID}/${VALID_MEDIA_UUID}.webp`,
  alt_da: "Alt tekst",
  alt_en: "",
  width: 1200,
  height: 800,
};

const NOT_ADMIN_ERROR = new Error("Not authenticated — redirect to /admin/no-access");

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue(undefined);
  mockRevalidate.mockReturnValue(undefined);
  mockRemoveOrphanMedia.mockResolvedValue({ ok: true, removed: 0 });
});

// ── AC-CATADM-07 / AC-CATADM-19: category actions — requireAdmin gate ─────────

describe("AC-CATADM-19: saveCategoryAction — requireAdmin called before service", () => {
  it("AC-CATADM-19a: calls requireAdmin before saveCategory", async () => {
    const callOrder: string[] = [];
    mockRequireAdmin.mockImplementation(async () => { callOrder.push("requireAdmin"); });
    mockSaveCategory.mockImplementation(async () => { callOrder.push("saveCategory"); return { ok: true, id: VALID_CAT_UUID }; });

    await saveCategoryAction(VALID_CATEGORY_INPUT);

    expect(callOrder).toEqual(["requireAdmin", "saveCategory"]);
  });

  it("AC-CATADM-07: non-admin — requireAdmin throws, saveCategory never called", async () => {
    mockRequireAdmin.mockRejectedValue(NOT_ADMIN_ERROR);

    await expect(saveCategoryAction(VALID_CATEGORY_INPUT)).rejects.toThrow();
    expect(mockSaveCategory).not.toHaveBeenCalled();
  });

  it("AC-CATADM-19b: revalidates public content on successful save", async () => {
    mockSaveCategory.mockResolvedValue({ ok: true, id: VALID_CAT_UUID });
    await saveCategoryAction(VALID_CATEGORY_INPUT);

    expect(mockRevalidate).toHaveBeenCalledOnce();
  });

  it("AC-CATADM-19c: does NOT revalidate when saveCategory returns a failure", async () => {
    mockSaveCategory.mockResolvedValue({ ok: false, error: "da-title-required" });
    await saveCategoryAction(VALID_CATEGORY_INPUT);

    expect(mockRevalidate).not.toHaveBeenCalled();
  });
});

describe("AC-CATADM-19: setCategoryStatusAction — requireAdmin gate", () => {
  it("AC-CATADM-19d: calls requireAdmin before setCategoryStatus", async () => {
    mockSetCategoryStatus.mockResolvedValue({ ok: true });
    await setCategoryStatusAction(VALID_CAT_UUID, "published");

    expect(mockRequireAdmin).toHaveBeenCalledOnce();
    expect(mockSetCategoryStatus).toHaveBeenCalledWith(VALID_CAT_UUID, "published");
  });

  it("AC-CATADM-19e: revalidates public content on success", async () => {
    mockSetCategoryStatus.mockResolvedValue({ ok: true });
    await setCategoryStatusAction(VALID_CAT_UUID, "draft");

    expect(mockRevalidate).toHaveBeenCalledOnce();
  });

  it("AC-CATADM-19f: does NOT revalidate when setCategoryStatus returns failure", async () => {
    mockSetCategoryStatus.mockResolvedValue({ ok: false, error: "not-found" });
    await setCategoryStatusAction(VALID_CAT_UUID, "published");

    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it("AC-CATADM-19g: non-admin — requireAdmin throws, setCategoryStatus never called", async () => {
    mockRequireAdmin.mockRejectedValue(NOT_ADMIN_ERROR);
    await expect(setCategoryStatusAction(VALID_CAT_UUID, "published")).rejects.toThrow();
    expect(mockSetCategoryStatus).not.toHaveBeenCalled();
  });
});

describe("AC-CATADM-19: reorderItemsAction — requireAdmin gate", () => {
  it("AC-CATADM-19h: calls requireAdmin before reorderItems", async () => {
    mockReorderItems.mockResolvedValue({ ok: true });
    await reorderItemsAction(VALID_CAT_UUID, [VALID_ITEM_UUID]);

    expect(mockRequireAdmin).toHaveBeenCalledOnce();
    expect(mockReorderItems).toHaveBeenCalledWith(VALID_CAT_UUID, [VALID_ITEM_UUID]);
  });

  it("AC-CATADM-19i: non-admin — requireAdmin throws, reorderItems never called", async () => {
    mockRequireAdmin.mockRejectedValue(NOT_ADMIN_ERROR);
    await expect(reorderItemsAction(VALID_CAT_UUID, [VALID_ITEM_UUID])).rejects.toThrow();
    expect(mockReorderItems).not.toHaveBeenCalled();
  });
});

// ── AC-CATADM-33: item actions — requireAdmin gate ────────────────────────────

describe("AC-CATADM-33: saveItemAction — requireAdmin gate", () => {
  it("AC-CATADM-33a: calls requireAdmin before saveItem", async () => {
    const callOrder: string[] = [];
    mockRequireAdmin.mockImplementation(async () => { callOrder.push("requireAdmin"); });
    mockSaveItem.mockImplementation(async () => { callOrder.push("saveItem"); return { ok: true, id: VALID_ITEM_UUID }; });

    await saveItemAction(VALID_ITEM_INPUT);

    expect(callOrder).toEqual(["requireAdmin", "saveItem"]);
  });

  it("AC-CATADM-33b: revalidates public content on successful save", async () => {
    mockSaveItem.mockResolvedValue({ ok: true, id: VALID_ITEM_UUID });
    await saveItemAction(VALID_ITEM_INPUT);

    expect(mockRevalidate).toHaveBeenCalledOnce();
  });

  it("AC-CATADM-33c: does NOT revalidate when saveItem returns a failure", async () => {
    mockSaveItem.mockResolvedValue({ ok: false, error: "da-title-required" });
    await saveItemAction(VALID_ITEM_INPUT);

    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it("AC-CATADM-33d: non-admin — requireAdmin throws, saveItem never called", async () => {
    mockRequireAdmin.mockRejectedValue(NOT_ADMIN_ERROR);
    await expect(saveItemAction(VALID_ITEM_INPUT)).rejects.toThrow();
    expect(mockSaveItem).not.toHaveBeenCalled();
  });
});

describe("AC-CATADM-33: setItemStatusAction — requireAdmin gate", () => {
  it("AC-CATADM-33e: calls requireAdmin before setItemStatus", async () => {
    mockSetItemStatus.mockResolvedValue({ ok: true });
    await setItemStatusAction(VALID_ITEM_UUID, "published");

    expect(mockRequireAdmin).toHaveBeenCalledOnce();
    expect(mockSetItemStatus).toHaveBeenCalledWith(VALID_ITEM_UUID, "published");
  });

  it("AC-CATADM-33f: revalidates on success", async () => {
    mockSetItemStatus.mockResolvedValue({ ok: true });
    await setItemStatusAction(VALID_ITEM_UUID, "draft");

    expect(mockRevalidate).toHaveBeenCalledOnce();
  });

  it("AC-CATADM-33g: does NOT revalidate when setItemStatus returns failure", async () => {
    mockSetItemStatus.mockResolvedValue({ ok: false, error: "not-found" });
    await setItemStatusAction(VALID_ITEM_UUID, "published");

    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it("AC-CATADM-33h: non-admin — requireAdmin throws, setItemStatus never called", async () => {
    mockRequireAdmin.mockRejectedValue(NOT_ADMIN_ERROR);
    await expect(setItemStatusAction(VALID_ITEM_UUID, "published")).rejects.toThrow();
    expect(mockSetItemStatus).not.toHaveBeenCalled();
  });
});

describe("AC-CATADM-31/33: deleteItemAction — requireAdmin gate", () => {
  it("AC-CATADM-33i: calls requireAdmin before deleteItem", async () => {
    mockDeleteItem.mockResolvedValue({ ok: true });
    await deleteItemAction(VALID_ITEM_UUID);

    expect(mockRequireAdmin).toHaveBeenCalledOnce();
    expect(mockDeleteItem).toHaveBeenCalledWith(VALID_ITEM_UUID);
  });

  it("AC-CATADM-33j: revalidates on successful delete", async () => {
    mockDeleteItem.mockResolvedValue({ ok: true });
    await deleteItemAction(VALID_ITEM_UUID);

    expect(mockRevalidate).toHaveBeenCalledOnce();
  });

  it("AC-CATADM-33k: does NOT revalidate when deleteItem returns failure", async () => {
    mockDeleteItem.mockResolvedValue({ ok: false, error: "not-found" });
    await deleteItemAction(VALID_ITEM_UUID);

    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it("AC-CATADM-33l: non-admin — requireAdmin throws, deleteItem never called", async () => {
    mockRequireAdmin.mockRejectedValue(NOT_ADMIN_ERROR);
    await expect(deleteItemAction(VALID_ITEM_UUID)).rejects.toThrow();
    expect(mockDeleteItem).not.toHaveBeenCalled();
  });
});

// ── AC-CATADM-50: media actions — requireAdmin gate ───────────────────────────

describe("AC-CATADM-50: createMediaUploadAction — requireAdmin gate", () => {
  it("AC-CATADM-50a: calls requireAdmin before createMediaUpload", async () => {
    mockCreateMediaUpload.mockResolvedValue({
      ok: true,
      path: `items/${VALID_ITEM_UUID}/${VALID_MEDIA_UUID}.webp`,
      token: "tok",
      signedUrl: "https://example.supabase.co/upload",
    });
    await createMediaUploadAction({ itemId: VALID_ITEM_UUID, mimeType: "image/webp", size: 1024 });

    expect(mockRequireAdmin).toHaveBeenCalledOnce();
    expect(mockCreateMediaUpload).toHaveBeenCalledWith({ itemId: VALID_ITEM_UUID, mimeType: "image/webp", size: 1024 });
  });

  it("AC-CATADM-50b: non-admin — requireAdmin throws, createMediaUpload never called", async () => {
    mockRequireAdmin.mockRejectedValue(NOT_ADMIN_ERROR);
    await expect(
      createMediaUploadAction({ itemId: VALID_ITEM_UUID, mimeType: "image/webp", size: 1024 }),
    ).rejects.toThrow();
    expect(mockCreateMediaUpload).not.toHaveBeenCalled();
    expect(mockRemoveOrphanMedia).not.toHaveBeenCalled();
  });

  it("AC-CATADM-50c: forwards the service result unchanged", async () => {
    const result = { ok: false as const, error: "too-many-media" as const };
    mockCreateMediaUpload.mockResolvedValue(result);
    const ret = await createMediaUploadAction({ itemId: VALID_ITEM_UUID, mimeType: "image/webp", size: 1024 });
    expect(ret).toEqual(result);
  });
});

// ── F23-SEC-L1: orphan sweep before every upload URL ─────────────────────────

describe("F23-SEC-L1: createMediaUploadAction sweeps orphan media best-effort before minting", () => {
  const input = { itemId: VALID_ITEM_UUID, mimeType: "image/webp", size: 1024 };
  const minted = {
    ok: true as const,
    path: `items/${VALID_ITEM_UUID}/${VALID_MEDIA_UUID}.webp`,
    token: "tok",
    signedUrl: "https://example.supabase.co/upload",
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("F23-SEC-L1a: calls removeOrphanMedia once, after requireAdmin and before createMediaUpload", async () => {
    mockRemoveOrphanMedia.mockResolvedValue({ ok: true, removed: 3 });
    mockCreateMediaUpload.mockResolvedValue(minted);

    expect(await createMediaUploadAction(input)).toEqual(minted);

    expect(mockRemoveOrphanMedia).toHaveBeenCalledExactlyOnceWith();
    const [admin] = mockRequireAdmin.mock.invocationCallOrder;
    const [sweep] = mockRemoveOrphanMedia.mock.invocationCallOrder;
    const [mint] = mockCreateMediaUpload.mock.invocationCallOrder;
    expect(admin!).toBeLessThan(sweep!);
    expect(sweep!).toBeLessThan(mint!);
  });

  it("F23-SEC-L1b: a sweep that returns a failure does not fail the upload", async () => {
    mockRemoveOrphanMedia.mockResolvedValue({ ok: false, error: "failed" });
    mockCreateMediaUpload.mockResolvedValue(minted);

    expect(await createMediaUploadAction(input)).toEqual(minted);
    expect(mockCreateMediaUpload).toHaveBeenCalledExactlyOnceWith(input);
  });

  it("F23-SEC-L1c: a sweep that throws does not fail the upload; the error is logged by name only", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockRemoveOrphanMedia.mockRejectedValue(new TypeError("fetch failed: secret-bearing detail"));
    mockCreateMediaUpload.mockResolvedValue(minted);

    expect(await createMediaUploadAction(input)).toEqual(minted);
    expect(mockCreateMediaUpload).toHaveBeenCalledExactlyOnceWith(input);
    expect(consoleError).toHaveBeenCalledExactlyOnceWith("orphan media sweep failed: TypeError");
  });
});

describe("AC-CATADM-50: attachMediaAction — requireAdmin gate", () => {
  it("AC-CATADM-50d: calls requireAdmin before attachMedia", async () => {
    mockAttachMedia.mockResolvedValue({ ok: true, id: VALID_MEDIA_UUID });
    await attachMediaAction(VALID_ATTACH_INPUT);

    expect(mockRequireAdmin).toHaveBeenCalledOnce();
    expect(mockAttachMedia).toHaveBeenCalledWith(VALID_ATTACH_INPUT);
  });

  it("AC-CATADM-50e: non-admin — requireAdmin throws, attachMedia never called", async () => {
    mockRequireAdmin.mockRejectedValue(NOT_ADMIN_ERROR);
    await expect(attachMediaAction(VALID_ATTACH_INPUT)).rejects.toThrow();
    expect(mockAttachMedia).not.toHaveBeenCalled();
  });
});

describe("AC-CATADM-48: detachMediaAction — requireAdmin gate", () => {
  it("AC-CATADM-48a: calls requireAdmin before detachMedia", async () => {
    mockDetachMedia.mockResolvedValue({ ok: true });
    await detachMediaAction(VALID_MEDIA_UUID);

    expect(mockRequireAdmin).toHaveBeenCalledOnce();
    expect(mockDetachMedia).toHaveBeenCalledWith(VALID_MEDIA_UUID);
  });

  it("AC-CATADM-48b: non-admin — requireAdmin throws, detachMedia never called", async () => {
    mockRequireAdmin.mockRejectedValue(NOT_ADMIN_ERROR);
    await expect(detachMediaAction(VALID_MEDIA_UUID)).rejects.toThrow();
    expect(mockDetachMedia).not.toHaveBeenCalled();
  });

  it("AC-CATADM-48c: does NOT revalidate on detach failure", async () => {
    mockDetachMedia.mockResolvedValue({ ok: false, error: "not-found" });
    await detachMediaAction(VALID_MEDIA_UUID);

    expect(mockRevalidate).not.toHaveBeenCalled();
  });
});
