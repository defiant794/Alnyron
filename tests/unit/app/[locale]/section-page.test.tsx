// @vitest-environment jsdom
/**
 * Unit tests: catalog section route (src/app/[locale]/[slug]/page.tsx). The
 * catalog service is mocked; next/navigation's notFound and permanentRedirect
 * throw like Next's own, so a test sees where the page stops. The redirect
 * target is the real locale-aware path from @/i18n/navigation.
 * Service logic: tests/unit/services/content/catalog.test.ts; the view:
 * tests/unit/components/site/CatalogIndexView.test.tsx.
 * Journey: catalog-public
 * Acceptance IDs: AC-CATPUB-01, AC-CATPUB-21, AC-CATPUB-22, AC-CATPUB-40
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
  getCatalogSection: vi.fn(),
  getCatalogStaticParams: vi.fn(),
  resolveCatalogSlug: vi.fn(),
}));

import { setRequestLocale } from "next-intl/server";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import Page, { generateMetadata, generateStaticParams } from "@/app/[locale]/[slug]/page";
import { getCatalogSection, getCatalogStaticParams, resolveCatalogSlug } from "@/services/content/catalog";
import { catalogItem, catalogSection, MALFORMED_SLUGS } from "../../../helpers/catalog-fixtures";

const DA_PRICE_LABELS = { from: "fra", vatIncluded: "inkl. moms", contact: "Kontakt" };
const EN_PRICE_LABELS = { from: "from", vatIncluded: "incl. VAT", contact: "Contact" };

const ydelser = catalogSection({
  items: [
    catalogItem({ id: "item-web", title: "Webudvikling", featured: true }),
    catalogItem({ id: "item-advice", slug: "raadgivning", href: "/ydelser/raadgivning", title: "Teknisk rådgivning" }),
  ],
});

const params = (locale: string, slug: string) => ({ params: Promise.resolve({ locale, slug }) });

async function renderSection(locale: string, slug: string) {
  render(await Page(params(locale, slug)));
}

beforeEach(() => {
  vi.mocked(getCatalogSection).mockResolvedValue(null);
  vi.mocked(resolveCatalogSlug).mockResolvedValue(null);
});

afterEach(cleanup);

describe("AC-CATPUB-01: section page renders a public section", () => {
  it("renders the section title and a card per published item", async () => {
    vi.mocked(getCatalogSection).mockResolvedValue(ydelser);
    await renderSection("da", "ydelser");
    expect(screen.getByRole("heading", { level: 1, name: "Ydelser" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Webudvikling" })).toHaveAttribute("href", "/ydelser/webudvikling");
    expect(screen.getByRole("link", { name: "Teknisk rådgivning" })).toHaveAttribute("href", "/ydelser/raadgivning");
  });

  it("reads the section by the route slug and locale, with the DA price labels", async () => {
    vi.mocked(getCatalogSection).mockResolvedValue(ydelser);
    await renderSection("da", "ydelser");
    expect(getCatalogSection).toHaveBeenCalledWith("ydelser", "da", DA_PRICE_LABELS);
  });

  it("formats EN prices with the EN labels", async () => {
    vi.mocked(getCatalogSection).mockResolvedValue(ydelser);
    await renderSection("en", "services");
    expect(getCatalogSection).toHaveBeenCalledWith("services", "en", EN_PRICE_LABELS);
  });

  it("sets the request locale, so the page stays statically rendered", async () => {
    vi.mocked(getCatalogSection).mockResolvedValue(ydelser);
    await renderSection("en", "services");
    expect(setRequestLocale).toHaveBeenCalledWith("en");
  });
});

describe("AC-CATPUB-01: section page answers 404", () => {
  it("for a slug that is no public section in any locale (unknown, draft, or without a published item)", async () => {
    await expect(renderSection("da", "kladde")).rejects.toThrow(/404/);
    expect(notFound).toHaveBeenCalled();
    expect(permanentRedirect).not.toHaveBeenCalled();
  });

  it("for a slug shared by both locales whose section is not public here, instead of redirecting to itself", async () => {
    vi.mocked(resolveCatalogSlug).mockResolvedValue("apps");
    await expect(renderSection("en", "apps")).rejects.toThrow(/404/);
    expect(permanentRedirect).not.toHaveBeenCalled();
  });

  it("for an unsupported locale, without reading the catalog", async () => {
    await expect(renderSection("de", "ydelser")).rejects.toThrow(/404/);
    expect(getCatalogSection).not.toHaveBeenCalled();
  });
});

describe("AC-CATPUB-01: a malformed section slug answers 404 before any catalog read", () => {
  it.each(MALFORMED_SLUGS)("page: for a slug with %s, without a catalog query", async (_problem, slug) => {
    await expect(renderSection("da", slug)).rejects.toThrow(/404/);
    expect(notFound).toHaveBeenCalled();
    expect(getCatalogSection).not.toHaveBeenCalled();
    expect(resolveCatalogSlug).not.toHaveBeenCalled();
    expect(permanentRedirect).not.toHaveBeenCalled();
  });

  it.each(MALFORMED_SLUGS)("generateMetadata: for a slug with %s, without a catalog query", async (_problem, slug) => {
    await expect(generateMetadata(params("da", slug))).rejects.toThrow(/404/);
    expect(notFound).toHaveBeenCalled();
    expect(getCatalogSection).not.toHaveBeenCalled();
    expect(resolveCatalogSlug).not.toHaveBeenCalled();
  });

  it("page: a well-formed slug of no public section still reads the catalog, then answers 404", async () => {
    await expect(renderSection("da", "findes-ikke")).rejects.toThrow(/404/);
    expect(getCatalogSection).toHaveBeenCalledWith("findes-ikke", "da", DA_PRICE_LABELS);
    expect(resolveCatalogSlug).toHaveBeenCalledWith("findes-ikke", "en", "da");
    expect(notFound).toHaveBeenCalled();
  });

  it("generateMetadata: a well-formed slug of no public section still reads the catalog and is empty", async () => {
    expect(await generateMetadata(params("da", "findes-ikke"))).toEqual({});
    expect(getCatalogSection).toHaveBeenCalledWith("findes-ikke", "da", DA_PRICE_LABELS);
    expect(notFound).not.toHaveBeenCalled();
  });

  it("page: an 80-character slug is well-formed and reaches the catalog", async () => {
    const slug = "a".repeat(80);
    await expect(renderSection("da", slug)).rejects.toThrow(/404/);
    expect(getCatalogSection).toHaveBeenCalledWith(slug, "da", DA_PRICE_LABELS);
  });
});

describe("AC-CATPUB-21: another locale's slug redirects permanently (308) to this locale's slug", () => {
  it("/en/ydelser redirects to /en/services", async () => {
    vi.mocked(resolveCatalogSlug).mockImplementation(async (slug, from, to) =>
      slug === "ydelser" && from === "da" && to === "en" ? "services" : null,
    );
    await expect(renderSection("en", "ydelser")).rejects.toThrow(/308/);
    expect(permanentRedirect).toHaveBeenCalledWith("/en/services");
    expect(redirect).not.toHaveBeenCalled();
  });

  it("/services redirects to /ydelser", async () => {
    vi.mocked(resolveCatalogSlug).mockImplementation(async (slug, from, to) =>
      slug === "services" && from === "en" && to === "da" ? "ydelser" : null,
    );
    await expect(renderSection("da", "services")).rejects.toThrow(/308/);
    expect(permanentRedirect).toHaveBeenCalledWith("/ydelser");
  });
});

describe("AC-CATPUB-22: section metadata with hreflang alternates", () => {
  it("gives the SEO title and description, the canonical path and da, en and x-default alternates", async () => {
    vi.mocked(getCatalogSection).mockResolvedValue(ydelser);
    expect(await generateMetadata(params("da", "ydelser"))).toEqual({
      title: "Ydelser hos Alnyron",
      description: "Udvikling, rådgivning og vedligehold.",
      alternates: {
        canonical: "/ydelser",
        languages: { da: "/ydelser", en: "/en/services", "x-default": "/ydelser" },
      },
    });
  });

  it("leaves the description out when the section has none", async () => {
    vi.mocked(getCatalogSection).mockResolvedValue(catalogSection({ seo: { title: "Ydelser", description: "" } }));
    expect(await generateMetadata(params("da", "ydelser"))).not.toHaveProperty("description");
  });

  it("lists only the locales the section exists in", async () => {
    vi.mocked(getCatalogSection).mockResolvedValue(catalogSection({ paths: { da: "/ydelser" } }));
    expect((await generateMetadata(params("da", "ydelser"))).alternates?.languages).toEqual({
      da: "/ydelser",
      "x-default": "/ydelser",
    });
  });

  it("is empty for a slug that is no public section", async () => {
    expect(await generateMetadata(params("da", "kladde"))).toEqual({});
  });

  it("is empty for an unsupported locale, without reading the catalog", async () => {
    expect(await generateMetadata(params("de", "ydelser"))).toEqual({});
    expect(getCatalogSection).not.toHaveBeenCalled();
  });
});

describe("AC-CATPUB-40: section generateStaticParams", () => {
  it("returns the { slug } of every public section in the layout's locale", async () => {
    vi.mocked(getCatalogStaticParams).mockResolvedValue([
      { locale: "da", slug: "ydelser" },
      { locale: "en", slug: "services" },
      { locale: "da", slug: "apps" },
      { locale: "en", slug: "apps" },
    ]);
    expect(await generateStaticParams({ params: { locale: "en" } })).toEqual([{ slug: "services" }, { slug: "apps" }]);
  });
});
