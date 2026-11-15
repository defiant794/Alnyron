import { hasLocale, type Locale } from "next-intl";
import { routing } from "@/i18n/routing";

/**
 * The /order pages (thanks, error, withdraw) live outside `[locale]`, so their
 * language travels in the query (`?lang=da|en`): the Checkout return URLs, the
 * Buy route's error redirects and the personal withdraw link all carry it. The
 * middleware copies it into this request header for the /order layout
 * (`<html lang>`, skip link, footer), which cannot read the query.
 */
export const ORDER_LOCALE_HEADER = "x-order-locale";

/**
 * The UI language named by `value` (a `?lang=` value or a form's `locale`
 * field): one of the site's locales exactly, otherwise Danish
 * (`routing.defaultLocale`), so a missing, repeated or tampered value renders
 * Danish.
 */
export function orderLocale(value: unknown): Locale {
  return hasLocale(routing.locales, value) ? value : routing.defaultLocale;
}
