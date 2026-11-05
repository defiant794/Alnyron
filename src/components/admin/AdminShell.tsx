import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { ActiveCatalogKindProvider } from "@/components/admin/ActiveCatalogKind";
import AdminAccount from "@/components/admin/AdminAccount";
import AdminNav from "@/components/admin/AdminNav";
import NavigationPendingContent, { NavigationPendingProvider } from "@/components/admin/NavigationPending";
import Logo from "@/components/brand/Logo";
import { ADMIN_CATALOG_PATH, ADMIN_HOME_PATH, ADMIN_PAGES_PATH, adminCatalogKindPath } from "@/config/admin";
import { AUTH_LOCALE } from "@/config/auth-areas";
import { CATALOG_KINDS } from "@/config/catalog";
import type { AdminUser } from "@/services/auth/require-admin";

export type AdminShellProps = {
  user: AdminUser;
  children: ReactNode;
};

/**
 * Admin panel frame (approved admin mock): sidebar with the lockup, the
 * sections that exist so far and the signed-in account with "Log ud"; page
 * content on the right. A section joins the navigation together with its
 * page, so no link leads to a 404 (settings arrive with F1.5, newsletter in
 * P2b). The "Kataloger" group holds the catalog overview and a shortcut to
 * each kind's section editor; a section editor declares its kind
 * (`ActiveCatalogKind`), which marks that kind's link. A link click in the
 * shell replaces the page content with "Indlæser siden …" until the next
 * page is there (`NavigationPending`), so the outgoing page's controls
 * cannot be used meanwhile. Below 768px the sidebar becomes a top bar: logo
 * and a compact account in one row, the navigation under it, then the
 * content, so nothing comes between the navigation and the page (in reading
 * and in tab order).
 */
export default async function AdminShell({ user, children }: AdminShellProps) {
  const t = await getTranslations({ locale: AUTH_LOCALE, namespace: "Admin" });
  const tAuth = await getTranslations({ locale: AUTH_LOCALE, namespace: "Auth" });
  const accountLabels = {
    region: t("account.label"),
    role: t(`account.roles.${user.role}`),
    signOut: tAuth("signOut"),
  };

  return (
    <ActiveCatalogKindProvider>
      <NavigationPendingProvider className="flex min-h-dvh flex-col md:flex-row">
        <aside className="flex flex-col gap-4 border-b border-border bg-side p-4 md:sticky md:top-0 md:h-dvh md:w-64 md:shrink-0 md:gap-6 md:overflow-y-auto md:border-r md:border-b-0 md:py-6">
          <div className="flex flex-wrap items-center gap-3">
            <Logo wordmark className="md:px-2" />
            <AdminAccount user={user} variant="bar" labels={accountLabels} />
          </div>
          <AdminNav
            label={t("nav.label")}
            items={[
              { href: ADMIN_HOME_PATH, label: t("nav.overview"), exact: true },
              {
                label: t("nav.catalogGroup"),
                items: [
                  { href: ADMIN_CATALOG_PATH, label: t("nav.catalog") },
                  ...CATALOG_KINDS.map((kind) => ({
                    href: adminCatalogKindPath(kind),
                    label: t(`catalog.kinds.${kind}`),
                    matchKind: kind,
                  })),
                ],
              },
              { href: ADMIN_PAGES_PATH, label: t("nav.pages") },
            ]}
          />
          <AdminAccount user={user} variant="sidebar" labels={accountLabels} />
        </aside>
        <main id="main" tabIndex={-1} className="flex flex-1 flex-col gap-8 px-4 py-8 focus:outline-none md:px-8">
          <NavigationPendingContent label={t("loading")}>{children}</NavigationPendingContent>
        </main>
      </NavigationPendingProvider>
    </ActiveCatalogKindProvider>
  );
}
