import createMiddleware from "next-intl/middleware";
import { NextResponse, type NextRequest } from "next/server";
import { isMyLifeHost, MYLIFE_HOME_PATH } from "@/config/mylife";
import { routing } from "@/i18n/routing";
import { areaOfPath } from "@/lib/safe-next";
import { updateSession } from "@/lib/supabase/middleware";

const handleI18n = createMiddleware(routing);

/**
 * Three branches that never mix (architecture §3), decided before next-intl
 * sees the request (so nothing here is ever sent to `/da/...`):
 * - The MyLife host serves only the `/mylife` route group: every path the
 *   middleware runs for is rewritten into it (`/` -> `/mylife`, `/login` ->
 *   `/mylife/login`, `/admin` -> `/mylife/admin`, a 404, so the admin panel
 *   is not reachable there). Paths already under `/mylife` are served as they
 *   are, and `/auth/*` passes through so the email links set their session
 *   cookies on the MyLife host. All of it goes through the session refresh.
 *   Paths the `matcher` below excludes (`/api/*`, `/_next/*`, `/_vercel/*`
 *   and any path with a dot, e.g. `/favicon.ico`) never reach the
 *   middleware, so they are not rewritten: they are served as on the main
 *   host.
 * - Admin, MyLife and auth routes on the main host (outside `[locale]`) go
 *   through the Supabase session refresh and the unauthenticated-area
 *   redirect, the only place cookies are set.
 * - Public routes go through next-intl only (locale-prefix rewrites
 *   (`/contact` -> `/da/contact`), `/da/*` -> unprefixed redirect). With
 *   `localeCookie: false` and `localeDetection: false` that branch sets no
 *   cookies, so public responses stay cacheable.
 */
export default async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isAuthRoute = pathname.startsWith("/auth/");

  if (isMyLifeHost(request.headers.get("host"))) {
    const servedAsIs = isAuthRoute || areaOfPath(pathname) === "mylife";
    const rewritePath = pathname === "/" ? MYLIFE_HOME_PATH : `${MYLIFE_HOME_PATH}${pathname}`;
    return updateSession(request, servedAsIs ? undefined : rewritePath);
  }
  if (isAuthRoute || areaOfPath(pathname)) return updateSession(request);

  const response = handleI18n(request);
  // next-intl redirects with 307. Without detection or a cookie every redirect
  // it issues depends on the URL alone (`/da/contact` -> `/contact`), so it is
  // a canonical-URL redirect: make it permanent (308) so crawlers drop the
  // duplicate URL.
  const location = response.headers.get("location");
  if (response.status === 307 && location) return NextResponse.redirect(location, 308);
  return response;
}

export const config = {
  // Skip API routes, Next internals and files with an extension (icons, assets).
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
