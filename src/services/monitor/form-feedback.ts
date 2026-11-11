import { createTranslator, type Locale } from "next-intl";
import { z } from "zod";
import { AUTH_LOCALE } from "@/config/auth-areas";
import { MONITOR_INTERVAL_RANGES, MONITOR_LABEL_MAX_LENGTH, MONITOR_URL_MAX_LENGTH } from "@/config/monitor";
import { loadMessages } from "@/i18n/messages";
import type { MonitorValidationKey } from "@/lib/validation/monitor";

function createMonitorTranslator(locale: Locale) {
  return createTranslator({ locale, messages: loadMessages(locale), namespace: "Monitor" });
}

const MONITOR_TRANSLATORS = {
  da: createMonitorTranslator("da"),
  en: createMonitorTranslator("en"),
} satisfies Record<Locale, unknown>;

/** Monitor copy (`Monitor` in `messages/*.json`) in the visitor's `locale`, for the Monitor Server Actions. */
export function monitorTranslator(locale: Locale) {
  return MONITOR_TRANSLATORS[locale];
}

/** Values every monitor form message may name (bounds from `config/monitor`). */
const MESSAGE_VALUES = {
  urlMax: MONITOR_URL_MAX_LENGTH,
  labelMax: MONITOR_LABEL_MAX_LENGTH,
  hoursMin: MONITOR_INTERVAL_RANGES.hours.min,
  hoursMax: MONITOR_INTERVAL_RANGES.hours.max,
  daysMin: MONITOR_INTERVAL_RANGES.days.min,
  daysMax: MONITOR_INTERVAL_RANGES.days.max,
};

const isValidationKey = (key: string): key is MonitorValidationKey =>
  Object.hasOwn(loadMessages(AUTH_LOCALE).Monitor.form.errors, key);

/**
 * Turn a failed `lib/validation/monitor` parse into field messages in
 * `locale` (first problem per field). Every issue carries a message key;
 * anything else (never expected) falls back to the generic invalid-URL
 * message rather than leaking zod's English text.
 */
export function toMonitorFieldErrors<Input>(
  error: z.ZodError<Input>,
  locale: Locale,
): { [Field in keyof Input]?: string } {
  const { fieldErrors } = z.flattenError(error);
  const t = monitorTranslator(locale);
  const result: { [Field in keyof Input]?: string } = {};
  for (const field of Object.keys(fieldErrors) as (keyof Input & string)[]) {
    const key = fieldErrors[field]?.[0];
    if (key === undefined) continue;
    result[field] = t(`form.errors.${isValidationKey(key) ? key : "urlInvalid"}`, MESSAGE_VALUES);
  }
  return result;
}
