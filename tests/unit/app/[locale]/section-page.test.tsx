// @vitest-environment jsdom
/**
 * Unit tests: catalog section route (src/app/[locale]/[slug]/page.tsx). The
 * catalog service is mocked; next/navigation's notFound throws like Next's own,
 * so a test sees where the page stops.
 *
 * english-slugs contract (AC-ENSLUG-02, AC-ENSLUG-03): the section URL slug
 * is its EN route slug on both locales; any other slug answers 404 through
 * notFound() (the page stops there, so nothing redirects).
 *
 * Service logic: tests/unit/services/content/catalog.test.ts; the view:
 * tests/unit/components/site/CatalogIndexView.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Dynamic import: vi.mock factories run hoisted above the static imports.
vi.mock("next-intl/server", async () =>
  (await import("../../../helpers/next-intl-server")).nextIntlServerMock(),
);
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => { throw new Error("NEXT_404_NOT_FOUND"); }),
}));
vi.mock("@/services/content/catalog", () => ({
  getCatalogSection: vi.fn(),
  getCatalogStaticParams: vi.fn(),
}));

import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import Page, { generateMetadata, generateStaticParams } from "@/app/[locale]/[slug]/page";
import { getCatalogSection, getCatalogStaticParams } from "@/services/content/catalog";
import { catalogItem, catalogSection, MALFORMED_SLUGS } from "../../../helpers/catalog-fixtures";

const DA_PRICE_LABELS = { from: "fra", vatIncluded: "inkl. moms", contact: "Kontakt" };
const EN_PRICE_LABELS = { from: "from", vatIncluded: "incl. VAT", contact: "Contact" };

const servicesSection = catalogSection({
  items: [
    catalogItem({ id: "item-web", featured: true }),
    catalogItem({ id: "item-advice", slug: "consulting", href: "/services/consulting", title: "Teknisk rådgivning" }),
  ],
});

const params = (locale: string, slug: string) => ({ params: Promise.resolve({ locale, slug }) });

async function renderSection(locale: string, slug: string) {
  render(await Page(params(locale, slug)));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCatalogSection).mockResolvedValue(null);
});

afterEach(cleanup);

describe("AC-CATPUB-01: section page renders a public section", () => {
  it("renders the section title and a card per published item", async () => {
    vi.mocked(getCatalogSection).mockResolvedValue(servicesSection);
    await renderSection("da", "services");
    expect(screen.getByRole("heading", { level: 1, name: "Ydelser" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Webudvikling" })).toHaveAttribute("href", "/services/web-development");
    expect(screen.getByRole("link", { name: "Teknisk rådgivning" })).toHaveAttribute("href", "/services/consulting");
  });

  it("reads the section by the route slug and locale, with the DA price labels", async () => {
    vi.mocked(getCatalogSection).mockResolvedValue(servicesSection);
    await renderSection("da", "services");
    expect(getCatalogSection).toHaveBeenCalledWith("services", "da", DA_PRICE_LABELS);
  });

  it("formats EN prices with the EN labels", async () => {
    vi.mocked(getCatalogSection).mockResolvedValue(servicesSection);
    await renderSection("en", "services");
    expect(getCatalogSection).toHaveBeenCalledWith("services", "en", EN_PRICE_LABELS);
  });

  it("sets the request locale, so the page stays statically rendered", async () => {
    vi.mocked(getCatalogSection).mockResolvedValue(servicesSection);
    await renderSection("en", "services");
    expect(setRequestLocale).toHaveBeenCalledWith("en");
  });
});

describe("AC-CATPUB-01: section page answers 404", () => {
  it("for a slug that is no public section (unknown, draft, or without a published item)", async () => {
    await expect(renderSection("da", "kladde")).rejects.toThrow(/404/);
    expect(notFound).toHaveBeenCalled();
  });

  it("for an unsupported locale, without reading the catalog", async () => {
    await expect(renderSection("de", "services")).rejects.toThrow(/404/);
    expect(getCatalogSection).not.toHaveBeenCalled();
  });
});

describe("AC-CATPUB-01: a malformed section slug answers 404 before any catalog read", () => {
  it.each(MALFORMED_SLUGS)("page: for a slug with %s, without a catalog query", async (_problem, slug) => {
    await expect(renderSection("da", slug)).rejects.toThrow(/404/);
    expect(notFound).toHaveBeenCalled();
    expect(getCatalogSection).not.toHaveBeenCalled();
  });

  it.each(MALFORMED_SLUGS)("generateMetadata: for a slug with %s, without a catalog query", async (_problem, slug) => {
    await expect(generateMetadata(params("da", slug))).rejects.toThrow(/404/);
    expect(notFound).toHaveBeenCalled();
    expect(getCatalogSection).not.toHaveBeenCalled();
  });

  it("page: a well-formed slug of no public section still reads the catalog, then answers 404", async () => {
    await expect(renderSection("da", "websites")).rejects.toThrow(/404/);
    expect(getCatalogSection).toHaveBeenCalledWith("websites", "da", DA_PRICE_LABELS);
    expect(notFound).toHaveBeenCalled();
  });

  it("generateMetadata: a well-formed slug of no public section still reads the catalog and is empty", async () => {
    expect(await generateMetadata(params("da", "websites"))).toEqual({});
    expect(getCatalogSection).toHaveBeenCalledWith("websites", "da", DA_PRICE_LABELS);
    expect(notFound).not.toHaveBeenCalled();
  });

  it("page: an 80-character slug is well-formed and reaches the catalog", async () => {
    const slug = "a".repeat(80);
    await expect(renderSection("da", slug)).rejects.toThrow(/404/);
    expect(getCatalogSection).toHaveBeenCalledWith(slug, "da", DA_PRICE_LABELS);
  });
});

describe("AC-ENSLUG-02/03: an old Danish section slug answers 404 through notFound()", () => {
  it("AC-ENSLUG-03: the old Danish slug on the EN locale (/en/ydelser) reads the catalog, then answers 404", async () => {
    await expect(renderSection("en", "ydelser")).rejects.toThrow(/404/);
    expect(getCatalogSection).toHaveBeenCalledWith("ydelser", "en", EN_PRICE_LABELS);
    expect(notFound).toHaveBeenCalled();
  });

  it("AC-ENSLUG-02d: the old Danish slug on the DA locale (/ydelser) answers 404", async () => {
    await expect(renderSection("da", "ydelser")).rejects.toThrow(/404/);
    expect(notFound).toHaveBeenCalled();
  });
});

describe("AC-CATPUB-22: section metadata with hreflang alternates", () => {
  it("gives the SEO title and description, the canonical path and da, en and x-default alternates", async () => {
    vi.mocked(getCatalogSection).mockResolvedValue(servicesSection);
    expect(await generateMetadata(params("da", "services"))).toEqual({
      title: "Ydelser hos Alnyron",
      description: "Udvikling, rådgivning og vedligehold.",
      alternates: {
        canonical: "/services",
        languages: { da: "/services", en: "/en/services", "x-default": "/services" },
      },
    });
  });

  it("leaves the description out when the section has none", async () => {
    vi.mocked(getCatalogSection).mockResolvedValue(catalogSection({ seo: { title: "Ydelser", description: "" } }));
    expect(await generateMetadata(params("da", "services"))).not.toHaveProperty("description");
  });

  it("is empty for a slug that is no public section", async () => {
    expect(await generateMetadata(params("da", "kladde"))).toEqual({});
  });

  it("is empty for an unsupported locale, without reading the catalog", async () => {
    expect(await generateMetadata(params("de", "services"))).toEqual({});
    expect(getCatalogSection).not.toHaveBeenCalled();
  });
});

describe("AC-CATPUB-40: section generateStaticParams", () => {
  it("returns the { slug } of every public section in the layout's locale, the same English slugs on both locales", async () => {
    vi.mocked(getCatalogStaticParams).mockResolvedValue([
      { locale: "da", slug: "services" },
      { locale: "en", slug: "services" },
      { locale: "da", slug: "apps" },
      { locale: "en", slug: "apps" },
    ]);
    expect(await generateStaticParams({ params: { locale: "en" } })).toEqual([{ slug: "services" }, { slug: "apps" }]);
    expect(await generateStaticParams({ params: { locale: "da" } })).toEqual([{ slug: "services" }, { slug: "apps" }]);
  });
});
