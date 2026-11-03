import { z } from "zod";
import {
  CATALOG_KINDS,
  CATEGORY_TEXT_LIMITS,
  EXTERNAL_LINK_KEYS,
  EXTERNAL_LINK_MAX_LENGTH,
  ITEM_TEXT_LIMITS,
  ITEMS_REORDER_MAX,
  MEDIA_ALT_MAX,
  MEDIA_MAX_BYTES,
  MEDIA_MAX_PER_ITEM,
  MEDIA_MIME_TYPES,
  PRICE_AMOUNT_MAX,
  PRICE_CURRENCY,
  RESERVED_ROUTE_SLUGS,
  SLUG_MAX_LENGTH,
  SLUG_PATTERN,
  type PriceType,
} from "@/config/catalog";
import { DA_TITLE_REQUIRED } from "@/lib/validation/pages";
import type { Database } from "@/types/database";

/**
 * Write schemas for the catalog admin RPCs (F2.1). Each mirrors the DB
 * CHECK constraints, so an input that passes here only fails in the DB on
 * state (a slug taken, an unknown id), never on shape. A failed rule carries
 * one of the issue messages below, which the services turn into the
 * matching `CatalogActionError` code.
 */

export { DA_TITLE_REQUIRED };
/**
 * Slug not in the slug format (`routes_slug_format`, `item_translations` slug
 * CHECK), or a reserved route slug (`routes_slug_reserved`).
 */
export const SLUG_INVALID = "slug-invalid";
/** Price type/amount combination `items_price_consistent` rejects, or an amount outside `numeric(12,2)`. */
export const PRICE_INVALID = "price-invalid";
/** An external link the `items_external_links_valid` CHECK rejects (unknown key, not an https URL). */
export const LINKS_INVALID = "links-invalid";
/** Blank Danish alt text (`media_alt_da_check`). */
export const ALT_REQUIRED = "alt-required";
/** More images than an item may hold. */
export const TOO_MANY_MEDIA = "too-many-media";
/** Upload larger than the `media` bucket's size limit. */
export const TOO_LARGE = "too-large";
/** Upload type the `media` bucket does not accept. */
export const UNSUPPORTED_TYPE = "unsupported-type";

