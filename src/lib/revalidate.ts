import { revalidatePath } from "next/cache";

/**
 * Refreshes every public page's ISR cache after an admin change, so published
 * content shows at once instead of after the hourly refresh. The `[locale]`
 * layout holds the header nav and footer, so revalidating the root layout
 * covers every page in both locales (and the nav built from page flags).
 *
 * Call it only after a mutation succeeded: a failed write changes nothing.
 */
export function revalidatePublicContent(): void {
  revalidatePath("/", "layout");
}
