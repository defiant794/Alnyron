import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { isConfirmType } from "@/app/auth/confirm/confirm-types";
import { ADMIN_LOGIN_PATH } from "@/config/admin";
import {
  AREA_CONFIG,
  AUTH_AREAS,
  canEnterArea,
  LOGIN_ERROR_LINK_INVALID,
  type AuthArea,
} from "@/config/auth-areas";
import { parseSiteEnv } from "@/config/env";
import { isMonitorHost, monitorSiteOrigin } from "@/config/monitor";
import { isMyLifeHost } from "@/config/mylife";
import { areaOfPath, safeNext } from "@/lib/safe-next";
import { createServerClient } from "@/lib/supabase/server";
import { lookupSessionUser, type SessionUser } from "@/services/auth/require-role";
import type { Database } from "@/types/database";

/** Areas with a host of their own: a link opened on that host is pinned to the area. */
type PinnedArea = Extract<AuthArea, "mylife" | "monitor">;

/**
 * Redirect no cache may keep: a successful one carries the new session
 * cookies, and every one answers a one-time token. The `@supabase/ssr`
 * no-cache headers cannot pass through the server client's cookie store, so
 * they are set here. A landing location is a path, resolved by the browser
 * against the host it asked: the session cookies are host-only, so the user
 * has to stay on that host (main, MyLife or Monitor), and `request.url` does
 * not reliably name it (`next dev` reports its own hostname). Only the
 * forward to the Monitor host is absolute, built from the site URL.
 */
function noStoreRedirect(location: string): NextResponse {
  return new NextResponse(null, {
    status: 307,
    headers: { Location: location, "Cache-Control": "private, no-store" },
  });
}

/**
 * Where a verified invite or reset link lands on the main host. `requested`
 * (already accepted by `safeNext`) is followed unless the user's role may not
 * enter its area: then the user lands on their own area's set-password page
 * instead (a `mylife_user` following a dashboard invite with
 * `next=/admin/set-password` goes to `/mylife/set-password`, an admin with a
 * MyLife link to `/admin/set-password`).
 * For a `monitor_user` that page is `/monitor/reset`, which the main host
 * redirects to the Monitor host, where this main-host session does not
 * exist: the reset ends on the Monitor login with the token spent. Such a
 * link is a reset asked on the main host (`/admin/forgot-password` and
 * `/mylife/forgot-password` there both send the Site URL link with
 * `next=/admin/set-password`) or a Monitor reset whose
 * `redirectTo` GoTrue dropped (its origin missing from the redirect
 * allow-list). The allow-list entry, a go-live prerequisite, prevents the
 * second; the first is a known limitation: a `monitor_user` resets on the
 * Monitor host's `/forgot-password` (`docs/runbooks/monitor-go-live.md`).
 * The owner, a user without a role and a session without claims keep
 * `requested`, whose page gate answers them. A profile outage keeps
 * `requested` too: the one-time token is spent, so the user should still get
 * their session, and that page's gate reports the outage.
 */
async function roleAwareLanding(
  supabase: SupabaseClient<Database>,
  requested: string,
): Promise<string> {
  const area = areaOfPath(requested);
  if (!area) return requested;

  let user: SessionUser | null;
  try {
    user = await lookupSessionUser(supabase, area);
  } catch (error) {
    console.error("/auth/confirm role lookup failed", error);
    return requested;
  }
  const role = user?.role ?? null;
  if (role === null || canEnterArea(area, role)) return requested;

  const ownArea = AUTH_AREAS.find((candidate) => canEnterArea(candidate, role));
  return ownArea ? AREA_CONFIG[ownArea].setPassword : requested;
}

/**
 * Landing point of the email links: invites and password resets
 * (`<origin>/auth/confirm?token_hash=...&type=invite|recovery&next=/admin/set-password`,
 * `next=/mylife/set-password` on the MyLife host, `next=/monitor/reset` on
 * the Monitor host) and the Monitor signup confirmation
 * (`<Site URL>/auth/confirm?...&type=signup&next=/monitor/dashboard`).
 *
 * On a host that is neither MyLife nor Monitor (the main site), a link pinned
 * to Monitor (`type=signup`, or a `next` under `/monitor/`) is forwarded
 * first, unverified and with its whole query, to `/auth/confirm` on the
 * Monitor host derived from the site URL (a fixed origin, never the request's
 * Host, so no open redirect): the token is spent there and the session
 * cookies land on the host the user works on.
 *
 * `verifyOtp` exchanges the one-time token for a session (cookies set through
 * the server client, on the host the link points to).
 * - On the MyLife host only MyLife paths are served: a `next` under
 *   `/mylife/` is followed, anything else lands on `/mylife/set-password`,
 *   whose gate sends a user without MyLife access to `/mylife/no-access`.
 * - On the Monitor host only Monitor paths are served: a `next` under
 *   `/monitor/` is followed. Without one (a cross-area `next` included) a
 *   signup confirmation lands on the dashboard (the account already chose its
 *   password at signup; a role Monitor does not admit is answered by the
 *   dashboard's gate), an invite or reset on `/monitor/reset`.
 * - Otherwise `next` is followed when `safeNext` accepts it (same origin,
 *   under an area's prefix), corrected by role (`roleAwareLanding`); anything
 *   else, or no `next`, lands on the admin login page.
 * An invalid, expired or already used link lands on the login page of the
 * link's area (MyLife host: `/mylife/login`; Monitor host: `/monitor/login`;
 * else the area of `next`, falling back to `/admin/login`) with
 * `error=link_invalid`, which it explains. No redirect may be cached.
 */
export async function GET(request: NextRequest) {
  const { searchParams, search } = request.nextUrl;
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  const next = searchParams.get("next");
  const host = request.headers.get("host");
  const pinnedArea: PinnedArea | null = isMyLifeHost(host) ? "mylife" : isMonitorHost(host) ? "monitor" : null;

  if (pinnedArea === null && (type === "signup" || safeNext(next, "monitor") !== null)) {
    const monitorHost = monitorSiteOrigin(parseSiteEnv().NEXT_PUBLIC_SITE_URL);
    return noStoreRedirect(`${monitorHost}/auth/confirm${search}`);
  }

  const requested = safeNext(next, pinnedArea ?? undefined);
  if (tokenHash && isConfirmType(type)) {
    const supabase = await createServerClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) {
      // A pinned link without a usable `next`: a Monitor signup confirmation
      // lands on the dashboard, every other link on the area's set-password page.
      const target = pinnedArea
        ? (requested ??
          (pinnedArea === "monitor" && type === "signup"
            ? AREA_CONFIG.monitor.landing
            : AREA_CONFIG[pinnedArea].setPassword))
        : requested
          ? await roleAwareLanding(supabase, requested)
          : ADMIN_LOGIN_PATH;
      return noStoreRedirect(target);
    }
  }

  const linkArea = pinnedArea ?? (requested ? areaOfPath(requested) : null);
  const failure = new URLSearchParams({ error: LOGIN_ERROR_LINK_INVALID });
  return noStoreRedirect(`${AREA_CONFIG[linkArea ?? "admin"].login}?${failure}`);
}
