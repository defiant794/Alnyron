import { cache } from "react";
import type { AreaRole } from "@/config/auth-areas";
import { getAreaAccess, requireArea, type AreaUser } from "@/services/auth/require-role";

/** Roles allowed into the admin panel. */
export type AdminRole = AreaRole<"admin">;

export type AdminUser = AreaUser<"admin">;

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

/**
 * Resolve the caller's admin access without redirecting (layouts use it to
 * pick the frame; `/admin/no-access` uses it to send admins home). The role
 * check is `getAreaAccess("admin")` (role from `profiles`, never the JWT; a
 * profile outage throws). Cached per request.
 */
export const getAdminAccess = cache(async (): Promise<AdminAccess> => {
  const access = await getAreaAccess("admin");
  return access.status === "allowed" ? { status: "admin", user: access.user } : access;
});

/**
 * Data-access guard (architecture §6, route protection layer 2): call at the
 * top of EVERY admin page and EVERY admin Server Action; layouts are not an
 * auth boundary. No session redirects to `/admin/login`, a non-admin role to
 * `/admin/no-access`. RLS (layer 3) still rejects non-admin writes on its own.
 * Cached per request, so page + layout cost one lookup.
 */
export const requireAdmin = cache((): Promise<AdminUser> => requireArea("admin"));
