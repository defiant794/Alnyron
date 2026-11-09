/**
 * Shared precondition helpers for monitor-engine integration tests (SNE-AC2i).
 * Used by both signup-notice-live.test.ts and engine-live.test.ts so the guard
 * code is in one place; SNE-AC2i-live1/live2/live3 (signup-notice-live.test.ts)
 * test it directly.
 */
import { MONITOR_SIGNUP_NOTICE_DAILY_CAP } from "@/config/monitor";
import { getClient } from "../../rls/helpers/db.js";

/** Confirmed monitor_user signups pending notification (cap lifted to catch all). */
async function pendingSignupCount(): Promise<number> {
  const c = await getClient();
  try {
    const { rows } = await c.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM public.monitor_engine_pending_signups(100, 2147483647)",
    );
    return rows[0]!.n;
  } finally {
    c.release();
  }
}

/** Unconfirmed monitor_user accounts >24 h old the purge could delete. */
async function purgeableAccountCount(): Promise<number> {
  const c = await getClient();
  try {
    const { rows } = await c.query<{ n: number }>(`
      SELECT count(*)::int AS n
        FROM auth.users u
        JOIN public.profiles p ON p.user_id = u.id
       WHERE p.role = 'monitor_user'
         AND u.email_confirmed_at IS NULL
         AND u.created_at < now() - interval '24 hours'
    `);
    return rows[0]!.n;
  } finally {
    c.release();
  }
}

/** monitor_user accounts stamped notified in the last 24 h: the daily notice cap's used slots. */
async function capSlotsUsed(): Promise<number> {
  const c = await getClient();
  try {
    const { rows } = await c.query<{ n: number }>(`
      SELECT count(*)::int AS n
        FROM public.profiles p
       WHERE p.role = 'monitor_user'
         AND p.signup_notified_at > now() - interval '24 hours'
    `);
    return rows[0]!.n;
  } finally {
    c.release();
  }
}

/**
 * SNE-AC2i: used in signup-notice-live.test.ts and engine-live.test.ts beforeAlls,
 * and directly tested by SNE-AC2i-live1/live2/live3. Throws with a deterministic message
 * when foreign signup or purge work is present, or when foreign stamps inside the 24 h
 * window leave the daily notice cap fewer free slots than `capHeadroomNeeded` (the most
 * notices the caller's tests need; 0 for a caller that sends none), so the SNE-AC2i tests can
 * pin on exact text.
 */
export async function assertNoForeignSignupWork(capHeadroomNeeded: number): Promise<void> {
  const signups = await pendingSignupCount();
  if (signups > 0) {
    throw new Error(
      `Precondition violated: ${signups} foreign confirmed signup(s) pending notification. ` +
        "They would be noticed and stamped during this test run.",
    );
  }
  const purgeable = await purgeableAccountCount();
  if (purgeable > 0) {
    throw new Error(
      `Precondition violated: ${purgeable} foreign purgeable unconfirmed monitor_user account(s). ` +
        "The purge step would delete them during this test run.",
    );
  }
  const used = await capSlotsUsed();
  const headroom = Math.max(0, MONITOR_SIGNUP_NOTICE_DAILY_CAP - used);
  if (headroom < capHeadroomNeeded) {
    throw new Error(
      `Precondition violated: ${used} foreign monitor_user notice stamp(s) in the last 24 h leave ` +
        `${headroom} of ${MONITOR_SIGNUP_NOTICE_DAILY_CAP} daily-cap slots; the tests need ${capHeadroomNeeded}.`,
    );
  }
}
