"use server";

import { hasLocale } from "next-intl";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { MONITOR_DASHBOARD_PATH } from "@/config/monitor";
import { MONITOR_LOCALE_COOKIE, MONITOR_LOCALES } from "@/i18n/monitor-locale";

/** How long the language choice is remembered: one year, in seconds. */
const LOCALE_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

// Placeholder origin used only to let the URL parser resolve the path.
const PROBE_ORIGIN = "http://monitor-return.invalid";

/**
 * The page a language switch returns to: `next` when it is a path on this
 * host (`/monitor/dashboard`, `/login?next=...`) written exactly as the
 * browser would request it, else `null`. The parse rejects anything that
 * leaves the host (absolute URLs, `javascript:`, protocol-relative `//host`
 * and the backslash, tab and newline forms browsers read as `//`), anything
 * it cannot parse (a forged `//[` or `//a:99999`) and any path the parser
 * rewrites (dot segments, also percent-encoded, as in
 * `/dashboard/../../admin`), so the redirect lands on the page it names.
 */
function returnPath(next: FormDataEntryValue | null): string | null {
  if (typeof next !== "string" || !next.startsWith("/")) return null;
  let url: URL;
  try {
    url = new URL(next, PROBE_ORIGIN);
  } catch {
    return null;
  }
  return url.origin === PROBE_ORIGIN && `${url.pathname}${url.search}${url.hash}` === next ? next : null;
}

/**
 * Switch the Monitor UI language (`MonitorLocaleSwitcher`'s DA | EN forms;
 * works without JavaScript). A `locale` Monitor offers is remembered for a
 * year in the {@link MONITOR_LOCALE_COOKIE} cookie (HTTP-only, sent on
 * top-level navigation, HTTPS-only in production); any other value is
 * ignored and the cookie left as it is. Then back to the `next` page, or the
 * dashboard when `next` is missing or unsafe (see {@link returnPath}).
 */
export async function setMonitorLocale(formData: FormData): Promise<void> {
  const locale = formData.get("locale");
  if (hasLocale(MONITOR_LOCALES, locale)) {
    (await cookies()).set(MONITOR_LOCALE_COOKIE, locale, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: LOCALE_COOKIE_MAX_AGE,
    });
  }

  redirect(returnPath(formData.get("next")) ?? MONITOR_DASHBOARD_PATH);
}
