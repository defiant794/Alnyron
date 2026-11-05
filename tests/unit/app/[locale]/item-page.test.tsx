// @vitest-environment jsdom
/**
 * Unit tests: catalog item route (src/app/[locale]/[slug]/[item]/page.tsx).
 * The catalog service is mocked; next/navigation's notFound throws like
 * Next's own, so a test sees where the page stops.
 *
 * english-slugs contract (AC-ENSLUG-01g, AC-ENSLUG-02g, AC-ENSLUG-03): the
 * item URL slug is its EN item_translations slug on both locales, so the DA
 * item renders at `/services/web-development`; any other slug (such as the
 * DA item slug `webudvikling`) answers 404 through notFound() (the page
 * stops there, so nothing redirects).
 *
 * Service logic: tests/unit/services/content/catalog.test.ts; the view:
 * tests/unit/components/site/ItemDetailView.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type * as NextNavigation from "next/navigation";

// Dynamic import: vi.mock factories run hoisted above the static imports.
vi.mock("next-intl/server", async () =>
  (await import("../../../helpers/next-intl-server")).nextIntlServerMock(),
);
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  notFound: vi.fn(() => { throw new Error("NEXT_404_NOT_FOUND"); }),
}));
vi.mock("@/services/content/catalog", () => ({
  getCatalogItem: vi.fn(),
  getItemStaticParams: vi.fn(),
}));

import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import Page, { generateMetadata, generateStaticParams } from "@/app/[locale]/[slug]/[item]/page";
import { getCatalogItem, getItemStaticParams } from "@/services/content/catalog";
import { catalogItem, catalogSection, MALFORMED_SLUGS } from "../../../helpers/catalog-fixtures";

const DA_PRICE_LABELS = { from: "fra", vatIncluded: "inkl. moms", contact: "Kontakt" };

const item = catalogItem(); // slug: "web-development", title: "Webudvikling"
const found = { section: catalogSection({ items: [item] }), item };

const params = (locale: string, slug: string, itemSlug: string) => ({
  params: Promise.resolve({ locale, slug, item: itemSlug }),
});

async function renderItem(locale: string, slug: string, itemSlug: string) {
  render(await Page(params(locale, slug, itemSlug)));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCatalogItem).mockResolvedValue(null);
});

afterEach(cleanup);

describe("AC-CATPUB-10: item page renders a published item of a public section", () => {
  it("renders the item title and a breadcrumb back to its section", async () => {
    vi.mocked(getCatalogItem).mockResolvedValue(found);
    await renderItem("da", "services", "web-development");
    expect(screen.getByRole("heading", { level: 1, name: "Webudvikling" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ydelser" })).toHaveAttribute("href", "/services");
  });

  it("reads the item by the section and item slugs and locale, with the DA price labels", async () => {
    vi.mocked(getCatalogItem).mockResolvedValue(found);
    await renderItem("da", "services", "web-development");
    expect(getCatalogItem).toHaveBeenCalledWith("services", "web-development", "da", DA_PRICE_LABELS);
    expect(setRequestLocale).toHaveBeenCalledWith("da");
  });

  it("AC-ENSLUG-01g: DA item at EN slug /services/web-development renders DA content (title 'Webudvikling')", async () => {
    // The URL uses the EN slug, but the page renders Danish content.
    // getCatalogItem looks up by EN slug → returns DA-language content.
    vi.mocked(getCatalogItem).mockResolvedValue(found);
    await renderItem("da", "services", "web-development");
    expect(screen.getByRole("heading", { level: 1, name: "Webudvikling" })).toBeInTheDocument();
  });
});

describe("AC-CATPUB-10: item page answers 404", () => {
  it("for an item that is unknown, a draft, or under a section that is not public", async () => {
    await expect(renderItem("da", "services", "kladde")).rejects.toThrow(/404/);
    expect(notFound).toHaveBeenCalled();
  });

  it("for an unsupported locale, without reading the catalog", async () => {
    await expect(renderItem("de", "services", "web-development")).rejects.toThrow(/404/);
    expect(getCatalogItem).not.toHaveBeenCalled();
  });
});

describe("AC-CATPUB-10: a malformed section or item slug answers 404 before any catalog read", () => {
  it.each(MALFORMED_SLUGS)("page: for a section slug with %s, without a catalog query", async (_problem, slug) => {
    await expect(renderItem("da", slug, "web-development")).rejects.toThrow(/404/);
    expect(notFound).toHaveBeenCalled();
    expect(getCatalogItem).not.toHaveBeenCalled();
  });

  it.each(MALFORMED_SLUGS)("page: for an item slug with %s, without a catalog query", async (_problem, itemSlug) => {
    await expect(renderItem("da", "services", itemSlug)).rejects.toThrow(/404/);
    expect(notFound).toHaveBeenCalled();
    expect(getCatalogItem).not.toHaveBeenCalled();
  });

  it.each(MALFORMED_SLUGS)(
    "generateMetadata: for a section slug with %s, without a catalog query",
    async (_problem, slug) => {
      await expect(generateMetadata(params("da", slug, "web-development"))).rejects.toThrow(/404/);
      expect(notFound).toHaveBeenCalled();
      expect(getCatalogItem).not.toHaveBeenCalled();
    },
  );

  it.each(MALFORMED_SLUGS)(
    "generateMetadata: for an item slug with %s, without a catalog query",
    async (_problem, itemSlug) => {
      await expect(generateMetadata(params("da", "services", itemSlug))).rejects.toThrow(/404/);
      expect(notFound).toHaveBeenCalled();
      expect(getCatalogItem).not.toHaveBeenCalled();
    },
  );

  it("page: well-formed slugs of no public item still read the catalog, then answer 404", async () => {
    await expect(renderItem("da", "services", "websites")).rejects.toThrow(/404/);
    expect(getCatalogItem).toHaveBeenCalledWith("services", "websites", "da", DA_PRICE_LABELS);
    expect(notFound).toHaveBeenCalled();
  });

  it("generateMetadata: well-formed slugs of no public item still read the catalog and are empty", async () => {
    expect(await generateMetadata(params("da", "services", "websites"))).toEqual({});
    expect(getCatalogItem).toHaveBeenCalledWith("services", "websites", "da", DA_PRICE_LABELS);
    expect(notFound).not.toHaveBeenCalled();
  });

  it("page: 80-character slugs are well-formed and reach the catalog", async () => {
    const slug = "a".repeat(80);
    await expect(renderItem("da", slug, slug)).rejects.toThrow(/404/);
    expect(getCatalogItem).toHaveBeenCalledWith(slug, slug, "da", DA_PRICE_LABELS);
  });
});

describe("AC-ENSLUG-02g/03: Danish item and section slugs answer 404 through notFound()", () => {
  it("AC-ENSLUG-02g: the Danish item slug /services/webudvikling reads the catalog, then answers 404", async () => {
    await expect(renderItem("da", "services", "webudvikling")).rejects.toThrow(/404/);
    expect(getCatalogItem).toHaveBeenCalledWith("services", "webudvikling", "da", DA_PRICE_LABELS);
    expect(notFound).toHaveBeenCalled();
  });

  it("AC-ENSLUG-03: old Danish slugs on the EN locale (/en/ydelser/webudvikling) answer 404", async () => {
    await expect(renderItem("en", "ydelser", "webudvikling")).rejects.toThrow(/404/);
    expect(notFound).toHaveBeenCalled();
  });
});

describe("AC-CATPUB-22: item metadata with hreflang alternates", () => {
  it("gives the SEO title and description, the canonical path and da, en and x-default alternates", async () => {
    vi.mocked(getCatalogItem).mockResolvedValue(found);
    expect(await generateMetadata(params("da", "services", "web-development"))).toEqual({
      title: "Webudvikling hos Alnyron",
      description: "Moderne og hurtige websites.",
      alternates: {
        canonical: "/services/web-development",
        languages: {
          da: "/services/web-development",
          en: "/en/services/web-development",
          "x-default": "/services/web-development",
        },
      },
    });
  });

  it("leaves the description out when the item has none", async () => {
    const plain = catalogItem({ seo: { title: "Webudvikling", description: "" } });
    vi.mocked(getCatalogItem).mockResolvedValue({ section: found.section, item: plain });
    expect(await generateMetadata(params("da", "services", "web-development"))).not.toHaveProperty("description");
  });

  it("is empty for an item that is not public", async () => {
    expect(await generateMetadata(params("da", "services", "kladde"))).toEqual({});
  });

  it("is empty for an unsupported locale, without reading the catalog", async () => {
    expect(await generateMetadata(params("de", "services", "web-development"))).toEqual({});
    expect(getCatalogItem).not.toHaveBeenCalled();
  });
});

describe("AC-CATPUB-41: item generateStaticParams per parent section page", () => {
  it("reads only the parent section's items and returns { item } entries", async () => {
    vi.mocked(getItemStaticParams).mockResolvedValue([{ item: "web-development" }, { item: "consulting" }]);
    expect(await generateStaticParams({ params: { locale: "en", slug: "services" } })).toEqual([
      { item: "web-development" },
      { item: "consulting" },
    ]);
    expect(getItemStaticParams).toHaveBeenCalledExactlyOnceWith("services", "en");
  });

  it("DA locale gets the same English item slugs from getItemStaticParams", async () => {
    vi.mocked(getItemStaticParams).mockResolvedValue([{ item: "web-development" }, { item: "consulting" }]);
    expect(await generateStaticParams({ params: { locale: "da", slug: "services" } })).toEqual([
      { item: "web-development" },
      { item: "consulting" },
    ]);
  });

  it("returns [] for an unsupported locale, without reading the catalog", async () => {
    expect(await generateStaticParams({ params: { locale: "de", slug: "services" } })).toEqual([]);
    expect(getItemStaticParams).not.toHaveBeenCalled();
  });
});
