import type { Locale } from "next-intl";
import {
  EXTERNAL_LINK_KEYS,
  URL_SLUG_LOCALE,
  type CatalogKind,
  type ExternalLinkKey,
  type PriceType,
} from "@/config/catalog";
import type { Price } from "@/lib/format-price";
import { createServerClient } from "@/lib/supabase/server";
import { uuidSchema } from "@/lib/validation/catalog";
import type { Database, Json } from "@/types/database";

/**
 * Admin reads for the catalog editors (F2.3). They run under the admin's RLS
 * rights, which see drafts and every locale; the writes stay in
 * `services/admin/catalog.ts` and `media.ts`.
 */

export type ContentStatus = Database["public"]["Enums"]["content_status"];

/** One section of the catalog overview. */
export interface AdminCatalogSection {
  id: string;
  kind: CatalogKind;
  status: ContentStatus;
  /** The Danish title (blank only if the Danish row is missing). */
  title: string;
  /** The URL slug (English route slug, the public path on every locale), `null` when the section has none. */
  slug: string | null;
  publishedCount: number;
  draftCount: number;
}

/** One locale of a section as the section editor shows it. */
export interface AdminCategoryTranslation {
  title: string;
  description: string;
  seo_title: string;
  seo_description: string;
  /** The locale's route slug, `null` when the section has none. */
  slug: string | null;
}

/** One item in the section editor's list. */
export interface AdminCategoryItem {
  id: string;
  /** The Danish title. */
  title: string;
  status: ContentStatus;
  featured: boolean;
  price: Price;
}

/** A section loaded for the section editor, its items in their order. */
export interface AdminCategoryDetail {
  id: string;
  kind: CatalogKind;
  status: ContentStatus;
  translations: Record<Locale, AdminCategoryTranslation>;
  items: AdminCategoryItem[];
}

/** One locale of an item as the item editor shows it. */
export interface AdminItemTranslation {
  slug: string;
  title: string;
  summary: string;
  body_md: string;
  seo_title: string;
  seo_description: string;
}

/** One image of an item, in its order. */
export interface AdminItemMedia {
  id: string;
  path: string;
  altDa: string;
  altEn: string;
}

/** An item loaded for the item editor. */
export interface AdminItemDetail {
  id: string;
  categoryId: string;
  status: ContentStatus;
  featured: boolean;
  priceType: PriceType | null;
  priceAmount: number | null;
  /** Valid https links by key (the `items_external_links_valid` CHECK guarantees the shape). */
  externalLinks: Partial<Record<ExternalLinkKey, string>>;
  /** `null` for a locale without a row (an item always has a Danish one). */
  translations: Record<Locale, AdminItemTranslation | null>;
  media: AdminItemMedia[];
}

/**
 * The catalog sections for the overview, in nav order, with their Danish
 * title, URL slug and how many items are published and drafts.
 *
 * @throws when the query fails.
 */
export async function listCatalogSections(): Promise<AdminCatalogSection[]> {
  const supabase = await createServerClient();
  const { data, error } = await supabase
    .from("categories")
    .select("id, kind, status, category_translations(locale, title), routes(locale, slug), items(status)")
    .order("nav_order")
    .order("created_at");
  if (error) throw new Error(`Failed to load the catalog sections: ${error.message}`);

  return data.map((category) => ({
    id: category.id,
    kind: category.kind,
    status: category.status,
    title: category.category_translations.find((row) => row.locale === "da")?.title ?? "",
    slug: category.routes.find((row) => row.locale === URL_SLUG_LOCALE)?.slug ?? null,
    publishedCount: category.items.filter((item) => item.status === "published").length,
    draftCount: category.items.filter((item) => item.status === "draft").length,
  }));
}

/**
 * The id of the first section of `kind` (in nav order), or `null` when there
 * is none: the sidebar's kind shortcuts open that section.
 *
 * @throws when the query fails.
 */
