import type { ReactNode } from "react";
import MonitorBrand from "@/components/monitor/MonitorBrand";
import { siteOrigin } from "@/config/site-origin";

/**
 * Centered card for every Monitor screen outside the panel (login, signup,
 * forgot password, reset, no access, not found, the error page), drawn to the
 * approved signup mock: a white card at most 400px wide (radius 16px, 36px
 * block padding from 640px) with the site's ALNYRON lockup on top, linked to
 * the main site's frontpage by its absolute URL (`NEXT_PUBLIC_SITE_URL`, read
 * at render: on the Monitor host `/` is the Monitor landing), on the surface
 * background. No footer: the card is the whole screen. Each page brings its
 * own heading. Like `MyLifeFrame` it draws its own card (the mock's radius is
 * not the shared `Card`'s 14px).
 */
export default function MonitorAuthFrame({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface px-4 py-12">
      <main id="main" tabIndex={-1} className="w-full max-w-100 focus:outline-none">
        <div className="flex flex-col gap-8 rounded-2xl border border-border bg-bg p-6 shadow-card sm:px-8 sm:py-9">
          <MonitorBrand href={siteOrigin()} className="self-center" />
          {children}
        </div>
      </main>
    </div>
  );
}
