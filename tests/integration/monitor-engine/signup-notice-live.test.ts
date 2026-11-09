/**
 * Live engine integration test: signup sweep + purge step
 * Journey: monitor-signup-notice
 *   SNE-AC1a-c, SNE-AC1g-h, SNE-AC1j, SNE-AC2g-i, SNE-AC3a-d, SNE-AC4e, SNE-AC5a-b
 *
 * e2e target only (requires SUPABASE_E2E_REF): off that target the whole suite is
 * reported as skipped (describe.skipIf), never as passed.
 *
 * Isolation strategy:
 *   RUN_CONFIG uses subrequestLimit = 5 (NO_CLAIM_SUBREQUESTS, a literal). The first email
 *   sweep's lookup (nothing pending, see the preconditions) leaves 4; the claim needs its own
 *   subrequest plus MONITOR_CHECK_SUBREQUESTS (15) per monitor, so claimLimit =
 *   floor((4 - 1) / 15) = 0 and no monitor is ever claimed or stamped in this file (this holds
 *   while MONITOR_CHECK_SUBREQUESTS is at least 4). The purge needs 1 (4 ≥ 1, leaving 3) and
 *   the signup sweep 3 (3 ≥ 3: pendingSignups, send, markSignupNotified, leaving 0), so both
 *   still run.
 *
 * Preconditions (SNE-AC2i — fail fast with a clear message):
 *   - no foreign pending change events the emailSweep could email and stamp
 *   - no foreign confirmed monitor_user signup pending notification
 *   - no foreign purgeable unconfirmed monitor_user account
 *   - no foreign notice stamp inside the 24 h window (the cap tests need the whole daily cap)
 *
 * fileParallelism is false for all integration tests (vitest.config.ts), so this
 * file and engine-live.test.ts never run concurrently.
 *
 * Run: npm run test:integration:e2e-project -- tests/integration/monitor-engine/signup-notice-live.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { MONITOR_SIGNUP_NOTICE_DAILY_CAP, MONITOR_SIGNUP_NOTICE_PER_RUN } from "@/config/monitor";
import { createSupabaseEngineRpc, EngineRpcError } from "../../../workers/monitor-cron/rpc";
import { runMonitorChecks, type Mailer, type RunConfig, type RunSummary } from "../../../workers/monitor-cron/run";
import type { EmailMessage, SendResult } from "@/lib/email/resend";
import { endPool, getClient } from "../rls/helpers/db.js";
import { assertNoForeignSignupWork } from "./helpers/signup-preconditions.js";
import { expectPgError, withTx } from "../rls/helpers/roles.js";
import { assertE2eTarget } from "../../helpers/assert-e2e-target.js";

// ── Skip when not on the e2e project ─────────────────────────────────────────

const ON_E2E = !!process.env.SUPABASE_E2E_REF;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? "";
const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";

// ── No-claim run budget (see "Isolation strategy" in the header) ─────────────

const NO_CLAIM_SUBREQUESTS = 1 + 1 + 3; // emailSweep + purge + full signupSweep

const RUN_CONFIG: RunConfig = {
  batchSize: 10,
  subrequestLimit: NO_CLAIM_SUBREQUESTS,
  siteUrl: "https://alnyron.dk",
  mailFrom: "Alnyron <noreply@send.alnyron.dk>",
};

/**
 * Daily notice-cap slots this file needs free: SNE-AC2g-live6 stamps exactly
 * MONITOR_SIGNUP_NOTICE_DAILY_CAP accounts inside the 24 h window and expects
 * `pendingSignups(1, CAP + 1)` to return its own account, so any foreign stamp in the window
 * fails it (SNE-AC1a and SNE-AC2h need one slot each).
 */
const CAP_HEADROOM_NEEDED = MONITOR_SIGNUP_NOTICE_DAILY_CAP;

