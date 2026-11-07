import type { SupabaseClient } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { cache } from "react";
import { AREA_CONFIG, canEnterArea, type AreaRole, type AuthArea } from "@/config/auth-areas";
import { createServerClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database";

type AppRole = Database["public"]["Enums"]["app_role"];

export interface AreaUser<A extends AuthArea> {
  userId: string;
  email: string;
  role: AreaRole<A>;
}

/**
 * Who is asking, from one area's point of view:
 * - `anonymous`: no valid session.
 * - `forbidden`: signed in, but `profiles.role` does not admit them (another
 *   area's role, null, or no profile row).
 * - `allowed`: may use the area.
 */
export type AreaAccess<A extends AuthArea> =
  | { status: "anonymous" }
  | { status: "forbidden"; email: string }
  | { status: "allowed"; user: AreaUser<A> };

/** The signed-in user and their `profiles.role` (null: no role, or no profile row). */
export interface SessionUser {
  userId: string;
  email: string;
  role: AppRole | null;
}

/** PostgREST code for `.single()` matching zero rows. */
const NO_ROWS = "PGRST116";

/**
 * Read the session's user and role with `supabase` (the caller's client, so
 * `/auth/confirm` can use the one that just verified the link). Returns null
 * without a valid session.
 *
 * `getClaims()` verifies the JWT. The role comes from `profiles` (RLS lets a
 * user read only their own row), never from the token, so revoking a role
 * takes effect on the next request (architecture §4). A profile query that
 * fails for any reason other than "no row" throws, naming `area`: an outage is
 * not a "no access" answer.
 */
export async function lookupSessionUser(
  supabase: SupabaseClient<Database>,
  area: AuthArea,
): Promise<SessionUser | null> {
  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims) return null;

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("role")
    .eq("user_id", claims.sub)
    .single();
  if (profileError && profileError.code !== NO_ROWS) {
    throw new Error(`${AREA_CONFIG[area].label} profile lookup failed: ${profileError.message}`);
  }

  return { userId: claims.sub, email: claims.email ?? "", role: profile?.role ?? null };
}

/**
 * Resolve the caller's access to `area` without redirecting (no-access pages
 * use it to send allowed users home). Cached per request.
 */
export const getAreaAccess = cache(async <A extends AuthArea>(area: A): Promise<AreaAccess<A>> => {
  const user = await lookupSessionUser(await createServerClient(), area);
  if (!user) return { status: "anonymous" };
  const { role } = user;
  if (!canEnterArea(area, role)) return { status: "forbidden", email: user.email };
  return { status: "allowed", user: { userId: user.userId, email: user.email, role } };
});

/**
 * Data-access guard (architecture §6, route protection layer 2): call at the
 * top of EVERY page and EVERY Server Action of the area; layouts are not an
 * auth boundary. No session redirects to the area's login page, a role the
 * area does not admit to its no-access page. RLS (layer 3) still applies on
 * its own. Cached per request, so page + layout cost one lookup.
 */
export const requireArea = cache(async <A extends AuthArea>(area: A): Promise<AreaUser<A>> => {
  const access = await getAreaAccess(area);
  if (access.status === "anonymous") redirect(AREA_CONFIG[area].login);
  if (access.status === "forbidden") redirect(AREA_CONFIG[area].noAccess);
  return access.user;
});

export type MyLifeUser = AreaUser<"mylife">;
export type MyLifeAccess = AreaAccess<"mylife">;

/** `getAreaAccess("mylife")`: the owner and `mylife_user` are allowed. */
export function getMyLifeAccess(): Promise<MyLifeAccess> {
  return getAreaAccess("mylife");
}

/** `requireArea("mylife")`: the guard for every MyLife panel page and Server Action. */
export function requireMyLife(): Promise<MyLifeUser> {
  return requireArea("mylife");
}

export type MonitorUser = AreaUser<"monitor">;
export type MonitorAccess = AreaAccess<"monitor">;

/** `getAreaAccess("monitor")`: the owner and `monitor_user` are allowed. */
export function getMonitorAccess(): Promise<MonitorAccess> {
  return getAreaAccess("monitor");
}

/**
 * `requireArea("monitor")`: the guard for every Monitor panel page and Server
 * Action, and the source of the user id the monitors service writes with.
 */
export function requireMonitor(): Promise<MonitorUser> {
  return requireArea("monitor");
}
