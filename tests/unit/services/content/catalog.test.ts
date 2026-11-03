/**
 * Unit tests — public catalog content service (F2.2 catalog-public)
 * Journey: catalog-public
 * Acceptance IDs: AC-CATPUB-01, AC-CATPUB-02, AC-CATPUB-03,
 *                 AC-CATPUB-10, AC-CATPUB-20, AC-CATPUB-21,
 *                 AC-CATPUB-30, AC-CATPUB-31,
 *                 AC-CATPUB-40, AC-CATPUB-41
 *
 * Module: src/services/content/catalog.ts. The Supabase public client is
 * mocked: every query chain resolves to the next `mockQuery` value, and
 * `mockChainCall` records each builder call (`eq`, `select`, ...). Price
 * formatting is mocked too: the service passes the raw price columns to
 * `formatPrice(price, locale, labels)` and stores its result on each item,
 * never the DB columns (formatPrice itself: tests/unit/lib/format-price.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FormattedPrice, PriceLabels } from "@/lib/format-price";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { mockFinalQuery, mockFormatPrice, mockChainCall } = vi.hoisted(() => ({
  mockFinalQuery: vi.fn(),
  mockFormatPrice: vi.fn(),
  mockChainCall: vi.fn(),
}));

vi.mock("@/lib/supabase/public", () => ({
  getPublicClient: () => {
    function chain(): Record<string, unknown> {
      const node: Record<string, unknown> = {};
      for (const m of ["select","eq","neq","order","limit","in","not","filter","is","contains"]) {
        node[m] = vi.fn((...args: unknown[]) => {
          mockChainCall(m, ...args);
          return chain();
        });
      }
      node["single"] = mockFinalQuery;
      node["maybeSingle"] = mockFinalQuery;
      node["then"] = (res: (v: unknown) => unknown, rej: ((r: unknown) => unknown) | undefined) =>
        Promise.resolve(mockFinalQuery()).then(res, rej);
      node["catch"] = (rej: (r: unknown) => unknown) => Promise.resolve(mockFinalQuery()).catch(rej);
      return node;
    }
    return { from: vi.fn(() => chain()) };
  },
}));

vi.mock("@/lib/format-price", () => ({ formatPrice: mockFormatPrice }));

import {
  getCatalogItem,
  getCatalogSection,
  getCatalogSitemapEntries,
  getCatalogStaticParams,
  getItemStaticParams,
  resolveCatalogItemSlugs,
  resolveCatalogSlug,
} from "@/services/content/catalog";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const DA_LABELS: PriceLabels = { from: "fra", vatIncluded: "inkl. moms", contact: "Kontakt" };
const EN_LABELS: PriceLabels = { from: "from", vatIncluded: "incl. VAT", contact: "Contact" };

const NBSP = "\u00a0";
const FORMATTED_FROM_DA: FormattedPrice = { text: `fra${NBSP}12.000${NBSP}kr.`, vat: "inkl. moms" };
const FORMATTED_FIXED_DA: FormattedPrice = { text: `950${NBSP}kr.`, vat: "inkl. moms" };

const servicesCategoryRow = {
  id: "cat-services-uuid", kind: "services", status: "published", nav_order: 30, featured: false,
  category_translations: [
    { locale: "da", title: "Ydelser", description: "Rådgivning og vedligehold.", seo_title: "", seo_description: "" },
    { locale: "en", title: "Services", description: "", seo_title: "", seo_description: "" },
  ],
  routes: [{ locale: "da", slug: "ydelser" }, { locale: "en", slug: "services" }],
  items: [
    {
      id: "item-featured-uuid", status: "published", sort_order: 20, featured: true,
      price_type: "from", price_amount: 12000, price_currency: "DKK",
      external_links: { website: "https://example.com" }, published_at: "2026-11-01T12:00:00Z",
      item_translations: [
        { locale: "da", slug: "webudvikling", title: "Webudvikling", summary: "Moderne sites.", body_md: "## Hvad du får\n\nEt skræddersyet website.", seo_title: "", seo_description: "" },
        { locale: "en", slug: "web-development", title: "Web Development", summary: "", body_md: "", seo_title: "", seo_description: "" },
      ],
      media: [],
    },
    {
      id: "item-nonfeatured-uuid", status: "published", sort_order: 10, featured: false,
      price_type: "fixed", price_amount: 950, price_currency: "DKK",
      external_links: {}, published_at: "2026-11-01T12:00:00Z",
      item_translations: [
        { locale: "da", slug: "raadgivning", title: "Teknisk rådgivning", summary: "Arkitektur.", body_md: "## Hvad du får\n\nRådgivning.", seo_title: "", seo_description: "" },
        { locale: "en", slug: "consulting", title: "Consulting", summary: "Architecture and code review.", body_md: "Architecture review.", seo_title: "", seo_description: "" },
      ],
      media: [],
    },
    {
      id: "item-draft-uuid", status: "draft", sort_order: 5, featured: false,
      price_type: null, price_amount: null, price_currency: "DKK",
      external_links: {}, published_at: null,
      item_translations: [{ locale: "da", slug: "draft-item", title: "Kladde", summary: "", body_md: "", seo_title: "", seo_description: "" }],
      media: [],
    },
  ],
};

const emptyPublishedCategory = { ...servicesCategoryRow, id: "cat-empty-uuid", items: [] };
const draftCategoryRow = { ...servicesCategoryRow, id: "cat-draft-uuid", status: "draft", items: [] };

function mockQuery(data: unknown, error: unknown = null): void {
  mockFinalQuery.mockResolvedValueOnce({ data, error });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFormatPrice.mockImplementation((price: { type: string | null }) =>
    price?.type === null ? null
    : price?.type === "contact" ? { text: "Kontakt", vat: null }
    : price?.type === "from" ? FORMATTED_FROM_DA
    : FORMATTED_FIXED_DA,
  );
});

// ── AC-CATPUB-01: getCatalogSection ───────────────────────────────────────────

describe("AC-CATPUB-01: getCatalogSection — published category resolves correctly", () => {
  it("returns non-null for published category slug (DA)", async () => {
    mockQuery(servicesCategoryRow);
    expect(await getCatalogSection("ydelser", "da", DA_LABELS)).not.toBeNull();
  });

  it("maps category id", async () => {
    mockQuery(servicesCategoryRow);
    expect((await getCatalogSection("ydelser", "da", DA_LABELS))?.id).toBe("cat-services-uuid");
  });

  it("maps kind", async () => {
    mockQuery(servicesCategoryRow);
    expect((await getCatalogSection("ydelser", "da", DA_LABELS))?.kind).toBe("services");
  });

  it("maps DA title", async () => {
    mockQuery(servicesCategoryRow);
    expect((await getCatalogSection("ydelser", "da", DA_LABELS))?.title).toBe("Ydelser");
  });

  it("maps DA description", async () => {
    mockQuery(servicesCategoryRow);
    expect((await getCatalogSection("ydelser", "da", DA_LABELS))?.description).toBe("Rådgivning og vedligehold.");
  });

  it("returns null for unknown slug", async () => {
    mockQuery(null);
    expect(await getCatalogSection("unknown", "da", DA_LABELS)).toBeNull();
  });

  it("returns null for draft category", async () => {
    mockQuery(draftCategoryRow);
    expect(await getCatalogSection("ydelser", "da", DA_LABELS)).toBeNull();
  });

  it("returns null for published category with no published items", async () => {
    mockQuery(emptyPublishedCategory);
    expect(await getCatalogSection("ydelser", "da", DA_LABELS)).toBeNull();
  });

  it("throws on DB error (never caches empty)", async () => {
    mockFinalQuery.mockResolvedValueOnce({ data: null, error: { message: "connection refused" } });
    await expect(getCatalogSection("ydelser", "da", DA_LABELS)).rejects.toThrow(/connection refused/);
  });

  it("exposes slugDA and slugEN for hreflang", async () => {
    mockQuery(servicesCategoryRow);
    const r = await getCatalogSection("ydelser", "da", DA_LABELS);
    expect(r?.slugDA).toBe("ydelser");
    expect(r?.slugEN).toBe("services");
  });
});

// ── AC-CATPUB-02: Featured items pin first ────────────────────────────────────

describe("AC-CATPUB-02: getCatalogSection — featured items pin first", () => {
  it("featured (sort_order=20) appears before non-featured (sort_order=10)", async () => {
    mockQuery(servicesCategoryRow);
    const r = await getCatalogSection("ydelser", "da", DA_LABELS);
    expect(r?.items[0]?.id).toBe("item-featured-uuid");
    expect(r?.items[1]?.id).toBe("item-nonfeatured-uuid");
  });

  it("draft items excluded", async () => {
    mockQuery(servicesCategoryRow);
    const r = await getCatalogSection("ydelser", "da", DA_LABELS);
    expect(r?.items.map((i) => i.id)).not.toContain("item-draft-uuid");
  });

  it("featured flag true on featured item", async () => {
    mockQuery(servicesCategoryRow);
    expect((await getCatalogSection("ydelser", "da", DA_LABELS))?.items[0]?.featured).toBe(true);
  });

  it("returns 2 items (draft excluded) from 3-item fixture", async () => {
    mockQuery(servicesCategoryRow);
    expect((await getCatalogSection("ydelser", "da", DA_LABELS))?.items).toHaveLength(2);
  });
});

// ── AC-CATPUB-03: Price via formatPrice ──────────────────────────────────────

describe("AC-CATPUB-03: getCatalogSection — price via formatPrice", () => {
  it("calls formatPrice with raw price, locale, labels for featured item", async () => {
    mockQuery(servicesCategoryRow);
    await getCatalogSection("ydelser", "da", DA_LABELS);
    expect(mockFormatPrice).toHaveBeenCalledWith({ type: "from", amount: 12000, currency: "DKK" }, "da", DA_LABELS);
  });

  it("calls formatPrice for non-featured item", async () => {
    mockQuery(servicesCategoryRow);
    await getCatalogSection("ydelser", "da", DA_LABELS);
    expect(mockFormatPrice).toHaveBeenCalledWith({ type: "fixed", amount: 950, currency: "DKK" }, "da", DA_LABELS);
  });

  it("item.price holds the FormattedPrice returned by formatPrice", async () => {
    mockFormatPrice.mockReturnValue(FORMATTED_FROM_DA);
    mockQuery(servicesCategoryRow);
    const r = await getCatalogSection("ydelser", "da", DA_LABELS);
    expect(r?.items.find((i) => i.id === "item-featured-uuid")?.price).toEqual(FORMATTED_FROM_DA);
  });

  it("null price_type → item.price is null", async () => {
    const row = { ...servicesCategoryRow, items: [{ ...servicesCategoryRow.items[0]!, price_type: null, price_amount: null }] };
    mockFormatPrice.mockReturnValue(null);
    mockQuery(row);
    expect((await getCatalogSection("ydelser", "da", DA_LABELS))?.items[0]?.price).toBeNull();
  });

  it("contact price → { text: 'Kontakt', vat: null }", async () => {
    const row = { ...servicesCategoryRow, items: [{ ...servicesCategoryRow.items[0]!, price_type: "contact", price_amount: null }] };
    mockFormatPrice.mockReturnValue({ text: "Kontakt", vat: null });
    mockQuery(row);
    expect((await getCatalogSection("ydelser", "da", DA_LABELS))?.items[0]?.price).toEqual({ text: "Kontakt", vat: null });
  });

  it("passes EN labels when locale is EN", async () => {
    mockQuery(servicesCategoryRow);
    await getCatalogSection("services", "en", EN_LABELS);
    expect(mockFormatPrice).toHaveBeenCalledWith(expect.objectContaining({ type: "from" }), "en", EN_LABELS);
  });
});

// ── AC-CATPUB-20: DA/EN fallback ─────────────────────────────────────────────

describe("AC-CATPUB-20: getCatalogSection — DA/EN translation fallback", () => {
  it("EN: uses EN title when present", async () => {
    mockQuery(servicesCategoryRow);
    expect((await getCatalogSection("services", "en", EN_LABELS))?.title).toBe("Services");
  });

  it("EN: falls back to DA description when EN description blank", async () => {
    mockQuery(servicesCategoryRow);
    const r = await getCatalogSection("services", "en", EN_LABELS);
    expect(r?.description).toBe("Rådgivning og vedligehold.");
    expect(r?.fallbackKeys).toContain("description");
  });

  it("EN: item falls back to DA summary when EN summary blank", async () => {
    mockQuery(servicesCategoryRow);
    const r = await getCatalogSection("services", "en", EN_LABELS);
    const item = r?.items.find((i) => i.id === "item-featured-uuid");
    expect(item?.summary).toBe("Moderne sites.");
    expect(item?.fallbackKeys).toContain("summary");
  });

  it("EN: item uses EN title when present", async () => {
    mockQuery(servicesCategoryRow);
    const r = await getCatalogSection("services", "en", EN_LABELS);
    expect(r?.items.find((i) => i.id === "item-featured-uuid")?.title).toBe("Web Development");
  });

  it("EN: item with full EN translations has no fallback keys", async () => {
    mockQuery(servicesCategoryRow);
    const r = await getCatalogSection("services", "en", EN_LABELS);
    expect(r?.items.find((i) => i.id === "item-nonfeatured-uuid")?.fallbackKeys).toEqual([]);
  });

  it("DA: no section fallback keys", async () => {
    mockQuery(servicesCategoryRow);
    expect((await getCatalogSection("ydelser", "da", DA_LABELS))?.fallbackKeys).toEqual([]);
  });

  it("DA: no item fallback keys", async () => {
    mockQuery(servicesCategoryRow);
    expect((await getCatalogSection("ydelser", "da", DA_LABELS))?.items[0]?.fallbackKeys).toEqual([]);
  });
});

// ── AC-CATPUB-10: getCatalogItem ──────────────────────────────────────────────

describe("AC-CATPUB-10: getCatalogItem — item detail", () => {
  it("returns non-null for published item (DA)", async () => {
    mockQuery(servicesCategoryRow);
    expect((await getCatalogItem("ydelser", "webudvikling", "da", DA_LABELS))?.item.id).toBe("item-featured-uuid");
  });

  it("maps DA title", async () => {
    mockQuery(servicesCategoryRow);
    expect((await getCatalogItem("ydelser", "webudvikling", "da", DA_LABELS))?.item.title).toBe("Webudvikling");
  });

  it("maps DA summary", async () => {
    mockQuery(servicesCategoryRow);
    expect((await getCatalogItem("ydelser", "webudvikling", "da", DA_LABELS))?.item.summary).toBe("Moderne sites.");
  });

  it("maps body markdown", async () => {
    mockQuery(servicesCategoryRow);
    expect((await getCatalogItem("ydelser", "webudvikling", "da", DA_LABELS))?.item.bodyMd).toContain("## Hvad du får");
  });

  it("maps external links", async () => {
    mockQuery(servicesCategoryRow);
    expect((await getCatalogItem("ydelser", "webudvikling", "da", DA_LABELS))?.item.externalLinks).toMatchObject({ website: "https://example.com" });
  });

  it("item.price is FormattedPrice (not raw columns)", async () => {
    mockFormatPrice.mockReturnValue(FORMATTED_FROM_DA);
    mockQuery(servicesCategoryRow);
    expect((await getCatalogItem("ydelser", "webudvikling", "da", DA_LABELS))?.item.price).toEqual(FORMATTED_FROM_DA);
  });

  it("includes parent section breadcrumb", async () => {
    mockQuery(servicesCategoryRow);
    const r = await getCatalogItem("ydelser", "webudvikling", "da", DA_LABELS);
    expect(r?.section.title).toBe("Ydelser");
    expect(r?.section.slugDA).toBe("ydelser");
  });

  it("returns null for unknown item slug", async () => {
    mockQuery(servicesCategoryRow);
    expect(await getCatalogItem("ydelser", "nonexistent", "da", DA_LABELS)).toBeNull();
  });

  it("returns null for unknown section slug", async () => {
    mockQuery(null);
    expect(await getCatalogItem("unknown", "webudvikling", "da", DA_LABELS)).toBeNull();
  });

  it("returns null for empty section", async () => {
    mockQuery(emptyPublishedCategory);
    expect(await getCatalogItem("ydelser", "webudvikling", "da", DA_LABELS)).toBeNull();
  });

  it("EN: falls back to DA summary when EN summary blank", async () => {
    mockQuery(servicesCategoryRow);
    const r = await getCatalogItem("services", "web-development", "en", EN_LABELS);
    expect(r?.item.summary).toBe("Moderne sites.");
    expect(r?.item.fallbackKeys).toContain("summary");
  });
});

// ── AC-CATPUB-40: getCatalogStaticParams ──────────────────────────────────────

describe("AC-CATPUB-40: getCatalogStaticParams — locale × slug pairs", () => {
  it("returns one entry per public category per locale", async () => {
    mockQuery([
      { status: "published", routes: [{ locale: "da", slug: "ydelser" }, { locale: "en", slug: "services" }], items: [{ status: "published" }] },
      { status: "published", routes: [{ locale: "da", slug: "apps" }, { locale: "en", slug: "apps" }], items: [{ status: "published" }] },
    ]);
    const params = await getCatalogStaticParams();
    expect(params).toContainEqual({ locale: "da", slug: "ydelser" });
    expect(params).toContainEqual({ locale: "en", slug: "services" });
  });

  it("excludes draft categories", async () => {
    mockQuery([{ status: "draft", routes: [{ locale: "da", slug: "x" }], items: [] }]);
    expect((await getCatalogStaticParams()).map((p) => p.slug)).not.toContain("x");
  });

  it("excludes categories with no published items", async () => {
    mockQuery([{ status: "published", routes: [{ locale: "da", slug: "empty" }], items: [] }]);
    expect((await getCatalogStaticParams()).map((p) => p.slug)).not.toContain("empty");
  });

  it("returns [] when no public categories", async () => {
    mockQuery([]);
    expect(await getCatalogStaticParams()).toEqual([]);
  });
});

// ── AC-CATPUB-41: getItemStaticParams ─────────────────────────────────────────

describe("AC-CATPUB-41: getItemStaticParams: the items of one section page", () => {
  const section = {
    status: "published",
    items: [
      { status: "published", item_translations: [{ locale: "da", slug: "webudvikling" }, { locale: "en", slug: "web-development" }] },
      { status: "published", item_translations: [{ locale: "da", slug: "raadgivning" }, { locale: "en", slug: "consulting" }] },
    ],
  };

  it("returns one { item } per published item, by its slug in the locale", async () => {
    mockQuery(section);
    expect(await getItemStaticParams("services", "en")).toEqual([{ item: "web-development" }, { item: "consulting" }]);
  });

  it("reads only the section whose slug in the locale is the parent slug", async () => {
    mockQuery(section);
    await getItemStaticParams("ydelser", "da");
    expect(mockChainCall).toHaveBeenCalledWith("eq", "match.locale", "da");
    expect(mockChainCall).toHaveBeenCalledWith("eq", "match.slug", "ydelser");
  });

  it("skips an item without a slug in the locale", async () => {
    mockQuery({ ...section, items: [{ status: "published", item_translations: [{ locale: "da", slug: "kun-dansk" }] }, ...section.items] });
    expect(await getItemStaticParams("services", "en")).toEqual([{ item: "web-development" }, { item: "consulting" }]);
  });

  it("excludes draft items", async () => {
    mockQuery({ ...section, items: [...section.items, { status: "draft", item_translations: [{ locale: "da", slug: "draft-item" }] }] });
    expect((await getItemStaticParams("ydelser", "da")).map((p) => p.item)).toEqual(["webudvikling", "raadgivning"]);
  });

  it("returns [] for a draft section", async () => {
    mockQuery({ ...section, status: "draft" });
    expect(await getItemStaticParams("ydelser", "da")).toEqual([]);
  });

  it("returns [] for a section without a published item", async () => {
    mockQuery({ status: "published", items: [{ status: "draft", item_translations: [{ locale: "da", slug: "draft-item" }] }] });
    expect(await getItemStaticParams("ydelser", "da")).toEqual([]);
  });

  it("returns [] for an unknown section slug", async () => {
    mockQuery(null);
    expect(await getItemStaticParams("ukendt", "da")).toEqual([]);
  });

  it("throws on a DB error, so a broken read never fails a build silently", async () => {
    mockQuery(null, { message: "connection refused" });
    await expect(getItemStaticParams("ydelser", "da")).rejects.toThrow(/connection refused/);
  });
});

// ── AC-CATPUB-30/31: getCatalogSitemapEntries ─────────────────────────────────

describe("AC-CATPUB-30: getCatalogSitemapEntries — public entries", () => {
  const fix = [{
    id: "cat-services-uuid", status: "published",
    routes: [{ locale: "da", slug: "ydelser" }, { locale: "en", slug: "services" }],
    items: [{ status: "published", published_at: "2026-11-01T12:00:00Z", item_translations: [{ locale: "da", slug: "webudvikling" }, { locale: "en", slug: "web-development" }] }],
  }];

  it("includes DA section URL", async () => {
    mockQuery(fix);
    expect((await getCatalogSitemapEntries()).map((e) => e.url).some((u) => u.endsWith("/ydelser"))).toBe(true);
  });

  it("includes EN section URL", async () => {
    mockQuery(fix);
    expect((await getCatalogSitemapEntries()).map((e) => e.url).some((u) => u.endsWith("/en/services"))).toBe(true);
  });

  it("includes DA item URL", async () => {
    mockQuery(fix);
    expect((await getCatalogSitemapEntries()).map((e) => e.url).some((u) => u.endsWith("/ydelser/webudvikling"))).toBe(true);
  });

  it("includes EN item URL", async () => {
    mockQuery(fix);
    expect((await getCatalogSitemapEntries()).map((e) => e.url).some((u) => u.endsWith("/en/services/web-development"))).toBe(true);
  });

  it("excludes draft sections", async () => {
    mockQuery([{ id: "x", status: "draft", routes: [{ locale: "da", slug: "hidden" }], items: [] }]);
    expect((await getCatalogSitemapEntries()).map((e) => e.url).join(",")).not.toContain("hidden");
  });

  it("excludes sections with no published items", async () => {
    mockQuery([{ id: "x", status: "published", routes: [{ locale: "da", slug: "empty" }], items: [] }]);
    expect((await getCatalogSitemapEntries()).map((e) => e.url).join(",")).not.toContain("empty");
  });

  it("returns [] when no public entries", async () => {
    mockQuery([]);
    expect(await getCatalogSitemapEntries()).toEqual([]);
  });
});

describe("AC-CATPUB-31: getCatalogSitemapEntries — hreflang alternates", () => {
  const fix = [{
    id: "cat-services-uuid", status: "published",
    routes: [{ locale: "da", slug: "ydelser" }, { locale: "en", slug: "services" }],
    items: [{ status: "published", published_at: "2026-11-01T12:00:00Z", item_translations: [{ locale: "da", slug: "webudvikling" }, { locale: "en", slug: "web-development" }] }],
  }];

  it("DA section entry has languages.da and languages.en", async () => {
    mockQuery(fix);
    const sectionDA = (await getCatalogSitemapEntries()).find((e) => e.url.endsWith("/ydelser"));
    expect(sectionDA?.alternates?.languages).toMatchObject({ da: expect.stringContaining("ydelser"), en: expect.stringContaining("services") });
  });

  it("x-default points to DA URL", async () => {
    mockQuery(fix);
    const sectionDA = (await getCatalogSitemapEntries()).find((e) => e.url.endsWith("/ydelser"));
    expect(sectionDA?.alternates?.languages?.["x-default"]).toEqual(expect.stringContaining("ydelser"));
  });
});

// ── AC-CATPUB-21: resolveCatalogSlug ─────────────────────────────────────────

describe("AC-CATPUB-21: resolveCatalogSlug — cross-locale canonical slug", () => {
  it("DA 'ydelser' → EN 'services'", async () => {
    mockQuery({ routes: [{ locale: "da", slug: "ydelser" }, { locale: "en", slug: "services" }] });
    expect(await resolveCatalogSlug("ydelser", "da", "en")).toBe("services");
  });

  it("EN 'services' → DA 'ydelser'", async () => {
    mockQuery({ routes: [{ locale: "da", slug: "ydelser" }, { locale: "en", slug: "services" }] });
    expect(await resolveCatalogSlug("services", "en", "da")).toBe("ydelser");
  });

  it("unknown slug → null", async () => {
    mockQuery(null);
    expect(await resolveCatalogSlug("nonexistent", "da", "en")).toBeNull();
  });

  it("same locale → same slug", async () => {
    mockQuery({ routes: [{ locale: "da", slug: "ydelser" }, { locale: "en", slug: "services" }] });
    expect(await resolveCatalogSlug("ydelser", "da", "da")).toBe("ydelser");
  });

  it("target locale has no route → null", async () => {
    mockQuery({ routes: [{ locale: "da", slug: "ydelser" }] });
    expect(await resolveCatalogSlug("ydelser", "da", "en")).toBeNull();
  });
});

// ── AC-CATPUB-21: resolveCatalogItemSlugs ────────────────────────────────────

describe("AC-CATPUB-21: resolveCatalogItemSlugs: cross-locale canonical item slugs", () => {
  const section = {
    routes: [{ locale: "da", slug: "ydelser" }, { locale: "en", slug: "services" }],
    items: [
      { item_translations: [{ locale: "da", slug: "raadgivning" }, { locale: "en", slug: "consulting" }] },
      { item_translations: [{ locale: "da", slug: "webudvikling" }, { locale: "en", slug: "web-development" }] },
    ],
  };

  it("DA 'ydelser/webudvikling' resolves to EN 'services/web-development'", async () => {
    mockQuery(section);
    expect(await resolveCatalogItemSlugs("ydelser", "webudvikling", "da", "en")).toEqual({ slug: "services", item: "web-development" });
  });

  it("looks the section up by its slug in the source locale", async () => {
    mockQuery(section);
    await resolveCatalogItemSlugs("services", "consulting", "en", "da");
    expect(mockChainCall).toHaveBeenCalledWith("eq", "match.locale", "en");
    expect(mockChainCall).toHaveBeenCalledWith("eq", "match.slug", "services");
  });

  it("unknown section → null", async () => {
    mockQuery(null);
    expect(await resolveCatalogItemSlugs("ukendt", "webudvikling", "da", "en")).toBeNull();
  });

  it("unknown item in a known section → null", async () => {
    mockQuery(section);
    expect(await resolveCatalogItemSlugs("ydelser", "ukendt", "da", "en")).toBeNull();
  });

  it("item without a slug in the target locale → null", async () => {
    mockQuery({ ...section, items: [{ item_translations: [{ locale: "da", slug: "kun-dansk" }] }] });
    expect(await resolveCatalogItemSlugs("ydelser", "kun-dansk", "da", "en")).toBeNull();
  });

  it("section without a slug in the target locale → null", async () => {
    mockQuery({ ...section, routes: [{ locale: "da", slug: "ydelser" }] });
    expect(await resolveCatalogItemSlugs("ydelser", "webudvikling", "da", "en")).toBeNull();
  });

  it("throws on a DB error", async () => {
    mockQuery(null, { message: "connection refused" });
    await expect(resolveCatalogItemSlugs("ydelser", "webudvikling", "da", "en")).rejects.toThrow(/connection refused/);
  });
});
