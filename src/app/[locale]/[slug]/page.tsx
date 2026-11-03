import type { Metadata } from "next";
import { hasLocale, type Locale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import CatalogIndexView from "@/components/site/CatalogIndexView";
import { languageAlternates } from "@/i18n/alternates";
import { permanentRedirect } from "@/i18n/navigation";
import { getPriceLabels } from "@/i18n/price-labels";
import { routing } from "@/i18n/routing";
import { isValidSlug } from "@/lib/slugify";
import { getCatalogSection, getCatalogStaticParams, resolveCatalogSlug } from "@/services/content/catalog";

type SectionProps = Readonly<{ params: Promise<{ locale: string; slug: string }> }>;

/**
 * Prerender every public section in the layout's locale. A section published
 * later renders on its first request (ISR); revalidation inherits the
 * `[locale]` layout's `revalidate`.
 */
export async function generateStaticParams({ params }: { params: { locale: string } }) {
  const sections = await getCatalogStaticParams();
  return sections.filter((section) => section.locale === params.locale).map(({ slug }) => ({ slug }));
}

/**
 * SEO title/description (DB, falling back to the section's title and lead)
 * and hreflang alternates. A malformed slug answers 404 before any DB read.
 */
export async function generateMetadata({ params }: SectionProps): Promise<Metadata> {
  const { locale, slug } = await params;
  if (!isValidSlug(slug)) notFound();
  if (!hasLocale(routing.locales, locale)) return {};
  const section = await getCatalogSection(slug, locale, await getPriceLabels(locale));
  if (!section) return {};
  return {
    title: section.seo.title,
    ...(section.seo.description && { description: section.seo.description }),
    alternates: { canonical: section.href, languages: languageAlternates(section.paths) },
  };
}

/**
 * Catalog section page (`/ydelser`, `/en/services`; approved section mock).
 * A route slug that is not a public section answers 404: malformed slugs
 * (before any DB read), unknown slugs, a draft section or one without a
 * published item, and routes of custom pages (not rendered yet). A slug of
 * another locale (the language switch keeps the slug: `/en/ydelser`)
 * redirects permanently to this locale's slug.
 */
export default async function CatalogSection({ params }: SectionProps) {
  const { locale, slug } = await params;
  // The 404 is never written to the KV page cache either (open-next.config.ts).
  if (!isValidSlug(slug)) notFound();
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  const section = await getCatalogSection(slug, locale, await getPriceLabels(locale));
  if (!section) {
    const canonical = await canonicalSlug(slug, locale);
    if (canonical) permanentRedirect({ href: { pathname: "/[slug]", params: { slug: canonical } }, locale });
    notFound();
  }

  return <CatalogIndexView locale={locale} section={section} />;
}

/** This locale's slug of the public section whose slug in another locale is `slug`, unless it is `slug` itself. */
async function canonicalSlug(slug: string, locale: Locale): Promise<string | null> {
  for (const fromLocale of routing.locales) {
    if (fromLocale === locale) continue;
    const canonical = await resolveCatalogSlug(slug, fromLocale, locale);
    if (canonical && canonical !== slug) return canonical;
  }
  return null;
}
