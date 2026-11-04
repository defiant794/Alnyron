import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import ItemEditorScreen from "@/app/admin/(panel)/catalog/items/item-editor-screen";
import { AUTH_LOCALE } from "@/config/auth-areas";
import { publicMediaUrl } from "@/lib/public-media-url";
import { getItemForEdit, listCatalogSections } from "@/services/admin/catalog-read";
import { requireAdmin } from "@/services/auth/require-admin";

type EditItemPageProps = Readonly<{ params: Promise<{ id: string }> }>;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: AUTH_LOCALE, namespace: "Admin.catalog.item" });
  return { title: t("metaTitle") };
}

/**
 * `/admin/catalog/items/[id]` ("Rediger element"): the item editor with the
 * item's images. Ids that name no item are a 404.
 */
export default async function EditItemPage({ params }: EditItemPageProps) {
  await requireAdmin();
  const { id } = await params;
  const [item, sections] = await Promise.all([getItemForEdit(id), listCatalogSections()]);
  if (!item) notFound();

  return (
    <ItemEditorScreen
      sections={sections}
      item={{
        id: item.id,
        categoryId: item.categoryId,
        status: item.status,
        featured: item.featured,
        priceType: item.priceType,
        priceAmount: item.priceAmount,
        externalLinks: item.externalLinks,
        translations: item.translations,
        media: item.media.map((image, index) => ({
          id: image.id,
          src: publicMediaUrl(image.path),
          path: image.path,
          altDa: image.altDa,
          altEn: image.altEn,
          position: index + 1,
        })),
      }}
    />
  );
}
