import type { CookieOptionsWithName } from "@supabase/ssr";

/**
 * Auth-cookie attributes for every `@supabase/ssr` client (the server client
 * and the middleware); merged over the library defaults (`path: "/"`, 400-day
 * `maxAge`), whose `httpOnly: false` would expose the session to scripts.
 *
 * - `httpOnly`: the app has no browser Supabase client, so only the server
 *   reads the session; page scripts never see the tokens.
 * - `secure` in production (HTTPS only); `next dev` serves plain HTTP.
 * - `sameSite: "lax"`: sent on top-level navigation, e.g. the invite and
 *   recovery links from the e-mail, not on cross-site subrequests.
 */
export const AUTH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
} as const satisfies CookieOptionsWithName;
