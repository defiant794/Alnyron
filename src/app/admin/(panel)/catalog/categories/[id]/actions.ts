"use server";

import { revalidatePublicContent } from "@/lib/revalidate";
import {
  reorderItems,
  saveCategory,
  setCategoryStatus,
  type CatalogActionResult,
  type CatalogSaveResult,
} from "@/services/admin/catalog";
import { requireAdmin } from "@/services/auth/require-admin";
import type { Database } from "@/types/database";

type ContentStatus = Database["public"]["Enums"]["content_status"];

/**
 * Save a section's DA/EN text from the section editor (see `saveCategory`).
 * Admins only; the public site is refreshed once the save went through.
 * `input` is validated by the service, never trusted.
 */
export async function saveCategoryAction(input: unknown): Promise<CatalogSaveResult> {
  await requireAdmin();
  const result = await saveCategory(input);
  if (result.ok) revalidatePublicContent();
  return result;
}

/** Show or hide a section (see `setCategoryStatus`). Admins only; refreshes the public site on success. */
export async function setCategoryStatusAction(
  categoryId: string,
  status: ContentStatus,
): Promise<CatalogActionResult> {
  await requireAdmin();
  const result = await setCategoryStatus(categoryId, status);
  if (result.ok) revalidatePublicContent();
  return result;
}

/**
 * Store a section's item order, first id first (see `reorderItems`). Admins
 * only; refreshes the public site on success.
 */
export async function reorderItemsAction(
  categoryId: string,
  itemIds: readonly string[],
): Promise<CatalogActionResult> {
  await requireAdmin();
  const result = await reorderItems(categoryId, itemIds);
  if (result.ok) revalidatePublicContent();
  return result;
}
