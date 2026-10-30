import type { Locale, Messages } from "next-intl";
import da from "../../messages/da.json";
import en from "../../messages/en.json";
import { mergeLocalized } from "@/lib/i18n/merge-localized";

/**
 * UI messages per locale, merged once at module load. `messages/da.json` is
 * the complete source; other locales are merged onto it so a missing or blank
 * translation shows the Danish string instead of a raw key.
 */
const MESSAGES: Record<Locale, Messages> = {
  da,
  en: mergeLocalized(da, en),
};

/** UI messages for `locale` with Danish fallback applied. */
export function loadMessages(locale: Locale): Messages {
  return MESSAGES[locale];
}
