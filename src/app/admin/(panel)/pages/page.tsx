import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { reorderNav } from "@/app/admin/(panel)/pages/actions";
import PageHeader from "@/components/admin/PageHeader";
import PagesTable from "@/components/admin/PagesTable";
import Card from "@/components/ui/Card";
import { ADMIN_PAGES_PATH } from "@/config/admin";
import { AUTH_LOCALE } from "@/config/auth-areas";
import { loadMessages } from "@/i18n/messages";
import { listSystemPages } from "@/services/admin/pages";
import { requireAdmin } from "@/services/auth/require-admin";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: AUTH_LOCALE, namespace: "Admin.pages" });
  return { title: t("title") };
}

const HEADING_ID = "pages-heading";

/**
 * `/admin/pages` ("Sider"): the system pages with their status, a link to
 * edit each, and the nav order. Pages are named by their fixed nav label;
 * the Danish title is shown under it.
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
          rows={pages.map((page) => ({
            id: page.id,
            name: tNav(page.systemKey),
            title: page.title,
            status: page.status,
            showInNav: page.showInNav,
            editHref: `${ADMIN_PAGES_PATH}/${page.id}`,
            pinned: page.systemKey === "home",
          }))}
          labelledBy={HEADING_ID}
          reorder={reorderNav}
          labels={{
            page: t("table.page"),
            status: t("table.status"),
            actions: t("table.actions"),
            statuses: { published: t("status.published"), draft: t("status.draft") },
            shown: t("menu.shown"),
            hidden: t("menu.hidden"),
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
