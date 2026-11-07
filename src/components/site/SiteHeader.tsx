import type { Locale } from "next-intl";
import { getTranslations } from "next-intl/server";
import Logo from "@/components/brand/Logo";
import LanguageSwitcher from "@/components/site/LanguageSwitcher";
import NavLink from "@/components/site/NavLink";
import SiteMenu from "@/components/site/SiteMenu";
import { getPathname } from "@/i18n/navigation";
import { getNavItems } from "@/services/content/nav";

export interface SiteHeaderProps {
  locale: Locale;
}

/**
 * Sticky site header (approved home mock): logo left; the DB-driven nav
 * ("Forside" pinned, published `show_in_nav` pages and public categories by
 * `nav_order`) and the DA/EN switcher right, collapsing into a menu below
 * 768px. The current page's link carries `aria-current="page"`.
 */
export default async function SiteHeader({ locale }: SiteHeaderProps) {
  const [items, t] = await Promise.all([getNavItems(locale), getTranslations({ locale })]);

  return (
    <header className="sticky top-0 z-10 border-b border-border bg-bg/90 backdrop-blur-sm">
      <div className="mx-auto flex h-21 max-w-content items-center justify-between gap-3 px-6 sm:gap-6">
        <Logo wordmark asLink href={getPathname({ href: "/", locale })} priority />
        <SiteMenu toggleLabel={t("Nav.menu")}>
          <nav aria-label={t("Nav.label")} className="w-full md:w-auto">
            <ul className="flex flex-col gap-2 md:flex-row md:items-center md:gap-6">
              {items.map((item) => (
                <li key={item.key}>
                  <NavLink
                    href={item.href}
                    lang={item.lang}
                    hrefLang={item.hrefLang}
                    className="flex min-h-11 items-center text-body text-muted transition-colors hover:text-fg active:text-fg"
                  >
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
          <LanguageSwitcher
            label={t("LanguageSwitcher.label")}
            localeNames={{ da: t("LanguageSwitcher.da"), en: t("LanguageSwitcher.en") }}
          />
        </SiteMenu>
      </div>
    </header>
  );
}
