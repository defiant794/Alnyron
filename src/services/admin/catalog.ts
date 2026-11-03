import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";
import { createServerClient } from "@/lib/supabase/server";
import {
  ALT_REQUIRED,
  categoryStatusSchema,
  DA_TITLE_REQUIRED,
  itemStatusSchema,
  LINKS_INVALID,
  PRICE_INVALID,
  reorderItemsSchema,
  saveCategorySchema,
  saveItemSchema,
  SLUG_INVALID,
  TOO_LARGE,
  TOO_MANY_MEDIA,
  UNSUPPORTED_TYPE,
  uuidSchema,
} from "@/lib/validation/catalog";
import type { Database } from "@/types/database";

/** The Storage bucket of catalog images (public; written only under the admin policies). */
export const MEDIA_BUCKET = "media";

/**
 * Why a catalog mutation failed (the admin UI maps each to copy):
 * - `invalid`: the input does not match the write schema, or the DB rejected its shape
 *   (e.g. an alt text over `MEDIA_ALT_MAX`, `media_alt_*_length`; a reorder over `ITEMS_REORDER_MAX`).
 * - `da-title-required`: blank Danish title (schema or a `*_da_title` CHECK).
 * - `slug-taken`: 23505, the slug already names another route or item.
 * - `slug-invalid`: the slug format or a reserved slug (`routes_slug_*`, item slug CHECK).
 * - `price-invalid`: price type/amount mismatch (`items_price_consistent`).
 * - `links-invalid`: an external link that is not an https URL under a known key.
 * - `alt-required`: blank Danish alt text (`media_alt_da_check`).
 * - `missing-slugs` / `missing-translations`: P0001, a category needs a DA and an EN slug,
 *   an item a DA and an EN translation, before it is published.
 * - `too-many-media`: the item already holds the maximum number of images (P0001
 *   `too_many_media`: the media trigger, the upload pre-check, or a save listing more).
 * - `too-large` / `unsupported-type`: an upload the media bucket would refuse.
 * - `not-found`: P0002 / 23503 / 22P02, the id names no row of that kind.
 * - `forbidden`: 42501, the caller is not an admin (RLS / `is_admin()`).
 * - `failed`: anything else (logged by code).
 */
export type CatalogActionError =
  | "invalid"
  | "da-title-required"
  | "slug-taken"
  | "slug-invalid"
  | "price-invalid"
  | "links-invalid"
  | "alt-required"
  | "missing-slugs"
  | "missing-translations"
  | "too-many-media"
  | "too-large"
  | "unsupported-type"
  | "not-found"
  | "forbidden"
  | "failed";

export type CatalogFailure = { ok: false; error: CatalogActionError };

/** Result of a status change, reorder or delete. */
export type CatalogActionResult = { ok: true } | CatalogFailure;

/** Result of a save or attach: the row's id. */
export type CatalogSaveResult = { ok: true; id: string } | CatalogFailure;

/** Schema issue messages that name a specific error (validation/catalog.ts); any other issue is `invalid`. */
const ISSUE_ERRORS = [
  DA_TITLE_REQUIRED,
  SLUG_INVALID,
  PRICE_INVALID,
  LINKS_INVALID,
  ALT_REQUIRED,
  TOO_MANY_MEDIA,
  TOO_LARGE,
  UNSUPPORTED_TYPE,
] as const satisfies readonly CatalogActionError[];

/**
 * Creates or updates a category with its translations and slugs through
 * `admin_save_category` (see {@link saveCategorySchema}). `input` is untrusted
 * (a Server Action argument) and never reaches the RPC unless it parses.
 */
export async function saveCategory(input: unknown): Promise<CatalogSaveResult> {
  const parsed = saveCategorySchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);

  const supabase = await createServerClient();
  const { data, error } = await supabase.rpc("admin_save_category", { payload: parsed.data });
  return error ? failure("admin_save_category", error) : { ok: true, id: data };
}

/** Publishes or unpublishes a category through `admin_set_category_status`. */
export async function setCategoryStatus(categoryId: unknown, status: unknown): Promise<CatalogActionResult> {
  const parsed = categoryStatusSchema.safeParse({ categoryId, status });
  if (!parsed.success) return { ok: false, error: "invalid" };

  const supabase = await createServerClient();
  const { error } = await supabase.rpc("admin_set_category_status", {
    p_category_id: parsed.data.categoryId,
    p_status: parsed.data.status,
  });
  return error ? failure("admin_set_category_status", error) : { ok: true };
}

/**
 * Creates or updates an item with its price, links, translations and image
 * texts through `admin_save_item` (see {@link saveItemSchema}).
 */
