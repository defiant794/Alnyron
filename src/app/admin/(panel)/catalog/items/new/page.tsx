import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import ItemEditorScreen from "@/app/admin/(panel)/catalog/items/item-editor-screen";
import { ADMIN_CATALOG_PATH } from "@/config/admin";
import { AUTH_LOCALE } from "@/config/auth-areas";
import { listCatalogSections } from "@/services/admin/catalog-read";
import { requireAdmin } from "@/services/auth/require-admin";

type NewItemPageProps = Readonly<{ searchParams: Promise<{ category?: string | string[] }> }>;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: AUTH_LOCALE, namespace: "Admin.catalog.item" });
  return { title: t("newTitle") };
}

/**
 * `/admin/catalog/items/new?category=<id>` ("Nyt element"): the item editor
 * for a new draft, in the section named by `category`. Without exactly one
 * `category` that names a section, it redirects to the catalog overview
 * instead of guessing a section. Images can be added once it is saved.
 */
export default async function NewItemPage({ searchParams }: NewItemPageProps) {
  await requireAdmin();
  const [{ category }, sections] = await Promise.all([searchParams, listCatalogSections()]);
  const section = typeof category === "string" ? sections.find((candidate) => candidate.id === category) : undefined;
  if (!section) redirect(ADMIN_CATALOG_PATH);

  return (
    <ItemEditorScreen
      sections={sections}
      item={{
        categoryId: section.id,
        status: "draft",
        featured: false,
        priceType: null,
        priceAmount: null,
        externalLinks: {},
        translations: { da: null, en: null },
        media: [],
      }}
    />
  );
}
