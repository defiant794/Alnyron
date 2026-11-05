import type { Locale } from "next-intl";
import { cache } from "react";
import { EXTERNAL_LINK_KEYS, URL_SLUG_LOCALE, type CatalogKind, type ExternalLinkKey } from "@/config/catalog";
import { languageAlternates, type LocalePaths } from "@/i18n/alternates";
import { getPathname, pathsInEveryLocale } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { formatPrice, type FormattedPrice, type PriceLabels } from "@/lib/format-price";
import { resolveContent } from "@/lib/i18n/resolve-content";
import { publicMediaUrl } from "@/lib/public-media-url";
import { getPublicClient } from "@/lib/supabase/public";
import type { Json } from "@/types/database";

/** One image of a catalog item, ready for `next/image`. */
export interface CatalogImage {
  id: string;
  src: string;
  alt: string;
  /** `"da"` when the alt text is the Danish fallback on another locale (WCAG 3.1.2). */
  lang?: Locale;
  width: number;
  height: number;
}

/** Search-engine title and description, already falling back to the visible text. */
export interface CatalogSeo {
  title: string;
  description: string;
}

/** A published item of a public section, resolved for one locale. */
export interface PublicCatalogItem {
  id: string;
  /** Item URL slug: its `URL_SLUG_LOCALE` (English) slug, the same on every locale. */
  slug: string;
  /** Locale-aware path of the item page (`/services/web-development`, `/en/services/web-development`). */
  href: string;
  /** The item page's path in every locale it exists in (hreflang alternates). */
  paths: LocalePaths;
  title: string;
  /** Short card text; `""` when neither locale has one. */
  summary: string;
  /** Markdown body (render with `sanitizeMarkdown`). */
  bodyMd: string;
  /** `formatPrice` of the price columns; `null` when the item shows no price. */
  price: FormattedPrice | null;
  featured: boolean;
  /** Valid https links by key, in no particular order. */
  externalLinks: Partial<Record<ExternalLinkKey, string>>;
  /** Images in `sort_order`. */
  media: CatalogImage[];
  seo: CatalogSeo;
  /** Fields shown from the Danish row (`"title"`, `"summary"`, `"bodyMd"`): render with `lang="da"`. */
  fallbackKeys: string[];
}

/** A public catalog section (category page), resolved for one locale. */
export interface PublicCatalogSection {
  id: string;
  kind: CatalogKind;
  title: string;
  /** Lead under the title; `""` when neither locale has one. */
  description: string;
  /** Locale-aware path of the section page (`/services`, `/en/services`). */
  href: string;
  /** The section page's path in every locale: a public section exists in each (hreflang alternates). */
  paths: Record<Locale, string>;
  seo: CatalogSeo;
  /** Fields shown from the Danish row (`"title"`, `"description"`): render with `lang="da"`. */
  fallbackKeys: string[];
  /** Published items: featured first, then by `sort_order`. */
  items: PublicCatalogItem[];
}

/** `generateStaticParams` entry of a section page. */
export interface CatalogSectionParams {
  locale: Locale;
  slug: string;
}

/**
 * `generateStaticParams` entry of an item page. Next.js adds the parent
 * section page's `{ locale, slug }` to each.
 */
export interface CatalogItemParams {
  item: string;
}

/** One sitemap entry of a public section or item page. */
export interface CatalogSitemapEntry {
  /** Site-relative URL (`/services`, `/en/services/web-development`); `app/sitemap.ts` makes it absolute. */
  url: string;
  /** Latest change of the page's own rows. */
  lastModified?: Date;
  /** hreflang alternates, site-relative like `url`. */
  alternates: { languages: Record<string, string> };
}

type Status = "draft" | "published";
type RouteRow = { locale: Locale; slug: string };

/**
 * One public section with everything its pages show. `match` (an inner join
 * on `routes`) picks the category by its URL slug (its `URL_SLUG_LOCALE`
 * route).
 */
