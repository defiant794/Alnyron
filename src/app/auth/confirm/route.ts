import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_LOGIN_PATH, LOGIN_ERROR_LINK_INVALID } from "@/config/admin";
import { safeNext } from "@/lib/safe-next";
import { createServerClient } from "@/lib/supabase/server";

/** Link types the DA email templates send (`supabase/templates/*.html`). */
const CONFIRM_TYPES = ["invite", "recovery"] as const satisfies readonly EmailOtpType[];
type ConfirmType = (typeof CONFIRM_TYPES)[number];

const isConfirmType = (value: string | null): value is ConfirmType =>
  (CONFIRM_TYPES as readonly (string | null)[]).includes(value);

/**
 * Redirect no cache may keep: a successful one carries the new session
 * cookies, and every one answers a one-time token. The `@supabase/ssr`
 * no-cache headers cannot pass through the server client's cookie store, so
 * they are set here.
 */
function noStoreRedirect(url: URL): NextResponse {
  const response = NextResponse.redirect(url);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

/**
 * Landing point of the invite and password-reset emails:
 * `/auth/confirm?token_hash=...&type=invite|recovery&next=/admin/set-password`.
 *
 * `verifyOtp` exchanges the one-time token for a session (cookies set through
 * the server client). `next` is followed only when `safeNext` accepts it
 * (same-origin `/admin/...`); anything else, or no `next`, lands on the login
 * page. An invalid, expired or already used link lands on the login page with
 * `error=link_invalid`, which it explains. No redirect may be cached.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");

  if (tokenHash && isConfirmType(type)) {
    const supabase = await createServerClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) {
      const target = safeNext(searchParams.get("next")) ?? ADMIN_LOGIN_PATH;
      return noStoreRedirect(new URL(target, request.url));
    }
  }

  const failure = new URL(ADMIN_LOGIN_PATH, request.url);
  failure.searchParams.set("error", LOGIN_ERROR_LINK_INVALID);
  return noStoreRedirect(failure);
}
