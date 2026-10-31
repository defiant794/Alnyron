import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_LOGIN_PATH, ADMIN_PUBLIC_PATHS } from "@/config/admin";
import { parseSupabasePublicEnv } from "@/config/env";
import { safeNext } from "@/lib/safe-next";
import { AUTH_COOKIE_OPTIONS } from "./cookie-options";

/** Headers `@supabase/ssr` sets with refreshed auth cookies so no cache stores them. */
const CACHE_HEADERS = ["cache-control", "expires", "pragma"] as const;

function isProtectedAdminPath(pathname: string): boolean {
  const isAdmin = pathname === "/admin" || pathname.startsWith("/admin/");
  return isAdmin && !ADMIN_PUBLIC_PATHS.has(pathname);
}

/**
 * Redirect to the login page, carrying everything the session refresh put on
 * `refreshed`: new or cleared auth cookies and the no-cache headers. Dropping
 * them would leave the browser with a stale session (or let a cache keep it).
 * The original admin path goes along as `next` when the guard accepts it.
 */
function redirectToLogin(request: NextRequest, refreshed: NextResponse): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = ADMIN_LOGIN_PATH;
  url.search = "";
  const next = safeNext(`${request.nextUrl.pathname}${request.nextUrl.search}`);
  if (next) url.searchParams.set("next", next);

  const redirect = NextResponse.redirect(url);
  for (const cookie of refreshed.cookies.getAll()) redirect.cookies.set(cookie);
  for (const name of CACHE_HEADERS) {
    const value = refreshed.headers.get(name);
    if (value !== null) redirect.headers.set(name, value);
  }
  return redirect;
}

/**
 * Supabase SSR session handling for `/admin/*` and `/auth/*` (architecture §6,
 * route protection layer 1). Public `[locale]` routes never reach this, so
 * they stay cookie-free and cacheable.
 *
 * `getClaims()` verifies the access token and refreshes an expired session;
 * refreshed cookies go onto the request (for Server Components rendering
 * this request) and onto the response (for the browser). Without claims,
 * every admin route except login and forgot-password redirects (307) to the
 * login page. The role check is not done here: `requireAdmin()` does it.
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  const env = parseSupabasePublicEnv();
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookieOptions: AUTH_COOKIE_OPTIONS,
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(cookiesToSet, headers) {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
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

  if (!data?.claims && isProtectedAdminPath(request.nextUrl.pathname)) {
    return redirectToLogin(request, response);
  }
  return response;
}
