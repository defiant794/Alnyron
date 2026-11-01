import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { AREA_CONFIG, type AuthArea } from "@/config/auth-areas";
import { parseSupabasePublicEnv } from "@/config/env";
import { areaOfPath, safeNext } from "@/lib/safe-next";
import { AUTH_COOKIE_OPTIONS } from "./cookie-options";

/** Headers `@supabase/ssr` sets with refreshed auth cookies so no cache stores them. */
const CACHE_HEADERS = ["cache-control", "expires", "pragma"] as const;

/** The area whose login guards `pathname`, or null when it is served without a session. */
function protectedArea(pathname: string): AuthArea | null {
  const area = areaOfPath(pathname);
  return area && !AREA_CONFIG[area].publicPaths.has(pathname) ? area : null;
}

/**
 * Redirect to the area's login page on the same host, carrying everything the
 * session refresh put on `refreshed`: new or cleared auth cookies and the
 * no-cache headers. Dropping them would leave the browser with a stale
 * session (or let a cache keep it). The requested path goes along as `next`
 * when the guard accepts it for that area.
 */
function redirectToLogin(
  request: NextRequest,
  refreshed: NextResponse,
  area: AuthArea,
  pathname: string,
): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = AREA_CONFIG[area].login;
  url.search = "";
  const next = safeNext(`${pathname}${request.nextUrl.search}`, area);
  if (next) url.searchParams.set("next", next);

  const redirect = NextResponse.redirect(url);
  for (const cookie of refreshed.cookies.getAll()) redirect.cookies.set(cookie);
  for (const name of CACHE_HEADERS) {
    const value = refreshed.headers.get(name);
    if (value !== null) redirect.headers.set(name, value);
  }
  return redirect;
}

/** The request URL (same host, same query) with another path. */
function withPathname(request: NextRequest, pathname: string): URL {
  const url = new URL(request.nextUrl.href);
  url.pathname = pathname;
  return url;
}

/**
 * Supabase SSR session handling for `/admin/*`, `/mylife/*`, `/auth/*` and
 * every request on the MyLife host (architecture §6, route protection layer
 * 1). Public `[locale]` routes never reach this, so they stay cookie-free and
 * cacheable.
 *
 * `rewritePath` (MyLife host) serves the request from that path instead
 * (`mylife.alnyron.dk/login` -> `/mylife/login`); the browser keeps its URL.
 *
 * `getClaims()` verifies the access token and refreshes an expired session;
 * refreshed cookies go onto the request (for Server Components rendering
 * this request) and onto the response (for the browser), rewrite or not.
 * Without claims, every admin or MyLife route except its login and forgot
 * password pages redirects (307) to that area's login page. The role check is
 * not done here: `requireAdmin()` / `requireMyLife()` do it.
 */
export async function updateSession(
  request: NextRequest,
  rewritePath?: string,
): Promise<NextResponse> {
  const env = parseSupabasePublicEnv();
  const rewriteUrl = rewritePath === undefined ? null : withPathname(request, rewritePath);
  const pass = (): NextResponse =>
    rewriteUrl ? NextResponse.rewrite(rewriteUrl, { request }) : NextResponse.next({ request });
  let response = pass();

  const supabase = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookieOptions: AUTH_COOKIE_OPTIONS,
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(cookiesToSet, headers) {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          response = pass();
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
          for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
        },
      },
    },
  );

  // Nothing may run between creating the client and getClaims(): the refresh
  // has to land before any response is built from `response`.
  const { data } = await supabase.auth.getClaims();

  const pathname = rewritePath ?? request.nextUrl.pathname;
  const area = data?.claims ? null : protectedArea(pathname);
  if (area) return redirectToLogin(request, response, area, pathname);
  return response;
}
