import type { Locale } from "next-intl";
import { cache } from "react";
import { URL_SLUG_LOCALE, type CatalogKind } from "@/config/catalog";
import { getPathname } from "@/i18n/navigation";
import { resolveContent } from "@/lib/i18n/resolve-content";
import { getPublicClient } from "@/lib/supabase/public";

/** A catalog category visible to the public, resolved for one locale. */
export interface PublicCategory {
  id: string;
  kind: CatalogKind;
  navOrder: number;
  title: string;
  /** Short card text; `""` when neither locale has one. */
  description: string;
  /** Locale-aware path with the English URL slug: `/websites` (DA), `/en/websites` (EN). */
  href: string;
  /** Fields shown from the Danish row (`"title"`, `"description"`): render with `lang="da"`. */
  fallbackKeys: string[];
}

type CategoryText = { title: string; description: string };

const NO_TEXT: CategoryText = { title: "", description: "" };

/**
 * Public categories for `locale`, in `nav_order`. Anonymous RLS returns only
 * categories that are published and hold at least one published item, so an
 * empty category never reaches the site (Q-8).
 *
 * Text falls back to Danish per field. The URL slug is the category's
 * English route slug on every locale (`URL_SLUG_LOCALE`); a category without
 * one is left out. Deduplicated per render (the header nav and the home page
 * both list categories).
 *
 * @throws when the query fails, so a broken read never caches an empty list.
 */
export const getPublicCategories = cache(async (locale: Locale): Promise<PublicCategory[]> => {
  const { data, error } = await getPublicClient()
    .from("categories")
    .select("id, kind, nav_order, category_translations(locale, title, description), routes(locale, slug)")
    .order("nav_order");
  if (error) throw new Error(`Failed to load public categories: ${error.message}`);

  const categories: PublicCategory[] = [];
  for (const row of data ?? []) {
    const slug = row.routes.find((route) => route.locale === URL_SLUG_LOCALE)?.slug;
    if (!slug) continue;

    const da = pickText(row.category_translations, "da") ?? NO_TEXT;
    const own = pickText(row.category_translations, locale);
    const { value, fallbackKeys } = resolveContent(da, own, locale);
    if (value.title.trim() === "") continue;

    categories.push({
      id: row.id,
      kind: row.kind,
      navOrder: row.nav_order,
      title: value.title,
      description: value.description,
      href: getPathname({ href: { pathname: "/[slug]", params: { slug } }, locale }),
      fallbackKeys,
    });
  }
  return categories;
});

function pickText(
  translations: readonly (CategoryText & { locale: Locale })[],
  locale: Locale,
): CategoryText | undefined {
  const row = translations.find((translation) => translation.locale === locale);
  return row && { title: row.title, description: row.description };
}