const SECTION_SELECT = `id, kind, status,
  category_translations(locale, title, description, seo_title, seo_description),
  items(id, status, sort_order, featured, price_type, price_amount, price_currency, external_links,
    item_translations(locale, slug, title, summary, body_md, seo_title, seo_description),
    media(id, storage_path, alt_da, alt_en, width, height, sort_order)),
  match:routes!inner(locale, slug)`;

/**
 * The category whose URL slug is `slug`, with its translations and items.
 * Anonymous RLS returns it only when it is published and holds a
 * published item, and embeds only published items and their media. The slug
 * is the same on every locale, so a request's pages (and their
 * `generateMetadata`) share one cached query.
 *
 * @throws when the query fails, so a broken read never caches a 404.
 */
const loadSection = cache(async (slug: string) => {
  const { data, error } = await getPublicClient()
    .from("categories")
    .select(SECTION_SELECT)
    .eq("match.locale", URL_SLUG_LOCALE)
    .eq("match.slug", slug)
    .maybeSingle();
  if (error) throw new Error(`Failed to load the catalog section "${slug}": ${error.message}`);
  return data;
});

type SectionRow = NonNullable<Awaited<ReturnType<typeof loadSection>>>;
type ItemRow = SectionRow["items"][number];

/**
 * The public catalog section whose URL slug is `slug`, resolved for
 * `locale`, or `null` when no public section has it (unknown, a draft, no
 * published item, or no title in either locale). The URL slug is the
 * section's English route slug on every locale; a Danish route slug is no
 * address. Text falls back to Danish per field. Prices are formatted with
 * `labels` (the page's `Catalog.price` messages).
 *
 * @throws when the query fails.
 */
export async function getCatalogSection(
  slug: string,
  locale: Locale,
  labels: PriceLabels,
): Promise<PublicCatalogSection | null> {
  const row = await loadSection(slug);
  return row && toSection(row, slug, locale, labels);
}

/**
 * A published item of the public section `categorySlug`, by its URL slug
 * (its English slug on every locale), with that section (breadcrumb,
 * alternates); `null` when either is not public, the item has no
 * translation in `locale`, or it is not in that section.
 *
 * @throws when the query fails.
 */
export async function getCatalogItem(
  categorySlug: string,
  itemSlug: string,
  locale: Locale,
  labels: PriceLabels,
): Promise<{ section: PublicCatalogSection; item: PublicCatalogItem } | null> {
  const section = await getCatalogSection(categorySlug, locale, labels);
  const item = section?.items.find((candidate) => candidate.slug === itemSlug);
  return section && item ? { section, item } : null;
}

/**
 * Every public section page to prerender: one `{ locale, slug }` per locale
 * for each published category that holds a published item, all with its
 * URL slug (the English route slug).
 *
 * @throws when the query fails, so a broken read never fails a build silently.
 */
export async function getCatalogStaticParams(): Promise<CatalogSectionParams[]> {
  const { data, error } = await getPublicClient()
    .from("categories")
    .select("status, routes(locale, slug), items(status)");
  if (error) throw new Error(`Failed to load the catalog sections: ${error.message}`);

  return (data ?? []).filter(isPublicCategory).flatMap((category) => {
    const slug = slugIn(category.routes, URL_SLUG_LOCALE);
    return slug ? routing.locales.map((locale) => ({ locale, slug })) : [];
  });
}

/**
 * The item pages to prerender below one section page: one `{ item }` (the
 * item's URL slug) per published item with a translation in `locale`, when
 * the section whose URL slug is `slug` is public; `[]` otherwise. Next.js
 * runs the item route's `generateStaticParams` once per section page, so
 * each call reads only that section.
 *
 * @throws when the query fails.
 */
export async function getItemStaticParams(slug: string, locale: Locale): Promise<CatalogItemParams[]> {
  const { data, error } = await getPublicClient()
    .from("categories")
    .select("status, items(status, item_translations(locale, slug)), match:routes!inner(locale, slug)")
    .eq("match.locale", URL_SLUG_LOCALE)
    .eq("match.slug", slug)
    .maybeSingle();
  if (error) throw new Error(`Failed to load the catalog items of "${slug}": ${error.message}`);
  if (!data || !isPublicCategory(data)) return [];

  return data.items.filter(isPublished).flatMap((item) => {
    const itemSlug = slugIn(item.item_translations, URL_SLUG_LOCALE);
    const translated = item.item_translations.some((translation) => translation.locale === locale);
    return itemSlug && translated ? [{ item: itemSlug }] : [];
  });
}

