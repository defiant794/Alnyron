import { hasLocale, IntlErrorCode } from "next-intl";
import { getRequestConfig } from "next-intl/server";
import { loadMessages } from "./messages";
import { routing } from "./routing";

/**
 * Per-request next-intl config. Locale comes from the `[locale]` segment
 * (set via `setRequestLocale`); messages carry the recursive EN -> DA fallback.
 */
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;

  return {
    locale,
    messages: loadMessages(locale),
    timeZone: "Europe/Copenhagen",
    onError(error) {
      // Missing keys are already covered by the Danish fallback merge.
      if (error.code !== IntlErrorCode.MISSING_MESSAGE) console.error(error);
    },
  };
});
