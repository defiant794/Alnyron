import { AUTH_LOCALE } from "@/config/auth-areas";
import { MONITOR_ERROR_THRESHOLD, MONITOR_INTERVAL_RANGES } from "@/config/monitor";

/** How a monitor is doing, as its status dot and text show it. */
export type MonitorHealth = "active" | "paused" | "error";

/**
 * Paused when the user paused it; otherwise "error" once the checker has
 * failed to fetch it {@link MONITOR_ERROR_THRESHOLD} times in a row, else active.
 */
export function monitorHealth(monitor: { status: string; consecutive_errors: number }): MonitorHealth {
  if (monitor.status === "paused") return "paused";
  return monitor.consecutive_errors >= MONITOR_ERROR_THRESHOLD ? "error" : "active";
}

/** A URL as people read it: without the scheme, and without the lone `/` of a site root (`example.com`). */
export function displayUrl(url: string): string {
  const withoutScheme = url.replace(/^https?:\/\//i, "");
  return withoutScheme.endsWith("/") && withoutScheme.indexOf("/") === withoutScheme.length - 1
    ? withoutScheme.slice(0, -1)
    : withoutScheme;
}

/** Message key (`Monitor.interval`) and count describing a check interval ("hver dag", "hver 6. time"). */
export function describeInterval(minutes: number): { key: "hour" | "hours" | "day" | "days" | "minutes"; count: number } {
  const { days, hours } = MONITOR_INTERVAL_RANGES;
  if (minutes % days.minutes === 0) {
    const count = minutes / days.minutes;
    return { key: count === 1 ? "day" : "days", count };
  }
  if (minutes % hours.minutes === 0) {
    const count = minutes / hours.minutes;
    return { key: count === 1 ? "hour" : "hours", count };
  }
  return { key: "minutes", count: minutes };
}

/** Largest unit first: seconds per unit for {@link formatRelative}. */
const RELATIVE_UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

const relativeFormat = new Intl.RelativeTimeFormat(AUTH_LOCALE, { numeric: "auto" });

/** Danish relative time of a past moment ("for 3 dage siden", "i går", "nu"). */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(seconds) >= size) return relativeFormat.format(Math.round(seconds / size), unit);
  }
  return relativeFormat.format(seconds, "second");
}

const dateTimeFormat = new Intl.DateTimeFormat(AUTH_LOCALE, {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Copenhagen",
});

/** Danish date and time in Danish time ("5. nov. 2026 11.00"). */
export function formatDateTime(iso: string): string {
  return dateTimeFormat.format(new Date(iso));
}
