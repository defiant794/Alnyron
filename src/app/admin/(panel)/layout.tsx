import AdminShell from "@/components/admin/AdminShell";
import AuthFrame from "@/components/admin/AuthFrame";
import { getAdminAccess } from "@/services/auth/require-admin";

/**
 * Signed-in admin routes. Admins get the panel shell; a signed-in user
 * without an admin role (who only ever reaches `/admin/no-access`) gets the
 * plain card frame and never sees the panel navigation.
 *
 * Choosing the frame is not the auth boundary: every page here calls
 * `requireAdmin()` (or, on `/admin/no-access`, checks access) itself.
 */
export default async function PanelLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const access = await getAdminAccess();
  if (access.status !== "admin") return <AuthFrame>{children}</AuthFrame>;
  return <AdminShell user={access.user}>{children}</AdminShell>;
}