/**
 * Sitemap entries of every public section and item page, in each locale it
 * exists in, with hreflang alternates (`x-default` = Danish). Every locale
 * shares the English URL slugs; URLs are site-relative.
 *
 * @throws when the query fails, so a broken read never publishes an empty sitemap.
 */
export async function getCatalogSitemapEntries(): Promise<CatalogSitemapEntry[]> {
  const { data, error } = await getPublicClient()
    .from("categories")
    .select("status, updated_at, routes(locale, slug), items(status, updated_at, item_translations(locale, slug))");
  if (error) throw new Error(`Failed to load the catalog sitemap: ${error.message}`);

  const entries: CatalogSitemapEntry[] = [];
  for (const category of (data ?? []).filter(isPublicCategory)) {
    const sectionSlug = slugIn(category.routes, URL_SLUG_LOCALE);
    if (!sectionSlug) continue;
    const items = category.items.filter(isPublished);
    entries.push(
      ...sitemapEntries(
        sectionPaths(sectionSlug),
        latest([category.updated_at, ...items.map((item) => item.updated_at)]),
      ),
    );
    for (const item of items) {
      entries.push(...sitemapEntries(itemPaths(sectionSlug, item.item_translations), latest([item.updated_at])));
    }
  }
  return entries;
}

// ── Row mapping ──────────────────────────────────────────────────────────────

/** The section for `locale` below its URL slug `slug`, or `null` when it is a draft, has no title or no item. */
function toSection(row: SectionRow, slug: string, locale: Locale, labels: PriceLabels): PublicCatalogSection | null {
  if (row.status !== "published") return null;

  const da = row.category_translations.find((translation) => translation.locale === "da");
  const own = row.category_translations.find((translation) => translation.locale === locale);
  const text = resolveContent(
    { title: da?.title ?? "", description: da?.description ?? "" },
    own && { title: own.title, description: own.description },
    locale,
  );
  if (text.value.title.trim() === "") return null;

  const items = row.items
    .filter(isPublished)
    .toSorted((a, b) => Number(b.featured) - Number(a.featured) || a.sort_order - b.sort_order)
    .flatMap((item) => toItem(item, slug, locale, labels) ?? []);
  if (items.length === 0) return null;

  const seo = resolveContent(
    { title: da?.seo_title ?? "", description: da?.seo_description ?? "" },
    own && { title: own.seo_title, description: own.seo_description },
    locale,
  ).value;

  const paths = sectionPaths(slug);
  return {
    id: row.id,
    kind: row.kind,
    title: text.value.title,
    description: text.value.description,
    href: paths[locale],
    paths,
    seo: {
      title: seo.title.trim() || text.value.title,
      description: seo.description.trim() || text.value.description,
    },
    fallbackKeys: text.fallbackKeys,
    items,
  };
}

/**
 * The item for `locale`, or `null` when it has no Danish row, no row in
 * `locale`, no URL slug (English row) or no title.
 */
