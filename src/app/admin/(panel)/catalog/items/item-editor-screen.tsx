import type { Locale } from "next-intl";
import { getTranslations } from "next-intl/server";
import { deleteItemAction, saveItemAction, setItemStatusAction } from "@/app/admin/(panel)/catalog/items/actions";
import {
  attachMediaAction,
  createMediaUploadAction,
  detachMediaAction,
} from "@/app/admin/(panel)/catalog/items/[id]/media-actions";
import AdminBreadcrumb from "@/components/admin/AdminBreadcrumb";
import ItemEditor, { type ItemEditorItem, type ItemFieldLabels } from "@/components/admin/ItemEditor";
import Badge from "@/components/ui/Badge";
import { ADMIN_CATALOG_PATH, adminCategoryPath } from "@/config/admin";
import { AUTH_LOCALE } from "@/config/auth-areas";
import { MEDIA_MAX_PER_ITEM, URL_SLUG_LOCALE } from "@/config/catalog";
import { loadMessages } from "@/i18n/messages";
import { getPathname } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import type { AdminCatalogSection } from "@/services/admin/catalog-read";

export type ItemEditorScreenProps = {
  item: ItemEditorItem;
  /** Every section (from `listCatalogSections`); the item's own one names the breadcrumb. */
  sections: AdminCatalogSection[];
};

/**
 * Header (breadcrumb, title, status badge) and {@link ItemEditor} with its
 * Server Actions and Danish copy: shared by `/admin/catalog/items/new` and
 * `/admin/catalog/items/[id]`. The caller has checked `requireAdmin()`.
 */
export default async function ItemEditorScreen({ item, sections }: ItemEditorScreenProps) {
  const t = await getTranslations({ locale: AUTH_LOCALE, namespace: "Admin.catalog" });
  const messages = loadMessages(AUTH_LOCALE).Admin.catalog;
  const { media } = messages;
  const sectionTitle = (section: AdminCatalogSection) => section.title || t(`kinds.${section.kind}`);
  const section = sections.find((candidate) => candidate.id === item.categoryId);
  const itemTitle = item.translations.da?.title;
  const title = item.id && itemTitle ? itemTitle : t("item.newTitle");
  const urlSlug = item.translations[URL_SLUG_LOCALE]?.slug;
  // The public item page exists only while the item and its section are published; its
  // address uses the English slugs on every locale.
  const previewHref =
    item.status === "published" && section?.status === "published" && section.slug && urlSlug
      ? getPathname({
          href: { pathname: "/[slug]/[item]", params: { slug: section.slug, item: urlSlug } },
          locale: routing.defaultLocale,
        })
      : null;
  const fieldLabels = (locale: Locale): ItemFieldLabels => {
    const code = locale.toUpperCase();
    return {
      title: t("item.fields.title", { locale: code }),
      slug: t("item.fields.slug", { locale: code }),
      summary: t("item.fields.summary", { locale: code }),
      body: t("item.fields.body", { locale: code }),
      seoTitle: t("item.fields.seoTitle", { locale: code }),
      seoDescription: t("item.fields.seoDescription", { locale: code }),
    };
  };

  return (
    <>
      <div className="flex flex-col gap-2">
        <AdminBreadcrumb
          label={t("breadcrumb")}
          items={[
            { label: t("title"), href: ADMIN_CATALOG_PATH },
            ...(section ? [{ label: sectionTitle(section), href: adminCategoryPath(section.id) }] : []),
            { label: title },
          ]}
        />
        <header className="flex flex-wrap items-center gap-3">
          <h1 className="text-h1 font-semibold">{title}</h1>
          {item.id && <Badge tone={item.status}>{t(`status.${item.status}`)}</Badge>}
        </header>
      </div>
      {/*
        Keyed by item, so the form (and its image list) starts fresh on another item. A new item is
        keyed by its section: "Nyt element" of another section is the same route with another
        `?category`, and only a remount applies the uncontrolled section select's new default.
      */}
      <ItemEditor
        key={item.id ?? `new-${item.categoryId}`}
        item={item}
        sections={sections.map((candidate) => ({ id: candidate.id, title: sectionTitle(candidate) }))}
        previewHref={previewHref}
        sectionHref={adminCategoryPath(item.categoryId)}
        save={saveItemAction}
        setStatus={setItemStatusAction}
        remove={deleteItemAction}
        createUpload={createMediaUploadAction}
        attach={attachMediaAction}
        detach={detachMediaAction}
        labels={{
          languages: t("languages"),
          locales: { da: t("locales.da"), en: t("locales.en") },
          contentHeading: t("item.contentHeading"),
          sideHeading: t("item.sideHeading"),
          fields: { da: fieldLabels("da"), en: fieldLabels("en") },
          slugHint: { da: t("item.fields.slugHint.da"), en: t("item.fields.slugHint.en") },
          bodyHint: t("item.fields.bodyHint"),
          seoTitleHint: t("item.fields.seoTitleHint"),
          seoDescriptionHint: t("item.fields.seoDescriptionHint"),
          enHint: t("item.enHint"),
          section: t("item.fields.section"),
          sectionHint: t("item.fields.sectionHint"),
          priceType: t("item.fields.priceType"),
          priceTypes: {
            none: t("item.fields.priceTypes.none"),
            fixed: t("item.fields.priceTypes.fixed"),
            from: t("item.fields.priceTypes.from"),
            contact: t("item.fields.priceTypes.contact"),
          },
          amount: t("item.fields.amount"),
          amountHint: t("item.fields.amountHint"),
          links: t("item.fields.links"),
          linkKeys: messages.item.fields.linkKeys,
          featured: t("item.fields.featured"),
          featuredHint: t("item.fields.featuredHint"),
          save: t("item.save"),
          saveDraft: t("item.saveDraft"),
          publish: t("item.publish"),
          publishHint: t("item.publishHint"),
          hide: t("item.hide"),
          preview: t("item.preview"),
          previewHint: t("item.previewHint"),
          newTab: t("newTab"),
          delete: t("item.delete"),
          confirmDelete: t("item.confirmDelete"),
          saved: t("item.saved"),
          savedDraft: t("item.savedDraft"),
          published: t("item.published"),
          hidden: t("item.hidden"),
          errors: messages.errors,
          media: {
            heading: media.heading,
            saveFirst: media.saveFirst,
            empty: media.empty,
            addImage: media.addImage,
            uploading: media.uploading,
            busy: media.busy,
            altDaLabel: media.altDa,
            altEnLabel: media.altEn,
            image: media.image,
            remove: media.remove,
            confirmRemove: media.confirmRemove,
            errors: media.errors,
            dropHint: media.dropHint,
            formats: media.formats,
            moveUp: media.moveUp,
            moveDown: media.moveDown,
            counts: Array.from({ length: MEDIA_MAX_PER_ITEM + 1 }, (_, count) =>
              t("media.count", { count, max: MEDIA_MAX_PER_ITEM }),
            ),
          },
        }}
      />
    </>
  );
}
