import { revalidatePath } from "next/cache";

/**
 * Asks Next to refresh every public page's ISR cache after an admin change.
 * The `[locale]` layout holds the header nav and footer, so revalidating the
 * root layout covers every page in both locales (and the nav built from page
 * flags). It takes effect on a Node server (`next start`, as in the e2e run);
 * on the Cloudflare Worker it is a no-op without a tag cache, so live pages
 * show published content only after the ~5-minute time-based refresh.
 *
 * Call it only after a mutation succeeded: a failed write changes nothing.
 */
export function revalidatePublicContent(): void {
  revalidatePath("/", "layout");
}
