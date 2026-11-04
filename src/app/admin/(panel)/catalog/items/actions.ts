"use server";

import { revalidatePublicContent } from "@/lib/revalidate";
import {
  deleteItem,
  saveItem,
  setItemStatus,
  type CatalogActionResult,
  type CatalogSaveResult,
} from "@/services/admin/catalog";
import { requireAdmin } from "@/services/auth/require-admin";
import type { Database } from "@/types/database";

type ContentStatus = Database["public"]["Enums"]["content_status"];

/**
 * Create or update an item from the item editor (see `saveItem`). Admins
 * only; the public site is refreshed once the save went through. `input` is
 * validated by the service, never trusted.
 */
export async function saveItemAction(input: unknown): Promise<CatalogSaveResult> {
  await requireAdmin();
  const result = await saveItem(input);
  if (result.ok) revalidatePublicContent();
  return result;
}

/** Publish or hide an item (see `setItemStatus`). Admins only; refreshes the public site on success. */
export async function setItemStatusAction(itemId: string, status: ContentStatus): Promise<CatalogActionResult> {
  await requireAdmin();
  const result = await setItemStatus(itemId, status);
  if (result.ok) revalidatePublicContent();
  return result;
}

/**
 * Delete an item with its texts and images (see `deleteItem`). Admins only;
 * refreshes the public site on success.
 */
export async function deleteItemAction(itemId: string): Promise<CatalogActionResult> {
  await requireAdmin();
  const result = await deleteItem(itemId);
  if (result.ok) revalidatePublicContent();
  return result;
}
