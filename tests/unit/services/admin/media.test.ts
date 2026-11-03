/**
 * Unit tests — admin media service (F2.1 catalog-model)
 * Journey: catalog-model  AC-CAT-81, AC-CAT-89, AC-CAT-90, AC-CAT-91, AC-CAT-92;
 * security hardening (f21-security-1 L2) AC-CAT-S10, AC-CAT-S11, AC-CAT-S12;
 * code review 5 (R5-1) AC-CAT-S17
 *
 * Module: src/services/admin/media.ts
 *
 * Mocks: @/lib/supabase/server (createServerClient)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockRpc = vi.fn();
const mockStorageRemove = vi.fn();
const mockCreateSignedUploadUrl = vi.fn();
const mockStorageFrom = vi.fn(() => ({
  remove: mockStorageRemove,
  createSignedUploadUrl: mockCreateSignedUploadUrl,
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: vi.fn(async () => ({
    rpc: mockRpc,
    storage: { from: mockStorageFrom },
  })),
}));

// ── Module under test ─────────────────────────────────────────────────────────

import { createMediaUpload, attachMedia, detachMedia, removeOrphanMedia } from "@/services/admin/media";

// ── Fixtures ──────────────────────────────────────────────────────────────────

// RFC 4122-compliant v4 UUIDs (version nibble '4', variant nibble '8'-'b').
const VALID_ITEM_UUID = "550e8400-e29b-41d4-a716-446655440001";
const VALID_MEDIA_UUID = "550e8400-e29b-41d4-a716-446655440002";
const VALID_FILE_UUID = "550e8400-e29b-41d4-a716-446655440003";
// Used only as a path segment to trigger mismatch; just needs hex UUID shape.
const DIFFERENT_ITEM_UUID = "99999999-9999-4999-8999-999999999999";

const VALID_PATH = `items/${VALID_ITEM_UUID}/${VALID_FILE_UUID}.webp`;

const VALID_ATTACH_INPUT = {
  itemId: VALID_ITEM_UUID,
  path: VALID_PATH,
  alt_da: "Alt text",
  alt_en: "",
  width: 800,
  height: 600,
};

beforeEach(() => {
  vi.clearAllMocks();
  // Defaults (implementations survive clearAllMocks): the slot pre-check passes and a
  // removal succeeds. Tests that need another outcome override them.
  mockRpc.mockResolvedValue({ data: null, error: null });
  mockStorageRemove.mockResolvedValue({ data: [], error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── AC-CAT-92: invalid input never calls storage or RPC ──────────────────────

describe("AC-CAT-92: invalid mediaUpload input never calls storage", () => {
  it("returns {ok:false, error:'unsupported-type'} for unsupported MIME type", async () => {
    const result = await createMediaUpload({ itemId: VALID_ITEM_UUID, mimeType: "image/gif", size: 1024 });
    expect(result).toEqual({ ok: false, error: "unsupported-type" });
    expect(mockStorageFrom).not.toHaveBeenCalled();
  });

  it("returns {ok:false, error:'too-large'} for size > 5242880", async () => {
    const result = await createMediaUpload({ itemId: VALID_ITEM_UUID, mimeType: "image/webp", size: 5242881 });
    expect(result).toEqual({ ok: false, error: "too-large" });
    expect(mockStorageFrom).not.toHaveBeenCalled();
  });

  it("returns {ok:false, error:'invalid'} for invalid itemId UUID", async () => {
    const result = await createMediaUpload({ itemId: "not-a-uuid", mimeType: "image/webp", size: 1024 });
    expect(result.ok).toBe(false);
    expect(mockStorageFrom).not.toHaveBeenCalled();
  });

  it("returns error for size = 0", async () => {
    const result = await createMediaUpload({ itemId: VALID_ITEM_UUID, mimeType: "image/png", size: 0 });
    expect(result.ok).toBe(false);
    expect(mockStorageFrom).not.toHaveBeenCalled();
  });
});

describe("AC-CAT-92: invalid attachMedia input never calls RPC", () => {
  it("returns {ok:false, error:'invalid'} for bad path format", async () => {
    const result = await attachMedia({ ...VALID_ATTACH_INPUT, path: "other/path.webp" });
    expect(result.ok).toBe(false);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("returns error when path item segment does not match itemId", async () => {
    const result = await attachMedia({ ...VALID_ATTACH_INPUT, path: `items/${DIFFERENT_ITEM_UUID}/${VALID_FILE_UUID}.webp` });
    expect(result.ok).toBe(false);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("returns error for blank alt_da", async () => {
    const result = await attachMedia({ ...VALID_ATTACH_INPUT, alt_da: "" });
    expect(result.ok).toBe(false);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

// ── AC-CAT-89: createMediaUpload builds path and calls createSignedUploadUrl ──

describe("AC-CAT-89: createMediaUpload builds path and calls createSignedUploadUrl", () => {
  it("builds a path matching items/{itemId}/{uuid}.ext and calls createSignedUploadUrl", async () => {
    mockCreateSignedUploadUrl.mockResolvedValue({
      data: { path: VALID_PATH, token: "tok", signedUrl: "https://example.com/upload" },
      error: null,
    });

    const result = await createMediaUpload({ itemId: VALID_ITEM_UUID, mimeType: "image/webp", size: 1024 });

    expect(mockStorageFrom).toHaveBeenCalledWith("media");
    expect(mockCreateSignedUploadUrl).toHaveBeenCalledTimes(1);

    const [calledPath] = mockCreateSignedUploadUrl.mock.calls[0]!;
    // Path must match: items/{itemId}/{uuid}.webp
    expect(calledPath).toMatch(
      new RegExp(`^items/${VALID_ITEM_UUID}/[0-9a-f-]{36}\\.webp$`),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toMatch(/^items\//);
      expect(result.token).toBe("tok");
      expect(result.signedUrl).toBe("https://example.com/upload");
    }
  });

  it("derives ext=jpeg for image/jpeg", async () => {
    mockCreateSignedUploadUrl.mockResolvedValue({
      data: { path: "items/x/y.jpg", token: "tok", signedUrl: "https://x" },
      error: null,
    });

    await createMediaUpload({ itemId: VALID_ITEM_UUID, mimeType: "image/jpeg", size: 1024 });

    const [calledPath] = mockCreateSignedUploadUrl.mock.calls[0]!;
    expect(calledPath).toMatch(/\.jpe?g$/);
  });

  it("derives ext=png for image/png", async () => {
    mockCreateSignedUploadUrl.mockResolvedValue({
      data: { path: "items/x/y.png", token: "tok", signedUrl: "https://x" },
      error: null,
    });

    await createMediaUpload({ itemId: VALID_ITEM_UUID, mimeType: "image/png", size: 1024 });

    const [calledPath] = mockCreateSignedUploadUrl.mock.calls[0]!;
    expect(calledPath).toMatch(/\.png$/);
  });

  it("returns {ok:false, error:'forbidden'} when storage returns a 403/RLS error", async () => {
    mockCreateSignedUploadUrl.mockResolvedValue({
      data: null,
      error: { status: 403, message: "RLS policy violation" },
    });

    const result = await createMediaUpload({ itemId: VALID_ITEM_UUID, mimeType: "image/webp", size: 1024 });

    expect(result).toEqual({ ok: false, error: "forbidden" });
  });

  it("returns {ok:false, error:'forbidden'} for the Storage API's RLS refusal shape (HTTP 400, statusCode '403')", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockCreateSignedUploadUrl.mockResolvedValue({
      data: null,
      error: { name: "StorageApiError", status: 400, statusCode: "403", message: "new row violates row-level security policy" },
    });

    const result = await createMediaUpload({ itemId: VALID_ITEM_UUID, mimeType: "image/webp", size: 1024 });

    expect(result).toEqual({ ok: false, error: "forbidden" });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("returns {ok:false, error:'failed'} for any other storage error and logs only its status code", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockCreateSignedUploadUrl.mockResolvedValue({
      data: null,
      error: { name: "StorageApiError", status: 500, statusCode: "500", message: `internal error for items/${VALID_ITEM_UUID}` },
    });

    const result = await createMediaUpload({ itemId: VALID_ITEM_UUID, mimeType: "image/webp", size: 1024 });

    expect(result).toEqual({ ok: false, error: "failed" });
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith("createSignedUploadUrl failed: 500");
  });
});

// ── AC-CAT-90: attachMedia calls admin_attach_media ───────────────────────────

describe("AC-CAT-90: attachMedia calls admin_attach_media RPC", () => {
  it("calls admin_attach_media with correct args and returns {ok:true, id}", async () => {
    mockRpc.mockResolvedValue({ data: VALID_MEDIA_UUID, error: null });

    const result = await attachMedia(VALID_ATTACH_INPUT);

    expect(mockRpc).toHaveBeenCalledTimes(1);
    const [rpcName, rpcArgs] = mockRpc.mock.calls[0]!;
    expect(rpcName).toBe("admin_attach_media");
    expect(rpcArgs).toMatchObject({
      p_item_id: VALID_ITEM_UUID,
      p_path: VALID_PATH,
      p_alt_da: "Alt text",
      p_alt_en: "",
      p_width: 800,
      p_height: 600,
    });
    expect(result).toEqual({ ok: true, id: VALID_MEDIA_UUID });
  });

  it("returns {ok:false, error:'too-many-media'} when RPC returns P0001 too_many_media", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "too_many_media" } });

    const result = await attachMedia(VALID_ATTACH_INPUT);

    expect(result).toEqual({ ok: false, error: "too-many-media" });
  });

  it("returns {ok:false, error:'invalid'} when RPC returns 22023 (bad path)", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "22023", message: "invalid_media_path" } });

    const result = await attachMedia(VALID_ATTACH_INPUT);

    expect(result).toEqual({ ok: false, error: "invalid" });
  });

  it("returns {ok:false, error:'not-found'} when RPC returns P0002", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "P0002", message: "item_not_found" } });

    const result = await attachMedia(VALID_ATTACH_INPUT);

    expect(result).toEqual({ ok: false, error: "not-found" });
  });
});

// ── AC-CAT-91: detachMedia calls admin_detach_media + storage.remove ─────────

describe("AC-CAT-91: detachMedia calls admin_detach_media then storage.remove", () => {
  it("calls RPC and then storage.remove with the returned path", async () => {
    const storagePath = `items/${VALID_ITEM_UUID}/img.webp`;
    mockRpc.mockResolvedValue({ data: storagePath, error: null });
    mockStorageRemove.mockResolvedValue({ error: null });

    const result = await detachMedia(VALID_MEDIA_UUID);

    expect(mockRpc).toHaveBeenCalledWith("admin_detach_media", expect.objectContaining({ p_media_id: VALID_MEDIA_UUID }));
    expect(mockStorageFrom).toHaveBeenCalledWith("media");
    expect(mockStorageRemove).toHaveBeenCalledWith([storagePath]);
    expect(result).toEqual({ ok: true });
  });

  it("still returns {ok:true} when storage.remove fails", async () => {
    mockRpc.mockResolvedValue({ data: `items/${VALID_ITEM_UUID}/img.webp`, error: null });
    mockStorageRemove.mockResolvedValue({ error: { message: "storage error" } });

    const result = await detachMedia(VALID_MEDIA_UUID);

    expect(result).toEqual({ ok: true });
  });

  it("returns {ok:false, error:'not-found'} when RPC returns P0002", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "P0002", message: "media_not_found" } });

    const result = await detachMedia(VALID_MEDIA_UUID);

    expect(result).toEqual({ ok: false, error: "not-found" });
  });

  it("returns {ok:false, error:'invalid'} for non-UUID mediaId", async () => {
    const result = await detachMedia("not-a-uuid");

    expect(result.ok).toBe(false);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

// ── AC-CAT-S10: createMediaUpload checks the item's slot before signing ──────

describe("AC-CAT-S10: createMediaUpload runs admin_check_media_slot before createSignedUploadUrl", () => {
  const input = { itemId: VALID_ITEM_UUID, mimeType: "image/webp", size: 1024 };

  it("calls admin_check_media_slot with p_item_id, then signs", async () => {
    mockCreateSignedUploadUrl.mockResolvedValue({
      data: { path: VALID_PATH, token: "tok", signedUrl: "https://example.com/upload" },
      error: null,
    });

    const result = await createMediaUpload(input);

    expect(result.ok).toBe(true);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith("admin_check_media_slot", { p_item_id: VALID_ITEM_UUID });
    expect(mockCreateSignedUploadUrl).toHaveBeenCalledTimes(1);
    expect(mockRpc.mock.invocationCallOrder[0]!).toBeLessThan(mockCreateSignedUploadUrl.mock.invocationCallOrder[0]!);
  });

  const refusals = [
    { code: "P0001", message: "too_many_media", error: "too-many-media" },
    { code: "P0002", message: "item_not_found", error: "not-found" },
    { code: "42501", message: "forbidden", error: "forbidden" },
  ] as const;

  for (const refusal of refusals) {
    it(`returns ${refusal.error} for ${refusal.code} ${refusal.message} and never signs an upload URL`, async () => {
      mockRpc.mockResolvedValue({ data: null, error: { code: refusal.code, message: refusal.message } });

      const result = await createMediaUpload(input);

      expect(result).toEqual({ ok: false, error: refusal.error });
      expect(mockStorageFrom).not.toHaveBeenCalled();
      expect(mockCreateSignedUploadUrl).not.toHaveBeenCalled();
    });
  }
});

// ── AC-CAT-S11: attachMedia removes an upload the attach refused ─────────────

describe("AC-CAT-S11: attachMedia removes the uploaded object only when the attach refused it for good", () => {
  const removed = [
    { code: "P0001", message: "too_many_media", error: "too-many-media" },
    { code: "P0002", message: "item_not_found", error: "not-found" },
    { code: "22023", message: "media_type_mismatch", error: "invalid" },
    { code: "23514", message: 'new row for relation "media" violates check constraint "media_alt_da_length"', error: "invalid" },
  ] as const;

  for (const failure of removed) {
    it(`${failure.code} ${failure.message}: removes [path] from the media bucket and returns ${failure.error}`, async () => {
      mockRpc.mockResolvedValue({ data: null, error: { code: failure.code, message: failure.message } });

      const result = await attachMedia(VALID_ATTACH_INPUT);

      expect(result).toEqual({ ok: false, error: failure.error });
      expect(mockStorageFrom).toHaveBeenCalledWith("media");
      expect(mockStorageRemove).toHaveBeenCalledTimes(1);
      expect(mockStorageRemove).toHaveBeenCalledWith([VALID_PATH]);
    });
  }

  const kept = [
    { code: "23505", message: 'duplicate key value violates unique constraint "media_storage_path_key"', error: "invalid" },
    { code: "42501", message: "forbidden", error: "forbidden" },
    { code: "P0002", message: "media_not_stored", error: "not-found" },
    { code: "22023", message: "invalid_media_path", error: "invalid" },
    { code: "23503", message: "insert or update on table \"media\" violates foreign key constraint", error: "not-found" },
    { code: "08006", message: "connection failure", error: "failed" },
  ] as const;

  for (const failure of kept) {
    it(`${failure.code} ${failure.message}: keeps the object and returns ${failure.error}`, async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      mockRpc.mockResolvedValue({ data: null, error: { code: failure.code, message: failure.message } });

      const result = await attachMedia(VALID_ATTACH_INPUT);

      expect(result).toEqual({ ok: false, error: failure.error });
      expect(mockStorageFrom).not.toHaveBeenCalled();
      expect(mockStorageRemove).not.toHaveBeenCalled();
    });
  }

  it("does not remove anything after a successful attach", async () => {
    mockRpc.mockResolvedValue({ data: VALID_MEDIA_UUID, error: null });

    expect(await attachMedia(VALID_ATTACH_INPUT)).toEqual({ ok: true, id: VALID_MEDIA_UUID });
    expect(mockStorageRemove).not.toHaveBeenCalled();
  });

  it("a failed removal is only logged: the attach error is still returned", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockRpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "too_many_media" } });
    mockStorageRemove.mockResolvedValue({ data: null, error: { name: "StorageApiError", message: "storage error" } });

    const result = await attachMedia(VALID_ATTACH_INPUT);

    expect(result).toEqual({ ok: false, error: "too-many-media" });
    expect(mockStorageRemove).toHaveBeenCalledWith([VALID_PATH]);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith("media object removal failed (1 orphaned): StorageApiError");
  });

  it("an input that fails the schema reaches neither the RPC nor the bucket", async () => {
    const result = await attachMedia({ ...VALID_ATTACH_INPUT, alt_da: "a".repeat(301) });

    expect(result).toEqual({ ok: false, error: "invalid" });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockStorageFrom).not.toHaveBeenCalled();
  });
});

// ── AC-CAT-S17: re-attaching an attached path keeps its object ───────────────

describe("AC-CAT-S17: attachMedia keeps the object when admin_attach_media reports it already attached", () => {
  it("23505 media_storage_path_key (the RPC's own duplicate check) returns invalid and never removes the object", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockRpc.mockResolvedValue({ data: null, error: { code: "23505", message: "media_storage_path_key" } });

    const result = await attachMedia(VALID_ATTACH_INPUT);

    expect(result).toEqual({ ok: false, error: "invalid" });
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith("admin_attach_media", expect.objectContaining({ p_path: VALID_PATH }));
    expect(mockStorageFrom).not.toHaveBeenCalled();
    expect(mockStorageRemove).not.toHaveBeenCalled();
  });
});

// ── AC-CAT-S12: removeOrphanMedia removes unreferenced objects ───────────────

describe("AC-CAT-S12: removeOrphanMedia lists orphans via admin_list_orphan_media and removes them via the Storage API", () => {
  const orphans = [
    `items/${VALID_ITEM_UUID}/${VALID_FILE_UUID}.webp`,
    `items/${DIFFERENT_ITEM_UUID}/${VALID_MEDIA_UUID}.png`,
  ];

  it("removes the listed paths from the media bucket and returns how many were removed", async () => {
    mockRpc.mockResolvedValue({ data: orphans, error: null });
    mockStorageRemove.mockResolvedValue({ data: orphans.map((name) => ({ name })), error: null });

    const result = await removeOrphanMedia();

    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith("admin_list_orphan_media");
    expect(mockStorageFrom).toHaveBeenCalledWith("media");
    expect(mockStorageRemove).toHaveBeenCalledWith(orphans);
    expect(result).toEqual({ ok: true, removed: 2 });
  });

  it("counts only the objects the bucket reports as removed", async () => {
    mockRpc.mockResolvedValue({ data: orphans, error: null });
    mockStorageRemove.mockResolvedValue({ data: [{ name: orphans[0] }], error: null });

    expect(await removeOrphanMedia()).toEqual({ ok: true, removed: 1 });
  });

  it("returns removed 0 without a storage call when there are no orphans", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });

    expect(await removeOrphanMedia()).toEqual({ ok: true, removed: 0 });
    expect(mockStorageFrom).not.toHaveBeenCalled();
  });

  it("returns forbidden without a storage call when the RPC refuses (42501)", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "42501", message: "forbidden" } });

    expect(await removeOrphanMedia()).toEqual({ ok: false, error: "forbidden" });
    expect(mockStorageFrom).not.toHaveBeenCalled();
  });

  it("returns forbidden for the Storage API's RLS refusal (HTTP 400, statusCode '403') without logging", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockRpc.mockResolvedValue({ data: orphans, error: null });
    mockStorageRemove.mockResolvedValue({
      data: null,
      error: { name: "StorageApiError", status: 400, statusCode: "403", message: "row-level security" },
    });

    expect(await removeOrphanMedia()).toEqual({ ok: false, error: "forbidden" });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("returns failed for any other storage error and logs only its status code", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockRpc.mockResolvedValue({ data: orphans, error: null });
    mockStorageRemove.mockResolvedValue({
      data: null,
      error: { name: "StorageApiError", status: 500, statusCode: "500", message: `internal error for ${orphans[0]}` },
    });

    expect(await removeOrphanMedia()).toEqual({ ok: false, error: "failed" });
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith("orphan media removal failed: 500");
  });
});
