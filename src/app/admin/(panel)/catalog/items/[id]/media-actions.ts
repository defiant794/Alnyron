"use server";

import { revalidatePublicContent } from "@/lib/revalidate";
import type { CatalogActionResult, CatalogSaveResult } from "@/services/admin/catalog";
import {
  attachMedia,
  createMediaUpload,
  detachMedia,
  removeOrphanMedia,
  type MediaUploadResult,
} from "@/services/admin/media";
import { requireAdmin } from "@/services/auth/require-admin";

/**
 * Mint a signed upload URL for one image of an item (see `createMediaUpload`),
 * under the admin's own session: no service-role key is involved, and the
 * Storage API checks the admin insert policy when signing. Nothing public
 * changes, so nothing is revalidated.
 *
 * Orphan uploads older than a day are swept first (see {@link sweepOrphanMedia}),
 * so they do not stay in the public bucket and an item whose folder reached
 * the unattached-object ceiling of `admin_check_media_slot` frees itself.
 */
export async function createMediaUploadAction(input: unknown): Promise<MediaUploadResult> {
  await requireAdmin();
  await sweepOrphanMedia();
  return createMediaUpload(input);
}

/**
 * Best-effort `removeOrphanMedia`: a failure never fails the upload.
 * `removeOrphanMedia` logs its own unexpected failures; a thrown error is
 * logged by name only.
 */
async function sweepOrphanMedia(): Promise<void> {
  try {
    await removeOrphanMedia();
  } catch (error) {
    console.error(`orphan media sweep failed: ${error instanceof Error ? error.name : "unknown"}`);
  }
}

/** Attach an uploaded object to its item (see `attachMedia`). Admins only; refreshes the public site on success. */
export async function attachMediaAction(input: unknown): Promise<CatalogSaveResult> {
  await requireAdmin();
  const result = await attachMedia(input);
  if (result.ok) revalidatePublicContent();
  return result;
}

/** Remove an image from its item and the bucket (see `detachMedia`). Admins only; refreshes the public site on success. */
export async function detachMediaAction(mediaId: string): Promise<CatalogActionResult> {
  await requireAdmin();
  const result = await detachMedia(mediaId);
  if (result.ok) revalidatePublicContent();
  return result;
}
