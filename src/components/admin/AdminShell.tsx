import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import AdminAccount from "@/components/admin/AdminAccount";
import AdminNav from "@/components/admin/AdminNav";
import Logo from "@/components/brand/Logo";
import { ADMIN_HOME_PATH, ADMIN_LOCALE } from "@/config/admin";
import type { AdminUser } from "@/services/auth/require-admin";

export type AdminShellProps = {
  user: AdminUser;
  children: ReactNode;
};

/**
 * Admin panel frame (approved admin mock): sidebar with the lockup, the
 * sections that exist so far and the signed-in account with "Log ud"; page
 * content on the right. A section joins the navigation together with its
 * page, so no link leads to a 404 (pages and settings arrive with F1.2 and
 * F1.5, catalogs and newsletter in P2). Below 768px the sidebar becomes a
 * top bar: logo and a compact account in one row, the navigation under it,
 * then the content, so nothing comes between the navigation and the page
 * (in reading and in tab order).
 */
export default async function AdminShell({ user, children }: AdminShellProps) {
  const t = await getTranslations({ locale: ADMIN_LOCALE, namespace: "Admin" });
  const accountLabels = {
    region: t("account.label"),
    role: t(`account.roles.${user.role}`),
    signOut: t("account.signOut"),
  };

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <aside className="flex flex-col gap-4 border-b border-border bg-side p-4 md:sticky md:top-0 md:h-dvh md:w-64 md:shrink-0 md:gap-6 md:overflow-y-auto md:border-r md:border-b-0 md:py-6">
        <div className="flex flex-wrap items-center gap-3">
          <Logo wordmark className="md:px-2" />
          <AdminAccount user={user} variant="bar" labels={accountLabels} />
        </div>
        <AdminNav
          label={t("nav.label")}
          items={[{ href: ADMIN_HOME_PATH, label: t("nav.overview"), exact: true }]}
        />
        <AdminAccount user={user} variant="sidebar" labels={accountLabels} />
      </aside>
      <main id="main" tabIndex={-1} className="flex flex-1 flex-col gap-8 px-4 py-8 focus:outline-none md:px-8">
        {children}
      </main>
    </div>
  );
}
