"use server";

import { revalidatePublicContent } from "@/lib/revalidate";
import {
  saveNavOrder,
  savePageNav,
  savePageStatus,
  saveSystemPage,
  type PageActionResult,
  type PageStatus,
} from "@/services/admin/pages";
import { requireAdmin } from "@/services/auth/require-admin";

/**
 * Save a system page from the editor (see `saveSystemPage`): flags plus the
 * full DA and EN text. Admins only; the public site is refreshed once the
 * save went through. `input` is validated, never trusted.
 */
export async function savePage(input: unknown): Promise<PageActionResult> {
  await requireAdmin();
  const result = await saveSystemPage(input);
  if (result.ok) revalidatePublicContent();
  return result;
}

/**
 * Publish or unpublish a page (see `savePageStatus`). Admins only; refreshes
 * the public site on success. System pages are always published, so the DB
 * refuses `draft` for them (`system-always-published`).
 */
export async function setPageStatus(pageId: string, status: PageStatus): Promise<PageActionResult> {
  await requireAdmin();
  const result = await savePageStatus(pageId, status);
  if (result.ok) revalidatePublicContent();
  return result;
}

/**
 * Store a new nav order, first id first (see `saveNavOrder`). Admins only;
 * refreshes the public site on success.
 */
export async function reorderNav(pageIds: readonly string[]): Promise<PageActionResult> {
  await requireAdmin();
  const result = await saveNavOrder(pageIds);
  if (result.ok) revalidatePublicContent();
  return result;
}

/**
 * Show or hide a page in the public nav (see `savePageNav`): the Sider list's
 * switch for a page without an editor (Monitor). Admins only; refreshes the
 * public site on success. Both arguments are validated, never trusted.
 */
export async function setPageNav(pageId: string, show: boolean): Promise<PageActionResult> {
  await requireAdmin();
  const result = await savePageNav(pageId, show);
  if (result.ok) revalidatePublicContent();
  return result;
}
