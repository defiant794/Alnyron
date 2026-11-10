import * as z from "zod/mini";
import { MONITOR_MIN_RUN_SUBREQUESTS } from "@/config/monitor";

/**
 * Environment of the cron Worker `alnyron-monitor-cron`: `vars` from its
 * wrangler.jsonc plus two secrets (`wrangler secret put … --config
 * workers/monitor-cron/wrangler.jsonc`, or `.dev.vars` locally). Separate from
 * the web app's `src/config/env.ts` on purpose: the Supabase secret key
 * bypasses RLS and must never reach the public app bundle.
 *
 * Zod 4's tree-shakable `zod/mini` API: the classic `zod` import would add
 * about 440 KiB of minified code to a Worker that parses its bundle at every
 * cold start on a 10 ms CPU plan.
 */

const httpsUrl = z.string().check(z.refine((value) => URL.canParse(value) && new URL(value).protocol === "https:"));

const nonEmpty = z.string().check(z.minLength(1));

/** A new-format Supabase secret API key: `sb_secret_`, then at least one letter, digit, `_` or `-`. */
const supabaseSecretKey = z.string().check(z.regex(/^sb_secret_[A-Za-z0-9_-]+$/));

export const monitorCronEnvSchema = z.object({
  /** The Supabase project the engine works on. */
  SUPABASE_URL: httpsUrl,
  /**
   * Supabase secret API key (`sb_secret_…`, service_role): EXECUTE on the monitor_engine_*
   * functions. Anything else (a legacy JWT key, a publishable key, the key with quotes,
   * whitespace, a line break or a BOM around or in it) fails the env check, so a mangled
   * secret fails the run loudly (Cloudflare counts the error) instead of every engine call
   * failing silently at the Supabase gateway.
   */
  SUPABASE_SECRET_KEY: supabaseSecretKey,
  /** Resend sending key (restricted to the sending domain). */
  RESEND_API_KEY: nonEmpty,
  /** From address of every email (`Name <address>`), same as the web app's MAIL_FROM. */
  MAIL_FROM: nonEmpty,
  /** The Monitor host the emails link to (the monitor's detail page), `https://monitor.alnyron.dk`. */
  MONITOR_SITE_URL: httpsUrl,
  /** Monitors checked (and change emails sent per sweep) per run. */
  MONITOR_BATCH_SIZE: z.coerce.number().check(z.refine(Number.isInteger), z.gte(1), z.lte(500)),
  /**
   * Subrequests a run may make: the plan's per-invocation limit (Free 50, Paid 10 000). A run
   * claims no more monitors than this leaves room to check at their worst case. At least
   * {@link MONITOR_MIN_RUN_SUBREQUESTS} (17): below it a run could never check a monitor.
   */
  MONITOR_SUBREQUEST_LIMIT: z.coerce
    .number()
    .check(z.refine(Number.isInteger), z.gte(MONITOR_MIN_RUN_SUBREQUESTS), z.lte(10_000)),
});

export type MonitorCronEnv = z.infer<typeof monitorCronEnvSchema>;

/**
 * Validates the Worker's environment. On failure throws an Error that names
 * only the missing or invalid keys, never a value (they include secrets).
 */
export function parseMonitorCronEnv(raw: unknown): MonitorCronEnv {
  const result = monitorCronEnvSchema.safeParse(raw);
  if (!result.success) {
    const keys = [...new Set(result.error.issues.map((issue) => String(issue.path[0] ?? "(env)")))];
    throw new Error(`monitor-cron: missing or invalid environment keys: ${keys.join(", ")}`);
  }
  return result.data;
}
