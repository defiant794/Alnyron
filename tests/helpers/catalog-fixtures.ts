import type { CatalogImage, PublicCatalogItem, PublicCatalogSection } from "@/services/content/catalog";

/**
 * Resolved catalog view models (what src/services/content/catalog.ts returns)
 * for page and component unit tests: a published Danish `services` section
 * and item, overridable per test.
 */

/** No-break space, as `formatPrice` puts it inside a price. */
export const NBSP = "\u00a0";

export function catalogImage(overrides: Partial<CatalogImage> = {}): CatalogImage {
  return {
    id: "media-1",
    src: "https://e2eprojectref0000000.supabase.co/storage/v1/object/public/media/items/item-web/1.webp",
    alt: "Forsiden af et kundewebsite",
    width: 1600,
    height: 900,
    ...overrides,
  };
}

export function catalogItem(overrides: Partial<PublicCatalogItem> = {}): PublicCatalogItem {
  return {
    id: "item-web",
    // The URL slug is the EN item slug; the DA slug ("webudvikling") is no address.
    slug: "web-development",
    href: "/services/web-development",
    paths: { da: "/services/web-development", en: "/en/services/web-development" },
    title: "Webudvikling",
    summary: "Moderne og hurtige websites.",
    bodyMd: "## Hvad du får\n\nEt skræddersyet website.",
    price: { text: `fra${NBSP}12.000${NBSP}kr.`, vat: "inkl. moms" },
    featured: false,
    externalLinks: {},
    media: [],
    seo: { title: "Webudvikling hos Alnyron", description: "Moderne og hurtige websites." },
    fallbackKeys: [],
    ...overrides,
  };
}

export function catalogSection(overrides: Partial<PublicCatalogSection> = {}): PublicCatalogSection {
  return {
    id: "cat-services",
    kind: "services",
    title: "Ydelser",
    description: "Udvikling, rådgivning og vedligehold.",
    href: "/services",
    paths: { da: "/services", en: "/en/services" },
    seo: { title: "Ydelser hos Alnyron", description: "Udvikling, rådgivning og vedligehold." },
    fallbackKeys: [],
    items: [catalogItem()],
    ...overrides,
  };
}

/**
 * Route params no stored slug can equal (the `routes_slug_format` /
 * `item_translations` slug CHECK format), as `[what is wrong, slug]` pairs:
 * the catalog routes answer 404 for them without reading the DB.
 */
export const MALFORMED_SLUGS: [problem: string, slug: string][] = [
  ["a path traversal", "../"],
  ["a percent-encoded path traversal", "%2e%2e%2f"],
  ["upper-case letters", "Ydelser"],
  ["an underscore", "a_b"],
  ["more than 80 characters", "a".repeat(81)],
  ["an SQL-ish payload", "ydelser' OR '1'='1"],
  ["a leading dash", "-ydelser"],
  ["a double dash", "web--udvikling"],
  ["a Danish letter", "rådgivning"],
  ["no characters", ""],
];
