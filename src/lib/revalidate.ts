import { revalidatePath } from "next/cache";

/**
 * Asks Next to refresh every public page's ISR cache after an admin change.
 * The `[locale]` layout holds the header nav and footer, so revalidating the
 * root layout covers every page in both locales (and the nav built from page
 * flags). On the Cloudflare Worker the D1 tag cache (open-next.config.ts)
 * records the revalidation, so every isolate serves fresh pages on the next
 * request; on a Node server (`next start`, as in the e2e run) it works
 * in-process.
 *
 * Call it only after a mutation succeeded: a failed write changes nothing.
 */
export function revalidatePublicContent(): void {
  revalidatePath("/", "layout");
}