const SEED_PREFIX = `e2e-signup-${Date.now()}-`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAdminClient() {
  return createClient<Database>(SUPABASE_URL, SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

interface CapturedMail {
  to: string;
  subject: string;
  idempotencyKey: string;
  html: string;
  text: string;
}

function makeCapturingMailer(): { mailer: Mailer; captured: CapturedMail[] } {
  const captured: CapturedMail[] = [];
  const mailer: Mailer = async (message: EmailMessage, idempotencyKey: string): Promise<SendResult> => {
    captured.push({ to: message.to, subject: message.subject, idempotencyKey, html: message.html, text: message.text });
    return { ok: true, id: `captured-${idempotencyKey}` };
  };
  return { mailer, captured };
}

/** Run the engine once with a capturing mailer (no-claim budget). */
async function runEngine(): Promise<{ summary: RunSummary; captured: CapturedMail[] }> {
  const { mailer, captured } = makeCapturingMailer();
  const rpc = createSupabaseEngineRpc(SUPABASE_URL, SECRET_KEY);
  const summary = await runMonitorChecks({
    rpc,
    mailer,
    // fetchPage is never called at this budget (claimLimit=0), but required by the signature.
    fetchPage: async (url) => ({ ok: true, body: "<html><body><p>Stable</p></body></html>", contentType: "text/html", finalUrl: url, truncated: false, subrequests: 1 }),
    config: RUN_CONFIG,
    log: () => {},
  });
  return { summary, captured };
}

/** Profile emails of owners ordered by profile created_at then user_id (the RPC's owner_emails contract). */
async function ownerEmails(): Promise<string[]> {
  const c = await getClient();
  try {
    const { rows } = await c.query<{ email: string }>(
      `SELECT p.email
         FROM public.profiles p
        WHERE p.role = 'owner'
        ORDER BY p.created_at, p.user_id`,
    );
    return rows.map((r) => r.email);
  } finally {
    c.release();
  }
}

// ── Precondition helpers ──────────────────────────────────────────────────────

/** Pending change events the emailSweep could email (cap lifted to catch all). */
async function pendingEventCount(): Promise<number> {
  const c = await getClient();
  try {
    const { rows } = await c.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM public.monitor_engine_pending_emails(500, 2147483647)",
    );
    return rows[0]!.n;
  } finally {
    c.release();
  }
}

// ── Fixture helpers ───────────────────────────────────────────────────────────

/** Create a confirmed monitor_user via service-role. Returns the user's id. */
async function createConfirmedMonitorUser(tag: string): Promise<string> {
  const admin = makeAdminClient();
  const { data, error } = await admin.auth.admin.createUser({
    email: `${SEED_PREFIX}${tag}@alnyron-test.local`,
    email_confirm: true,
    user_metadata: {},
  });
  if (error) throw new Error(`Failed to create confirmed monitor user (${tag}): ${error.message}`);
  return data.user.id;
}

/** Create an unconfirmed monitor_user (no email_confirm, no password). Returns the user's id. */
async function createUnconfirmedMonitorUser(tag: string): Promise<string> {
  const admin = makeAdminClient();
  const { data, error } = await admin.auth.admin.createUser({
    email: `${SEED_PREFIX}${tag}@alnyron-test.local`,
    email_confirm: false,
    user_metadata: {},
  });
  if (error) throw new Error(`Failed to create unconfirmed monitor user (${tag}): ${error.message}`);
  return data.user.id;
}

/** Delete a user by id. */
async function deleteUser(id: string): Promise<void> {
  const admin = makeAdminClient();
  const { error } = await admin.auth.admin.deleteUser(id);
  if (error) throw new Error(`Failed to delete user ${id}: ${error.message}`);
}

/** Set email_confirmed_at to now() - hoursBack hours via direct SQL. */
async function setConfirmedAtHoursBack(userId: string, hoursBack: number): Promise<void> {
  const c = await getClient();
  try {
    await c.query(
      "UPDATE auth.users SET email_confirmed_at = now() - make_interval(hours => $2) WHERE id = $1",
      [userId, hoursBack],
    );
  } finally {
    c.release();
  }
}

/** Set created_at to now() - hoursBack hours via direct SQL. */
async function setCreatedAtHoursBack(userId: string, hoursBack: number): Promise<void> {
  const c = await getClient();
  try {
    await c.query(
      "UPDATE auth.users SET created_at = now() - make_interval(hours => $2) WHERE id = $1",
      [userId, hoursBack],
    );
  } finally {
    c.release();
  }
}

/** Stamp the profile notified minutesBack minutes ago (inside the 24 h cap window); throws unless one row changed. */
async function setSignupNotifiedMinutesBack(userId: string, minutesBack: number): Promise<void> {
  const c = await getClient();
  try {
    const { rowCount } = await c.query(
      "UPDATE public.profiles SET signup_notified_at = now() - make_interval(mins => $2) WHERE user_id = $1",
      [userId, minutesBack],
    );
    if (rowCount !== 1) throw new Error(`Expected 1 profile row to stamp, got ${rowCount ?? 0}`);
  } finally {
    c.release();
  }
}

/** Read signup_notified_at for a profile (null = not set). */
async function readSignupNotifiedAt(userId: string): Promise<string | null> {
  const c = await getClient();
  try {
    const { rows } = await c.query<{ stamp: string | null }>(
      "SELECT signup_notified_at::text AS stamp FROM public.profiles WHERE user_id = $1",
      [userId],
    );
    return rows[0]?.stamp ?? null;
  } finally {
    c.release();
  }
}

/** Check whether a row still exists in auth.users. */
async function userExists(userId: string): Promise<boolean> {
  const c = await getClient();
  try {
    const { rows } = await c.query<{ id: string }>(
      "SELECT id FROM auth.users WHERE id = $1",
      [userId],
    );
    return rows.length > 0;
  } finally {
    c.release();
  }
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  if (!ON_E2E) return;
  // Guard: verify the env targets the e2e project, not prod,
  // before the first supabase-js client is built later in this beforeAll.
  assertE2eTarget();

  // Fail fast if migration is missing
  const c = await getClient();
  try {
    const { rows } = await c.query<{ pending: string | null }>(
      "SELECT to_regprocedure('public.monitor_engine_pending_signups(integer,integer)')::text AS pending",
    );
    if (!rows[0]?.pending) {
      throw new Error(
        "monitor_engine_pending_signups not found on e2e project — " +
          "apply 20261110000100_monitor_signup_notice.sql before running this file",
      );
    }
  } finally {
    c.release();
  }

  if (ON_E2E && !PUBLISHABLE_KEY) {
    throw new Error("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is empty on the e2e target — check tests/.env.e2e");
  }

  // Precondition: no foreign pending change events the emailSweep could stamp irreversibly.
  const events = await pendingEventCount();
  if (events > 0) {
    throw new Error(
      `Precondition violated: ${events} foreign pending change event(s) in the 23 h email window. ` +
        "They would be emailed and stamped during this test run.",
    );
  }

  // Preconditions (SNE-AC2i): no foreign pending signup, purgeable account or in-window stamp.
  await assertNoForeignSignupWork(CAP_HEADROOM_NEEDED);
});

