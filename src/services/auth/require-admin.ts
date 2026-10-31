import { redirect } from "next/navigation";
import { cache } from "react";
import { ADMIN_LOGIN_PATH, ADMIN_NO_ACCESS_PATH } from "@/config/admin";
import { createServerClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database";

type AppRole = Database["public"]["Enums"]["app_role"];

/** Roles allowed into the admin panel. */
export type AdminRole = Extract<AppRole, "owner" | "admin">;

export interface AdminUser {
  userId: string;
  email: string;
  role: AdminRole;
}

/**
 * Who is asking, from the admin panel's point of view:
 * - `anonymous`: no valid session.
 * - `forbidden`: signed in, but `profiles.role` is not owner/admin (null,
 *   `mylife_user`, or no profile row).
 * - `admin`: may use the panel.
 */
export type AdminAccess =
  | { status: "anonymous" }
  | { status: "forbidden"; email: string }
  | { status: "admin"; user: AdminUser };

/** PostgREST code for `.single()` matching zero rows. */
const NO_ROWS = "PGRST116";

const isAdminRole = (role: AppRole | null): role is AdminRole =>
  role === "owner" || role === "admin";

/**
 * Resolve the caller's admin access without redirecting (layouts use it to
 * pick the frame; `/admin/no-access` uses it to send admins home).
 *
 * `getClaims()` verifies the JWT. The role comes from `profiles` (RLS lets a
 * user read only their own row), never from the token, so revoking a role
 * takes effect on the next request (architecture §4). A profile query that
 * fails for any reason other than "no row" throws: an outage is not a "no
 * access" answer. Cached per request.
 */
export const getAdminAccess = cache(async (): Promise<AdminAccess> => {
  const supabase = await createServerClient();
  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims) return { status: "anonymous" };

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("role")
    .eq("user_id", claims.sub)
    .single();
  if (profileError && profileError.code !== NO_ROWS) {
    throw new Error(`Admin profile lookup failed: ${profileError.message}`);
  }

  const email = claims.email ?? "";
  if (!profile || !isAdminRole(profile.role)) return { status: "forbidden", email };
  return { status: "admin", user: { userId: claims.sub, email, role: profile.role } };
});

/**
 * Data-access guard (architecture §6, route protection layer 2): call at the
 * top of EVERY admin page and EVERY admin Server Action; layouts are not an
 * auth boundary. No session redirects to `/admin/login`, a non-admin role to
 * `/admin/no-access`. RLS (layer 3) still rejects non-admin writes on its own.
 * Cached per request, so page + layout cost one lookup.
 */
export const requireAdmin = cache(async (): Promise<AdminUser> => {
  const access = await getAdminAccess();
  if (access.status === "anonymous") redirect(ADMIN_LOGIN_PATH);
  if (access.status === "forbidden") redirect(ADMIN_NO_ACCESS_PATH);
  return access.user;
});
