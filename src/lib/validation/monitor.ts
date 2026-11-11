import type { Messages } from "next-intl";
import { z } from "zod";
import {
  MONITOR_INTERVAL_RANGES,
  MONITOR_INTERVAL_UNITS,
  MONITOR_LABEL_MAX_LENGTH,
  type MonitorIntervalUnit,
} from "@/config/monitor";
import { checkMonitorUrl, type MonitorUrlCheck, type MonitorUrlRejection } from "@/lib/monitor/url-guard";

/**
 * Key of a monitor form message in `messages/*.json`
 * (`Monitor.form.errors`). Every issue these schemas raise carries such a key
 * as its message, so the caller shows copy in the visitor's Monitor language
 * instead of zod's English.
 */
export type MonitorValidationKey = keyof Messages["Monitor"]["form"]["errors"];

/** Issue options that set the message key (zod 4 `error` param). */
function issue(key: MonitorValidationKey) {
  return { error: key };
}

const URL_REJECTION_KEYS: Record<MonitorUrlRejection, MonitorValidationKey> = {
  invalid: "urlInvalid",
  scheme: "urlScheme",
  credentials: "urlCredentials",
  port: "urlPort",
  blocked_host: "urlBlockedHost",
  too_long: "urlTooLong",
};

/** A URL that names its scheme (`https://`, `ftp://`, ...). */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * A URL as typed into the monitor form: trimmed, and without a scheme
 * (`aarhus.dk/affald`) read as `https://`, then checked by
 * {@link checkMonitorUrl}.
 */
export function parseMonitorUrl(input: string): MonitorUrlCheck {
  const trimmed = input.trim();
  return checkMonitorUrl(trimmed === "" || HAS_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`);
}

/** The URL field: required, then {@link parseMonitorUrl}; the value becomes the normalised URL. */
const urlSchema = z.string(issue("urlRequired")).transform((value, ctx) => {
  if (value.trim() === "") {
    ctx.addIssue({ code: "custom", message: "urlRequired" satisfies MonitorValidationKey });
    return z.NEVER;
  }
  const result = parseMonitorUrl(value);
  if (!result.ok) {
    ctx.addIssue({ code: "custom", message: URL_REJECTION_KEYS[result.reason] });
    return z.NEVER;
  }
  return result.url;
});

/** Optional label; blank means none (`monitors.label` NULL). */
const labelSchema = z
  .string(issue("labelTooLong"))
  .trim()
  .max(MONITOR_LABEL_MAX_LENGTH, issue("labelTooLong"))
  .optional()
  .transform((value) => value || null);

/**
 * Add/edit monitor form: URL, optional label and the check interval as a
 * whole number of hours (1 to 168) or days (1 to 30). The interval value may
 * arrive as a form string; it is read as a number.
 */
export const monitorSchema = z
  .object({
    url: urlSchema,
    label: labelSchema,
    intervalValue: z.coerce.number(issue("intervalInvalid")).int(issue("intervalInvalid")),
    intervalUnit: z.enum(MONITOR_INTERVAL_UNITS, issue("intervalInvalid")),
  })
  .superRefine(({ intervalValue, intervalUnit }, ctx) => {
    const { min, max } = MONITOR_INTERVAL_RANGES[intervalUnit];
    if (intervalValue < min || intervalValue > max) {
      ctx.addIssue({
        code: "custom",
        path: ["intervalValue"],
        message: (intervalUnit === "hours" ? "intervalHoursRange" : "intervalDaysRange") satisfies MonitorValidationKey,
      });
    }
  });

export type MonitorInput = z.infer<typeof monitorSchema>;

/** A monitor id in a URL or action (any UUID-shaped string; PostgREST errors on others). */
export const monitorIdSchema = z.guid();

/** `monitors.interval_minutes` for an interval entered as `value` hours or days. */
export function intervalToMinutes(value: number, unit: MonitorIntervalUnit): number {
  return value * MONITOR_INTERVAL_RANGES[unit].minutes;
}

/**
 * The form's value + unit for a stored interval: whole days up to the days
 * maximum, else hours (at least one; intervals the form cannot produce are
 * rounded to the nearest hour).
 */
export function minutesToInterval(minutes: number): { value: number; unit: MonitorIntervalUnit } {
  const { days, hours } = MONITOR_INTERVAL_RANGES;
  if (minutes % days.minutes === 0 && minutes / days.minutes <= days.max) {
    return { value: minutes / days.minutes, unit: "days" };
  }
  return { value: Math.max(hours.min, Math.round(minutes / hours.minutes)), unit: "hours" };
}
