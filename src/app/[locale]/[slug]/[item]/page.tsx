import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import ItemDetailView from "@/components/site/ItemDetailView";
import { languageAlternates } from "@/i18n/alternates";
import { getPriceLabels } from "@/i18n/price-labels";
import { routing } from "@/i18n/routing";
import { isValidSlug } from "@/lib/slugify";
import { getCatalogItem, getItemStaticParams } from "@/services/content/catalog";

type ItemProps = Readonly<{ params: Promise<{ locale: string; slug: string; item: string }> }>;

/**
 * Prerender every public item of the section page above: Next.js calls this
 * once per section page and adds its `{ locale, slug }` to each `{ item }`
 * (the item's English URL slug, the same on every locale). An item
 * published later renders on its first request (ISR); revalidation inherits
 * the `[locale]` layout's `revalidate`.
 */
export async function generateStaticParams({ params }: { params: { locale: string; slug: string } }) {
  if (!hasLocale(routing.locales, params.locale)) return [];
  return getItemStaticParams(params.slug, params.locale);
}

/**
 * SEO title/description (DB, falling back to the item's title and summary)
 * and hreflang alternates. A malformed slug answers 404 before any DB read.
 */
export async function generateMetadata({ params }: ItemProps): Promise<Metadata> {
  const { locale, slug, item: itemSlug } = await params;
  if (!isValidSlug(slug) || !isValidSlug(itemSlug)) notFound();
  if (!hasLocale(routing.locales, locale)) return {};
  const found = await getCatalogItem(slug, itemSlug, locale, await getPriceLabels(locale));
  if (!found) return {};
  const { item } = found;
  return {
    title: item.seo.title,
    ...(item.seo.description && { description: item.seo.description }),
    alternates: { canonical: item.href, languages: languageAlternates(item.paths) },
  };
}

/**
 * Catalog item page (`/services/web-development`, `/en/services/web-development`;
 * approved detail mock). Both slugs are English on every locale: the section's
 * English route slug and the item's English slug; the text is in the page's
 * locale. 404 unless both the section and the item are public, the item has
 * a translation in this locale and belongs to that section; a malformed slug
 * answers 404 before any DB read. Slugs of another locale are no address
 * (nothing redirects).
 */
export default async function CatalogItem({ params }: ItemProps) {
  const { locale, slug, item: itemSlug } = await params;
  // The 404 is never written to the KV page cache either (open-next.config.ts).
  if (!isValidSlug(slug) || !isValidSlug(itemSlug)) notFound();
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  const found = await getCatalogItem(slug, itemSlug, locale, await getPriceLabels(locale));
  if (!found) notFound();

  return <ItemDetailView locale={locale} section={found.section} item={found.item} />;
}
