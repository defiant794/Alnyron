import type { Database } from "@/types/database";

type ContentStatus = Database["public"]["Enums"]["content_status"];

/**
 * How a catalog section shows on the public site (admin overview badge):
 * - `synlig`: published and holding at least one published item, so it is
 *   in the menu, on the home page and in the sitemap.
 * - `vises-ved-forste`: published, but it appears only once its first item is
 *   published (`private.category_is_public`).
 * - `skjult`: a draft section, hidden whatever its items are.
 */
export type CatalogVisibility = "synlig" | "vises-ved-forste" | "skjult";

/** The visibility badge of a section with `status` and `publishedItemCount` published items. */
export function catalogVisibilityBadge(status: ContentStatus, publishedItemCount: number): CatalogVisibility {
  if (status === "draft") return "skjult";
  return publishedItemCount > 0 ? "synlig" : "vises-ved-forste";
}