const EXTERNAL_LINK_PATTERN = /^https:\/\/[^\s<>"]+$/;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** The object names `private.media_path_valid` accepts: `items/{item id}/{uuid}.{ext}`. */
const MEDIA_PATH_PATTERN = new RegExp(`^items/(${UUID})/${UUID}\\.(jpg|jpeg|png|webp|avif)$`);
const RESERVED_ROUTE_SLUG_SET: ReadonlySet<string> = new Set(RESERVED_ROUTE_SLUGS);

/** A row id (any UUID-shaped string; PostgREST errors on others instead of returning nothing). */
export const uuidSchema = z.guid();

type ContentStatus = Database["public"]["Enums"]["content_status"];

export const contentStatusSchema = z.enum(["draft", "published"] as const satisfies readonly ContentStatus[]);

/** An item slug (`item_translations` slug CHECK): lower-case `a-z0-9` words joined by single dashes, at most 80. */
export const slugSchema = z
  .string({ error: SLUG_INVALID })
  .max(SLUG_MAX_LENGTH, { error: SLUG_INVALID })
  .regex(SLUG_PATTERN, { error: SLUG_INVALID });

/**
 * A route slug (a category's or page's top-level path): the slug format and
 * none of {@link RESERVED_ROUTE_SLUGS} (`routes_slug_format`, `routes_slug_reserved`).
 */
export const routeSlugSchema = slugSchema.refine((slug) => !RESERVED_ROUTE_SLUG_SET.has(slug), {
  error: SLUG_INVALID,
});

/** A non-blank title (mirrors the `*_da_title` CHECKs, which compare `btrim(title)`). */
function daTitle(max: number) {
  return z
    .string()
    .max(max)
    .refine((title) => title.trim() !== "", { error: DA_TITLE_REQUIRED });
}

/** One locale of a category. `slug` (when given) sets the locale's route; absent keeps it. */
function categoryTranslationSchema(title: z.ZodType<string>) {
  return z.object({
    title,
    description: z.string().max(CATEGORY_TEXT_LIMITS.description),
    seo_title: z.string().max(CATEGORY_TEXT_LIMITS.seo_title),
    seo_description: z.string().max(CATEGORY_TEXT_LIMITS.seo_description),
    slug: routeSlugSchema.optional(),
  });
}

/**
 * A category save (`admin_save_category`): no `id` creates a draft category
 * and needs `kind`; with `id`, `kind` is ignored (it never changes). Each
 * given locale's text replaces the stored one; Danish is always given.
 */
export const saveCategorySchema = z
  .object({
    id: uuidSchema.optional(),
    kind: z.enum(CATALOG_KINDS).optional(),
    featured: z.boolean().optional(),
    nav_order: z.int32().optional(),
    translations: z.object({
      da: categoryTranslationSchema(daTitle(CATEGORY_TEXT_LIMITS.title)),
      en: categoryTranslationSchema(z.string().max(CATEGORY_TEXT_LIMITS.title)).optional(),
    }),
  })
  .refine((category) => category.id !== undefined || category.kind !== undefined, {
    error: "kind-required",
    path: ["kind"],
  });

export type SaveCategoryInput = z.infer<typeof saveCategorySchema>;

/** One locale of an item: every column, since a save replaces the stored row. */
function itemTranslationSchema(title: z.ZodType<string>) {
  return z.object({
    slug: slugSchema,
    title,
    summary: z.string().max(ITEM_TEXT_LIMITS.summary),
    body_md: z.string().max(ITEM_TEXT_LIMITS.body_md),
    seo_title: z.string().max(ITEM_TEXT_LIMITS.seo_title),
    seo_description: z.string().max(ITEM_TEXT_LIMITS.seo_description),
  });
}

const externalLinkSchema = z
  .string({ error: LINKS_INVALID })
  .max(EXTERNAL_LINK_MAX_LENGTH, { error: LINKS_INVALID })
  .regex(EXTERNAL_LINK_PATTERN, { error: LINKS_INVALID });

/** `items.external_links`: only {@link EXTERNAL_LINK_KEYS}, each an https URL (an unknown key fails). */
const externalLinksSchema = z.partialRecord(z.enum(EXTERNAL_LINK_KEYS), externalLinkSchema.optional(), {
  error: LINKS_INVALID,
});

/** A price fits `numeric(12,2)`: 0 to 9 999 999 999.99, at most two decimals. */
const priceAmountSchema = z
  .number({ error: PRICE_INVALID })
  .min(0, { error: PRICE_INVALID })
  .max(PRICE_AMOUNT_MAX, { error: PRICE_INVALID })
  .refine((amount) => Math.round(amount * 100) / 100 === amount, { error: PRICE_INVALID });

const PRICE_TYPES = ["fixed", "from", "contact"] as const satisfies readonly PriceType[];

/** `items_price_consistent`: no price, a contact price without amount, or a fixed/from price with one. */
function priceConsistent(type: PriceType | null, amount: number | null): boolean {
  if (type === null || type === "contact") return amount === null;
  return amount !== null;
}

/** Danish alt text: non-blank (`media_alt_da_check`), at most {@link MEDIA_ALT_MAX} (`media_alt_da_length`). */
const altDaSchema = z
  .string()
  .max(MEDIA_ALT_MAX)
  .refine((alt) => alt.trim() !== "", { error: ALT_REQUIRED });

/** English alt text: may be blank, at most {@link MEDIA_ALT_MAX} (`media_alt_en_length`). */
const altEnSchema = z.string().max(MEDIA_ALT_MAX).default("");

/** Alt text and position of one of the item's images. */
const mediaEntrySchema = z.object({
  id: uuidSchema,
  alt_da: altDaSchema,
  alt_en: altEnSchema,
  sort_order: z.int32(),
});

/**
 * An item save (`admin_save_item`): no `id` creates a draft item at the end
 * of `category_id` (required then; fixed afterwards). The price, currency and
 * links are always sent and replace the stored ones; `media` updates the alt
 * text and order of the item's own images.
 */
export const saveItemSchema = z
  .object({
    id: uuidSchema.optional(),
    category_id: uuidSchema.optional(),
    featured: z.boolean().optional(),
    price_type: z.enum(PRICE_TYPES, { error: PRICE_INVALID }).nullable(),
    price_amount: priceAmountSchema.nullable(),
    price_currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .default(PRICE_CURRENCY),
    external_links: externalLinksSchema,
    translations: z.object({
      da: itemTranslationSchema(daTitle(ITEM_TEXT_LIMITS.title)),
      en: itemTranslationSchema(z.string().max(ITEM_TEXT_LIMITS.title)).optional(),
    }),
    media: z.array(mediaEntrySchema).max(MEDIA_MAX_PER_ITEM, { error: TOO_MANY_MEDIA }).optional(),
  })
  .refine((item) => item.id !== undefined || item.category_id !== undefined, {
    error: "category-required",
    path: ["category_id"],
  })
  .refine((item) => priceConsistent(item.price_type, item.price_amount), {
    error: PRICE_INVALID,
    path: ["price_amount"],
  });

export type SaveItemInput = z.infer<typeof saveItemSchema>;

export const categoryStatusSchema = z.object({ categoryId: uuidSchema, status: contentStatusSchema });

export const itemStatusSchema = z.object({ itemId: uuidSchema, status: contentStatusSchema });

/**
 * A category's items in their new order (first id = first place), no repeats,
 * at most {@link ITEMS_REORDER_MAX} (`admin_reorder_items` bound). Ids compare
 * case-insensitively: `z.guid()` accepts mixed-case hex, and two spellings of
 * one uuid are the same row to `admin_reorder_items`.
 */
export const reorderItemsSchema = z.object({
  categoryId: uuidSchema,
  itemIds: z
    .array(uuidSchema)
    .max(ITEMS_REORDER_MAX)
    .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, {
      error: "duplicate-item-id",
    }),
});

/** An image the admin is about to upload for `itemId` (checked before a signed upload URL is issued). */
export const mediaUploadSchema = z.object({
  itemId: uuidSchema,
  mimeType: z.enum(MEDIA_MIME_TYPES, { error: UNSUPPORTED_TYPE }),
  size: z.int().min(1).max(MEDIA_MAX_BYTES, { error: TOO_LARGE }),
});

/** An uploaded object to attach to its item: the path must lie in that item's folder. */
export const attachMediaSchema = z
  .object({
    itemId: uuidSchema,
    path: z.string().regex(MEDIA_PATH_PATTERN),
    alt_da: altDaSchema,
    alt_en: altEnSchema,
    width: z.int32().positive(),
    height: z.int32().positive(),
  })
  .refine((media) => MEDIA_PATH_PATTERN.exec(media.path)?.[1] === media.itemId.toLowerCase(), {
    error: "path-item-mismatch",
    path: ["path"],
  });
