import { createTranslator } from "next-intl";
import { z } from "zod";
import { AUTH_LOCALE } from "@/config/auth-areas";
import { MONITOR_INTERVAL_RANGES, MONITOR_LABEL_MAX_LENGTH, MONITOR_URL_MAX_LENGTH } from "@/config/monitor";
import { loadMessages } from "@/i18n/messages";
import type { MonitorValidationKey } from "@/lib/validation/monitor";

const messages = loadMessages(AUTH_LOCALE);

/** Danish Monitor copy (`Monitor` in `messages/da.json`) for the Monitor Server Actions. */
export const monitorT = createTranslator({ locale: AUTH_LOCALE, messages, namespace: "Monitor" });

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
  Object.hasOwn(messages.Monitor.form.errors, key);

/**
 * Turn a failed `lib/validation/monitor` parse into Danish field messages
 * (first problem per field). Every issue carries a message key; anything
 * else (never expected) falls back to the generic invalid-URL message rather
 * than leaking zod's English text.
 */
export function toMonitorFieldErrors<Input>(error: z.ZodError<Input>): { [Field in keyof Input]?: string } {
  const { fieldErrors } = z.flattenError(error);
  const result: { [Field in keyof Input]?: string } = {};
  for (const field of Object.keys(fieldErrors) as (keyof Input & string)[]) {
    const key = fieldErrors[field]?.[0];
    if (key === undefined) continue;
    result[field] = monitorT(`form.errors.${isValidationKey(key) ? key : "urlInvalid"}`, MESSAGE_VALUES);
  }
  return result;
}
