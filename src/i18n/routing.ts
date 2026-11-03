import { defineRouting } from "next-intl/routing";

/**
 * Locale routing for the public site (architecture §3).
 *
 * Danish is unprefixed (`/kontakt`), English lives under `/en`
 * (`/en/contact`). Locale comes from the path only: no Accept-Language
 * detection and no locale cookie, so public responses set zero cookies and
 * need no consent banner.
 */
export const routing = defineRouting({
  locales: ["da", "en"],
  defaultLocale: "da",
  localePrefix: "as-needed",
  // DA-first: ignore Accept-Language.
  localeDetection: false,
  // `localeDetection: false` alone still writes NEXT_LOCALE in v4; this stops it.
  localeCookie: false,
  // DB slugs differ per locale, so hreflang comes from generateMetadata instead.
  alternateLinks: false,
  pathnames: {
    "/": "/",
    "/contact": { da: "/kontakt", en: "/contact" },
    "/privacy": { da: "/privatliv", en: "/privacy" },
    "/[slug]": "/[slug]",
    "/[slug]/[item]": "/[slug]/[item]",
  },
});