function toItem(
  row: ItemRow,
  sectionSlug: string,
  locale: Locale,
  labels: PriceLabels,
): PublicCatalogItem | null {
  const da = row.item_translations.find((translation) => translation.locale === "da");
  const own = row.item_translations.find((translation) => translation.locale === locale);
  const slug = slugIn(row.item_translations, URL_SLUG_LOCALE);
  if (!da || !own || !slug) return null;

  const text = resolveContent(
    { title: da.title, summary: da.summary, bodyMd: da.body_md },
    { title: own.title, summary: own.summary, bodyMd: own.body_md },
    locale,
  );
  if (text.value.title.trim() === "") return null;

  const paths = itemPaths(sectionSlug, row.item_translations);
  const href = paths[locale];
  if (!href) return null;

  const seo = resolveContent(
    { title: da.seo_title, description: da.seo_description },
    { title: own.seo_title, description: own.seo_description },
    locale,
  ).value;

  return {
    id: row.id,
    slug,
    href,
    paths,
    title: text.value.title,
    summary: text.value.summary,
    bodyMd: text.value.bodyMd,
    price: formatPrice(
      { type: row.price_type, amount: row.price_amount, currency: row.price_currency },
      locale,
      labels,
    ),
    featured: row.featured,
    externalLinks: toExternalLinks(row.external_links),
    media: row.media
      .toSorted((a, b) => a.sort_order - b.sort_order)
      .map((media) => {
        const ownAlt = locale === "da" ? media.alt_da : media.alt_en;
        const fallback = ownAlt.trim() === "";
        return {
          id: media.id,
          src: publicMediaUrl(media.storage_path),
          alt: fallback ? media.alt_da : ownAlt,
          ...(fallback && { lang: "da" as const }),
          width: media.width,
          height: media.height,
        };
      }),
    seo: {
      title: seo.title.trim() || text.value.title,
      description: seo.description.trim() || text.value.summary,
    },
    fallbackKeys: text.fallbackKeys,
  };
}

/**
 * The https links of `items.external_links` under a known key. The
 * `items_external_links_valid` CHECK already guarantees this; anything else
 * is dropped rather than linked.
 */
function toExternalLinks(links: Json): Partial<Record<ExternalLinkKey, string>> {
  if (typeof links !== "object" || links === null || Array.isArray(links)) return {};
  const valid: Partial<Record<ExternalLinkKey, string>> = {};
  for (const key of EXTERNAL_LINK_KEYS) {
    const url = links[key];
    if (typeof url === "string" && URL.canParse(url) && new URL(url).protocol === "https:") valid[key] = url;
  }
  return valid;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isPublished(row: { status: Status }): boolean {
  return row.status === "published";
}

/** Published and holding a published item: what `private.category_is_public` lets anonymous RLS return. */
function isPublicCategory(category: { status: Status; items: { status: Status }[] }): boolean {
  return isPublished(category) && category.items.some(isPublished);
}

function slugIn(rows: readonly RouteRow[], locale: Locale): string | undefined {
  return rows.find((row) => row.locale === locale)?.slug;
}

/** Section page path in every locale: the same URL slug below each locale's prefix. */
function sectionPaths(slug: string): Record<Locale, string> {
  return pathsInEveryLocale({ pathname: "/[slug]", params: { slug } });
}

/**
 * Item page path in each locale the item has a translation in, all with its
 * URL slug (`translations` row in `URL_SLUG_LOCALE`); none without one.
 */
function itemPaths(sectionSlug: string, translations: readonly RouteRow[]): LocalePaths {
  const paths: LocalePaths = {};
  const item = slugIn(translations, URL_SLUG_LOCALE);
  if (!item) return paths;
  for (const locale of routing.locales) {
    if (!translations.some((translation) => translation.locale === locale)) continue;
    paths[locale] = getPathname({ href: { pathname: "/[slug]/[item]", params: { slug: sectionSlug, item } }, locale });
  }
  return paths;
}

/** One sitemap entry per locale the page exists in, all sharing the same alternates. */
function sitemapEntries(paths: LocalePaths, lastModified: Date | undefined): CatalogSitemapEntry[] {
  const languages = languageAlternates(paths);
  return entries(paths).map(([, url]) => ({ url, lastModified, alternates: { languages } }));
}

/** The latest of the given timestamps; `undefined` when none is present. */
function latest(timestamps: readonly (string | null | undefined)[]): Date | undefined {
  const times = timestamps.filter((value): value is string => typeof value === "string").map(Date.parse);
  return times.length > 0 ? new Date(Math.max(...times)) : undefined;
}

/** The defined entries of a per-locale record. */
function entries(record: LocalePaths): [Locale, string][] {
  return Object.entries(record).filter((entry): entry is [Locale, string] => typeof entry[1] === "string");
}
