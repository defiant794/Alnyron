import createMiddleware from "next-intl/middleware";
import { NextResponse, type NextRequest } from "next/server";
import { routing } from "@/i18n/routing";
import { updateSession } from "@/lib/supabase/middleware";

const handleI18n = createMiddleware(routing);

/**
 * Two branches that never mix (architecture §3):
 * - Admin/auth routes (outside `[locale]`) go through the Supabase session
 *   refresh and the unauthenticated-admin redirect, the only place cookies
 *   are set.
 * - Public routes go through next-intl only (locale prefix handling,
 *   `/da/*` -> unprefixed redirect, localized pathname rewrites). With
 *   `localeCookie: false` and `localeDetection: false` that branch sets no
 *   cookies, so public responses stay cacheable.
 */
export default async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isAuthRoute =
    pathname === "/admin" || pathname.startsWith("/admin/") || pathname.startsWith("/auth/");
  if (isAuthRoute) return updateSession(request);

  const response = handleI18n(request);
  // next-intl redirects with 307. Without detection or a cookie every redirect
  // it issues depends on the URL alone (`/da/kontakt` -> `/kontakt`,
  // `/contact` -> `/kontakt`), so it is a canonical-URL redirect: make it
  // permanent (308) so crawlers drop the duplicate URL.
  const location = response.headers.get("location");
  if (response.status === 307 && location) return NextResponse.redirect(location, 308);
  return response;
}

export const config = {
  // Skip API routes, Next internals and files with an extension (icons, assets).
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
