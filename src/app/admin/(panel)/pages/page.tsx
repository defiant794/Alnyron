import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { reorderNav, setPageNav } from "@/app/admin/(panel)/pages/actions";
import PageHeader from "@/components/admin/PageHeader";
import PagesTable, { type PagesTableRow } from "@/components/admin/PagesTable";
import Card from "@/components/ui/Card";
import { ADMIN_PAGES_PATH } from "@/config/admin";
import { AUTH_LOCALE } from "@/config/auth-areas";
import { parseSiteEnv } from "@/config/env";
import { SYSTEM_PAGE_AREA_ORIGIN } from "@/config/system-pages";
import { loadMessages } from "@/i18n/messages";
import { isContentPage } from "@/lib/validation/pages";
import { listSystemPages } from "@/services/admin/pages";
import { requireAdmin } from "@/services/auth/require-admin";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: AUTH_LOCALE, namespace: "Admin.pages" });
  return { title: t("title") };
}

const HEADING_ID = "pages-heading";

/**
 * `/admin/pages` ("Sider"): the system pages with their status, a link to
 * edit each (an app area like Monitor has a nav switch instead), and the nav
 * order. Pages are named by their fixed nav label; the Danish title is shown
 * under it (an app area, which has none, says what it is and the host it is
 * served on, `monitor.alnyron.dk`).
 */
export default async function AdminPagesPage() {
  await requireAdmin();
  const [pages, t, tNav] = await Promise.all([
    listSystemPages(),
    getTranslations({ locale: AUTH_LOCALE, namespace: "Admin.pages" }),
    getTranslations({ locale: AUTH_LOCALE, namespace: "Nav" }),
  ]);

  return (
    <>
      <PageHeader title={t("title")} description={t("lead")} />
      <Card className="flex max-w-4xl flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 id={HEADING_ID} className="text-h3 font-semibold">
            {t("table.caption")}
          </h2>
          <p className="text-small text-muted">{t("orderHint")}</p>
        </div>
        <PagesTable
          rows={pages.map((page): PagesTableRow => {
            const row = {
              id: page.id,
              name: tNav(page.systemKey),
              status: page.status,
              showInNav: page.showInNav,
              pinned: page.systemKey === "home",
            };
            return isContentPage(page.systemKey)
              ? { ...row, kind: "content", title: page.title, editHref: `${ADMIN_PAGES_PATH}/${page.id}` }
              : {
                  ...row,
                  kind: "area",
                  description: t("area.description", {
                    host: new URL(SYSTEM_PAGE_AREA_ORIGIN[page.systemKey](parseSiteEnv().NEXT_PUBLIC_SITE_URL)).host,
                  }),
                };
          })}
          labelledBy={HEADING_ID}
          reorder={reorderNav}
          setPageNav={setPageNav}
          labels={{
            page: t("table.page"),
            status: t("table.status"),
            actions: t("table.actions"),
            statuses: { published: t("status.published"), draft: t("status.draft") },
            shown: t("menu.shown"),
            hidden: t("menu.hidden"),
            toggle: t("menu.toggle"),
            edit: t("edit"),
            moveUp: t("moveUp"),
            moveDown: t("moveDown"),
            // Plain strings (no ICU arguments), read as typed messages.
            errors: loadMessages(AUTH_LOCALE).Admin.pages.errors,
          }}
        />
      </Card>
    </>
  );
}