export async function getCategoryIdForKind(kind: CatalogKind): Promise<string | null> {
  const supabase = await createServerClient();
  const { data, error } = await supabase
    .from("categories")
    .select("id")
    .eq("kind", kind)
    .order("nav_order")
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to load the ${kind} section: ${error.message}`);
  return data?.id ?? null;
}

/**
 * A section with both locales and its items (by `sort_order`) for the
 * section editor, or `null` when `id` names no section. A missing locale
 * row reads as blank fields.
 *
 * @throws when the query fails.
 */
export async function getCategoryForEdit(id: string): Promise<AdminCategoryDetail | null> {
  if (!uuidSchema.safeParse(id).success) return null;

  const supabase = await createServerClient();
  const { data, error } = await supabase
    .from("categories")
    .select(
      `id, kind, status,
       category_translations(locale, title, description, seo_title, seo_description),
       routes(locale, slug),
       items(id, status, featured, sort_order, created_at, price_type, price_amount, price_currency,
         item_translations(locale, title))`,
    )
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Failed to load the catalog section: ${error.message}`);
  if (!data) return null;

  const translation = (locale: Locale): AdminCategoryTranslation => {
    const row = data.category_translations.find((candidate) => candidate.locale === locale);
    return {
      title: row?.title ?? "",
      description: row?.description ?? "",
      seo_title: row?.seo_title ?? "",
      seo_description: row?.seo_description ?? "",
      slug: data.routes.find((route) => route.locale === locale)?.slug ?? null,
    };
  };

  const items = data.items
    .toSorted((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at))
    .map((item) => ({
      id: item.id,
      title: item.item_translations.find((row) => row.locale === "da")?.title ?? "",
      status: item.status,
      featured: item.featured,
      price: { type: item.price_type, amount: item.price_amount, currency: item.price_currency },
    }));

  return {
    id: data.id,
    kind: data.kind,
    status: data.status,
    translations: { da: translation("da"), en: translation("en") },
    items,
  };
}

/**
 * An item with both locales and its images (by `sort_order`) for the item
 * editor, or `null` when `id` names no item.
 *
 * @throws when the query fails.
 */
export async function getItemForEdit(id: string): Promise<AdminItemDetail | null> {
  if (!uuidSchema.safeParse(id).success) return null;

  const supabase = await createServerClient();
  const { data, error } = await supabase
    .from("items")
    .select(
      `id, category_id, status, featured, price_type, price_amount, external_links,
       item_translations(locale, slug, title, summary, body_md, seo_title, seo_description),
       media(id, storage_path, alt_da, alt_en, sort_order, created_at)`,
    )
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Failed to load the catalog item: ${error.message}`);
  if (!data) return null;

  const translation = (locale: Locale): AdminItemTranslation | null => {
    const row = data.item_translations.find((candidate) => candidate.locale === locale);
    return row
      ? {
          slug: row.slug,
          title: row.title,
          summary: row.summary,
          body_md: row.body_md,
          seo_title: row.seo_title,
          seo_description: row.seo_description,
        }
      : null;
  };

  return {
    id: data.id,
    categoryId: data.category_id,
    status: data.status,
    featured: data.featured,
    priceType: data.price_type,
    priceAmount: data.price_amount,
    externalLinks: externalLinks(data.external_links),
    translations: { da: translation("da"), en: translation("en") },
    media: data.media
      .toSorted((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at))
      .map((row) => ({ id: row.id, path: row.storage_path, altDa: row.alt_da, altEn: row.alt_en })),
  };
}

/** The string links of `items.external_links` under a known key. */
function externalLinks(links: Json): Partial<Record<ExternalLinkKey, string>> {
  if (typeof links !== "object" || links === null || Array.isArray(links)) return {};
  const result: Partial<Record<ExternalLinkKey, string>> = {};
  for (const key of EXTERNAL_LINK_KEYS) {
    const value = links[key];
    if (typeof value === "string") result[key] = value;
  }
  return result;
}
