import type { Metadata } from "next";
import { hasLocale, type Locale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import ItemDetailView from "@/components/site/ItemDetailView";
import { languageAlternates } from "@/i18n/alternates";
import { permanentRedirect } from "@/i18n/navigation";
import { getPriceLabels } from "@/i18n/price-labels";
import { routing } from "@/i18n/routing";
import { isValidSlug } from "@/lib/slugify";
import { getCatalogItem, getItemStaticParams, resolveCatalogItemSlugs } from "@/services/content/catalog";

type ItemProps = Readonly<{ params: Promise<{ locale: string; slug: string; item: string }> }>;

/**
 * Prerender every public item of the section page above: Next.js calls this
 * once per section page and adds its `{ locale, slug }` to each `{ item }`.
 * An item published later renders on its first request (ISR); revalidation
 * inherits the `[locale]` layout's `revalidate`.
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
 * Catalog item page (`/ydelser/webudvikling`, `/en/services/web-development`;
 * approved detail mock). 404 unless both the section and the item are public
 * and the item belongs to that section; a malformed slug answers 404 before
 * any DB read. Slugs of another locale (the language switch keeps them:
 * `/en/ydelser/webudvikling`) redirect permanently to this locale's slugs.
 */
export default async function CatalogItem({ params }: ItemProps) {
  const { locale, slug, item: itemSlug } = await params;
  // The 404 is never written to the KV page cache either (open-next.config.ts).
  if (!isValidSlug(slug) || !isValidSlug(itemSlug)) notFound();
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  const found = await getCatalogItem(slug, itemSlug, locale, await getPriceLabels(locale));
  if (!found) {
    const canonical = await canonicalSlugs(slug, itemSlug, locale);
    if (canonical) permanentRedirect({ href: { pathname: "/[slug]/[item]", params: canonical }, locale });
    notFound();
  }

  return <ItemDetailView locale={locale} section={found.section} item={found.item} />;
}

/** This locale's section and item slugs of the public item addressed by another locale's slugs, unless unchanged. */
async function canonicalSlugs(
  slug: string,
  itemSlug: string,
  locale: Locale,
): Promise<{ slug: string; item: string } | null> {
  for (const fromLocale of routing.locales) {
    if (fromLocale === locale) continue;
    const canonical = await resolveCatalogItemSlugs(slug, itemSlug, fromLocale, locale);
    if (canonical && (canonical.slug !== slug || canonical.item !== itemSlug)) return canonical;
  }
  return null;
}
