import NextLink from "next/link";
import { createTranslator, type Locale } from "next-intl";
import type { ReactNode } from "react";
import { signOut } from "@/app/monitor/(auth)/actions";
import MonitorBrand from "@/components/monitor/MonitorBrand";
import MonitorLocaleSwitcher from "@/components/monitor/MonitorLocaleSwitcher";
import MonitorMainNav from "@/components/monitor/MonitorMainNav";
import SiteFooter from "@/components/site/SiteFooter";
import SiteMenu from "@/components/site/SiteMenu";
import SubmitButton from "@/components/ui/SubmitButton";
import { MONITOR_DASHBOARD_PATH, MONITOR_SETTINGS_PATH } from "@/config/monitor";
import { siteHomeUrl, siteOrigin } from "@/config/site-origin";
import { loadMessages } from "@/i18n/messages";
import { cx } from "@/lib/cx";

/** Panel destinations in the slim app bar. */
export type MonitorSection = "dashboard" | "settings";

/** Each section's start page. */
const SECTION_PATHS = {
  dashboard: MONITOR_DASHBOARD_PATH,
  settings: MONITOR_SETTINGS_PATH,
} as const satisfies Record<MonitorSection, string>;

export type MonitorShellProps = {
  /** The signed-in account, shown beside "Log ud". */
  email: string;
  /** The section the page belongs to (its nav link is marked current). */
  section: MonitorSection;
  /** The page's UI language (`getMonitorLocale()`): the shell's copy, the lockup's frontpage, the site nav and footer, the switcher. */
  locale: Locale;
  /**
   * The page's Monitor path (and query), where the language switcher
   * returns; defaults to the section's start page. The section's link is
   * `aria-current="page"` on that start page and `"true"` on a page below
   * it (`monitorDetailPath(id)`).
   */
  currentPath?: string;
  children: ReactNode;
};

/** Current section: navy, semibold, 2px accent rule under the label (as the site nav). */
const CURRENT =
  "aria-[current]:font-semibold aria-[current]:text-fg aria-[current]:underline aria-[current]:decoration-accent aria-[current]:decoration-2 aria-[current]:underline-offset-8";

/**
 * Monitor panel frame (approved dashboard mock): a two-row header that
 * mirrors the rest of the site. Row 1 is the site-style top bar, as
 * `SiteHeader`: the site's ALNYRON lockup on the left, linked to the main
 * site's frontpage in `locale` (`siteHomeUrl`: `/` or `/en` on
 * `NEXT_PUBLIC_SITE_URL`), and on the right the main site's own navigation
 * (`MonitorMainNav`, the admin-controlled nav as absolute links to the main
 * site) followed by the `DA | EN` switcher (`MonitorLocaleSwitcher`, back to
 * `currentPath`). Below 768px both collapse behind a "Menu" button
 * (`SiteMenu`, DESIGN.md Nav); from 768px up they sit inline. The top bar is
 * the menu's positioned container, so the open menu spans the bar and drops
 * down right under it, over the app bar: its links follow the button on
 * screen as in the focus order (WCAG 2.4.3). Row 2, under a divider, is the
 * slim Monitor app bar: the panel's two destinations (no sidebar, per the
 * brief) on the left, the account and "Log ud" on the right; it wraps on
 * small screens in reading order. The three navigation landmarks carry
 * distinct labels. Both rows and the page sit in a centered column up to
 * 1120px; the site footer below, whose privacy link is the main site's
 * absolute URL. Everything follows `locale`. Each panel page renders it with
 * its own `requireMonitor()` user (a synchronous component, so pages render
 * it like any element; the async `MonitorMainNav` and `SiteFooter` are server
 * component children, rendered by RSC).
 */
export default function MonitorShell({
  email,
  section,
  locale,
  currentPath = SECTION_PATHS[section],
  children,
}: MonitorShellProps) {
  const messages = loadMessages(locale);
  const t = createTranslator({ locale, messages, namespace: "Monitor" });
  const items = [
    { key: "dashboard", label: t("shell.dashboard") },
    { key: "settings", label: t("shell.settings") },
  ] as const satisfies readonly { key: MonitorSection; label: string }[];

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-border">
        <div className="relative z-10 mx-auto flex max-w-content flex-wrap items-center justify-between gap-x-6 gap-y-2 px-6 py-3">
          <MonitorBrand href={siteHomeUrl(locale)} />
          <SiteMenu toggleLabel={messages.Nav.menu}>
            <MonitorMainNav locale={locale} />
            <MonitorLocaleSwitcher locale={locale} currentPath={currentPath} />
          </SiteMenu>
        </div>
        <div className="border-t border-border">
          <div className="mx-auto flex max-w-content flex-wrap items-center justify-between gap-x-6 gap-y-1 px-6 py-2">
            <nav aria-label={t("shell.navLabel")}>
              <ul className="flex flex-wrap items-center gap-x-4">
                {items.map(({ key, label }) => (
                  <li key={key}>
                    <NextLink
                      href={SECTION_PATHS[key]}
                      aria-current={key === section ? (currentPath === SECTION_PATHS[key] ? "page" : "true") : undefined}
                      className={cx(
                        "inline-flex min-h-11 items-center rounded-btn px-1 text-muted transition-colors hover:text-fg",
                        CURRENT,
                      )}
                    >
                      {label}
                    </NextLink>
                  </li>
                ))}
              </ul>
            </nav>
            <section aria-label={t("shell.account")} className="flex items-center gap-3">
              <span className="hidden max-w-64 truncate text-small text-muted sm:block" title={email}>
                {email}
              </span>
              <form action={signOut}>
                <SubmitButton variant="secondary">{messages.Auth.signOut}</SubmitButton>
              </form>
            </section>
          </div>
        </div>
      </header>
      <main
        id="main"
        tabIndex={-1}
        className="mx-auto flex w-full max-w-content flex-1 flex-col gap-8 px-6 py-10 focus:outline-none"
      >
        {children}
      </main>
      <SiteFooter locale={locale} siteOrigin={siteOrigin()} />
    </div>
  );
}
