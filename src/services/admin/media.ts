import type { PostgrestError } from "@supabase/supabase-js";
import { MEDIA_BUCKET, MEDIA_EXTENSION } from "@/config/catalog";
import { createServerClient } from "@/lib/supabase/server";
import { attachMediaSchema, mediaUploadSchema, uuidSchema } from "@/lib/validation/catalog";
import {
  failure,
  invalidInput,
  removeMediaObjects,
  type CatalogActionResult,
  type CatalogFailure,
  type CatalogSaveResult,
} from "@/services/admin/catalog";

/** A signed upload slot: the browser PUTs the file to `signedUrl` (with `token`), then calls {@link attachMedia} with `path`. */
export type MediaUploadResult = { ok: true; path: string; token: string; signedUrl: string } | CatalogFailure;

/** Result of an orphan cleanup: how many objects the bucket removed. */
export type OrphanCleanupResult = { ok: true; removed: number } | CatalogFailure;

/**
 * Issues a signed upload URL for one image of an item. Type and size are
 * checked first (`unsupported-type`, `too-large`; the bucket enforces both
 * again on the upload), then `admin_check_media_slot` confirms the item exists
 * and has room for another image: fewer than 8 images and fewer than 16
 * unattached objects in its bucket folder (`not-found`, `too-many-media`,
 * `forbidden`), so nothing is uploaded for an unknown or full item and
 * never-attached uploads cannot pile up. Only then is the object
 * name chosen, `items/{itemId}/{random uuid}.{ext}` (the only names the
 * bucket's insert policy accepts; no client text reaches the path), and
 * signed. The Storage API checks the admin insert policy when signing; a
 * refusal is `forbidden`.
 */
export async function createMediaUpload(input: unknown): Promise<MediaUploadResult> {
  const parsed = mediaUploadSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);

  const { itemId, mimeType } = parsed.data;
  const supabase = await createServerClient();
  const slot = await supabase.rpc("admin_check_media_slot", { p_item_id: itemId });
  if (slot.error) return failure("admin_check_media_slot", slot.error);

  const path = `items/${itemId.toLowerCase()}/${crypto.randomUUID()}.${MEDIA_EXTENSION[mimeType]}`;
  const { data, error } = await supabase.storage.from(MEDIA_BUCKET).createSignedUploadUrl(path);
  if (error) return storageFailure("createSignedUploadUrl", error);
  return { ok: true, path, token: data.token, signedUrl: data.signedUrl };
}

/**
 * Attaches an uploaded object to its item through `admin_attach_media`
 * (path in the item's folder, object present, its recorded content type, if
 * any, matching the extension, at most 8 images; the stored type is derived
 * from the extension). When the attach fails in a way that leaves the upload
 * unusable (see {@link isRejectedUpload}), the object is removed from the
 * bucket so it does not stay publicly fetchable; a failed removal is logged.
 */
export async function attachMedia(input: unknown): Promise<CatalogSaveResult> {
  const parsed = attachMediaSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);

  const { itemId, path, alt_da, alt_en, width, height } = parsed.data;
  const supabase = await createServerClient();
  const { data, error } = await supabase.rpc("admin_attach_media", {
    p_item_id: itemId,
    p_path: path,
    p_alt_da: alt_da,
    p_alt_en: alt_en,
    p_width: width,
    p_height: height,
  });
  if (!error) return { ok: true, id: data };

  if (isRejectedUpload(error)) await removeMediaObjects(supabase, [path]);
  return failure("admin_attach_media", error);
}

/**
 * True when `admin_attach_media` refused an upload that can never be attached
 * and that no row references: the item is full (P0001 `too_many_media`) or
 * gone (P0002 `item_not_found`), the object is not the image its name claims
 * (22023 `media_type_mismatch`), or a CHECK refused the row (23514). The RPC
 * checks, under the item lock and before the limit trigger and the CHECKs can
 * fire, whether a row already holds the path; that case comes back as 23505
 * `media_storage_path_key` (e.g. a double-submitted 8th image), so the
 * refusals above never name a referenced object. Every other failure keeps
 * the object: 23505 means a row already references the path, 42501 a caller
 * who may not remove it, P0002 `media_not_stored` that there is nothing to
 * remove, 22023 `invalid_media_path` a path outside the item's folder;
 * anything else is unexpected.
 */
function isRejectedUpload({ code, message }: Pick<PostgrestError, "code" | "message">): boolean {
  switch (code) {
    case "P0001":
    case "23514":
      return true;
    case "P0002":
      return message === "item_not_found";
    case "22023":
      return message === "media_type_mismatch";
    default:
      return false;
  }
}

/**
 * Detaches an image through `admin_detach_media`, then removes its object
 * from the bucket (a failed removal is logged, the detach still succeeded).
 */
export async function detachMedia(mediaId: unknown): Promise<CatalogActionResult> {
  const parsed = uuidSchema.safeParse(mediaId);
  if (!parsed.success) return { ok: false, error: "invalid" };

  const supabase = await createServerClient();
  const { data, error } = await supabase.rpc("admin_detach_media", { p_media_id: parsed.data });
  if (error) return failure("admin_detach_media", error);

  await removeMediaObjects(supabase, [data]);
  return { ok: true };
}

/**
 * Removes media-bucket objects that no image row references and that are
 * older than a day (uploads never attached, or objects whose removal failed
 * after a delete), through `admin_list_orphan_media` and the Storage API.
 * One call handles at most 1000 objects (the Storage API's limit for one
 * remove); call again until `removed` is 0. `createMediaUploadAction` runs it,
 * best-effort, before every new upload URL.
 */
export async function removeOrphanMedia(): Promise<OrphanCleanupResult> {
  const supabase = await createServerClient();
  const { data: paths, error } = await supabase.rpc("admin_list_orphan_media");
  if (error) return failure("admin_list_orphan_media", error);
  if (paths.length === 0) return { ok: true, removed: 0 };

  const removal = await supabase.storage.from(MEDIA_BUCKET).remove(paths);
  if (removal.error) return storageFailure("orphan media removal", removal.error);
  return { ok: true, removed: removal.data.length };
}

/**
 * Maps a Storage API error to a failure. An RLS refusal (HTTP 403, or the
 * Storage API's HTTP 400 carrying statusCode "403") is `forbidden`; anything
 * else is `failed`, logged by status code only.
 */
function storageFailure(
  operation: string,
  error: { status: number | undefined; statusCode: string | undefined },
): CatalogFailure {
  const refused = error.status === 403 || error.statusCode === "403";
  if (!refused) console.error(`${operation} failed: ${error.statusCode ?? error.status ?? "unknown"}`);
  return { ok: false, error: refused ? "forbidden" : "failed" };
}
