"use client";

import type { Locale } from "next-intl";
import { useRef, type KeyboardEvent } from "react";
import { routing } from "@/i18n/routing";
import { cx } from "@/lib/cx";

/** Id of the tab for `locale` (pair it with {@link localePanelId} on the panel). */
export function localeTabId(baseId: string, locale: Locale): string {
  return `${baseId}-tab-${locale}`;
}

/** Id of the tab panel for `locale`. */
export function localePanelId(baseId: string, locale: Locale): string {
  return `${baseId}-panel-${locale}`;
}

export type LocaleTabsProps = {
  /** Shared prefix of the tab and panel ids (`useId()` of the editor). */
  baseId: string;
  /** Accessible name of the tab list ("Sprog"). */
  label: string;
  /** Tab text per locale ("Dansk", "Engelsk"). */
  names: Record<Locale, string>;
  selected: Locale;
  onSelect: (locale: Locale) => void;
};

/**
 * Dansk / Engelsk tabs of the admin editors (approved admin mock): an ARIA
 * tab list with roving tabindex; arrow keys, Home and End move between the
 * tabs. The editor renders the panels itself with {@link localePanelId} and
 * `aria-labelledby` = {@link localeTabId}, keeping every panel in its form.
 */
export default function LocaleTabs({ baseId, label, names, selected, onSelect }: LocaleTabsProps) {
  const tabs = useRef(new Map<Locale, HTMLButtonElement>());

  function handleKey(event: KeyboardEvent<HTMLButtonElement>) {
    const { locales } = routing;
    const index = locales.indexOf(selected);
    const next =
      event.key === "ArrowRight"
        ? locales[(index + 1) % locales.length]
        : event.key === "ArrowLeft"
          ? locales[(index - 1 + locales.length) % locales.length]
          : event.key === "Home"
            ? locales[0]
            : event.key === "End"
              ? locales[locales.length - 1]
              : undefined;
    if (!next) return;
    event.preventDefault();
    onSelect(next);
    tabs.current.get(next)?.focus();
  }

  return (
    <div role="tablist" aria-label={label} className="flex gap-1 self-start rounded-pill border border-border p-1">
      {routing.locales.map((locale) => {
        const isSelected = locale === selected;
        return (
          <button
            key={locale}
            ref={(element) => {
              if (element) tabs.current.set(locale, element);
              else tabs.current.delete(locale);
            }}
            type="button"
            role="tab"
            id={localeTabId(baseId, locale)}
            aria-selected={isSelected}
            aria-controls={localePanelId(baseId, locale)}
            tabIndex={isSelected ? 0 : -1}
            onClick={() => onSelect(locale)}
            onKeyDown={handleKey}
            className={cx(
              "min-h-11 cursor-pointer rounded-pill px-4 text-small font-semibold transition-[background-color,color]",
              isSelected ? "bg-brand-navy text-accent-ink" : "text-muted hover:bg-surface hover:text-fg active:bg-surface",
            )}
          >
            {names[locale]}
          </button>
        );
      })}
    </div>
  );
}
