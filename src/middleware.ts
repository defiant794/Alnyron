import createMiddleware from "next-intl/middleware";
import { NextResponse, type NextRequest } from "next/server";
import { routing } from "@/i18n/routing";

const handleI18n = createMiddleware(routing);

/**
 * Public routes go through next-intl (locale prefix handling, `/da/*` ->
 * unprefixed redirect, localized pathname rewrites). With `localeCookie:
 * false` and `localeDetection: false` that branch sets no cookies.
 * Admin/auth routes live outside `[locale]`, so they pass through untouched;
 * their Supabase session refresh arrives with auth (F1.1), which keeps cookie
 * logic off public pages.
 */
export default function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname === "/admin" || pathname.startsWith("/admin/") || pathname.startsWith("/auth/")) {
    return NextResponse.next();
  }

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
