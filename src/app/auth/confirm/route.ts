import type { EmailOtpType, SupabaseClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_LOGIN_PATH } from "@/config/admin";
import {
  AREA_CONFIG,
  AUTH_AREAS,
  canEnterArea,
  LOGIN_ERROR_LINK_INVALID,
} from "@/config/auth-areas";
import { isMyLifeHost } from "@/config/mylife";
import { areaOfPath, safeNext } from "@/lib/safe-next";
import { createServerClient } from "@/lib/supabase/server";
import { lookupSessionUser, type SessionUser } from "@/services/auth/require-role";
import type { Database } from "@/types/database";

/** Link types the DA email templates send (`supabase/templates/*.html`). */
const CONFIRM_TYPES = ["invite", "recovery"] as const satisfies readonly EmailOtpType[];
type ConfirmType = (typeof CONFIRM_TYPES)[number];

const isConfirmType = (value: string | null): value is ConfirmType =>
  (CONFIRM_TYPES as readonly (string | null)[]).includes(value);

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
 * Where a verified link lands on the main host. `requested` (already accepted
 * by `safeNext`) is followed unless the user's role may not enter its area:
 * then the user lands on their own area's set-password page instead (a
 * `mylife_user` following a dashboard invite with `next=/admin/set-password`
 * goes to `/mylife/set-password`, an admin with a MyLife link to
 * `/admin/set-password`). The owner, a user without a role and a session
 * without claims keep `requested`, whose page gate answers them. A profile
 * outage keeps `requested` too: the one-time token is spent, so the user
 * should still get their session, and that page's gate reports the outage.
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
 * Landing point of the invite and password-reset emails:
 * `<origin>/auth/confirm?token_hash=...&type=invite|recovery&next=/admin/set-password`
 * (or `next=/mylife/set-password` on the MyLife host).
 *
 * `verifyOtp` exchanges the one-time token for a session (cookies set through
 * the server client, on the host the link points to).
 * - On the MyLife host only MyLife paths are served: a `next` under
 *   `/mylife/` is followed, anything else lands on `/mylife/set-password`,
 *   whose gate sends a user without MyLife access to `/mylife/no-access`.
 * - On the main host `next` is followed when `safeNext` accepts it (same
 *   origin, `/admin/...` or `/mylife/...`), corrected by role
 *   (`roleAwareLanding`); anything else, or no `next`, lands on the admin
 *   login page.
 * An invalid, expired or already used link lands on the login page of the
 * link's area (MyLife host or a `/mylife/` `next`: `/mylife/login`, else
 * `/admin/login`) with `error=link_invalid`, which it explains. No redirect
 * may be cached.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  const onMyLifeHost = isMyLifeHost(request.headers.get("host"));
  const requested = safeNext(searchParams.get("next"), onMyLifeHost ? "mylife" : undefined);

  if (tokenHash && isConfirmType(type)) {
    const supabase = await createServerClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) {
      const target = onMyLifeHost
        ? (requested ?? AREA_CONFIG.mylife.setPassword)
        : requested
          ? await roleAwareLanding(supabase, requested)
          : ADMIN_LOGIN_PATH;
      return noStoreRedirect(target);
    }
  }

  const linkArea = onMyLifeHost ? "mylife" : requested ? areaOfPath(requested) : null;
  const failure = new URLSearchParams({ error: LOGIN_ERROR_LINK_INVALID });
  return noStoreRedirect(`${AREA_CONFIG[linkArea ?? "admin"].login}?${failure}`);
}
