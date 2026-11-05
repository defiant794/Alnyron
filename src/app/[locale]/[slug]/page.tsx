import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import CatalogIndexView from "@/components/site/CatalogIndexView";
import { languageAlternates } from "@/i18n/alternates";
import { getPriceLabels } from "@/i18n/price-labels";
import { routing } from "@/i18n/routing";
import { isValidSlug } from "@/lib/slugify";
import { getCatalogSection, getCatalogStaticParams } from "@/services/content/catalog";

type SectionProps = Readonly<{ params: Promise<{ locale: string; slug: string }> }>;

/**
 * Prerender every public section in the layout's locale (every locale gets
 * the same English URL slugs). A section published later renders on its
 * first request (ISR); revalidation inherits the `[locale]` layout's
 * `revalidate`.
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
 * Catalog section page (`/websites`, `/en/websites`; approved section mock).
 * The slug is the section's English route slug on every locale. A slug that
 * is not a public section answers 404: malformed slugs (before any DB read),
 * unknown slugs, a draft section or one without a published item, routes of
 * custom pages (not rendered yet) and a section's route slug in another
 * locale (no address; nothing redirects).
 */
export default async function CatalogSection({ params }: SectionProps) {
  const { locale, slug } = await params;
  // The 404 is never written to the KV page cache either (open-next.config.ts).
  if (!isValidSlug(slug)) notFound();
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  const section = await getCatalogSection(slug, locale, await getPriceLabels(locale));
  if (!section) notFound();

  return <CatalogIndexView locale={locale} section={section} />;
}
