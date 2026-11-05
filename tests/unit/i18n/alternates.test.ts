/**
 * Unit tests: hreflang alternates (src/i18n/alternates.ts), shared by the
 * page metadata and the sitemap.
 * Journey: catalog-public
 * Acceptance IDs: AC-CATPUB-22, AC-CATPUB-31
 */
import { describe, expect, it } from "vitest";
import { languageAlternates } from "@/i18n/alternates";

describe("AC-CATPUB-22: languageAlternates: da, en and x-default", () => {
  it("lists the path per locale, with x-default pointing at the Danish path", () => {
    expect(languageAlternates({ da: "/services", en: "/en/services" })).toEqual({
      da: "/services",
      en: "/en/services",
      "x-default": "/services",
    });
  });

  it("orders the keys da, en, x-default whatever the input order", () => {
    expect(Object.keys(languageAlternates({ en: "/en/services", da: "/services" }))).toEqual(["da", "en", "x-default"]);
  });

  it("leaves out a locale the page does not exist in", () => {
    expect(languageAlternates({ da: "/services" })).toEqual({ da: "/services", "x-default": "/services" });
  });

  it("has no x-default without a Danish path", () => {
    expect(languageAlternates({ en: "/en/services" })).toEqual({ en: "/en/services" });
  });

  it("skips an empty path", () => {
    expect(languageAlternates({ da: "", en: "/en/services" })).toEqual({ en: "/en/services" });
  });

  it("is empty for a page that exists in no locale", () => {
    expect(languageAlternates({})).toEqual({});
  });
});
