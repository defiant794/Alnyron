import NextLink from "next/link";
import type { Locale } from "next-intl";
import { getTranslations } from "next-intl/server";
import { siteOrigin } from "@/config/site-origin";
import { getNavItems } from "@/services/content/nav";

export type MonitorMainNavProps = {
  /** The panel's UI language: the items and their main-site pages are in it. */
  locale: Locale;
};

/**
 * The main site's header navigation (`getNavItems`, in the panel's
 * language) in the Monitor panel's top bar, so a signed-in user reaches the
 * site's pages directly. The panel is served on its own host, where a path
 * would stay on that host, so each path is joined to the main site's origin
 * (`siteOrigin`); an item that is already an absolute URL (the Monitor area
 * itself) is kept as is. Its landmark carries the site nav's own label,
 * distinct from the panel's "Monitor" nav and the language switcher. A
 * failed nav read throws, as in `SiteHeader`.
 */
export default async function MonitorMainNav({ locale }: MonitorMainNavProps) {
  const [items, t] = await Promise.all([getNavItems(locale), getTranslations({ locale, namespace: "Nav" })]);
  const origin = siteOrigin();

  return (
    <nav aria-label={t("label")} className="w-full md:w-auto">
      <ul className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center md:gap-x-4 md:gap-y-0">
        {items.map((item) => (
          <li key={item.key}>
            <NextLink
              href={new URL(item.href, origin).href}
              lang={item.lang}
              className="inline-flex min-h-11 items-center rounded-btn px-1 text-muted transition-colors hover:text-fg active:text-fg"
            >
              {item.label}
            </NextLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
