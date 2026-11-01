import "server-only";
import { createServerClient as createSsrServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { parseSupabasePublicEnv } from "@/config/env";
import type { Database } from "@/types/database";
import { AUTH_COOKIE_OPTIONS } from "./cookie-options";

/**
 * Supabase client bound to the signed-in user's session cookies, for admin
 * and MyLife pages, Server Actions and the `/auth/confirm` Route Handler
 * (architecture §6).
 *
 * It uses the publishable key, so every query runs under the user's own RLS
 * rights; no secret key exists in the app. Create one per request (it reads
 * that request's cookies). Server-side auth checks use `auth.getClaims()`,
 * which verifies the JWT, never `auth.getSession()`, which trusts the cookie.
 */
export async function createServerClient(): Promise<SupabaseClient<Database>> {
  const cookieStore = await cookies();
  const env = parseSupabasePublicEnv();

  return createSsrServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookieOptions: AUTH_COOKIE_OPTIONS,
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Server Components cannot write cookies. The middleware refreshes
            // the session on every admin and MyLife request, so nothing is lost here.
          }
          // The no-cache headers @supabase/ssr passes along with these cookies
          // cannot be set through a cookie store: a Route Handler that sets
          // session cookies marks its own response no-store (`/auth/confirm`).
        },
      },
    },
  );
}

