import { hasLocale, type Locale } from "next-intl";
import { cookies } from "next/headers";
import { routing } from "@/i18n/routing";

/**
 * Cookie that remembers the Monitor area's UI language (set by
 * `setMonitorLocale`). Monitor is served outside `[locale]`, on its own host
 * with raw paths (no `/en` prefix), so the choice cannot live in the path as
 * on the public site, whose locale stays path-only and cookie-free
 * (`routing`). The admin and MyLife areas stay Danish (`AUTH_LOCALE`).
 */
export const MONITOR_LOCALE_COOKIE = "monitor-locale";

/** The languages Monitor offers: the site's own (`da`, `en`). */
export const MONITOR_LOCALES = routing.locales;

/**
 * The Monitor UI language of this request: the {@link MONITOR_LOCALE_COOKIE}
 * cookie when it names one of {@link MONITOR_LOCALES} exactly, otherwise
 * Danish (`routing.defaultLocale`), so a first visit and a missing or
 * tampered cookie all render Danish.
 */
export async function getMonitorLocale(): Promise<Locale> {
  const value = (await cookies()).get(MONITOR_LOCALE_COOKIE)?.value;
  return hasLocale(MONITOR_LOCALES, value) ? value : routing.defaultLocale;
}
