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
import { isMyLifeHost } from "@/config/mylife";
import { areaOfPath, safeNext } from "@/lib/safe-next";
import { createServerClient } from "@/lib/supabase/server";
import { lookupSessionUser, type SessionUser } from "@/services/auth/require-role";
import type { Database } from "@/types/database";

/** Areas a link can be pinned to, and where a verified pinned link lands without a usable `next`. */
const PINNED_LANDING = {
  // MyLife host: invites and resets set the password there.
  mylife: AREA_CONFIG.mylife.setPassword,
  // Monitor signup confirmation: the account already has its password.
  monitor: AREA_CONFIG.monitor.landing,
} as const satisfies Partial<Record<AuthArea, string>>;

type PinnedArea = keyof typeof PINNED_LANDING;

/**
 * Redirect no cache may keep: a successful one carries the new session
 * cookies, and every one answers a one-time token. The `@supabase/ssr`
 * no-cache headers cannot pass through the server client's cookie store, so
 * they are set here. The location is a path, resolved by the browser against
 * the host it asked: the session cookies are host-only, so the user has to
 * stay on that host (main or MyLife), and `request.url` does not reliably
 * name it (`next dev` reports its own hostname).
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
 * `next=/admin/set-password` goes to `/mylife/set-password`, a
 * `monitor_user`'s reset link, which carries the same `next`, to
 * `/monitor/reset`, an admin with a MyLife link to `/admin/set-password`).
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
 * or `next=/mylife/set-password` on the MyLife host) and the Monitor signup
 * confirmation (`...&type=signup&next=/monitor/dashboard`).
 *
 * `verifyOtp` exchanges the one-time token for a session (cookies set through
 * the server client, on the host the link points to).
 * - On the MyLife host only MyLife paths are served: a `next` under
 *   `/mylife/` is followed, anything else lands on `/mylife/set-password`,
 *   whose gate sends a user without MyLife access to `/mylife/no-access`.
 * - A signup confirmation comes only from Monitor's public signup, so it
 *   stays in Monitor: a `next` under `/monitor/` is followed, anything else
 *   (a cross-area `next` included) lands on the dashboard. The account
 *   already chose its password at signup, so it never needs the reset page;
 *   a role Monitor does not admit is answered by the dashboard's gate.
 * - Otherwise `next` is followed when `safeNext` accepts it (same origin,
 *   under an area's prefix), corrected by role (`roleAwareLanding`); anything
 *   else, or no `next`, lands on the admin login page.
 * An invalid, expired or already used link lands on the login page of the
 * link's area (MyLife host: `/mylife/login`; signup: `/monitor/login`; else
 * the area of `next`, falling back to `/admin/login`) with
 * `error=link_invalid`, which it explains. No redirect may be cached.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  const pinnedArea: PinnedArea | null = isMyLifeHost(request.headers.get("host"))
    ? "mylife"
    : type === "signup"
      ? "monitor"
      : null;
  const requested = safeNext(searchParams.get("next"), pinnedArea ?? undefined);

  if (tokenHash && isConfirmType(type)) {
    const supabase = await createServerClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) {
      const target = pinnedArea
        ? (requested ?? PINNED_LANDING[pinnedArea])
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
