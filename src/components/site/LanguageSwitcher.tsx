"use client";

import { useParams } from "next/navigation";
import { useLocale, type Locale } from "next-intl";
import { getPathname, usePathname } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";

type Href = Parameters<typeof getPathname>[0]["href"];

export type LanguageSwitcherProps = {
  /** Accessible name of the switcher landmark ("Sprog" / "Language"). */
  label: string;
  /** Each locale's name in its own language ("Dansk", "English"). */
  localeNames: Record<Locale, string>;
};

/**
 * `DA | EN` pill toggle (DESIGN.md). The other locale is a plain `<a>` to the
 * same page in that locale (`/kontakt` <-> `/en/contact`): a full document
 * load, so `<html lang>` updates and it works without JavaScript. The current
 * locale is marked, not linked.
 */
export default function LanguageSwitcher({ label, localeNames }: LanguageSwitcherProps) {
  const currentLocale = useLocale();
  // Internal pathname template (`/contact`, `/[slug]`) plus the route params
  // that fill it; both always describe the current route, so they match.
  const href = { pathname: usePathname(), params: useParams() } as Href;

  return (
    <nav aria-label={label}>
      <ul className="inline-flex items-center rounded-pill border border-border text-small">
        {routing.locales.map((locale) => {
          // Accessible name "EN English": starts with the visible code (WCAG
          // 2.5.3 Label in Name, voice control) and adds the full name.
          const content = (
            <>
              {locale.toUpperCase()}
              <span className="sr-only">{` ${localeNames[locale]}`}</span>
            </>
          );

          return (
            <li key={locale}>
              {locale === currentLocale ? (
                <span
                  aria-current="true"
                  lang={locale}
                  className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-pill bg-fg px-3 font-semibold text-bg"
                >
                  {content}
                </span>
              ) : (
                <a
                  href={getPathname({ href, locale })}
                  hrefLang={locale}
                  lang={locale}
                  className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-pill px-3 text-muted transition-colors hover:bg-surface hover:text-fg active:bg-border"
                >
                  {content}
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
