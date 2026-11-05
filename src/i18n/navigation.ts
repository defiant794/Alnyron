import type { Locale } from "next-intl";
import { createNavigation } from "next-intl/navigation";
import { routing } from "./routing";

/** The locale-aware path of a page (`/contact`, `/en/contact`), bound to {@link routing}. */
export const { getPathname } = createNavigation(routing);

/**
 * A next-intl href: internal pathname template plus the params that fill it
 * (`"/contact"`, `{ pathname: "/[slug]", params: { slug } }`).
 */
export type RouteHref = Parameters<typeof getPathname>[0]["href"];

/**
 * The locale-aware path of a page that exists in every locale
 * (`"/contact"` -> `{ da: "/contact", en: "/en/contact" }`).
 */
export function pathsInEveryLocale(href: RouteHref): Record<Locale, string> {
  const paths = Object.fromEntries(routing.locales.map((locale) => [locale, getPathname({ href, locale })]));
  // Built from every routing locale, so no key is missing.
  return paths as Record<Locale, string>;
}
