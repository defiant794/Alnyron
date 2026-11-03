/**
 * Unit tests: /sitemap.xml (src/app/sitemap.ts). The catalog service is
 * mocked (its own filtering and alternates: tests/unit/services/content/catalog.test.ts);
 * these tests check the system pages, the absolute URLs and the failure modes.
 * Journey: catalog-public
 * Acceptance IDs: AC-CATPUB-30, AC-CATPUB-31
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/content/catalog", () => ({ getCatalogSitemapEntries: vi.fn() }));

import sitemap, { revalidate } from "@/app/sitemap";
import { getCatalogSitemapEntries, type CatalogSitemapEntry } from "@/services/content/catalog";

const SITE = "https://alnyron.example";
const UPDATED = new Date("2026-11-02T10:00:00Z");

const SECTION_LANGUAGES = { da: "/ydelser", en: "/en/services", "x-default": "/ydelser" };
const ITEM_LANGUAGES = {
  da: "/ydelser/webudvikling",
  en: "/en/services/web-development",
  "x-default": "/ydelser/webudvikling",
};

const CATALOG: CatalogSitemapEntry[] = [
  { url: "/ydelser", lastModified: UPDATED, alternates: { languages: SECTION_LANGUAGES } },
  { url: "/en/services", lastModified: UPDATED, alternates: { languages: SECTION_LANGUAGES } },
  { url: "/ydelser/webudvikling", lastModified: UPDATED, alternates: { languages: ITEM_LANGUAGES } },
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
  it("lists home, contact and privacy in both locales, then the catalog entries", async () => {
    expect((await sitemap()).map((candidate) => candidate.url)).toEqual([
      `${SITE}/`,
      `${SITE}/en`,
      `${SITE}/kontakt`,
      `${SITE}/en/contact`,
      `${SITE}/privatliv`,
      `${SITE}/en/privacy`,
      `${SITE}/ydelser`,
      `${SITE}/en/services`,
      `${SITE}/ydelser/webudvikling`,
      `${SITE}/en/services/web-development`,
    ]);
  });

  it("lists no catalog page the service leaves out (drafts, sections without a published item)", async () => {
    vi.mocked(getCatalogSitemapEntries).mockResolvedValue([]);
    expect((await sitemap()).map((candidate) => candidate.url)).toHaveLength(6);
  });

  it("keeps each catalog page's last modification", async () => {
    expect((await entry(`${SITE}/ydelser/webudvikling`)).lastModified).toEqual(UPDATED);
  });

  it("throws when NEXT_PUBLIC_SITE_URL is missing, so a broken sitemap is never cached", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", undefined);
    await expect(sitemap()).rejects.toThrow();
  });

  it("throws when the catalog cannot be read", async () => {
    vi.mocked(getCatalogSitemapEntries).mockRejectedValue(new Error("Failed to load the catalog sitemap: timeout"));
    await expect(sitemap()).rejects.toThrow(/catalog sitemap/);
  });

  it("is refreshed hourly like the public pages", () => {
    expect(revalidate).toBe(3600);
  });
});

describe("AC-CATPUB-31: sitemap alternates are absolute, with x-default = Danish", () => {
  it("gives the DA section entry its EN alternate and x-default on the DA URL", async () => {
    expect((await entry(`${SITE}/ydelser`)).alternates?.languages).toEqual({
      da: `${SITE}/ydelser`,
      en: `${SITE}/en/services`,
      "x-default": `${SITE}/ydelser`,
    });
  });

  it("gives an EN item entry the same absolute alternates as its DA entry", async () => {
    expect((await entry(`${SITE}/en/services/web-development`)).alternates?.languages).toEqual({
      da: `${SITE}/ydelser/webudvikling`,
      en: `${SITE}/en/services/web-development`,
      "x-default": `${SITE}/ydelser/webudvikling`,
    });
  });

  it("gives a system page its localized paths as alternates", async () => {
    expect((await entry(`${SITE}/en/contact`)).alternates?.languages).toEqual({
      da: `${SITE}/kontakt`,
      en: `${SITE}/en/contact`,
      "x-default": `${SITE}/kontakt`,
    });
  });
});