afterAll(async () => {
  await endPool();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe.skipIf(!ON_E2E)("monitor signup-notice live run (e2e project only)", () => {

  // SNE-AC2i: precondition helper rejects when foreign signup/purge work is present
  it("SNE-AC2i-live1: assertNoForeignSignupWork rejects when a confirmed un-notified monitor_user exists", async () => {
    const userId = await createConfirmedMonitorUser("ac2i-signup");
    try {
      await expect(assertNoForeignSignupWork(CAP_HEADROOM_NEEDED)).rejects.toThrow(
        "Precondition violated: 1 foreign confirmed signup(s) pending notification",
      );
    } finally {
      await deleteUser(userId);
    }
  });

  it("SNE-AC2i-live2: assertNoForeignSignupWork rejects when a purgeable unconfirmed monitor_user account exists", async () => {
    const userId = await createUnconfirmedMonitorUser("ac2i-purge");
    try {
      await setCreatedAtHoursBack(userId, 25);
      await expect(assertNoForeignSignupWork(CAP_HEADROOM_NEEDED)).rejects.toThrow(
        "Precondition violated: 1 foreign purgeable unconfirmed monitor_user account(s)",
      );
    } finally {
      await deleteUser(userId);
    }
  });

  it("SNE-AC2i-live3: assertNoForeignSignupWork rejects when a monitor_user stamped inside the 24 h window holds a daily-cap slot", async () => {
    const userId = await createConfirmedMonitorUser("ac2i-stamped");
    try {
      await setSignupNotifiedMinutesBack(userId, 1);
      await expect(assertNoForeignSignupWork(CAP_HEADROOM_NEEDED)).rejects.toThrow(
        `Precondition violated: 1 foreign monitor_user notice stamp(s) in the last 24 h leave ` +
          `${MONITOR_SIGNUP_NOTICE_DAILY_CAP - 1} of ${MONITOR_SIGNUP_NOTICE_DAILY_CAP} daily-cap slots; ` +
          `the tests need ${CAP_HEADROOM_NEEDED}.`,
      );
    } finally {
      await deleteUser(userId);
    }
  });

  // SNE-AC1a: confirmed monitor_user → exactly one email to expected owner
  it("SNE-AC1a-live1: confirmed monitor_user → one email to owner_emails[0] with key monitor-signup/<id> and defanged address", async () => {
    const userId = await createConfirmedMonitorUser("confirmed");
    try {
      const owners = await ownerEmails();
      expect(owners.length).toBeGreaterThan(0); // e2e anchor owner must exist

      const { summary, captured } = await runEngine();

      const signupMails = captured.filter((m) => m.idempotencyKey.startsWith("monitor-signup/"));
      expect(signupMails).toHaveLength(1);
      expect(signupMails[0]!.idempotencyKey).toBe(`monitor-signup/${userId}`);
      expect(signupMails[0]!.to).toBe(owners[0]);
      expect(summary.signupNotices).toBe(1);

      // Address is defanged in both html and text (full-defang rule: domain-like dots → [.], @ → [at]).
      // SEED_PREFIX is e2e-signup-<ts>- (hyphens only, no dots); local part has no dots.
      // Token pinned as a literal — not re-derived from the defang logic:
      const expectedDefanged = `${SEED_PREFIX}confirmed[at]alnyron-test[.]local`;
      expect(signupMails[0]!.html).toContain(expectedDefanged);
      expect(signupMails[0]!.text).toContain(expectedDefanged);
      expect(signupMails[0]!.html).not.toContain("@");
      expect(signupMails[0]!.html).not.toContain("alnyron-test.local");
      expect(signupMails[0]!.text).not.toContain("@");
      expect(signupMails[0]!.text).not.toContain("alnyron-test.local");
      // signup_notified_at is now set
      expect(await readSignupNotifiedAt(userId)).not.toBeNull();
    } finally {
      await deleteUser(userId);
    }
  });

  // SNE-AC1b: second run → no email (signup_notified_at set)
  it("SNE-AC1b-live2: second run with signup_notified_at already set → no signup notice", async () => {
    const userId = await createConfirmedMonitorUser("already-noticed");
    try {
      // First run to stamp signup_notified_at
      await runEngine();
      expect(await readSignupNotifiedAt(userId)).not.toBeNull();

      // Second run: no notice
      const { summary, captured } = await runEngine();
      const signupMails = captured.filter((m) => m.idempotencyKey.startsWith("monitor-signup/"));
      expect(signupMails).toHaveLength(0);
      expect(summary.signupNotices).toBe(0);
    } finally {
      await deleteUser(userId);
    }
  });

  // SNE-AC1g: unconfirmed → no email
  it("SNE-AC1g-live3: unconfirmed monitor_user → no signup notice, signup_notified_at stays null", async () => {
    const userId = await createUnconfirmedMonitorUser("unconfirmed");
    try {
      const { summary, captured } = await runEngine();
      const signupMails = captured.filter((m) => m.idempotencyKey.startsWith("monitor-signup/"));
      expect(signupMails).toHaveLength(0);
      expect(summary.signupNotices).toBe(0);
      expect(await readSignupNotifiedAt(userId)).toBeNull();
    } finally {
      await deleteUser(userId);
    }
  });

  // SNE-AC1h: confirmed other-role (mylife_user) → no email
  it("SNE-AC1h-live4: confirmed mylife_user → no signup notice (role guard)", async () => {
    const mylifeEmail = `${SEED_PREFIX}mylife@alnyron-test.local`;
    let userId: string | undefined;
    const c = await getClient();
    try {
      await c.query(
        "INSERT INTO public.user_allowlist (email, role) VALUES ($1, 'mylife_user') ON CONFLICT DO NOTHING",
        [mylifeEmail],
      );
    } finally {
      c.release();
    }
    try {
      const { data, error } = await makeAdminClient().auth.admin.createUser({
        email: mylifeEmail,
        email_confirm: true,
        user_metadata: {},
      });
      if (error) throw new Error(`Failed to create mylife_user: ${error.message}`);
      userId = data.user.id;

      const { captured } = await runEngine();
      const signupMails = captured.filter((m) => m.idempotencyKey.startsWith("monitor-signup/"));
      expect(signupMails).toHaveLength(0);
    } finally {
      const c2 = await getClient();
      try {
        await c2.query("DELETE FROM public.user_allowlist WHERE email = $1", [mylifeEmail]);
      } finally {
        c2.release();
      }
      if (userId) await deleteUser(userId).catch(() => {});
    }
  });

  // SNE-AC1c: confirmed >23h ago → no email, stays NULL
  it("SNE-AC1c-live5: confirmed >23 h ago → no signup notice, signup_notified_at stays null", async () => {
    const userId = await createConfirmedMonitorUser("old-confirmed");
    try {
      await setConfirmedAtHoursBack(userId, 24);
      const { captured } = await runEngine();
      expect(captured.filter((m) => m.idempotencyKey.startsWith("monitor-signup/"))).toHaveLength(0);
      expect(await readSignupNotifiedAt(userId)).toBeNull();
    } finally {
      await deleteUser(userId);
    }
  });

  // SNE-AC2g: over daily cap → pendingSignups RPC returns [] → no notice; one more slot returns the account
  it("SNE-AC2g-live6: over daily cap → pendingSignups(1, CAP) returns [], no notice sent; pendingSignups(1, CAP + 1) returns the account", async () => {
    const userId = await createConfirmedMonitorUser("over-cap");
    const capSeeds: string[] = [];
    try {
      // Create cap-many confirmed users stamped as already-notified within 24h
      for (let i = 0; i < MONITOR_SIGNUP_NOTICE_DAILY_CAP; i++) {
        const seedId = await createConfirmedMonitorUser(`cap-seed-${i}`);
        capSeeds.push(seedId);
        await setSignupNotifiedMinutesBack(seedId, i);
      }

      // The RPC itself must return 0 rows — not just the engine counter
      const rpc = createSupabaseEngineRpc(SUPABASE_URL, SECRET_KEY);
      const rows = await rpc.pendingSignups(MONITOR_SIGNUP_NOTICE_PER_RUN, MONITOR_SIGNUP_NOTICE_DAILY_CAP);
      expect(rows).toEqual([]);
      // Positive control: a cap one higher leaves exactly one slot, which the pending account takes.
      const oneSlot = await rpc.pendingSignups(1, MONITOR_SIGNUP_NOTICE_DAILY_CAP + 1);
      expect(oneSlot.map((row) => row.user_id)).toEqual([userId]);

      const { summary } = await runEngine();
      expect(summary.signupNotices).toBe(0);
      expect(await readSignupNotifiedAt(userId)).toBeNull();
    } finally {
      await deleteUser(userId);
      for (const id of capSeeds) await deleteUser(id).catch(() => {});
    }
  });

  // SNE-AC2h: waiting counts un-returned pending; deferred is exactly 1
  it("SNE-AC2h-live7: with 2 unnotified users, pendingSignups returns 1 row with waiting=1 → signupNoticesDeferred===1", async () => {
    const userId1 = await createConfirmedMonitorUser("wait-first");
    const userId2 = await createConfirmedMonitorUser("wait-second");
    try {
      // The RPC must report 1 row with waiting=1
      const rpc = createSupabaseEngineRpc(SUPABASE_URL, SECRET_KEY);
      const rows = await rpc.pendingSignups(MONITOR_SIGNUP_NOTICE_PER_RUN, MONITOR_SIGNUP_NOTICE_DAILY_CAP);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.waiting).toBe(1);

      const { summary } = await runEngine();
      expect(summary.signupNotices).toBe(1);
      // The 1 un-returned pending signup → deferred exactly 1
      expect(summary.signupNoticesDeferred).toBe(1);
    } finally {
      await deleteUser(userId1);
      await deleteUser(userId2);
    }
  });

  // SNE-AC1j: markSignupNotified returns true once then false
  it("SNE-AC1j-live8: markSignupNotified returns true the first time and false on a second call for the same user", async () => {
    const userId = await createConfirmedMonitorUser("mark-idempotent");
    try {
      const rpc = createSupabaseEngineRpc(SUPABASE_URL, SECRET_KEY);
      expect(await rpc.markSignupNotified(userId)).toBe(true);
      expect(await rpc.markSignupNotified(userId)).toBe(false);
    } finally {
      await deleteUser(userId);
    }
  });

  // SNE-AC4e: 22023 on bad args for all three RPCs
  it("SNE-AC4e-live9a: pendingSignups(0, 10) → EngineRpcError with code 22023 (p_limit < 1)", async () => {
    const rpc = createSupabaseEngineRpc(SUPABASE_URL, SECRET_KEY);
    const call = rpc.pendingSignups(0, 10);
    await expect(call).rejects.toBeInstanceOf(EngineRpcError);
    await expect(call).rejects.toMatchObject({ code: "22023" });
  });

  it("SNE-AC4e-live9b: pendingSignups(1, -1) → EngineRpcError with code 22023 (p_daily_cap < 0)", async () => {
    const rpc = createSupabaseEngineRpc(SUPABASE_URL, SECRET_KEY);
    const call = rpc.pendingSignups(1, -1);
    await expect(call).rejects.toBeInstanceOf(EngineRpcError);
    await expect(call).rejects.toMatchObject({ code: "22023" });
  });

  it("SNE-AC4e-live9c: purgeUnconfirmed(0) → EngineRpcError with code 22023 (p_limit < 1)", async () => {
    const rpc = createSupabaseEngineRpc(SUPABASE_URL, SECRET_KEY);
    const call = rpc.purgeUnconfirmed(0);
    await expect(call).rejects.toBeInstanceOf(EngineRpcError);
    await expect(call).rejects.toMatchObject({ code: "22023" });
  });

  it("SNE-AC4e-live9d: markSignupNotified(NULL) via direct SQL → 22023", async () => {
    const c = await getClient();
    try {
      // expectPgError sets a SAVEPOINT, which needs a transaction: run it in a rolled-back one.
      await withTx(c, async (tx) => {
        await expectPgError(
          tx,
          () => tx.query("SELECT public.monitor_engine_mark_signup_notified(NULL)"),
          "22023",
        );
      });
    } finally {
      c.release();
    }
  });

  // SNE-AC3a: unconfirmed monitor_user >24h → purged, counter matches
  it("SNE-AC3a-live10a: unconfirmed monitor_user account created more than 24 hours ago is deleted by purge and purged counter incremented", async () => {
    const toDelete = await createUnconfirmedMonitorUser("ac3a-target");
    try {
      await setCreatedAtHoursBack(toDelete, 25);
      const { summary } = await runEngine();
      expect(summary.purged).toBe(1);
      expect(await userExists(toDelete)).toBe(false);
    } finally {
      await deleteUser(toDelete).catch(() => {});
    }
  });

  // SNE-AC3b: confirmed monitor_user >24h → NOT purged
  it("SNE-AC3b-live10b: confirmed monitor_user account created more than 24 hours ago is NOT deleted by purge", async () => {
    const toKeep = await createConfirmedMonitorUser("ac3b-confirmed");
    try {
      await setCreatedAtHoursBack(toKeep, 25);
      const { summary } = await runEngine();
      expect(summary.purged).toBe(0);
      expect(summary.rpcErrors).toBe(0);
      expect(await userExists(toKeep)).toBe(true);
    } finally {
      await deleteUser(toKeep).catch(() => {});
    }
  });

  // SNE-AC3c: unconfirmed monitor_user <24h → NOT purged
  it("SNE-AC3c-live10c: unconfirmed monitor_user account created less than 24 hours ago is NOT deleted by purge", async () => {
    const toKeep = await createUnconfirmedMonitorUser("ac3c-young");
    try {
      // created_at stays at the default (just now), well within 24h
      const { summary } = await runEngine();
      expect(summary.purged).toBe(0);
      expect(summary.rpcErrors).toBe(0);
      expect(await userExists(toKeep)).toBe(true);
    } finally {
      await deleteUser(toKeep).catch(() => {});
    }
  });

  // SNE-AC3d: unconfirmed other-role (mylife_user) >24h → NOT purged
  it("SNE-AC3d-live10d: unconfirmed account of a different role (mylife_user) created more than 24 hours ago is NOT deleted by purge", async () => {
    const mylifeEmail = `${SEED_PREFIX}ac3d-mylife@alnyron-test.local`;
    const ca = await getClient();
    try {
      await ca.query(
        "INSERT INTO public.user_allowlist (email, role) VALUES ($1, 'mylife_user') ON CONFLICT DO NOTHING",
        [mylifeEmail],
      );
    } finally {
      ca.release();
    }
    const { data, error } = await makeAdminClient().auth.admin.createUser({
      email: mylifeEmail,
      email_confirm: false,
      user_metadata: {},
    });
    if (error) throw new Error(`Failed to create unconfirmed mylife_user for AC3d: ${error.message}`);
    const mylifeId = data.user.id;
    try {
      await setCreatedAtHoursBack(mylifeId, 25);
      const { summary } = await runEngine();
      expect(summary.purged).toBe(0);
      expect(summary.rpcErrors).toBe(0);
      expect(await userExists(mylifeId)).toBe(true);
    } finally {
      const cb = await getClient();
      try {
        await cb.query("DELETE FROM public.user_allowlist WHERE email = $1", [mylifeEmail]);
      } finally {
        cb.release();
      }
      if (mylifeId) await deleteUser(mylifeId).catch(() => {});
    }
  });

  // SNE-AC5a: public re-signup for an unconfirmed allowlisted address leaves DB state unchanged
  it("SNE-AC5a-live11: public POST /auth/v1/signup for an unconfirmed allowlisted address does not set the attacker's password (stored hash unchanged), email_confirmed_at stays null, role unchanged", async () => {
    const mylifeEmail = `${SEED_PREFIX}ac5a-mylife@alnyron-test.local`;
    const c = await getClient();
    try {
      await c.query(
        "INSERT INTO public.user_allowlist (email, role) VALUES ($1, 'mylife_user') ON CONFLICT DO NOTHING",
        [mylifeEmail],
      );
    } finally {
      c.release();
    }
    const { data, error } = await makeAdminClient().auth.admin.createUser({
      email: mylifeEmail,
      email_confirm: false, // unconfirmed, no password
      user_metadata: {},
    });
    if (error) throw new Error(`Failed to create unconfirmed mylife_user for AC5a: ${error.message}`);
    const mylifeId = data.user.id;
    try {
      // admin.createUser without an explicit password must store a non-empty hash — verified
      // by the expect below; "unchanged" means the same hash as before the signup attempt.
      const cBefore = await getClient();
      let hashBefore: string;
      try {
        const { rows } = await cBefore.query<{ encrypted_password: string | null }>(
          "SELECT u.encrypted_password FROM auth.users u WHERE u.id = $1",
          [mylifeId],
        );
        expect(rows).toHaveLength(1);
        hashBefore = rows[0]!.encrypted_password ?? "";
        expect(hashBefore, "createUser must store a non-empty hash — empty hash would make the unchanged check vacuous").not.toBe("");
      } finally {
        cBefore.release();
      }

      // Public signup attempt: attacker tries to set a password on this address.
      // We assert the response is NOT 401 (which would mean the publishable key was
      // missing/wrong rather than GoTrue actually processing the request), so a key
      // error cannot pass silently. Scope: on the e2e project (built-in mailer) GoTrue answers
      // 400 email_address_invalid for this domain, so this checks the DB state after that
      // answer only; it does not prove GoTrue's behaviour on a re-signup whose confirmation
      // email is actually sent (validated in the post-flip prod canary per SNE-AC5a).
      const signupRes = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: PUBLISHABLE_KEY },
        body: JSON.stringify({ email: mylifeEmail, password: "AttackerPassword123!" }),
      });
      expect(signupRes.status).not.toBe(401);

      // DB side: the original account must be unchanged
      const c2 = await getClient();
      try {
        const { rows } = await c2.query<{
          email_confirmed_at: string | null;
          password_unchanged: boolean;
          attacker_password: boolean;
          role_in_profile: string | null;
        }>(`
          SELECT u.email_confirmed_at::text,
                 coalesce(u.encrypted_password, '') = $2 AS password_unchanged,
                 CASE WHEN coalesce(u.encrypted_password, '') = '' THEN false
                      ELSE extensions.crypt($3, u.encrypted_password) = u.encrypted_password END AS attacker_password,
                 p.role AS role_in_profile
            FROM auth.users u
            JOIN public.profiles p ON p.user_id = u.id
           WHERE u.id = $1
        `, [mylifeId, hashBefore, "AttackerPassword123!"]);
        expect(rows).toHaveLength(1);
        // Role must still be mylife_user (allowlist guard)
        expect(rows[0]!.role_in_profile).toBe("mylife_user");
        // email_confirmed_at must still be null (the account was created unconfirmed)
        expect(rows[0]!.email_confirmed_at).toBeNull();
        // The re-signup must not change the stored password hash, and the attacker's password
        // must not open the account. Per docs/runbooks/area-user-onboarding.md: in the
        // supabase/auth source at v2.197.0 (the version the e2e project reports) GoTrue skips the
        // hook on a signup for an existing unconfirmed address and leaves the account unchanged
        // (not verified by a test); supabase/auth master runs the hook first and 403s the
        // allowlisted signup (read in the source; which version the hosted project runs is
        // not verified). Either way the DB state is verified here.
        // Compared as booleans so a failure never prints a hash.
        expect(rows[0]!.password_unchanged).toBe(true);
        expect(rows[0]!.attacker_password).toBe(false);
      } finally {
        c2.release();
      }
    } finally {
      const c3 = await getClient();
      try {
        await c3.query("DELETE FROM public.user_allowlist WHERE email = $1", [mylifeEmail]);
      } finally {
        c3.release();
      }
      if (mylifeId) await deleteUser(mylifeId).catch(() => {});
    }
  });

  // SNE-AC5b: purge never deletes the allowlisted account even when aged > 24h (role guard)
  it("SNE-AC5b-live12: purge does not delete an allowlisted mylife_user account even when created more than 24 hours ago", async () => {
    const mylifeEmail = `${SEED_PREFIX}ac5b-mylife@alnyron-test.local`;
    const c = await getClient();
    try {
      await c.query(
        "INSERT INTO public.user_allowlist (email, role) VALUES ($1, 'mylife_user') ON CONFLICT DO NOTHING",
        [mylifeEmail],
      );
    } finally {
      c.release();
    }
    const { data, error } = await makeAdminClient().auth.admin.createUser({
      email: mylifeEmail,
      email_confirm: false,
      user_metadata: {},
    });
    if (error) throw new Error(`Failed to create unconfirmed mylife_user for AC5b: ${error.message}`);
    const mylifeId = data.user.id;
    try {
      await setCreatedAtHoursBack(mylifeId, 25);
      const { summary } = await runEngine();
      // purged must be 0 — the other-role guard protects this account
      expect(summary.purged).toBe(0);
      expect(await userExists(mylifeId)).toBe(true);
    } finally {
      const c2 = await getClient();
      try {
        await c2.query("DELETE FROM public.user_allowlist WHERE email = $1", [mylifeEmail]);
      } finally {
        c2.release();
      }
      if (mylifeId) await deleteUser(mylifeId).catch(() => {});
    }
  });
});
