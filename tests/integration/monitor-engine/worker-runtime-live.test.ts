/**
 * Workers-runtime live integration test: alnyron-monitor-cron in real workerd
 * Journey: monitor-cron-runtime-fix  CRF-AC19, CRF-AC20
 *
 * e2e target only (requires SUPABASE_E2E_REF): off that target the whole suite is
 * reported as skipped (describe.skipIf), never as passed.
 *
 * Uses wrangler's `createTestHarness` (wrangler 4.156) to run the REAL
 * `workers/monitor-cron/wrangler.jsonc` in local workerd against the e2e Supabase project:
 * wrangler's bundle (the react alias included) under its compatibility date and flags, and
 * workerd's Request/Headers/AbortSignal handling of supabase-js's calls through rpcFetch.
 * The harness forwards outbound requests through Node's fetch (wrangler 4.156, cli.js
 * `outboundService`), so the edge egress path and `global_fetch_strictly_public` are not
 * covered here; those were checked once on the edge (`wrangler dev --remote`, a throwaway
 * Worker) during the incident diagnosis.
 *
 * CRF-AC19: valid key run — seed one due monitor (URL that the SSRF guard blocks
 *   immediately: https://alnyron-e2e.invalid/ uses the .invalid TLD, which url-guard.ts
 *   lists in BLOCKED_NAME_SUFFIXES, so fetchMonitorPage returns {ok:false,reason:"blocked"}
 *   with subrequests:0 before any DoH request) and one pending confirmed signup; dispatch
 *   scheduled(); parse the run line from getLogs(): rpcErrors 0, rpcError null, claimed 1,
 *   checked 1, errors 1. In the DB the monitor's last_checked_at is set (the claim ran from
 *   workerd; errors: 1 shows the record). The signup lookup returned a row and the mailer's
 *   request from workerd reached api.resend.com (forwarded by the harness through Node's
 *   fetch): mailStop is "config" (Resend's 401 for the fake key; as of 2026-11), and the
 *   pending signup is NOT stamped notified.
 *
 * CRF-AC20: incident reproduction — format-valid but wrong sb_secret_<random> key; all
 *   four engine calls fail at the Supabase gateway (401 for incorrect secret; as of 2026-11);
 *   rpcErrors 4, subrequests 4, rpcError { op:"pendingEmails", code:"unknown", status:401 },
 *   outcome "ok".
 *
 * Preconditions (fail fast with a clear message, same guards as engine-live.test.ts, plus one
 * free daily signup-notice slot and an owner profile as the notice's recipient):
 *   - no foreign monitor that the run could claim
 *   - no foreign pending change event the email sweep could stamp
 *   - no foreign confirmed signup pending notification (assertNoForeignSignupWork)
 *   - no foreign purgeable unconfirmed monitor_user account
 *   - a free slot under the daily signup-notice cap (assertNoForeignSignupWork(1))
 *
 * Run: npm run test:integration:e2e-project -- tests/integration/monitor-engine/worker-runtime-live.test.ts
 */

import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createTestHarness, type TestHarness } from "wrangler";
import type { Database } from "@/types/database";
import { MONITOR_DUE_GRACE_MINUTES, MONITOR_ERROR_THRESHOLD } from "@/config/monitor";
import { endPool, getClient } from "../rls/helpers/db.js";
import { assertNoForeignSignupWork } from "./helpers/signup-preconditions.js";
import { assertE2eTarget } from "../../helpers/assert-e2e-target.js";

// ── Skip when not on the e2e project ─────────────────────────────────────────

const ON_E2E = !!process.env.SUPABASE_E2E_REF;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? "";

/** Upper bound of this file's run time (minutes): a monitor falling due within it could be claimed. */
const TEST_WINDOW_MINUTES = 15;

/** Worker config relative to project root (CWD for vitest). */
const WRANGLER_CONFIG = "workers/monitor-cron/wrangler.jsonc";

