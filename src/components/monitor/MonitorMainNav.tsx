import NextLink from "next/link";
import type { Locale } from "next-intl";
import { getTranslations } from "next-intl/server";
import { siteOrigin } from "@/config/site-origin";
import { getNavItems } from "@/services/content/nav";

export type MonitorMainNavProps = {
  /** The page's UI language: the items and their main-site pages are in it. */
  locale: Locale;
  /** This page's absolute URL, when its main-site nav item should be marked current. */
  currentHref?: string;
};

/**
 * The main site's header navigation (`getNavItems`, in the page's
 * language) in Monitor's landing and panel headers, so visitors reach the
 * site's pages directly. Monitor is served on its own host, where a path
 * would stay on that host, so each path is joined to the main site's origin
 * (`siteOrigin`); an item that is already an absolute URL (the Monitor area
 * itself) is kept as is. Its landmark carries the site nav's own label,
 * distinct from the panel's "Monitor" nav and the language switcher. When
 * `currentHref` equals an item's resolved URL, that item is marked as the
 * current page. A failed nav read throws, as in `SiteHeader`.
 */
export default async function MonitorMainNav({ locale, currentHref }: MonitorMainNavProps) {
  const [items, t] = await Promise.all([getNavItems(locale), getTranslations({ locale, namespace: "Nav" })]);
  const origin = siteOrigin();

  return (
    <nav aria-label={t("label")} className="w-full md:w-auto">
      <ul className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center md:gap-x-4 md:gap-y-0">
        {items.map((item) => {
          const href = new URL(item.href, origin).href;
          return (
            <li key={item.key}>
              <NextLink
                href={href}
                lang={item.lang}
                aria-current={href === currentHref ? "page" : undefined}
                className="inline-flex min-h-11 items-center rounded-btn px-1 text-muted transition-colors hover:text-fg active:text-fg aria-[current]:font-semibold aria-[current]:text-fg aria-[current]:underline aria-[current]:decoration-accent aria-[current]:decoration-2 aria-[current]:underline-offset-8"
              >
                {item.label}
              </NextLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
