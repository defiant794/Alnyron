import type { Locale } from "next-intl";
import { parseSiteEnv } from "@/config/env";
import { SYSTEM_PAGE_PATHNAMES } from "@/config/system-pages";
import { getPathname } from "@/i18n/navigation";

/**
 * Origin of the main site: `NEXT_PUBLIC_SITE_URL` without path or trailing
 * slash (`https://alnyron.dk`, `http://localhost:3000`), read at call time.
 * Pages served on the Monitor host link back to the main site with it (the
 * lockup via {@link siteHomeUrl}, the nav, the privacy links): there a path
 * would stay on the Monitor host.
 *
 * @throws when `NEXT_PUBLIC_SITE_URL` is missing or not a URL (`parseSiteEnv`).
 */
export function siteOrigin(): string {
  return new URL(parseSiteEnv().NEXT_PUBLIC_SITE_URL).origin;
}

/**
 * The main site's frontpage in `locale` by its absolute URL: the origin for
 * Danish (`https://alnyron.dk`), the origin plus the English home path for
 * English (`https://alnyron.dk/en`), the path the site nav links home with
 * (`getPathname`). Monitor's ALNYRON lockup links it, so a visitor reading
 * Monitor in English lands on the English frontpage.
 *
 * @throws when `NEXT_PUBLIC_SITE_URL` is missing or not a URL (`parseSiteEnv`).
 */
export function siteHomeUrl(locale: Locale): string {
  const path = getPathname({ href: SYSTEM_PAGE_PATHNAMES.home, locale });
  // The Danish home is the bare origin, written as `siteOrigin` writes it (no trailing slash).
  return path === "/" ? siteOrigin() : `${siteOrigin()}${path}`;
}
