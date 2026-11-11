import type { Locale } from "next-intl";
import type { ReactNode } from "react";
import MonitorBrand from "@/components/monitor/MonitorBrand";
import { siteHomeUrl } from "@/config/site-origin";

export type MonitorAuthFrameProps = {
  /** The page's UI language (`getMonitorLocale()`, `useLocale()` in the error boundary): the lockup links that frontpage. */
  locale: Locale;
  /**
   * The page's `MonitorLocaleSwitcher`, right-aligned above the card. A slot,
   * not built in: the error boundary (a client component) renders this frame
   * too, and the switcher reads the message catalogues on the server. The
   * error and 404 pages, which know no page to return to, leave it out.
   */
  localeSwitcher?: ReactNode;
  children: ReactNode;
};

/**
 * Centered card for every Monitor screen outside the panel (login, signup,
 * forgot password, reset, no access, not found, the error page), drawn to the
 * approved signup mock: a white card at most 400px wide (radius 16px, 36px
 * block padding from 640px) with the site's ALNYRON lockup on top, linked to
 * the main site's frontpage in `locale` by its absolute URL (`siteHomeUrl`,
 * from `NEXT_PUBLIC_SITE_URL` read at render: on the Monitor host `/` is the
 * Monitor landing), on the surface background. The `DA | EN` switcher, when
 * given, sits just above the card's top-right corner, before the main
 * landmark (the skip link passes it, as the site header's). No footer: the
 * card is the whole screen. Each page brings its own heading. Like
 * `MyLifeFrame` it draws its own card (the mock's radius is not the shared
 * `Card`'s 14px).
 */
export default function MonitorAuthFrame({ locale, localeSwitcher, children }: MonitorAuthFrameProps) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-surface px-4 py-12">
      {localeSwitcher && <div className="flex w-full max-w-100 justify-end">{localeSwitcher}</div>}
      <main id="main" tabIndex={-1} className="w-full max-w-100 focus:outline-none">
        <div className="flex flex-col gap-8 rounded-2xl border border-border bg-bg p-6 shadow-card sm:px-8 sm:py-9">
          <MonitorBrand href={siteHomeUrl(locale)} className="self-center" />
          {children}
        </div>
      </main>
    </div>
  );
}
