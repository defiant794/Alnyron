import { createTranslator, type Locale } from "next-intl";
import { setMonitorLocale } from "@/app/monitor/actions";
import { loadMessages } from "@/i18n/messages";
import { MONITOR_LOCALES } from "@/i18n/monitor-locale";
import { cx } from "@/lib/cx";

export type MonitorLocaleSwitcherProps = {
  /** The language the page is rendered in (`getMonitorLocale()`), marked current. */
  locale: Locale;
  /** The page's Monitor path (and query), where switching returns to. */
  currentPath: string;
};

/** A 44px pill segment (DESIGN.md), as the site's `LanguageSwitcher`. */
const SEGMENT = "inline-flex min-h-11 min-w-11 items-center justify-center rounded-pill px-3";

/**
 * The Monitor area's `DA | EN` pill toggle, drawn like the site's
 * `LanguageSwitcher`. Monitor has no locale in its paths, so the other
 * language is a one-button form that posts it with the page's path to
 * `setMonitorLocale`, which remembers it in a cookie and returns to the same
 * page, now in that language: it works without JavaScript. The current
 * language is marked, not a control. Synchronous, so the shell renders it
 * like any element.
 */
export default function MonitorLocaleSwitcher({ locale, currentPath }: MonitorLocaleSwitcherProps) {
  const t = createTranslator({ locale, messages: loadMessages(locale), namespace: "LanguageSwitcher" });

  return (
    <nav aria-label={t("label")}>
      <ul className="inline-flex items-center rounded-pill border border-border bg-bg text-small">
        {MONITOR_LOCALES.map((option) => {
          // Accessible name "EN English": starts with the visible code (WCAG
          // 2.5.3 Label in Name, voice control) and adds the full name.
          const content = (
            <>
              {option.toUpperCase()}
              <span className="sr-only">{` ${t(option)}`}</span>
            </>
          );

          return (
            <li key={option}>
              {option === locale ? (
                <span aria-current="true" lang={option} className={cx(SEGMENT, "bg-fg font-semibold text-bg")}>
                  {content}
                </span>
              ) : (
                <form action={setMonitorLocale} className="flex">
                  <input type="hidden" name="locale" value={option} />
                  <input type="hidden" name="next" value={currentPath} />
                  <button
                    type="submit"
                    lang={option}
                    className={cx(
                      SEGMENT,
                      "cursor-pointer text-muted transition-colors hover:bg-surface hover:text-fg active:bg-border",
                    )}
                  >
                    {content}
                  </button>
                </form>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
