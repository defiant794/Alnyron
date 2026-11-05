/**
 * Unit tests: locale-aware paths (src/i18n/navigation.ts: next-intl's
 * getPathname bound to src/i18n/routing.ts, and pathsInEveryLocale).
 * Journey: english-slugs
 * Acceptance IDs: AC-ENSLUG-01, AC-ENSLUG-01b, AC-ENSLUG-01g, AC-ENSLUG-04,
 *                 AC-ENSLUG-04b, AC-ENSLUG-04d, AC-ENSLUG-06e
 *
 * Every path segment is English on both locales: Danish is unprefixed, English
 * gets the /en prefix, and nothing else differs.
 */
import { describe, it, expect } from "vitest";
import { getPathname, pathsInEveryLocale } from "@/i18n/navigation";

describe("AC-ENSLUG-01/04: system pages have the same English path on both locales", () => {
  it.each([
    ["/", "da", "/"],
    ["/", "en", "/en"],
    ["/contact", "da", "/contact"],
    ["/contact", "en", "/en/contact"],
    ["/privacy", "da", "/privacy"],
    ["/privacy", "en", "/en/privacy"],
  ] as const)("%s on %s is %s", (href, locale, path) => {
    expect(getPathname({ href, locale })).toBe(path);
  });
});

describe("AC-ENSLUG-01g/04d: catalog pathnames keep the slugs and only change the prefix", () => {
  it.each([
    ["da", "/services"],
    ["en", "/en/services"],
  ] as const)("section on %s is %s", (locale, path) => {
    expect(getPathname({ href: { pathname: "/[slug]", params: { slug: "services" } }, locale })).toBe(path);
  });

  it.each([
    ["da", "/services/web-development"],
    ["en", "/en/services/web-development"],
  ] as const)("item on %s is %s", (locale, path) => {
    expect(
      getPathname({ href: { pathname: "/[slug]/[item]", params: { slug: "services", item: "web-development" } }, locale }),
    ).toBe(path);
  });
});

describe("AC-ENSLUG-06e: pathsInEveryLocale keys a page's path by every locale", () => {
  it("gives a system page's path per locale", () => {
    expect(pathsInEveryLocale("/contact")).toEqual({ da: "/contact", en: "/en/contact" });
  });

  it("gives a catalog page's path per locale, its slug filled in", () => {
    expect(pathsInEveryLocale({ pathname: "/[slug]", params: { slug: "services" } })).toEqual({
      da: "/services",
      en: "/en/services",
    });
  });
});