/**
 * Monitor URL whose SSRF-guard check fails without DoH: .invalid is in BLOCKED_NAME_SUFFIXES
 * (url-guard.ts), so checkMonitorUrl returns {ok:false, reason:"blocked_host"} and
 * fetchMonitorPage returns {ok:false, reason:"blocked", subrequests:0} immediately.
 * This keeps the check deterministic and costs 0 subrequests for the page fetch.
 */
const BLOCKED_MONITOR_URL = "https://alnyron-e2e.invalid/check";

/** Fake Resend key: api.resend.com answers it with 401 (a config failure; as of 2026-11) → mailStop "config". */
const FAKE_RESEND_KEY = "re_live_test_fake_key_for_workerd_test";

const SEED_PREFIX = `e2e-workerd-${Date.now()}-`;

// ── Admin client ──────────────────────────────────────────────────────────────

function makeAdminClient() {
  return createClient<Database>(SUPABASE_URL, SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

// ── Precondition helpers (same logic as engine-live.test.ts) ──────────────────

async function claimableMonitorCount(): Promise<number> {
  const c = await getClient();
  try {
    await c.query("BEGIN");
    const { rows } = await c.query<{ id: string }>(
      "SELECT id FROM public.monitor_engine_claim(500, $1, $2)",
      [MONITOR_DUE_GRACE_MINUTES + TEST_WINDOW_MINUTES, MONITOR_ERROR_THRESHOLD],
    );
    return rows.length;
  } finally {
    const rollbackFailed = await c.query("ROLLBACK").then(() => false, () => true);
    c.release(rollbackFailed);
  }
}

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

/** Profile emails of all owner-role accounts, oldest first (same query as signup-notice-live). */
async function ownerEmails(): Promise<string[]> {
  const c = await getClient();
  try {
    const { rows } = await c.query<{ email: string }>(
      `SELECT p.email FROM public.profiles p WHERE p.role = 'owner' ORDER BY p.created_at, p.user_id`,
    );
    return rows.map((r) => r.email);
  } finally {
    c.release();
  }
}

// ── Seed state ────────────────────────────────────────────────────────────────

let seededMonitorUserId: string | undefined;
let seededMonitorId: string | undefined;
let seededSignupUserId: string | undefined;
const cleanupErrors: string[] = [];

// ── Harness ───────────────────────────────────────────────────────────────────

let harness: TestHarness | undefined;

/**
 * Parses the "monitor-cron run" JSON line from the harness logs: the first one, and the only
 * one, since each test clears the logs or starts a fresh harness before its single dispatch.
 */
function parseRunLine(logs: Array<{ level: string; message: string }>): Record<string, unknown> {
  const entry = logs.find((l) => l.message.includes('"monitor-cron run"'));
  if (!entry) throw new Error("No monitor-cron run log line found in harness logs");
  return JSON.parse(entry.message) as Record<string, unknown>;
}

/** Read last_checked_at for a monitor (null = not yet claimed). */
async function readLastCheckedAt(monitorId: string): Promise<string | null> {
  const { data, error } = await makeAdminClient()
    .from("monitors")
    .select("last_checked_at")
    .eq("id", monitorId)
    .single();
  if (error) throw new Error(`Failed to read monitor: ${error.message}`);
  return data.last_checked_at;
}

/** Read signup_notified_at for a profile (null = pending). */
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

describe.skipIf(!ON_E2E)("Workers-runtime live (e2e project only) — CRF-AC19, CRF-AC20", () => {
  // ── Setup / teardown ────────────────────────────────────────────────────────

  beforeAll(async () => {
    assertE2eTarget();

    // Precondition: no foreign claimable monitor
    const claimable = await claimableMonitorCount();
    if (claimable > 0) {
      throw new Error(
        `Precondition violated: ${claimable} foreign monitor(s) due now or within ${TEST_WINDOW_MINUTES} minutes. ` +
          "They would be claimed and stamped by the Worker run.",
      );
    }

    // Precondition: no foreign pending change event
    const pending = await pendingEventCount();
    if (pending > 0) {
      throw new Error(
        `Precondition violated: ${pending} foreign pending change event(s). ` +
          "They would be emailed by the Worker run.",
      );
    }

    // Precondition: no foreign pending signup or purgeable account, and daily-cap headroom for one
    // notice so the pending signup lookup returns the seeded row (nothing gets stamped: the
    // mailer's 401 stops the notice before markSignupNotified).
    await assertNoForeignSignupWork(1);

    // Precondition: at least one owner profile exists so the signup notice has a recipient.
    // Without an owner, the Worker defers the notice (no send, mailStop stays null).
    const owners = await ownerEmails();
    if (owners.length === 0) {
      throw new Error(
        "Precondition violated: no owner profile on the e2e project. " +
          "The signup notice has no recipient; CRF-AC19 cannot test the Resend path.",
      );
    }

    const admin = makeAdminClient();

    // Seed: the monitor's user (monitor_user role assigned automatically by handle_new_user)
    const { data: monitorUserData, error: monitorUserErr } = await admin.auth.admin.createUser({
      email: `${SEED_PREFIX}monitor-user@alnyron-test.local`,
      email_confirm: true,
      user_metadata: {},
    });
    if (monitorUserErr) throw new Error(`Failed to create monitor user: ${monitorUserErr.message}`);
    seededMonitorUserId = monitorUserData.user.id;

    // Pre-stamp signup_notified_at for the monitor user (25 h back) so the signup sweep never
    // picks it up as a pending signup in its own run.
    const stampClient = await getClient();
    try {
      const { rowCount } = await stampClient.query<never>(
        "UPDATE public.profiles SET signup_notified_at = now() - interval '25 hours' WHERE user_id = $1",
        [seededMonitorUserId],
      );
      if (rowCount !== 1)
        throw new Error(`Expected 1 profile to stamp for the monitor user, got ${rowCount ?? 0}`);
    } catch (err) {
      await admin.auth.admin.deleteUser(seededMonitorUserId).catch(() => {});
      throw err;
    } finally {
      stampClient.release();
    }

    // Seed: due monitor with blocked URL (error outcome, subrequests:0 for the page fetch)
    const { data: monitorData, error: monErr } = await admin
      .from("monitors")
      .insert({
        user_id: seededMonitorUserId,
        url: BLOCKED_MONITOR_URL,
        label: "Workerd Live Test Monitor",
        interval_minutes: 60,
        status: "active",
      })
      .select("id")
      .single();
    if (monErr || !monitorData) throw new Error(`Failed to seed monitor: ${monErr?.message}`);
    seededMonitorId = monitorData.id;

    // Seed: confirmed monitor_user pending signup notice (signup_notified_at null)
    const { data: signupData, error: signupErr } = await admin.auth.admin.createUser({
      email: `${SEED_PREFIX}pending-signup@alnyron-test.local`,
      email_confirm: true,
      user_metadata: {},
    });
    if (signupErr) throw new Error(`Failed to create pending signup user: ${signupErr.message}`);
    seededSignupUserId = signupData.user.id;
    // signup_notified_at is null by default → pending notice pickup

    // Start the harness for CRF-AC19 (CRF-AC20 starts its own with a wrong key); listen() starts workerd.
    harness = createTestHarness({
      workers: [
        {
          configPath: WRANGLER_CONFIG,
          vars: { SUPABASE_URL },
          secrets: {
            SUPABASE_SECRET_KEY: SECRET_KEY,
            RESEND_API_KEY: FAKE_RESEND_KEY,
          },
        },
      ],
    });
    await harness.listen();
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.close().catch((e: unknown) => cleanupErrors.push(String(e)));

    const admin = makeAdminClient();
    // Monitors first (PostgREST), user/cascade second (GoTrue).
    if (seededMonitorId) {
      const { error } = await admin.from("monitors").delete().eq("id", seededMonitorId);
      if (error) cleanupErrors.push(`monitor delete: ${error.message}`);
    }
    if (seededSignupUserId) {
      const { error } = await admin.auth.admin.deleteUser(seededSignupUserId);
      if (error) cleanupErrors.push(`signup user delete: ${error.message}`);
    }
    if (seededMonitorUserId) {
      const { error } = await admin.auth.admin.deleteUser(seededMonitorUserId);
      if (error) cleanupErrors.push(`monitor user delete: ${error.message}`);
    }

    await endPool();

    if (cleanupErrors.length > 0) {
      throw new Error(`Cleanup errors (data may be left on the e2e project):\n${cleanupErrors.join("\n")}`);
    }
  });

  // ── CRF-AC19: valid key run ───────────────────────────────────────────────

  describe("CRF-AC19: valid key run — real workerd engine run against the e2e project", () => {
    it(
      "CRF-AC19live1: rpcErrors 0, rpcError null, claimed 1, errors 1; last_checked_at set; mailStop from Resend; signup not stamped",
      async () => {
        if (!seededMonitorId) throw new Error("Monitor seed missing");
        if (!seededSignupUserId) throw new Error("Signup user seed missing");

        harness!.clearLogs();
        const worker = harness!.getWorker();
        const result = await worker.scheduled({ cron: "* * * * *" });

        // Worker outcome must be "ok": the handler doesn't throw, Cloudflare counts no error.
        expect(result.outcome).toBe("ok");

        const logs = harness!.getLogs();
        const run = parseRunLine(logs);

        // Core run assertions (CRF-AC19)
        expect(run["rpcErrors"]).toBe(0);
        // rpcError is null when no engine call fails.
        expect(run["rpcError"]).toBeNull();
        expect(run["claimed"]).toBe(1);
        expect(run["checked"]).toBe(1);
        expect(run["errors"]).toBe(1); // blocked URL → error outcome

        // The claim ran from workerd: last_checked_at is set in the DB (errors: 1 above shows the record).
        const lastCheckedAt = await readLastCheckedAt(seededMonitorId);
        expect(lastCheckedAt).not.toBeNull();

        // Resend returns 401 for an unknown key → mailStop "config" (as of 2026-11).
        expect(run["mailStop"]).toBe("config");

        // Pending signup lookup found the row; Resend's 401 set mailStop before markSignupNotified.
        // The signup is NOT stamped notified.
        const stamp = await readSignupNotifiedAt(seededSignupUserId);
        expect(stamp).toBeNull();
      },
      120_000,
    );
  });

  // ── CRF-AC20: incident reproduction ──────────────────────────────────────

  describe("CRF-AC20: incident reproduction — format-valid but wrong key → all 4 calls 401", () => {
    it(
      "CRF-AC20live1: rpcErrors 4, subrequests 4, rpcError { op:'pendingEmails', code:'unknown', status:401 }, outcome 'ok'",
      async () => {
        // Format-valid, intentionally wrong secret key (random suffix → not the e2e key).
        const wrongKey = `sb_secret_${randomBytes(16).toString("hex")}`;

        const incidentHarness = createTestHarness({
          workers: [
            {
              configPath: WRANGLER_CONFIG,
              vars: { SUPABASE_URL },
              secrets: {
                SUPABASE_SECRET_KEY: wrongKey,
                RESEND_API_KEY: FAKE_RESEND_KEY,
              },
            },
          ],
        });
        await incidentHarness.listen();

        try {
          const worker = incidentHarness.getWorker();
          const result = await worker.scheduled({ cron: "* * * * *" });

          // The handler does not throw (all failures are caught), so outcome is "ok".
          // Cloudflare sees no error; the diagnostics in rpcError are the guard.
          expect(result.outcome).toBe("ok");

          const logs = incidentHarness.getLogs();
          const run = parseRunLine(logs);

          // Incident shape (CRF-AC20): 4 subrequests, 4 rpcErrors, rpcError on pendingEmails.
          expect(run["subrequests"]).toBe(4);
          expect(run["rpcErrors"]).toBe(4);
          // rpcError carries the first failed engine call (as of 2026-11, Supabase gateway returns 401).
          expect(run["rpcError"]).toEqual({ op: "pendingEmails", code: "unknown", status: 401 });
        } finally {
          await incidentHarness.close();
        }
      },
      120_000,
    );
  });
});
