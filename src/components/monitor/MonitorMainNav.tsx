import NextLink from "next/link";
import { getTranslations } from "next-intl/server";
import { AUTH_LOCALE } from "@/config/auth-areas";
import { siteOrigin } from "@/config/site-origin";
import { getNavItems } from "@/services/content/nav";

/**
 * The main site's header navigation (`getNavItems`, Danish) in the Monitor
 * panel's top bar, so a signed-in user reaches the site's pages directly.
 * The panel is served on its own host, where a path would stay on that host,
 * so each path is joined to the main site's origin (`siteOrigin`); an item
 * that is already an absolute URL (the Monitor area itself) is kept as is.
 * Its landmark carries the site nav's own label, distinct from the panel's
 * "Monitor" nav. No language switcher: the panel is Danish only. A failed
 * nav read throws, as in `SiteHeader`.
 */
export default async function MonitorMainNav() {
  const [items, t] = await Promise.all([
    getNavItems(AUTH_LOCALE),
    getTranslations({ locale: AUTH_LOCALE, namespace: "Nav" }),
  ]);
  const origin = siteOrigin();

  return (
    <nav aria-label={t("label")} className="w-full md:w-auto">
      <ul className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center md:gap-x-4 md:gap-y-0">
        {items.map((item) => (
          <li key={item.key}>
            <NextLink
              href={new URL(item.href, origin).href}
              lang={item.lang}
              hrefLang={item.hrefLang}
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
