import type { Locale } from "next-intl";
import { getTranslations } from "next-intl/server";
import { SYSTEM_PAGE_PATHNAMES } from "@/config/system-pages";
import { getPathname } from "@/i18n/navigation";
import { resolveContent } from "@/lib/i18n/resolve-content";
import { getPublicClient } from "@/lib/supabase/public";
import { getPublicCategories } from "./categories";

/** One header navigation link. */
export interface NavItem {
  /** Stable identity (React key): `system-home`, `page-<id>`, `category-<id>`. */
  key: string;
  label: string;
  /** Locale-aware path (`/`, `/en`, `/kontakt`, `/en/apps`); also the active-state key. */
  href: string;
  navOrder: number;
  /** The home page, pinned first whatever its `nav_order`. */
  isHome: boolean;
  /** Set when the label's language differs from the page (Danish fallback on an English page). */
  lang?: Locale;
}

/**
 * Orders nav items: home first, then everything else by ascending `navOrder`
 * (stable for ties). Visibility is decided before this call (RLS +
 * `show_in_nav`), so no item is added or dropped. The input is not mutated.
 */
export function buildNavItems(items: readonly NavItem[]): NavItem[] {
  const home = items.filter((item) => item.isHome);
  const rest = items.filter((item) => !item.isHome).toSorted((a, b) => a.navOrder - b.navOrder);
  return [...home, ...rest];
}

/**
 * Header navigation for `locale`: published pages with `show_in_nav` plus the
 * public categories, ordered by {@link buildNavItems}. System pages use the
 * fixed UI labels ("Forside", "Kontakt"); custom pages and categories use
 * their DB title with Danish fallback. A custom page without a slug in
 * `locale` is left out (slugs never fall back).
 *
 * @throws when a query fails, so a broken read never caches an empty nav.
 */
export async function getNavItems(locale: Locale): Promise<NavItem[]> {
  const [pages, categories, t] = await Promise.all([
    getPublicClient()
      .from("pages")
      .select("id, system_key, nav_order, page_translations(locale, title), routes(locale, slug)")
      .eq("status", "published")
      .eq("show_in_nav", true),
    getPublicCategories(locale),
    getTranslations({ locale, namespace: "Nav" }),
  ]);
  if (pages.error) throw new Error(`Failed to load the navigation: ${pages.error.message}`);

  const items: NavItem[] = [];
  for (const page of pages.data ?? []) {
    if (page.system_key) {
      items.push({
        key: `system-${page.system_key}`,
        label: t(page.system_key),
        href: getPathname({ href: SYSTEM_PAGE_PATHNAMES[page.system_key], locale }),
        navOrder: page.nav_order,
        isHome: page.system_key === "home",
      });
      continue;
    }

    const slug = page.routes.find((route) => route.locale === locale)?.slug;
    const da = page.page_translations.find((translation) => translation.locale === "da");
    if (!slug || !da) continue;
    const own = page.page_translations.find((translation) => translation.locale === locale);
    const { value, fallbackKeys } = resolveContent({ title: da.title }, own && { title: own.title }, locale);

    items.push({
      key: `page-${page.id}`,
      label: value.title,
      href: getPathname({ href: { pathname: "/[slug]", params: { slug } }, locale }),
      navOrder: page.nav_order,
      isHome: false,
      lang: fallbackKeys.includes("title") ? "da" : undefined,
    });
  }

  for (const category of categories) {
    items.push({
      key: `category-${category.id}`,
      label: category.title,
      href: category.href,
      navOrder: category.navOrder,
      isHome: false,
      lang: category.fallbackKeys.includes("title") ? "da" : undefined,
    });
  }

  return buildNavItems(items);
}
