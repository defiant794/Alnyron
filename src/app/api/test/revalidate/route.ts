import { createHash, timingSafeEqual } from "node:crypto";
import { revalidatePath } from "next/cache";
import type { NextRequest } from "next/server";

/** Header carrying the shared secret (tests/e2e/fixtures/revalidate.ts sends it). */
const SECRET_HEADER = "x-revalidate-secret";

/** SHA-256 of `value`: equal-length buffers for `timingSafeEqual`, whatever the input length. */
const digest = (value: string) => createHash("sha256").update(value).digest();

/**
 * TEST ONLY: refreshes every public page's ISR cache so the e2e DB fixtures
 * see their rows on a production build (`next start`), where the pages are
 * served from the cache. Admin publishing will revalidate on demand itself
 * (F1.2); until then nothing else does.
 *
 * Inert unless `E2E_REVALIDATE_SECRET` is set in the server's environment:
 * without it, or with a missing or wrong `x-revalidate-secret` header, POST
 * answers an empty 404 and revalidates nothing. This gates the action, not
 * the route's visibility: other methods still get Next's default handling
 * (405 for GET and the rest, an automatic OPTIONS reply with
 * `Allow: OPTIONS, POST`). The deployed Worker never sets the variable (and
 * it must never go in `.env.local`, which OpenNext bundles), so in production
 * POST always 404s.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.E2E_REVALIDATE_SECRET;
  const provided = request.headers.get(SECRET_HEADER);
  if (!secret || provided === null || !timingSafeEqual(digest(provided), digest(secret))) {
    return new Response(null, { status: 404 });
  }

  // The `[locale]` layout holds the header nav and footer, so the root
  // layout path covers every page in both locales.
  revalidatePath("/", "layout");
  return Response.json({ revalidated: true });
}
