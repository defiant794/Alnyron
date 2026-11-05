import { defineRouting } from "next-intl/routing";

/**
 * Locale routing for the public site (architecture §3).
 *
 * Danish is unprefixed (`/contact`), English lives under `/en`
 * (`/en/contact`). Every path segment is English in both locales, so each
 * pathname is the same string per locale and only the prefix differs (DB
 * slugs follow the same rule: `URL_SLUG_LOCALE` in `config/catalog.ts`).
 * Locale comes from the path only: no Accept-Language detection and no
 * locale cookie, so public responses set zero cookies and need no consent
 * banner.
 */
export const routing = defineRouting({
  locales: ["da", "en"],
  defaultLocale: "da",
  localePrefix: "as-needed",
  // DA-first: ignore Accept-Language.
  localeDetection: false,
  // `localeDetection: false` alone still writes NEXT_LOCALE in v4; this stops it.
  localeCookie: false,
  // The middleware cannot know which DB slugs exist (or 404), so hreflang
  // comes from each page's generateMetadata instead.
  alternateLinks: false,
  pathnames: {
    "/": "/",
    "/contact": "/contact",
    "/privacy": "/privacy",
    "/[slug]": "/[slug]",
    "/[slug]/[item]": "/[slug]/[item]",
  },
});