export async function saveItem(input: unknown): Promise<CatalogSaveResult> {
  const parsed = saveItemSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);

  const supabase = await createServerClient();
  const { data, error } = await supabase.rpc("admin_save_item", { payload: parsed.data });
  return error ? failure("admin_save_item", error) : { ok: true, id: data };
}

/** Publishes or unpublishes an item through `admin_set_item_status`. */
export async function setItemStatus(itemId: unknown, status: unknown): Promise<CatalogActionResult> {
  const parsed = itemStatusSchema.safeParse({ itemId, status });
  if (!parsed.success) return { ok: false, error: "invalid" };

  const supabase = await createServerClient();
  const { error } = await supabase.rpc("admin_set_item_status", {
    p_item_id: parsed.data.itemId,
    p_status: parsed.data.status,
  });
  return error ? failure("admin_set_item_status", error) : { ok: true };
}

/** Stores a category's item order through `admin_reorder_items` (first id = first place). */
export async function reorderItems(categoryId: unknown, itemIds: unknown): Promise<CatalogActionResult> {
  const parsed = reorderItemsSchema.safeParse({ categoryId, itemIds });
  if (!parsed.success) return { ok: false, error: "invalid" };

  const supabase = await createServerClient();
  const { error } = await supabase.rpc("admin_reorder_items", {
    p_category_id: parsed.data.categoryId,
    p_item_ids: parsed.data.itemIds,
  });
  return error ? failure("admin_reorder_items", error) : { ok: true };
}

/**
 * Deletes an item with its translations and image rows through
 * `admin_delete_item`, then removes the images from the bucket. The DB is the
 * source of truth: once the rows are gone the delete succeeded, and a failed
 * object removal is only logged (the objects are unreferenced).
 */
export async function deleteItem(itemId: unknown): Promise<CatalogActionResult> {
  const parsed = uuidSchema.safeParse(itemId);
  if (!parsed.success) return { ok: false, error: "invalid" };

  const supabase = await createServerClient();
  const { data, error } = await supabase.rpc("admin_delete_item", { p_item_id: parsed.data });
  if (error) return failure("admin_delete_item", error);

  await removeMediaObjects(supabase, data ?? []);
  return { ok: true };
}

/**
 * Removes objects from the media bucket that no row references: images whose
 * rows were deleted, or uploads an attach refused. A failure is logged, never
 * returned: the objects are orphans that no page references, and
 * `removeOrphanMedia` (media.ts) sweeps up what is left.
 */
export async function removeMediaObjects(supabase: SupabaseClient<Database>, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  const { error } = await supabase.storage.from(MEDIA_BUCKET).remove([...paths]);
  if (error) console.error(`media object removal failed (${paths.length} orphaned): ${error.name}`);
}

/** The error for an input that failed its schema: the first specific issue, else `invalid`. */
export function invalidInput(error: z.ZodError): CatalogFailure {
  for (const issue of error.issues) {
    const specific = ISSUE_ERRORS.find((code) => code === issue.message);
    if (specific) return { ok: false, error: specific };
  }
  return { ok: false, error: "invalid" };
}

/** Maps an RPC error to a failure result, logging (by code only) the unexpected ones. */
export function failure(operation: string, error: Pick<PostgrestError, "code" | "message">): CatalogFailure {
  const reason = catalogActionError(error);
  if (reason === "failed") console.error(`${operation} failed: ${error.code || "unknown"}`);
  return { ok: false, error: reason };
}

/**
 * Maps a catalog RPC error to a {@link CatalogActionError}. 23514 and P0001
 * have several sources, told apart by the message (constraint name or the
 * RPC's raise text).
 */
export function catalogActionError({ code, message }: Pick<PostgrestError, "code" | "message">): CatalogActionError {
  switch (code) {
    case "23505":
      return message.includes("media_storage_path_key") ? "invalid" : "slug-taken";
    case "23514":
      return checkViolationError(message);
    case "P0001":
      if (message === "missing_slugs") return "missing-slugs";
      if (message === "missing_translations") return "missing-translations";
      if (message === "too_many_media") return "too-many-media";
      return "failed";
    case "23503":
    case "P0002":
    case "22P02":
      return "not-found";
    case "22023":
      return "invalid";
    case "42501":
      return "forbidden";
    default:
      return "failed";
  }
}

/** 23514 by the violated constraint's name. */
function checkViolationError(message: string): CatalogActionError {
  if (message.includes("category_translations_da_title") || message.includes("item_translations_da_title")) {
    return "da-title-required";
  }
  if (
    message.includes("routes_slug_format") ||
    message.includes("routes_slug_reserved") ||
    message.includes("item_translations_slug_check")
  ) {
    return "slug-invalid";
  }
  if (message.includes("media_alt_da_check")) return "alt-required";
  if (message.includes("items_price_consistent")) return "price-invalid";
  if (message.includes("items_external_links_valid")) return "links-invalid";
  return "invalid";
}
