import type { Metadata } from "next";
import type { Locale } from "next-intl";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import {
  reorderItemsAction,
  saveCategoryAction,
  setCategoryStatusAction,
} from "@/app/admin/(panel)/catalog/categories/[id]/actions";
import { setItemStatusAction } from "@/app/admin/(panel)/catalog/items/actions";
import ActiveCatalogKind from "@/components/admin/ActiveCatalogKind";
import AdminBreadcrumb from "@/components/admin/AdminBreadcrumb";
import CatalogItemsTable from "@/components/admin/CatalogItemsTable";
import CategoryEditor, { type CategoryFieldLabels } from "@/components/admin/CategoryEditor";
import PageHeader from "@/components/admin/PageHeader";
import { cardClassName } from "@/components/ui/card-styles";
import { ADMIN_CATALOG_PATH, adminItemPath } from "@/config/admin";
import { AUTH_LOCALE } from "@/config/auth-areas";
import { getPriceLabels } from "@/i18n/price-labels";
import { loadMessages } from "@/i18n/messages";
import { routing } from "@/i18n/routing";
import { cx } from "@/lib/cx";
import { formatPrice } from "@/lib/format-price";
import { getCategoryForEdit } from "@/services/admin/catalog-read";
import { requireAdmin } from "@/services/auth/require-admin";

type CategoryEditorPageProps = Readonly<{ params: Promise<{ id: string }> }>;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: AUTH_LOCALE, namespace: "Admin.catalog.section" });
  return { title: t("metaTitle") };
}

const ITEMS_HEADING_ID = "section-items-heading";
const TEXT_HEADING_ID = "section-text-heading";

/**
 * `/admin/catalog/categories/[id]` (approved section-editor mock): the
 * section's items (order, publish/hide, "+ Nyt element") beside its DA/EN
 * text and visibility. Ids that name no section are a 404. The page declares
 * the section's kind, so the sidebar marks that kind's link.
 */
export default async function CategoryEditorPage({ params }: CategoryEditorPageProps) {
  await requireAdmin();
  const { id } = await params;
  const category = await getCategoryForEdit(id);
  if (!category) notFound();

  const [t, priceLabels] = await Promise.all([
    getTranslations({ locale: AUTH_LOCALE, namespace: "Admin.catalog" }),
    getPriceLabels(routing.defaultLocale),
  ]);
  const { errors } = loadMessages(AUTH_LOCALE).Admin.catalog;
  const title = category.translations.da.title || t(`kinds.${category.kind}`);
  const fieldLabels = (locale: Locale): CategoryFieldLabels => {
    const code = locale.toUpperCase();
    return {
      title: t("section.fields.title", { locale: code }),
      description: t("section.fields.description", { locale: code }),
      slug: t("section.fields.slug", { locale: code }),
      seoTitle: t("section.fields.seoTitle", { locale: code }),
      seoDescription: t("section.fields.seoDescription", { locale: code }),
    };
  };
  const card = cx(cardClassName("white", false), "flex flex-col gap-6 p-6");

  return (
    <>
      <ActiveCatalogKind kind={category.kind} />
      <div className="flex flex-col gap-2">
        <AdminBreadcrumb label={t("breadcrumb")} items={[{ label: t("title"), href: ADMIN_CATALOG_PATH }, { label: title }]} />
        <PageHeader title={title} description={t("section.lead")} />
      </div>
      <div className="grid items-start gap-6 xl:grid-cols-[3fr_2fr]">
        <section aria-labelledby={ITEMS_HEADING_ID} className={card}>
          <h2 id={ITEMS_HEADING_ID} className="text-h3 font-semibold">
            {t("section.itemsHeading")}
          </h2>
          <CatalogItemsTable
            categoryId={category.id}
            labelledBy={ITEMS_HEADING_ID}
            rows={category.items.map((item) => ({
              id: item.id,
              title: item.title,
              status: item.status,
              featured: item.featured,
              price: formatPrice(item.price, routing.defaultLocale, priceLabels)?.text ?? null,
              editHref: adminItemPath(item.id),
            }))}
            onStatusChange={setItemStatusAction}
            reorder={{
              onReorder: reorderItemsAction.bind(null, category.id),
              labels: {
                moveUp: t("items.moveUp"),
                moveDown: t("items.moveDown"),
                hint: t("items.orderHint"),
              },
            }}
            labels={{
              newItem: t("items.newItem"),
              empty: t("items.empty"),
              edit: t("items.edit"),
              featured: t("items.featured"),
              publish: t("items.publish"),
              hide: t("items.hide"),
              statuses: { published: t("status.published"), draft: t("status.draft") },
              columns: {
                title: t("items.columns.title"),
                status: t("items.columns.status"),
                price: t("items.columns.price"),
                actions: t("items.columns.actions"),
              },
              errors,
            }}
          />
        </section>
        <section aria-labelledby={TEXT_HEADING_ID} className={card}>
          <h2 id={TEXT_HEADING_ID} className="text-h3 font-semibold">
            {t("section.textHeading")}
          </h2>
          <CategoryEditor
            category={{ id: category.id, status: category.status, translations: category.translations }}
            save={saveCategoryAction}
            setStatus={setCategoryStatusAction}
            labels={{
              languages: t("languages"),
              locales: { da: t("locales.da"), en: t("locales.en") },
              fields: { da: fieldLabels("da"), en: fieldLabels("en") },
              slugHint: t("section.fields.slugHint"),
              seoTitleHint: t("section.fields.seoTitleHint"),
              seoDescriptionHint: t("section.fields.seoDescriptionHint"),
              enHint: t("section.enHint"),
              visible: t("section.fields.visible"),
              visibleHint: t("section.fields.visibleHint"),
              cancel: t("section.cancel"),
              save: t("section.save"),
              saved: t("section.saved"),
              errors,
            }}
          />
        </section>
      </div>
    </>
  );
}
