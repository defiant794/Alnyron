import type { MetadataRoute } from "next";
import { parseSiteEnv } from "@/config/env";
import { SYSTEM_PAGE_PATHNAMES } from "@/config/system-pages";
import { languageAlternates } from "@/i18n/alternates";
import { pathsInEveryLocale } from "@/i18n/navigation";
import { isContentPage } from "@/lib/validation/pages";
import { getCatalogSitemapEntries } from "@/services/content/catalog";
import { Constants } from "@/types/database";

/**
 * Like the public pages: publishes refresh it at once through the tag cache;
 * the hourly time-based window is a safety fallback. See the [locale] layout
 * comment for the free-tier KV write-quota trade-off.
 */
export const revalidate = 3600;

/**
 * `/sitemap.xml`: the content system pages (home, contact, privacy) and every
 * public catalog section and item, each in both locales with hreflang
 * alternates (`x-default` = Danish). Paths are English on both locales
 * (`/contact`, `/en/contact`, `/services`, `/en/services`). Drafts and
 * sections without a published item are left out (anonymous RLS), and so are
 * app areas (`/monitor`: outside the locale routing). URLs are absolute on
 * `NEXT_PUBLIC_SITE_URL`.
 *
 * @throws when the site URL is missing or the catalog cannot be read, so a
 *   broken sitemap is never cached.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const siteUrl = parseSiteEnv().NEXT_PUBLIC_SITE_URL;
  const absolute = (path: string) => new URL(path, siteUrl).toString();

  const systemPages = Constants.public.Enums.system_page_key.filter(isContentPage).flatMap((key) => {
    const paths = pathsInEveryLocale(SYSTEM_PAGE_PATHNAMES[key]);
    const languages = languageAlternates(paths);
    return Object.values(paths).map((url) => ({ url, alternates: { languages } }));
  });
  const catalog = await getCatalogSitemapEntries();

  return [...systemPages, ...catalog].map((entry) => ({
    ...entry,
    url: absolute(entry.url),
    alternates: {
      languages: Object.fromEntries(
        Object.entries(entry.alternates.languages).map(([language, path]) => [language, absolute(path)]),
      ),
    },
  }));
}
