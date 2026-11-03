// @vitest-environment jsdom
/**
 * Unit tests: catalog item route (src/app/[locale]/[slug]/[item]/page.tsx).
 * The catalog service is mocked; next/navigation's notFound and
 * permanentRedirect throw like Next's own, so a test sees where the page
 * stops. The redirect target is the real locale-aware path from
 * @/i18n/navigation. Service logic: tests/unit/services/content/catalog.test.ts;
 * the view: tests/unit/components/site/ItemDetailView.test.tsx.
 * Journey: catalog-public
 * Acceptance IDs: AC-CATPUB-10, AC-CATPUB-21, AC-CATPUB-22, AC-CATPUB-41
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Dynamic import: vi.mock factories run hoisted above the static imports.
vi.mock("next-intl/server", async () =>
  (await import("../../../helpers/next-intl-server")).nextIntlServerMock(),
);
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  }),
  permanentRedirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT;replace;${url};308`);
  }),
  redirect: vi.fn(),
  usePathname: vi.fn(),
  useRouter: vi.fn(),
}));
vi.mock("@/services/content/catalog", () => ({
  getCatalogItem: vi.fn(),
  getItemStaticParams: vi.fn(),
  resolveCatalogItemSlugs: vi.fn(),
}));

import { setRequestLocale } from "next-intl/server";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import Page, { generateMetadata, generateStaticParams } from "@/app/[locale]/[slug]/[item]/page";
import { getCatalogItem, getItemStaticParams, resolveCatalogItemSlugs } from "@/services/content/catalog";
import { catalogItem, catalogSection, MALFORMED_SLUGS } from "../../../helpers/catalog-fixtures";

const DA_PRICE_LABELS = { from: "fra", vatIncluded: "inkl. moms", contact: "Kontakt" };

const item = catalogItem();
const found = { section: catalogSection({ items: [item] }), item };

const params = (locale: string, slug: string, itemSlug: string) => ({
  params: Promise.resolve({ locale, slug, item: itemSlug }),
});

async function renderItem(locale: string, slug: string, itemSlug: string) {
  render(await Page(params(locale, slug, itemSlug)));
}

beforeEach(() => {
  vi.mocked(getCatalogItem).mockResolvedValue(null);
  vi.mocked(resolveCatalogItemSlugs).mockResolvedValue(null);
});

afterEach(cleanup);

describe("AC-CATPUB-10: item page renders a published item of a public section", () => {
  it("renders the item title and a breadcrumb back to its section", async () => {
    vi.mocked(getCatalogItem).mockResolvedValue(found);
    await renderItem("da", "ydelser", "webudvikling");
    expect(screen.getByRole("heading", { level: 1, name: "Webudvikling" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ydelser" })).toHaveAttribute("href", "/ydelser");
  });

  it("reads the item by the section and item slugs and locale, with the DA price labels", async () => {
    vi.mocked(getCatalogItem).mockResolvedValue(found);
    await renderItem("da", "ydelser", "webudvikling");
    expect(getCatalogItem).toHaveBeenCalledWith("ydelser", "webudvikling", "da", DA_PRICE_LABELS);
    expect(setRequestLocale).toHaveBeenCalledWith("da");
  });
});

describe("AC-CATPUB-10: item page answers 404", () => {
  it("for an item that is unknown, a draft, or under a section that is not public", async () => {
    await expect(renderItem("da", "ydelser", "kladde")).rejects.toThrow(/404/);
    expect(notFound).toHaveBeenCalled();
    expect(permanentRedirect).not.toHaveBeenCalled();
  });

  it("when the other locale's slugs are the same, instead of redirecting to itself", async () => {
    vi.mocked(resolveCatalogItemSlugs).mockResolvedValue({ slug: "apps", item: "budget" });
    await expect(renderItem("en", "apps", "budget")).rejects.toThrow(/404/);
    expect(permanentRedirect).not.toHaveBeenCalled();
  });

  it("for an unsupported locale, without reading the catalog", async () => {
    await expect(renderItem("de", "ydelser", "webudvikling")).rejects.toThrow(/404/);
    expect(getCatalogItem).not.toHaveBeenCalled();
  });
});

describe("AC-CATPUB-10: a malformed section or item slug answers 404 before any catalog read", () => {
  it.each(MALFORMED_SLUGS)("page: for a section slug with %s, without a catalog query", async (_problem, slug) => {
    await expect(renderItem("da", slug, "webudvikling")).rejects.toThrow(/404/);
    expect(notFound).toHaveBeenCalled();
    expect(getCatalogItem).not.toHaveBeenCalled();
    expect(resolveCatalogItemSlugs).not.toHaveBeenCalled();
    expect(permanentRedirect).not.toHaveBeenCalled();
  });

  it.each(MALFORMED_SLUGS)("page: for an item slug with %s, without a catalog query", async (_problem, itemSlug) => {
    await expect(renderItem("da", "ydelser", itemSlug)).rejects.toThrow(/404/);
    expect(notFound).toHaveBeenCalled();
    expect(getCatalogItem).not.toHaveBeenCalled();
    expect(resolveCatalogItemSlugs).not.toHaveBeenCalled();
    expect(permanentRedirect).not.toHaveBeenCalled();
  });

  it.each(MALFORMED_SLUGS)(
    "generateMetadata: for a section slug with %s, without a catalog query",
    async (_problem, slug) => {
      await expect(generateMetadata(params("da", slug, "webudvikling"))).rejects.toThrow(/404/);
      expect(notFound).toHaveBeenCalled();
      expect(getCatalogItem).not.toHaveBeenCalled();
    },
  );

  it.each(MALFORMED_SLUGS)(
    "generateMetadata: for an item slug with %s, without a catalog query",
    async (_problem, itemSlug) => {
      await expect(generateMetadata(params("da", "ydelser", itemSlug))).rejects.toThrow(/404/);
      expect(notFound).toHaveBeenCalled();
      expect(getCatalogItem).not.toHaveBeenCalled();
    },
  );

  it("page: well-formed slugs of no public item still read the catalog, then answer 404", async () => {
    await expect(renderItem("da", "ydelser", "findes-ikke")).rejects.toThrow(/404/);
    expect(getCatalogItem).toHaveBeenCalledWith("ydelser", "findes-ikke", "da", DA_PRICE_LABELS);
    expect(resolveCatalogItemSlugs).toHaveBeenCalledWith("ydelser", "findes-ikke", "en", "da");
    expect(notFound).toHaveBeenCalled();
  });

  it("generateMetadata: well-formed slugs of no public item still read the catalog and are empty", async () => {
    expect(await generateMetadata(params("da", "ydelser", "findes-ikke"))).toEqual({});
    expect(getCatalogItem).toHaveBeenCalledWith("ydelser", "findes-ikke", "da", DA_PRICE_LABELS);
    expect(notFound).not.toHaveBeenCalled();
  });

  it("page: 80-character slugs are well-formed and reach the catalog", async () => {
    const slug = "a".repeat(80);
    await expect(renderItem("da", slug, slug)).rejects.toThrow(/404/);
    expect(getCatalogItem).toHaveBeenCalledWith(slug, slug, "da", DA_PRICE_LABELS);
  });
});

describe("AC-CATPUB-21: another locale's slugs redirect permanently (308) to this locale's slugs", () => {
  it("/en/ydelser/webudvikling redirects to /en/services/web-development", async () => {
    vi.mocked(resolveCatalogItemSlugs).mockImplementation(async (slug, itemSlug, from, to) =>
      slug === "ydelser" && itemSlug === "webudvikling" && from === "da" && to === "en"
        ? { slug: "services", item: "web-development" }
        : null,
    );
    await expect(renderItem("en", "ydelser", "webudvikling")).rejects.toThrow(/308/);
    expect(permanentRedirect).toHaveBeenCalledWith("/en/services/web-development");
    expect(redirect).not.toHaveBeenCalled();
  });

  it("/services/web-development redirects to /ydelser/webudvikling", async () => {
    vi.mocked(resolveCatalogItemSlugs).mockImplementation(async (slug, itemSlug, from, to) =>
      slug === "services" && itemSlug === "web-development" && from === "en" && to === "da"
        ? { slug: "ydelser", item: "webudvikling" }
        : null,
    );
    await expect(renderItem("da", "services", "web-development")).rejects.toThrow(/308/);
    expect(permanentRedirect).toHaveBeenCalledWith("/ydelser/webudvikling");
  });
});

describe("AC-CATPUB-22: item metadata with hreflang alternates", () => {
  it("gives the SEO title and description, the canonical path and da, en and x-default alternates", async () => {
    vi.mocked(getCatalogItem).mockResolvedValue(found);
    expect(await generateMetadata(params("da", "ydelser", "webudvikling"))).toEqual({
      title: "Webudvikling hos Alnyron",
      description: "Moderne og hurtige websites.",
      alternates: {
        canonical: "/ydelser/webudvikling",
        languages: {
          da: "/ydelser/webudvikling",
          en: "/en/services/web-development",
          "x-default": "/ydelser/webudvikling",
        },
      },
    });
  });

  it("leaves the description out when the item has none", async () => {
    const plain = catalogItem({ seo: { title: "Webudvikling", description: "" } });
    vi.mocked(getCatalogItem).mockResolvedValue({ section: found.section, item: plain });
    expect(await generateMetadata(params("da", "ydelser", "webudvikling"))).not.toHaveProperty("description");
  });

  it("is empty for an item that is not public", async () => {
    expect(await generateMetadata(params("da", "ydelser", "kladde"))).toEqual({});
  });

  it("is empty for an unsupported locale, without reading the catalog", async () => {
    expect(await generateMetadata(params("de", "ydelser", "webudvikling"))).toEqual({});
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

  it("returns [] for an unsupported locale, without reading the catalog", async () => {
    expect(await generateStaticParams({ params: { locale: "de", slug: "ydelser" } })).toEqual([]);
    expect(getItemStaticParams).not.toHaveBeenCalled();
  });
});
