import type { Database } from "@/types/database";

/** A catalog section (`categories.kind`). */
export type CatalogKind = Database["public"]["Enums"]["catalog_kind"];

/** How an item's price is shown (`items.price_type`); `null` in the DB = no price. */
export type PriceType = Database["public"]["Enums"]["price_type"];

/** Every catalog kind, in the order of the seeded categories. */
export const CATALOG_KINDS = ["apps", "websites", "services", "models3d"] as const satisfies readonly CatalogKind[];

/**
 * Decorative glyph per kind on catalog item cards without an image (render
 * `aria-hidden`). The home page's category cards use {@link KIND_MONOGRAM}.
 * `satisfies Record<CatalogKind, …>` fails to compile when a kind is added to the enum.
 */
export const KIND_GLYPH = {
  apps: "◱",
  websites: "◫",
  services: "▣",
  models3d: "◈",
} as const satisfies Record<CatalogKind, string>;

/**
 * Letter mark per kind on the home page's category cards (approved home
 * mock), rendered `aria-hidden` beside the category title. Item cards without
 * an image use {@link KIND_GLYPH} instead.
 */
export const KIND_MONOGRAM = {
  apps: "A",
  websites: "W",
  services: "S",
  models3d: "3D",
} as const satisfies Record<CatalogKind, string>;

/** The keys `items.external_links` may hold (the `items_external_links_valid` CHECK). */
export const EXTERNAL_LINK_KEYS = ["website", "demo", "app_store", "google_play", "download"] as const;

export type ExternalLinkKey = (typeof EXTERNAL_LINK_KEYS)[number];

/** Max length of one external link URL (the `items_external_links_valid` CHECK). */
export const EXTERNAL_LINK_MAX_LENGTH = 2048;

/** Images per item (the `media_limit_per_item` trigger rejects the 9th: `too_many_media`). */
export const MEDIA_MAX_PER_ITEM = 8;

/** The Storage bucket of catalog images: public reads, writes only under the admin policies. */
export const MEDIA_BUCKET = "media";

/** Max length of an image's alt text in each locale (the `media_alt_da_length` / `media_alt_en_length` CHECKs). */
export const MEDIA_ALT_MAX = 300;

/** Max upload size: 5 MiB, the `media` bucket's `file_size_limit` (5242880). */
export const MEDIA_MAX_BYTES = 5 * 1024 * 1024;

/** The image types the `media` bucket accepts (`allowed_mime_types`, `media.mime_type` CHECK). */
export const MEDIA_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif"] as const;

export type MediaMimeType = (typeof MEDIA_MIME_TYPES)[number];

/** File extension of an uploaded object per type; `admin_attach_media` derives the type back from it. */
export const MEDIA_EXTENSION = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
} as const satisfies Record<MediaMimeType, string>;

/** Currency of every price (`items.price_currency` default). */
export const PRICE_CURRENCY = "DKK";

/** Max length of a route or item slug (`routes_slug_format`, `item_translations` slug CHECK). */
export const SLUG_MAX_LENGTH = 80;

/**
 * Format of a route or item slug (`routes_slug_format`, `item_translations`
 * slug CHECK): lower-case `a-z0-9` words joined by single dashes.
 */
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Slugs no route may take (the `routes_slug_reserved` CHECK): app paths and
 * locale prefixes a page or category slug would shadow. Item slugs live in
 * `item_translations`, below their category's route, and are not reserved.
 */
export const RESERVED_ROUTE_SLUGS = [
  "admin",
  "auth",
  "api",
  "da",
  "en",
  "kontakt",
  "contact",
  "privatliv",
  "privacy",
  "mylife",
] as const;

/** Max lengths of the `category_translations` text columns (their CHECK constraints). */
export const CATEGORY_TEXT_LIMITS = {
  title: 120,
  description: 2000,
  seo_title: 70,
  seo_description: 160,
} as const;

/** Max lengths of the `item_translations` text columns (their CHECK constraints). */
export const ITEM_TEXT_LIMITS = {
  title: 160,
  summary: 600,
  body_md: 50_000,
  seo_title: 70,
  seo_description: 160,
} as const;

/** Most items one reorder may list (`admin_reorder_items` raises `too_many_items` above it). */
export const ITEMS_REORDER_MAX = 1000;

/** Largest `items.price_amount` (`numeric(12,2)`). */
export const PRICE_AMOUNT_MAX = 9_999_999_999.99;
