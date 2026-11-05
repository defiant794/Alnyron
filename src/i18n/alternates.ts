import type { Locale } from "next-intl";
import { routing } from "./routing";

/** A page's locale-aware path in each locale it exists in (`{ da: "/services", en: "/en/services" }`). */
export type LocalePaths = Partial<Record<Locale, string>>;

/**
 * hreflang alternates of a page: its path per locale it exists in, plus
 * `x-default` pointing at the default (Danish) path. Paths stay
 * site-relative: page metadata resolves them against `metadataBase`, the
 * sitemap against the site URL.
 */
export function languageAlternates(paths: LocalePaths): Record<string, string> {
  const languages: Record<string, string> = {};
  for (const locale of routing.locales) {
    const path = paths[locale];
    if (path) languages[locale] = path;
  }
  const defaultPath = paths[routing.defaultLocale];
  if (defaultPath) languages["x-default"] = defaultPath;
  return languages;
}
