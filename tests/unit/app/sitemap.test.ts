/**
 * Unit tests: /sitemap.xml (src/app/sitemap.ts). The catalog service is
 * mocked (its own filtering and alternates: tests/unit/services/content/catalog.test.ts);
 * these tests check the system pages, the absolute URLs and the failure modes.
 * Journey: catalog-public, english-slugs
 * Acceptance IDs: AC-CATPUB-30, AC-CATPUB-31, AC-ENSLUG-06, AC-ENSLUG-06b
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/content/catalog", () => ({ getCatalogSitemapEntries: vi.fn() }));

import sitemap, { revalidate } from "@/app/sitemap";
import { getCatalogSitemapEntries, type CatalogSitemapEntry } from "@/services/content/catalog";

const SITE = "https://alnyron.example";
const UPDATED = new Date("2026-11-02T10:00:00Z");

// The service's entries (site-relative, English slugs on both locales).
const SECTION_LANGUAGES = { da: "/services", en: "/en/services", "x-default": "/services" };
const ITEM_LANGUAGES = {
  da: "/services/web-development",
  en: "/en/services/web-development",
  "x-default": "/services/web-development",
};

const CATALOG: CatalogSitemapEntry[] = [
  { url: "/services", lastModified: UPDATED, alternates: { languages: SECTION_LANGUAGES } },
  { url: "/en/services", lastModified: UPDATED, alternates: { languages: SECTION_LANGUAGES } },
  { url: "/services/web-development", lastModified: UPDATED, alternates: { languages: ITEM_LANGUAGES } },
  { url: "/en/services/web-development", lastModified: UPDATED, alternates: { languages: ITEM_LANGUAGES } },
];

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", SITE);
  vi.mocked(getCatalogSitemapEntries).mockResolvedValue(CATALOG);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function entry(url: string) {
  const found = (await sitemap()).find((candidate) => candidate.url === url);
  if (!found) throw new Error(`no sitemap entry for ${url}`);
  return found;
}

describe("AC-CATPUB-30: sitemap lists the system pages and every public catalog page", () => {
  it("AC-ENSLUG-06/06b: lists home, contact and privacy at English paths, then the catalog entries", async () => {
    expect((await sitemap()).map((candidate) => candidate.url)).toEqual([
      `${SITE}/`,
      `${SITE}/en`,
      `${SITE}/contact`,
      `${SITE}/en/contact`,
      `${SITE}/privacy`,
      `${SITE}/en/privacy`,
      `${SITE}/services`,
      `${SITE}/en/services`,
      `${SITE}/services/web-development`,
      `${SITE}/en/services/web-development`,
    ]);
  });

  it("lists no catalog page the service leaves out (drafts, sections without a published item)", async () => {
    vi.mocked(getCatalogSitemapEntries).mockResolvedValue([]);
    expect((await sitemap()).map((candidate) => candidate.url)).toHaveLength(6);
  });

  it("keeps each catalog page's last modification", async () => {
    expect((await entry(`${SITE}/services/web-development`)).lastModified).toEqual(UPDATED);
  });

  it("throws when NEXT_PUBLIC_SITE_URL is missing, so a broken sitemap is never cached", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", undefined);
    await expect(sitemap()).rejects.toThrow();
  });

  it("throws when the catalog cannot be read", async () => {
    vi.mocked(getCatalogSitemapEntries).mockRejectedValue(new Error("Failed to load the catalog sitemap: timeout"));
    await expect(sitemap()).rejects.toThrow(/catalog sitemap/);
  });

  it("is refreshed within ~5 minutes like the public pages", () => {
    expect(revalidate).toBe(300);
  });
});

describe("AC-CATPUB-31: sitemap alternates are absolute, with x-default = Danish", () => {
  it("makes a catalog section's alternates absolute", async () => {
    expect((await entry(`${SITE}/services`)).alternates?.languages).toEqual({
      da: `${SITE}/services`,
      en: `${SITE}/en/services`,
      "x-default": `${SITE}/services`,
    });
  });

  it("makes a catalog item's alternates absolute on its EN entry too", async () => {
    expect((await entry(`${SITE}/en/services/web-development`)).alternates?.languages).toEqual({
      da: `${SITE}/services/web-development`,
      en: `${SITE}/en/services/web-development`,
      "x-default": `${SITE}/services/web-development`,
    });
  });

  it("AC-ENSLUG-06: the contact page alternates are /contact and /en/contact, x-default /contact", async () => {
    expect((await entry(`${SITE}/en/contact`)).alternates?.languages).toEqual({
      da: `${SITE}/contact`,
      en: `${SITE}/en/contact`,
      "x-default": `${SITE}/contact`,
    });
  });
});
