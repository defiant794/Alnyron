/**
 * Target probe for the Monitor free cap. Migration 20261107000300 sets the
 * `public.profiles.monitor_limit` column default to 2; a target without it gives new profiles
 * the default of 20261106000200 (5), or has no such column at all. Tests that assert the
 * default of 2 skip on such a target with FREE_LIMIT_SKIP_REASON: running the migration in
 * their transaction would lock public.profiles, which must never happen on production.
 */

import type { PoolClient } from "./db.js";

/** Why an assertion on the default cap of 2 skips on a target whose column default is not 2. */
export const FREE_LIMIT_SKIP_REASON = "20261107000300 not on this target yet";

/**
 * The `public.profiles.monitor_limit` column default as information_schema reports it
 * (`"2"` once 20261107000300 is applied); undefined while the column does not exist.
 */
export async function monitorLimitDefault(c: PoolClient): Promise<string | null | undefined> {
  const { rows } = await c.query<{ column_default: string | null }>(
    `SELECT column_default
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'profiles'
       AND column_name  = 'monitor_limit'`,
  );
  return rows[0]?.column_default;
}

/** Whether new profiles on the target get monitor_limit = 2 (20261107000300 applied). */
export async function freeLimitApplied(c: PoolClient): Promise<boolean> {
  return (await monitorLimitDefault(c)) === "2";
}
