import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import CatalogOverviewTable from "@/components/admin/CatalogOverviewTable";
import PageHeader from "@/components/admin/PageHeader";
import { cardClassName } from "@/components/ui/card-styles";
import { adminCategoryPath } from "@/config/admin";
import { AUTH_LOCALE } from "@/config/auth-areas";
import { getPathname } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { cx } from "@/lib/cx";
import { listCatalogSections } from "@/services/admin/catalog-read";
import { requireAdmin } from "@/services/auth/require-admin";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: AUTH_LOCALE, namespace: "Admin.catalog" });
  return { title: t("title") };
}

const HEADING_ID = "catalog-sections-heading";

/**
 * `/admin/catalog` ("Katalog", approved overview mock): every section with
 * its public path, visibility badge and item counts, and "Rediger" to its
 * section editor; a note on when a section shows publicly.
 */
export default async function AdminCatalogPage() {
  await requireAdmin();
  const [sections, t] = await Promise.all([
    listCatalogSections(),
    getTranslations({ locale: AUTH_LOCALE, namespace: "Admin.catalog" }),
  ]);

  return (
    <>
      <PageHeader title={t("title")} description={t("lead")} />
      <section aria-labelledby={HEADING_ID} className={cx(cardClassName("white", false), "max-w-4xl overflow-hidden")}>
        <h2 id={HEADING_ID} className="border-b border-border px-6 py-4 text-h3 font-semibold">
          {t("overview.heading")}
        </h2>
        <CatalogOverviewTable
          labelledBy={HEADING_ID}
          rows={sections.map((section) => ({
            id: section.id,
            title: section.title,
            path: section.slug
              ? getPathname({
                  href: { pathname: "/[slug]", params: { slug: section.slug } },
                  locale: routing.defaultLocale,
                })
              : undefined,
            status: section.status,
            publishedCount: section.publishedCount,
            draftCount: section.draftCount,
            editHref: adminCategoryPath(section.id),
          }))}
          labels={{
            edit: t("overview.edit"),
            visibility: {
              synlig: t("overview.visibility.synlig"),
              visesVedForste: t("overview.visibility.visesVedForste"),
              skjult: t("overview.visibility.skjult"),
            },
            counts: {
              published: (count) => t("overview.published", { count }),
              draft: (count) => t("overview.draft", { count }),
            },
            columns: {
              section: t("overview.columns.section"),
              visibility: t("overview.columns.visibility"),
              items: t("overview.columns.items"),
              actions: t("overview.columns.actions"),
            },
          }}
        />
      </section>
      <p className="max-w-prose text-small text-muted">{t("overview.note")}</p>
    </>
  );
}
