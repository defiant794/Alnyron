/**
 * Monitor: the public website-change monitor. A route group outside
 * `[locale]` (like the admin and MyLife), Danish only (`AUTH_LOCALE` in
 * `config/auth-areas`), served at `/monitor/*`. Unlike the other areas its
 * home is a public landing page and anyone may sign up; the signed-in panel
 * starts at the dashboard. Every link is built from these constants, so the
 * monitor host rewrite (monitor.alnyron.dk, a later slice) needs no page
 * changes.
 */
export const MONITOR_HOME_PATH = "/monitor";
export const MONITOR_LOGIN_PATH = "/monitor/login";
export const MONITOR_SIGNUP_PATH = "/monitor/signup";
export const MONITOR_FORGOT_PASSWORD_PATH = "/monitor/forgot-password";
/** Where reset links land (needs the session `/auth/confirm` created). */
export const MONITOR_SET_PASSWORD_PATH = "/monitor/reset";
export const MONITOR_NO_ACCESS_PATH = "/monitor/no-access";
/** The panel's start page: where sign-in and the signup confirmation link land. */
export const MONITOR_DASHBOARD_PATH = "/monitor/dashboard";
export const MONITOR_NEW_PATH = "/monitor/monitors/new";
export const MONITOR_SETTINGS_PATH = "/monitor/settings";

/** Detail page (header, actions, change history) of one monitor. */
export function monitorDetailPath(id: string): string {
  return `/monitor/monitors/${encodeURIComponent(id)}`;
}

/** Edit form of one monitor. */
export function monitorEditPath(id: string): string {
  return `${monitorDetailPath(id)}/edit`;
}

/** The only Monitor routes the middleware serves without a session. */
export const MONITOR_PUBLIC_PATHS: ReadonlySet<string> = new Set([
  MONITOR_HOME_PATH,
  MONITOR_LOGIN_PATH,
  MONITOR_SIGNUP_PATH,
  MONITOR_FORGOT_PASSWORD_PATH,
]);

/**
 * Robots directive of every Monitor page (also sent as an `X-Robots-Tag`
 * header for `/monitor` and `/monitor/*`, next.config.mjs): the public
 * landing and signup pages included, nothing in the area is indexed.
 */
export const MONITOR_ROBOTS = "noindex, nofollow";

/**
 * Monitors a new account may hold: the `profiles.monitor_limit` column
 * default (migration 20261106000200), enforced by the
 * `monitors_limit_per_user` trigger. The landing page quotes it.
 */
export const MONITOR_FREE_LIMIT = 5;

/** Units the check interval is entered in. */
export const MONITOR_INTERVAL_UNITS = ["hours", "days"] as const;

export type MonitorIntervalUnit = (typeof MONITOR_INTERVAL_UNITS)[number];

/**
 * Per unit: the allowed values (1 hour to 1 week, 1 to 30 days) and the
 * minutes one value stands for (`monitors.interval_minutes` = value x minutes).
 */
export const MONITOR_INTERVAL_RANGES = {
  hours: { min: 1, max: 168, minutes: 60 },
  days: { min: 1, max: 30, minutes: 1440 },
} as const satisfies Record<MonitorIntervalUnit, { min: number; max: number; minutes: number }>;

/** Interval preselected on the add form: once a day. */
export const MONITOR_DEFAULT_INTERVAL = { value: 1, unit: "days" } as const satisfies {
  value: number;
  unit: MonitorIntervalUnit;
};

/**
 * Consecutive failed fetches after which a monitor shows "Kunne ikke hentes"
 * (`monitors.consecutive_errors`, kept by the checker).
 */
export const MONITOR_ERROR_THRESHOLD = 3;

/** The longest URL `monitors.url` accepts (its CHECK constraint). */
export const MONITOR_URL_MAX_LENGTH = 2048;

/** The longest label `monitors.label` accepts (its CHECK constraint). */
export const MONITOR_LABEL_MAX_LENGTH = 200;
