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

/**
 * The main site's frontpage: where the ALNYRON lockup leads outside the panel
 * (the landing page and the auth card; inside the panel it leads to the
 * dashboard). Relative while Monitor is served under `/monitor` on the main
 * host; the monitor host slice must make it the main site's absolute URL,
 * because on monitor.alnyron.dk `/` would be the Monitor landing.
 */
export const MONITOR_SITE_HOME_HREF = "/";

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
 * default (migration 20261107000300, lowered from 5; accounts created
 * before it keep their own cap), enforced by the `monitors_limit_per_user`
 * trigger. The landing page quotes it.
 */
export const MONITOR_FREE_LIMIT = 2;

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
 * (`monitors.consecutive_errors`, kept by the checker). The engine also starts
 * backing off from here (the due query in `monitor_engine_claim`) and sends the
 * one "Vi kan ikke hente" email of the error streak.
 */
export const MONITOR_ERROR_THRESHOLD = 3;

/** The longest URL `monitors.url` accepts (its CHECK constraint). */
export const MONITOR_URL_MAX_LENGTH = 2048;

/** The longest label `monitors.label` accepts (its CHECK constraint). */
export const MONITOR_LABEL_MAX_LENGTH = 200;

/** Wall-clock budget of one page check: every DNS lookup and every redirect hop included. */
export const MONITOR_FETCH_TIMEOUT_MS = 15_000;

/**
 * Wall-clock time one cron run may use: Cloudflare's 15-minute (900 000 ms) limit of a cron
 * invocation minus a 30-second margin. A run starts no claim, email send or email lookup whose
 * worst case (every call taking its whole timeout) could end after it, and leases no more monitors
 * than it can check by then at {@link MONITOR_CHECK_WALL_MS} each once the claim call itself has
 * taken its whole {@link MONITOR_RPC_TIMEOUT_MS} (at most 24 per run).
 */
export const MONITOR_RUN_WALL_LIMIT_MS = 870_000;

/** How long one database call (a Supabase RPC, response included) may take before it is aborted and fails. */
export const MONITOR_RPC_TIMEOUT_MS = 5_000;

/** How long one email send (a Resend request) may take before it counts as a transient failure. */
export const MONITOR_EMAIL_SEND_TIMEOUT_MS = 10_000;

/**
 * Wall-clock time a cron run reserves for each monitor it leases (35 000 ms): the page fetch, the
 * error email sent during the check, and two database calls (snapshot read and record), each at
 * its whole timeout. No single check needs all of it (only a change reads the snapshot, only a
 * failure sends the error email), so every leased monitor is checked before
 * {@link MONITOR_RUN_WALL_LIMIT_MS}.
 */
export const MONITOR_CHECK_WALL_MS =
  MONITOR_FETCH_TIMEOUT_MS + MONITOR_EMAIL_SEND_TIMEOUT_MS + 2 * MONITOR_RPC_TIMEOUT_MS;

/** Bytes of a page body the checker reads; the rest is cut off (deterministically, so the hash stays stable). */
export const MONITOR_MAX_BODY_BYTES = 1_048_576;

/** Redirects the checker follows per check, so one check makes at most this + 1 page requests. */
export const MONITOR_MAX_REDIRECTS = 3;

/**
 * Subrequests one check may need at worst: two DNS lookups and the request for
 * the page and each of up to {@link MONITOR_MAX_REDIRECTS} redirects, plus the
 * snapshot read, the record call and one email. The cron run reserves this many
 * for every monitor it claims, and starts a check only with this many left.
 */
export const MONITOR_CHECK_SUBREQUESTS = (MONITOR_MAX_REDIRECTS + 1) * 3 + 3;

/**
 * The lowest per-run subrequest limit the cron Worker accepts
 * (`MONITOR_SUBREQUEST_LIMIT`): the run's two calls before its first check
 * (pending emails, claim) plus one worst-case check; below it a run could
 * never claim a monitor.
 */
export const MONITOR_MIN_RUN_SUBREQUESTS = 2 + MONITOR_CHECK_SUBREQUESTS;

/** Characters of a page's text stored as `monitors.last_snapshot` (the basis of the next change summary). */
export const MONITOR_SNAPSHOT_MAX_CHARS = 50_000;

/**
 * Minutes a monitor may be checked before its interval is up, so a check due
 * just after a cron run is not pushed to a whole extra run later.
 */
export const MONITOR_DUE_GRACE_MINUTES = 5;

/**
 * Monitor emails (change and error alike) per user per rolling 24 hours, counted
 * in the engine-only `monitor_email_log` (which users cannot delete); further
 * changes show only in the panel, and an error streak's notification waits until
 * the window frees.
 */
export const MONITOR_DAILY_EMAIL_CAP = 10;

/** Lines in a change summary (`monitor_events.summary`, the email's added/removed lists). */
export const MONITOR_SUMMARY_MAX_LINES = 5;

/** Characters per change-summary line, its `+ ` / `− ` prefix included. */
export const MONITOR_SUMMARY_MAX_LINE_CHARS = 160;

/** Characters in a whole change summary, line breaks included. */
export const MONITOR_SUMMARY_MAX_CHARS = 1000;

/** User-Agent of every page request the checker makes. */
export const MONITOR_FETCH_USER_AGENT = "AlnyronMonitor/1.0 (+https://alnyron.dk/monitor)";
