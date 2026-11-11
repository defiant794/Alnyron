import NextLink from "next/link";
import { createTranslator } from "next-intl";
import type { ReactNode } from "react";
import { signOut } from "@/app/monitor/(auth)/actions";
import MonitorBrand from "@/components/monitor/MonitorBrand";
import MonitorMainNav from "@/components/monitor/MonitorMainNav";
import SiteFooter from "@/components/site/SiteFooter";
import SiteMenu from "@/components/site/SiteMenu";
import SubmitButton from "@/components/ui/SubmitButton";
import { AUTH_LOCALE } from "@/config/auth-areas";
import { MONITOR_DASHBOARD_PATH, MONITOR_SETTINGS_PATH } from "@/config/monitor";
import { siteOrigin } from "@/config/site-origin";
import { loadMessages } from "@/i18n/messages";
import { cx } from "@/lib/cx";

/** Panel destinations in the top bar. */
export type MonitorSection = "dashboard" | "settings";

export type MonitorShellProps = {
  /** The signed-in account, shown beside "Log ud". */
  email: string;
  /** The section the page belongs to (its nav link is marked current). */
  section: MonitorSection;
  /** Whether the page IS the section's start page (`aria-current="page"`) or a page below it (`"true"`). */
  sectionPage?: boolean;
  children: ReactNode;
};

/** Current section: navy, semibold, 2px accent rule under the label (as the site nav). */
const CURRENT =
  "aria-[current]:font-semibold aria-[current]:text-fg aria-[current]:underline aria-[current]:decoration-accent aria-[current]:decoration-2 aria-[current]:underline-offset-8";

/**
 * Monitor panel frame (approved dashboard mock): a top bar with the site's
 * ALNYRON lockup, linked to the main site's frontpage (`siteOrigin`, from
 * `NEXT_PUBLIC_SITE_URL`), and the main site's own navigation beside it
 * (`MonitorMainNav`, absolute links to the main site); then the panel's two
 * destinations (no sidebar, per the brief), the account and "Log ud". The
 * two navigation landmarks carry distinct labels. The page sits in a
 * centered column up to 1120px; the site footer (Danish) below, whose
 * privacy link is the main site's absolute URL. Below 768px the site
 * navigation collapses behind a "Menu" button (`SiteMenu`, as in the main
 * site's header, DESIGN.md Nav); from 768px up it sits inline. The bar wraps
 * on small screens in reading order (the brand row with the menu, then the
 * panel navigation and account on their own row), so nothing comes between
 * the panel navigation and the page. The brand row is the menu's positioned
 * container, so the open menu drops down right under its button (over the
 * row below): its links come next on screen as in the focus order, before
 * the panel navigation (WCAG 2.4.3). Each panel page renders
 * it with its own `requireMonitor()` user (a synchronous component, so pages
 * render it like any element; the async `MonitorMainNav` and `SiteFooter`
 * are server component children, rendered by RSC).
 */
export default function MonitorShell({ email, section, sectionPage = true, children }: MonitorShellProps) {
  const messages = loadMessages(AUTH_LOCALE);
  const t = createTranslator({ locale: AUTH_LOCALE, messages, namespace: "Monitor" });
  const items = [
    { key: "dashboard", href: MONITOR_DASHBOARD_PATH, label: t("shell.dashboard") },
    { key: "settings", href: MONITOR_SETTINGS_PATH, label: t("shell.settings") },
  ] as const satisfies readonly { key: MonitorSection; href: string; label: string }[];

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-border">
        {/* Below 768px the rows carry the side padding, so the brand row (and the menu panel under it) spans the bar. */}
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3 md:px-6">
          <div className="relative z-10 flex w-full flex-wrap items-center gap-x-6 gap-y-2 px-6 md:w-auto md:px-0">
            <MonitorBrand href={siteOrigin()} />
            <SiteMenu toggleLabel={messages.Nav.menu}>
              <MonitorMainNav />
            </SiteMenu>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-6 md:px-0">
            <nav aria-label={t("shell.navLabel")}>
              <ul className="flex flex-wrap items-center gap-x-4">
                {items.map(({ key, href, label }) => (
                  <li key={key}>
                    <NextLink
                      href={href}
                      aria-current={key === section ? (sectionPage ? "page" : "true") : undefined}
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
      <SiteFooter locale={AUTH_LOCALE} siteOrigin={siteOrigin()} />
    </div>
  );
}
