/**
 * Live engine integration test: workers/monitor-cron/run.ts
 * Journey: monitor-engine  ENG-E1–ENG-E7; security round 1 live checks under ENG-AC1–ENG-AC4
 *          monitor-signup-notice  SNE-AC2i (precondition guard for pending signups + purgeable accounts)
 *
 * e2e target only (requires SUPABASE_E2E_REF): off that target the whole suite is reported as
 * skipped (describe.skipIf), never as passed.
 *
 * Uses:
 *   - real runMonitorChecks + createSupabaseEngineRpc
 *   - real fetchMonitorPage with a rewriting fetchImpl that maps
 *     https://example.com/alnyron-e2e/… → local node:http server
 *   - capturing Mailer
 *   - committed seed via service-role client (its monitors, then the auth user, deleted in
 *     afterAll; events go with the monitors and email-log rows with the user by cascade)
 *
 * Covers ENG-E2–ENG-E7 (baseline, change email with defanged page URL, no repeat, error
 *   streak, recovery, SSRF) and, after them: a run that dies between claim and record keeps the
 *   claim's provisional failure until the next good check and leaves one strike on the owner,
 *   which the next good run (claim + record with p_repay) takes off again (ENG-AC3live1); checks
 *   that keep dying add a strike per killed run and hold the owner to one monitor per run, an
 *   error run keeps the count, each good run takes one off, and at 0 every due monitor is claimed
 *   again, its two good records (no p_repay) taking off one each (ENG-AC3live2); a result made
 *   stale by a url edit mid-check takes off only its own strike, a monitor deleted mid-check
 *   leaves its strike until a good check from a later run repays it, and a good check on 0 stays
 *   at 0 (ENG-AC3live3); a good check recorded before the owner's killing page in the same run
 *   leaves that page's strike, so the next run claims only the owner's oldest due monitor, whose
 *   good check repays it (ENG-AC3live4); two owners on equal intervals with the killing page K
 *   first by id (batch 10; one slot for all owners with strikes): the run dying on K leaves the
 *   other owner's V unrecorded and strikes both, the next run takes K alone (dying again), the
 *   one after V alone (its good check repays its owner, no further provisional failure), and
 *   from then on V is checked before K, whose kills cost it nothing (ENG-AC3live5); every run's
 *   `strikerClaimed` (claimed monitors whose owner had strikes before the claim) from the real
 *   claim; an error notification is suppressed at the daily cap without stamping
 *   error_notified_at and sent once the log frees (ENG-AC4live1); a change email waits at the cap
 *   and goes out once it frees (ENG-AC4live2); an overdue monitor is claimed before a newly
 *   created one (ENG-AC2live1).
 *
 * Precondition (fails fast with a clear message): no foreign monitor that a run of this file
 *   could claim (the real claim, in a rolled-back transaction, with the grace widened by the
 *   file's run time), no foreign event it could email (the real pending-emails query, by the
 *   database clock, with the daily cap lifted), no foreign confirmed monitor_user signup
 *   pending notification (SNE-AC2i), and no foreign purgeable unconfirmed monitor_user
 *   account (SNE-AC2i). It sends no signup notice, so it needs no daily-cap headroom (its
 *   fixtures are stamped 25 h back, outside the cap window). Each run
 *   claims/stamps/emails/notices/purges whatever is due, so foreign rows would be touched by
 *   the test.
 * Run: npm run test:integration:e2e-project -- tests/integration/monitor-engine/engine-live.test.ts
 */

import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { MONITOR_DAILY_EMAIL_CAP, MONITOR_DUE_GRACE_MINUTES, MONITOR_ERROR_THRESHOLD } from "@/config/monitor";
import { buildChangeEmail } from "@/lib/monitor/change-email";
import { fetchMonitorPage } from "@/lib/monitor/page-fetch";
import { hashPageText } from "@/lib/monitor/page-text";
import { createSupabaseEngineRpc } from "../../../workers/monitor-cron/rpc";
import {
  runMonitorChecks,
  type Mailer,
  type RunConfig,
  type RunSummary,
} from "../../../workers/monitor-cron/run";
import type { EmailMessage, SendResult } from "@/lib/email/resend";
import { endPool, getClient } from "../rls/helpers/db.js";
import { assertNoForeignSignupWork } from "./helpers/signup-preconditions.js";
import { assertE2eTarget } from "../../helpers/assert-e2e-target.js";

// ── Skip when not on the e2e project ─────────────────────────────────────────

const ON_E2E = !!process.env.SUPABASE_E2E_REF;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? "";

/** Upper bound of this file's run time: a foreign monitor falling due within it would be claimed. */
const TEST_WINDOW_MINUTES = 15;

// ── Local HTTP server for page content ───────────────────────────────────────

type PageSpec =
  | { type: "html"; body: string }
  | { type: "status"; code: number };

let server: Server;
let serverPort: number;
let currentPage: PageSpec = { type: "html", body: "<html><body><p>Default</p></body></html>" };

/** Rewriting fetchImpl: passes DoH queries through to real fetch, rewrites the
 *  e2e page host (https://example.com/alnyron-e2e/…) to the local server. */
async function e2eFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://cloudflare-dns.com/")) {
    // Real DoH — example.com resolves to a public IP, allowing the check to proceed
    return fetch(input, init);
  }
  if (url.startsWith("https://example.com/alnyron-e2e/")) {
    const path = url.replace("https://example.com/alnyron-e2e/", "/");
    const localUrl = `http://127.0.0.1:${serverPort}${path}`;
    // Follow instead of redirect:'manual' for the local rewrite — the server won't redirect
    return fetch(localUrl, { ...init, redirect: "follow" });
  }
  // Everything else gets a 403 — no unintended external requests
  return new Response("Blocked by test rewrite", { status: 403 });
}

// ── Seed identifiers (unique prefix to avoid collisions) ─────────────────────

const SEED_PREFIX = `e2e-engine-${Date.now()}-`;
const SEED_EMAIL = `${SEED_PREFIX}user@example.com`;
const SEED_LABEL = "Engine Live Test";
const SEED_MONITOR_URL = "https://example.com/alnyron-e2e/monitor-page";
/** ENG-AC3live2's, ENG-AC3live3's and ENG-AC3live4's further monitors of the seeded user (served by the same local page). */
const STRIKE_MONITOR_URL = "https://example.com/alnyron-e2e/strike-page";
const STALE_MONITOR_URL = "https://example.com/alnyron-e2e/stale-page";
const KILL_MONITOR_URL = "https://example.com/alnyron-e2e/kill-page";
/** ENG-AC3live5's monitor of a second owner, left unchecked by the killing page's run. */
const VICTIM_MONITOR_URL = "https://example.com/alnyron-e2e/victim-page";

// ── Supabase admin client (service-role, bypasses RLS) ───────────────────────

function makeAdminClient() {
  return createClient<Database>(SUPABASE_URL, SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/**
 * Monitors a run of this file could claim: the real `monitor_engine_claim` (so the exact due
 * rule, backoff and role gate) with the grace widened by {@link TEST_WINDOW_MINUTES}, inside a
 * transaction that is rolled back, so nothing is stamped. Called before the seed exists, so
 * every row it finds belongs to someone else.
 */
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
    // Never commit the stamps: a connection whose ROLLBACK failed is destroyed, not pooled.
    const rollbackFailed = await c.query("ROLLBACK").then(() => false, () => true);
    c.release(rollbackFailed);
  }
}

/**
 * Change events a run of this file could email: the real `monitor_engine_pending_emails` (its
 * 23 h window by the database clock, role and email rules) with the daily cap lifted, since an
 * event held back by the cap may come free while the file runs. Called before the seed exists,
 * so every row it finds belongs to someone else.
 */
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

// ── Capturing mailer ──────────────────────────────────────────────────────────

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

// ── Run config ────────────────────────────────────────────────────────────────

const RUN_CONFIG: RunConfig = {
  batchSize: 10,
  subrequestLimit: 200,
  siteUrl: "https://alnyron.dk",
  mailFrom: "Alnyron <noreply@send.alnyron.dk>",
};

let seededUserId: string | undefined;
let seededMonitorId: string;
const cleanupErrors: string[] = [];

// ── Helper: run the engine once ───────────────────────────────────────────────

/** Updates the seeded monitor; throws on failure, so no test runs on a setup that did not apply. */
async function updateSeededMonitor(patch: Database["public"]["Tables"]["monitors"]["Update"]): Promise<void> {
  const { error } = await makeAdminClient().from("monitors").update(patch).eq("id", seededMonitorId);
  if (error) throw new Error(`Failed to update the seeded monitor: ${error.message}`);
}

async function runEngine(mailer: Mailer): Promise<RunSummary> {
  // Each run's claim leases the monitor (last_checked_at = now()), so it would not be due again
  // within its 60-minute interval: make it due before every run.
  await updateSeededMonitor({ last_checked_at: null });
  const rpc = createSupabaseEngineRpc(SUPABASE_URL, SECRET_KEY);
  const fetchPage = (url: string) => fetchMonitorPage(url, { fetchImpl: e2eFetch });
  return runMonitorChecks({
    rpc,
    mailer,
    fetchPage,
    config: RUN_CONFIG,
    log: () => {}, // suppress console noise in test output
  });
}

// ── Helper: read monitor state from DB ────────────────────────────────────────

async function readMonitorState(id: string) {
  const admin = makeAdminClient();
  const { data, error } = await admin
    .from("monitors")
    .select("last_hash, last_snapshot, consecutive_errors, error_notified_at")
    .eq("id", id)
    .single();
  if (error) throw new Error(`Failed to read monitor state: ${error.message}`);
  return data;
}

async function readMonitorEvents(monitorId: string) {
  const admin = makeAdminClient();
  const { data, error } = await admin
    .from("monitor_events")
    .select("id, emailed_at, summary, detected_at")
    .eq("monitor_id", monitorId)
    .order("detected_at", { ascending: false });
  if (error) throw new Error(`Failed to read events: ${error.message}`);
  return data ?? [];
}

/**
 * Replaces the seeded user's monitor_email_log with `count` change emails sent now (the database
 * clock): `MONITOR_DAILY_EMAIL_CAP` puts the user at the cap, 0 frees it.
 */
async function setEmailLog(count: number): Promise<void> {
  const userId = seededUserId;
  if (userId === undefined) throw new Error("Seeded user missing");
  const admin = makeAdminClient();
  const { error: deleteError } = await admin.from("monitor_email_log").delete().eq("user_id", userId);
  if (deleteError) throw new Error(`Failed to clear the email log: ${deleteError.message}`);
  if (count === 0) return;
  const rows = Array.from({ length: count }, () => ({ user_id: userId, kind: "change" }));
  const { error: insertError } = await admin.from("monitor_email_log").insert(rows);
  if (insertError) throw new Error(`Failed to seed the email log: ${insertError.message}`);
}

/** The kinds of the seeded user's monitor_email_log rows, newest first. */
async function readEmailLogKinds(): Promise<string[]> {
  const userId = seededUserId;
  if (userId === undefined) throw new Error("Seeded user missing");
  const { data, error } = await makeAdminClient()
    .from("monitor_email_log")
    .select("kind")
    .eq("user_id", userId)
    .order("sent_at", { ascending: false })
    .order("id", { ascending: false });
  if (error) throw new Error(`Failed to read the email log: ${error.message}`);
  return (data ?? []).map((row) => row.kind);
}

/**
 * A user's monitor_engine_strikes row as its count ([] without one), by default the seeded
 * user's. Read over the pg pool: the engine-only table is not in the generated API types.
 */
async function readStrikes(userId: string | undefined = seededUserId): Promise<Array<{ strikes: number }>> {
  if (userId === undefined) throw new Error("Seeded user missing");
  const c = await getClient();
  try {
    const { rows } = await c.query<{ strikes: number }>(
      "SELECT strikes FROM public.monitor_engine_strikes WHERE user_id = $1",
      [userId],
    );
    return rows;
  } finally {
    c.release();
  }
}

/**
 * Moves the monitors' last_checked_at `minutes` back over the pg pool, by the database clock
 * (NULL counts as now(), so monitors made due in one call are equally old): due again while
 * keeping their order in the queue.
 */
async function ageMonitors(ids: string[], minutes: number): Promise<void> {
  const c = await getClient();
  try {
    const { rowCount } = await c.query(
      "UPDATE public.monitors SET last_checked_at = coalesce(last_checked_at, now()) - make_interval(mins => $2) WHERE id = ANY($1::uuid[])",
      [ids, minutes],
    );
    if (rowCount !== ids.length) throw new Error(`Aged ${rowCount} of ${ids.length} monitors`);
  } finally {
    c.release();
  }
}

/** Creates a further monitor_user account; the test that creates it deletes it in `finally`. */
async function createOwner(tag: string): Promise<string> {
  const { data, error } = await makeAdminClient().auth.admin.createUser({
    email: `${SEED_PREFIX}${tag}@example.com`,
    email_confirm: true,
    user_metadata: {},
  });
  if (error) throw new Error(`Failed to create the ${tag} user: ${error.message}`);
  const userId = data.user.id;
  // Pre-stamp signup_notified_at so the signupSweep does not notice this test fixture; 25 h back,
  // outside the 24 h window, so the stamp holds no daily-cap slot (even if the run aborts).
  // On failure: delete the already-created user to prevent it leaking as a foreign pending signup.
  const c = await getClient();
  try {
    const { rowCount } = await c.query<never>(
      "UPDATE public.profiles SET signup_notified_at = now() - interval '25 hours' WHERE user_id = $1",
      [userId],
    );
    if (rowCount !== 1) throw new Error(`Expected 1 profile row to stamp for ${tag}, got ${rowCount ?? 0}`);
  } catch (stampErr) {
    await makeAdminClient().auth.admin.deleteUser(userId).catch(() => {});
    throw stampErr;
  } finally {
    c.release();
  }
  return userId;
}

/** Inserts a further active 60-minute monitor of the seeded user; the test deletes it in `finally`. */
async function insertOwnerMonitor(url: string): Promise<string> {
  const userId = seededUserId;
  if (userId === undefined) throw new Error("Seeded user missing");
  const { data, error } = await makeAdminClient()
    .from("monitors")
    .insert({ user_id: userId, url, label: "Strike test", interval_minutes: 60, status: "active" })
    .select("id")
    .single();
  if (error) throw new Error(`Failed to seed a monitor of the seeded user: ${error.message}`);
  return data.id;
}

/** What one {@link runChecks} did: the urls it fetched, in order, and its counts. */
type CheckRun = {
  urls: string[];
  claimed: number;
  /** Claimed monitors whose owner had strikes before the claim (the real claim's prior_strikes > 0). */
  strikerClaimed: number;
  unchanged: number;
  baselines: number;
  errors: number;
  rpcErrors: number;
};

/** What one {@link runDue} did: its {@link CheckRun} and the seeded user's strikes after it. */
type StrikeRun = CheckRun & { strikes: Array<{ strikes: number }> };

/** The counts of a {@link CheckRun} that claimed no owner with strikes and recorded and failed nothing: tests spread it and set what happened. */
const QUIET_RUN = { strikerClaimed: 0, unchanged: 0, baselines: 0, errors: 0, rpcErrors: 0 };

/** {@link runChecks}'s hook for a Worker killed mid-check: claimed, never recorded. */
async function killedMidCheck(): Promise<never> {
  throw new Error("run killed mid-check");
}

/**
 * One engine run on whatever is due. `midCheck(url)` runs in every check between the claim and
 * the real page fetch: it may throw ({@link killedMidCheck}) or change the monitor.
 */
async function runChecks(mailer: Mailer, midCheck: (url: string) => Promise<void> = async () => {}): Promise<CheckRun> {
  const urls: string[] = [];
  const { claimed, strikerClaimed, unchanged, baselines, errors, rpcErrors } = await runMonitorChecks({
    rpc: createSupabaseEngineRpc(SUPABASE_URL, SECRET_KEY),
    mailer,
    fetchPage: async (url) => {
      urls.push(url);
      await midCheck(url);
      return fetchMonitorPage(url, { fetchImpl: e2eFetch });
    },
    config: RUN_CONFIG,
    log: () => {},
  });
  return { urls, claimed, strikerClaimed, unchanged, baselines, errors, rpcErrors };
}

/**
 * {@link runChecks} with exactly `dueIds` made due (last_checked_at NULL); the seeded user's other
 * monitors keep the lease of their last claim.
 */
async function runDue(
  mailer: Mailer,
  dueIds: string[],
  midCheck?: (url: string) => Promise<void>,
): Promise<StrikeRun> {
  const { error } = await makeAdminClient().from("monitors").update({ last_checked_at: null }).in("id", dueIds);
  if (error) throw new Error(`Failed to make the monitors due: ${error.message}`);
  return { ...(await runChecks(mailer, midCheck)), strikes: await readStrikes() };
}

describe.skipIf(!ON_E2E)("monitor engine live run (e2e project only)", () => {
  // ── Setup / teardown ────────────────────────────────────────────────────────

  beforeAll(async () => {
    // Guard: verify the env targets the e2e project, not prod,
    // before the first supabase-js client is built later in this beforeAll.
    assertE2eTarget();

    // Start local HTTP server
    server = createServer((_req, res) => {
      const spec = currentPage;
      if (spec.type === "status") {
        res.writeHead(spec.code, { "content-type": "text/html" });
        res.end(`<html><body><p>Error ${spec.code}</p></body></html>`);
      } else {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(spec.body);
      }
    });
    const listening = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Local page server has no TCP port");
    serverPort = address.port;

    // Precondition: no foreign monitor that a run of this file could claim (and so stamp and
    // check): due now or within the test window, by the claim's own rule.
    const claimable = await claimableMonitorCount();
    if (claimable > 0) {
      throw new Error(
        `Precondition violated: ${claimable} foreign monitor(s) due now or within ${TEST_WINDOW_MINUTES} minutes. ` +
          "Clean them up (or wait) before running the live engine tests.",
      );
    }

    // Precondition: no foreign event a run could email (runMonitorChecks would send it and stamp
    // emailed_at irreversibly).
    const pending = await pendingEventCount();
    if (pending > 0) {
      throw new Error(
        `Precondition violated: ${pending} foreign pending event(s) inside the 23 h email window. ` +
          "They would be emailed during the test run.",
      );
    }
    // Precondition (SNE-AC2i): no foreign confirmed signup or purgeable unconfirmed account the
    // signup sweep / purge could notice or delete (stamps signup_notified_at irreversibly). This
    // file sends no signup notice (its fixtures are pre-stamped), so it needs no cap headroom.
    await assertNoForeignSignupWork(0);

    const admin = makeAdminClient();

    // Seed: auth user — handle_new_user assigns monitor_user automatically (no allowlist row)
    const { data: created, error: authErr } = await admin.auth.admin.createUser({
      email: SEED_EMAIL,
      email_confirm: true,
      user_metadata: {},
    });
    if (authErr) throw new Error(`Failed to create e2e user: ${authErr.message}`);
    const userId = created.user.id;
    seededUserId = userId;

    // Verify: handle_new_user assigned monitor_user role automatically
    const { data: prof } = await admin.from("profiles").select("role").eq("user_id", userId).single();
    if (prof?.role !== "monitor_user") throw new Error(`Expected profile role monitor_user, got ${prof?.role}`);

    // ENG-E7 adds two SSRF monitors to this one: lift the default free cap (monitor_limit = 2).
    const { error: capErr } = await admin.from("profiles").update({ monitor_limit: null }).eq("user_id", userId);
    if (capErr) throw new Error(`Failed to lift the monitor cap: ${capErr.message}`);

    // Seed: due active monitor with no stored hash
    const { data: monitor, error: monErr } = await admin
      .from("monitors")
      .insert({
        user_id: userId,
        url: SEED_MONITOR_URL,
        label: SEED_LABEL,
        interval_minutes: 60,
        status: "active",
      })
      .select("id")
      .single();
    if (monErr || !monitor) throw new Error(`Failed to seed monitor: ${monErr?.message}`);
    seededMonitorId = monitor.id;

    // Pre-stamp signup_notified_at so the signupSweep does not notice this confirmed monitor_user
    // seed in every subsequent run (it would email the owner and skew exact email counts); 25 h
    // back, outside the 24 h window, so the stamp holds no daily-cap slot.
    const stampClient = await getClient();
    try {
      const { rowCount } = await stampClient.query<never>(
        "UPDATE public.profiles SET signup_notified_at = now() - interval '25 hours' WHERE user_id = $1",
        [userId],
      );
      if (rowCount !== 1) throw new Error(`Expected 1 profile row to stamp for seed user, got ${rowCount ?? 0}`);
    } catch (stampErr) {
      await admin.auth.admin.deleteUser(userId).catch(() => {});
      throw stampErr;
    } finally {
      stampClient.release();
    }
  });

  afterAll(async () => {
    if (server) server.close();
    await endPool();

    // Best-effort cleanup — collect errors, don't re-throw. Monitors first (PostgREST), so a
    // failed user delete (GoTrue) cannot leave a due monitor on the shared project; deleting the
    // user then removes its profile and any rest by cascade.
    if (seededUserId) {
      const admin = makeAdminClient();
      const { error: monitorsErr } = await admin.from("monitors").delete().eq("user_id", seededUserId);
      if (monitorsErr) cleanupErrors.push(`monitors: ${monitorsErr.message}`);
      const { error: userErr } = await admin.auth.admin.deleteUser(seededUserId);
      if (userErr) cleanupErrors.push(`user: ${userErr.message}`);
    }

    if (cleanupErrors.length > 0) {
      console.error("Engine live test cleanup errors:", cleanupErrors);
    }
  });

  // ── ENG-E2: Baseline ────────────────────────────────────────────────────────

  describe("ENG-E2: Baseline — first check stores hash, no email", () => {
    it(
      "ENG-E2live: the first run stores the page text's v1 hash and snapshot; no email captured",
      async () => {
        currentPage = { type: "html", body: "<html><body><p>Baseline content</p></body></html>" };
        const { mailer, captured } = makeCapturingMailer();
        const summary = await runEngine(mailer);
        // Only the seeded monitor is due (precondition), so the run claims and baselines it alone.
        expect(summary.claimed).toBe(1);
        expect(summary.baselines).toBe(1);
        expect(captured).toHaveLength(0);
        expect(await readMonitorState(seededMonitorId)).toEqual({
          last_hash: await hashPageText("Baseline content"),
          last_snapshot: "Baseline content",
          consecutive_errors: 0,
          error_notified_at: null,
        });
      },
      30_000,
    );
  });

  // ── ENG-E3: Content change ──────────────────────────────────────────────────

  describe("ENG-E3: Content change → monitor_events row + one emailed email + emailed_at stamped", () => {
    it(
      "ENG-E3live: changing page text produces exactly one email with key monitor-event/<event_id>",
      async () => {
        // Change the page content so the hash differs from the stored baseline
        currentPage = {
          type: "html",
          body: "<html><body><p>Changed content — different from baseline</p></body></html>",
        };
        // Ensure the stored hash differs from the new content by explicitly updating it
        // (the stored snapshot stays "Baseline content", the basis of the summary).
        await updateSeededMonitor({ last_hash: "v1:" + "a".repeat(64) });

        const { mailer, captured } = makeCapturingMailer();
        const summary = await runEngine(mailer);
        expect(summary.changed).toBe(1);
        expect(summary.emailsSent).toBe(1);

        // One event, emailed; the one email carries its key "monitor-event/<event_id>".
        const events = await readMonitorEvents(seededMonitorId);
        expect(events).toHaveLength(1);
        const event = events[0]!;
        expect(event.emailed_at).not.toBeNull();
        expect(event.summary).toBe("+ Changed content — different from baseline\n\u2212 Baseline content");
        // Exactly the email built from the stored event: the page URL in it is defanged text.
        const expected = buildChangeEmail({
          eventId: event.id,
          monitorId: seededMonitorId,
          url: SEED_MONITOR_URL,
          label: SEED_LABEL,
          detectedAt: event.detected_at,
          summary: event.summary,
          siteUrl: RUN_CONFIG.siteUrl,
        });
        expect(captured).toEqual([{ to: SEED_EMAIL, idempotencyKey: `monitor-event/${event.id}`, ...expected }]);
        expect(captured[0]!.text).toContain("hxxps://example[.]com/alnyron-e2e/monitor-page");
        expect(captured[0]!.html).not.toContain(SEED_MONITOR_URL);
        expect(captured[0]!.text).not.toContain(SEED_MONITOR_URL);
        // The send is logged for the daily cap.
        expect(await readEmailLogKinds()).toEqual(["change"]);

        // mark_emailed is idempotent: second call returns false
        const { data, error } = await makeAdminClient().rpc("monitor_engine_mark_emailed", { p_event_id: event.id });
        expect(error).toBeNull();
        expect(data).toBe(false);
      },
      30_000,
    );
  });

  // ── ENG-E4: No new change ───────────────────────────────────────────────────

  describe("ENG-E4: Rerun with same page → no new email", () => {
    it(
      "ENG-E4live: second run with unchanged content captures no new email",
      async () => {
        // Page content stays the same as ENG-E3 final state; hash matches
        const { mailer, captured } = makeCapturingMailer();
        const summary = await runEngine(mailer);
        expect(summary.unchanged).toBe(1);
        // No new pending emails (previous event already emailed)
        expect(captured).toHaveLength(0);
      },
      30_000,
    );
  });

  // ── ENG-E5: Fetch failures × 3 → error email, 4th no second email ──────────

  describe("ENG-E5: Three consecutive fetch failures → one error email; 4th failure no extra email", () => {
    it(
      "ENG-E5live: 3 × 500 responses → consecutive_errors=3 + one error email; 4th failure → no second email",
      async () => {
        // Reset monitor state: errors=0, error_notified_at=null
        await updateSeededMonitor({ consecutive_errors: 0, error_notified_at: null });

        currentPage = { type: "status", code: 500 };

        const errorMails: CapturedMail[] = [];
        for (let run = 0; run < 3; run++) {
          const { mailer, captured } = makeCapturingMailer();
          await runEngine(mailer);
          errorMails.push(...captured.filter((m) => m.idempotencyKey.startsWith("monitor-error/")));
        }

        const state = await readMonitorState(seededMonitorId);
        expect(state.consecutive_errors).toBe(3);
        expect(state.error_notified_at).not.toBeNull();

        // Exactly one error email across the 3 runs, keyed by the streak's notification stamp
        expect(errorMails).toHaveLength(1);
        expect(errorMails[0]!.idempotencyKey).toBe(`monitor-error/${seededMonitorId}/${state.error_notified_at}`);
        expect(errorMails[0]!.to).toBe(SEED_EMAIL);
        // The claimed notification is logged for the daily cap, next to ENG-E3's change email.
        expect(await readEmailLogKinds()).toEqual(["error", "change"]);

        // 4th failure must not produce a second error email
        const { mailer: mailer4, captured: captured4 } = makeCapturingMailer();
        await runEngine(mailer4);
        const extraErrorMails = captured4.filter((m) => m.idempotencyKey.startsWith("monitor-error/"));
        expect(extraErrorMails).toHaveLength(0);
      },
      120_000,
    );
  });

  // ── ENG-E6: Recovery ────────────────────────────────────────────────────────

  describe("ENG-E6: Recovery from error streak → consecutive_errors=0, error_notified_at null", () => {
    it(
      "ENG-E6live: restoring the page clears error state (and records the change against the pre-error text)",
      async () => {
        // Restore the page
        currentPage = { type: "html", body: "<html><body><p>Recovered page</p></body></html>" };
        const { mailer } = makeCapturingMailer();
        const summary = await runEngine(mailer);
        expect(summary.changed).toBe(1);
        expect(await readMonitorState(seededMonitorId)).toEqual({
          last_hash: await hashPageText("Recovered page"),
          last_snapshot: "Recovered page",
          consecutive_errors: 0,
          error_notified_at: null,
        });
      },
      30_000,
    );
  });

  // ── ENG-E7: SSRF guard ──────────────────────────────────────────────────────

  describe("ENG-E7: SSRF guard — private hosts refused without a page request", () => {
    it(
      "ENG-E7live: 127.0.0.1 (blocked by checkMonitorUrl) + localtest.me (DoH→127.0.0.1) → no page fetch",
      async () => {
        const userId = seededUserId;
        if (userId === undefined) throw new Error("Seeded user missing");
        const admin = makeAdminClient();

        // Two SSRF monitors:
        //   (1) http://127.0.0.1/… — blocked by checkMonitorUrl before any fetchImpl call
        //   (2) http://localtest.me/… — passes checkMonitorUrl; DoH returns 127.0.0.1 → blocked
        const ssrfUrls = [
          "http://127.0.0.1/alnyron-e2e/ssrf",
          "http://localtest.me/alnyron-e2e/ssrf",
        ];
        const ssrfMonitorIds: string[] = [];
        try {
          for (const url of ssrfUrls) {
            const { data: m, error } = await admin
              .from("monitors")
              .insert({ user_id: userId, url, label: "SSRF test", interval_minutes: 60, status: "active" })
              .select("id")
              .single();
            if (error) throw new Error(`Failed to seed SSRF monitor for ${url}: ${error.message}`);
            ssrfMonitorIds.push(m.id);
          }

          // Spying fetchPage: captures the PageFetchResult for each claimed URL.
          // For http://127.0.0.1/…: checkMonitorUrl blocks BEFORE fetchImpl is called → 0 DoH/page fetches.
          // For http://localtest.me/…: checkMonitorUrl passes; real DoH sees A→127.0.0.1 → blocked.
          const fetchResults: Array<{ url: string; reason: string }> = [];
          const pageRequests: string[] = [];
          const spyFetchPage = async (url: string) => {
            const result = await fetchMonitorPage(url, {
              fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
                const reqUrl =
                  typeof input === "string" ? input
                  : input instanceof URL ? input.href
                  : input.url;
                if (!reqUrl.includes("cloudflare-dns.com")) pageRequests.push(reqUrl);
                return fetch(input, init);
              },
            });
            fetchResults.push({ url, reason: result.ok ? "fetched" : result.reason });
            return result;
          };

          const { mailer, captured } = makeCapturingMailer();
          const rpc = createSupabaseEngineRpc(SUPABASE_URL, SECRET_KEY);
          const summary = await runMonitorChecks({ rpc, mailer, fetchPage: spyFetchPage, config: RUN_CONFIG, log: () => {} });

          // Exactly the two SSRF monitors were due (the seeded one was checked by ENG-E6), both
          // claimed, fetched through the guard and refused as "blocked", both recorded as errors.
          expect(summary.claimed).toBe(2);
          expect(summary.errors).toBe(2);
          expect(fetchResults).toHaveLength(2);
          expect(Object.fromEntries(fetchResults.map((r) => [r.url, r.reason]))).toEqual(
            Object.fromEntries(ssrfUrls.map((url) => [url, "blocked"])),
          );

          // No request other than DoH lookups was made: nothing reached the SSRF hosts.
          expect(pageRequests).toEqual([]);

          // Both monitors show consecutive_errors === 1 (blocked = error outcome)
          const { data: states, error: statesErr } = await admin
            .from("monitors")
            .select("id, consecutive_errors")
            .in("id", ssrfMonitorIds);
          expect(statesErr).toBeNull();
          expect(Object.fromEntries((states ?? []).map((s) => [s.id, s.consecutive_errors]))).toEqual(
            Object.fromEntries(ssrfMonitorIds.map((id) => [id, 1])),
          );

          // SSRF errors < threshold → no error notification, and no change email either
          expect(captured).toHaveLength(0);
        } finally {
          // Their events (none expected) go with them by cascade.
          if (ssrfMonitorIds.length > 0) {
            const { error } = await admin.from("monitors").delete().in("id", ssrfMonitorIds);
            if (error) cleanupErrors.push(`SSRF monitors: ${error.message}`);
          }
        }
      },
      60_000,
    );
  });

  // ── Security round 1: provisional failure, daily cap from the send log, claim order ─────────

  describe("ENG-AC3: a run that dies between claim and record still counts the failure", () => {
    it(
      "ENG-AC3live1: claimed but never recorded → consecutive_errors + 1 and one strike on the owner; the next good check resets the errors and repays the strike (1 → 0)",
      async () => {
        currentPage = { type: "html", body: "<html><body><p>Recovered page</p></body></html>" };
        expect((await readMonitorState(seededMonitorId)).consecutive_errors).toBe(0);
        // Every earlier run recorded each monitor it claimed: claim and record cancelled out.
        expect(await readStrikes()).toEqual([{ strikes: 0 }]);

        // A fetchPage that throws stands in for a Worker killed mid-check: claimed, never recorded.
        await updateSeededMonitor({ last_checked_at: null });
        const { mailer, captured } = makeCapturingMailer();
        const killed = await runMonitorChecks({
          rpc: createSupabaseEngineRpc(SUPABASE_URL, SECRET_KEY),
          mailer,
          fetchPage: async () => {
            throw new Error("run killed mid-check");
          },
          config: RUN_CONFIG,
          log: () => {},
        });
        expect([killed.claimed, killed.errors, killed.rpcErrors]).toEqual([1, 0, 1]);
        expect((await readMonitorState(seededMonitorId)).consecutive_errors).toBe(1);
        expect(await readStrikes()).toEqual([{ strikes: 1 }]);

        const good = await runEngine(mailer);
        // The good run's claim found the killed check's strike: one monitor of an owner with strikes.
        expect([good.unchanged, good.strikerClaimed]).toEqual([1, 1]);
        expect((await readMonitorState(seededMonitorId)).consecutive_errors).toBe(0);
        // The good run's claim found 1 strike (prior_strikes 1, so the run passes p_repay) and added
        // one (2); its good record took off two: its own and the killed check's.
        expect(await readStrikes()).toEqual([{ strikes: 0 }]);
        expect(captured).toEqual([]);
      },
      30_000,
    );

    it(
      "ENG-AC3live2: checks that keep dying add a strike per killed run and leave the owner one monitor per run; an error run keeps the count, each good run takes one off, and at 0 both due monitors are claimed again, their two good records (no p_repay) taking off one each (2 → 0)",
      async () => {
        expect(await readStrikes()).toEqual([{ strikes: 0 }]);
        // A second monitor of the owner, created after the seeded one: with both never checked, the
        // seeded one is the older, so it is the one monitor a run claims while the owner has strikes.
        const second = await insertOwnerMonitor(STRIKE_MONITOR_URL);
        try {
          const { mailer, captured } = makeCapturingMailer();
          const both = [seededMonitorId, second];

          // Killed runs: the first claims both monitors (+2), every later one only the older (+1).
          const killed = [
            await runDue(mailer, both, killedMidCheck),
            await runDue(mailer, both, killedMidCheck),
            await runDue(mailer, both, killedMidCheck),
          ];
          expect(killed).toEqual([
            { ...QUIET_RUN, urls: [SEED_MONITOR_URL, STRIKE_MONITOR_URL], claimed: 2, rpcErrors: 2, strikes: [{ strikes: 2 }] },
            { ...QUIET_RUN, urls: [SEED_MONITOR_URL], claimed: 1, strikerClaimed: 1, rpcErrors: 1, strikes: [{ strikes: 3 }] },
            { ...QUIET_RUN, urls: [SEED_MONITOR_URL], claimed: 1, strikerClaimed: 1, rpcErrors: 1, strikes: [{ strikes: 4 }] },
          ]);

          // An error run: claim +1, error record −1. The killed runs' provisional failures are reset
          // first, so this one failure stays below the threshold (no error email).
          await updateSeededMonitor({ consecutive_errors: 0 });
          currentPage = { type: "status", code: 500 };
          expect(await runDue(mailer, both)).toEqual(
            { ...QUIET_RUN, urls: [SEED_MONITOR_URL], claimed: 1, strikerClaimed: 1, errors: 1, strikes: [{ strikes: 4 }] },
          );

          // Good runs: claim +1, good record with p_repay (the owner had strikes before the claim)
          // −2, so one off per run, still one monitor per run.
          currentPage = { type: "html", body: "<html><body><p>Recovered page</p></body></html>" };
          const good = [
            await runDue(mailer, both),
            await runDue(mailer, both),
            await runDue(mailer, both),
            await runDue(mailer, both),
          ];
          expect(good).toEqual([3, 2, 1, 0].map((strikes) => (
            { ...QUIET_RUN, urls: [SEED_MONITOR_URL], claimed: 1, strikerClaimed: 1, unchanged: 1, strikes: [{ strikes }] }
          )));

          // Recovered: both due monitors are claimed again (+2, prior_strikes 0); neither good record
          // has p_repay, so each takes off only its own claim's strike (2 → 1 → 0).
          expect(await runDue(mailer, both)).toEqual({
            ...QUIET_RUN,
            urls: [SEED_MONITOR_URL, STRIKE_MONITOR_URL],
            claimed: 2,
            unchanged: 1,
            baselines: 1,
            strikes: [{ strikes: 0 }],
          });
          expect(captured).toEqual([]);
        } finally {
          const { error } = await makeAdminClient().from("monitors").delete().eq("id", second);
          if (error) cleanupErrors.push(`strike monitor: ${error.message}`);
        }
      },
      120_000,
    );

    it(
      "ENG-AC3live3: a result made stale by a url edit mid-check takes off only its own strike (1 → 1); a monitor deleted mid-check leaves its strike (0 → 1), which the owner's good check in a later run repays (1 → 0); a good check on 0 stays at 0",
      async () => {
        expect(await readStrikes()).toEqual([{ strikes: 0 }]);
        const admin = makeAdminClient();
        // Never checked, so due at once; the seeded monitor is still leased by ENG-AC3live2's last run.
        const other = await insertOwnerMonitor(STALE_MONITOR_URL);
        const movedUrl = `${STALE_MONITOR_URL}-moved`;
        try {
          const { mailer, captured } = makeCapturingMailer();
          currentPage = { type: "html", body: "<html><body><p>Recovered page</p></body></html>" };

          // A killed check leaves one strike to tell "one off" from "two off" by.
          expect(await runDue(mailer, [other], killedMidCheck)).toEqual(
            { ...QUIET_RUN, urls: [STALE_MONITOR_URL], claimed: 1, rpcErrors: 1, strikes: [{ strikes: 1 }] },
          );

          // The owner edits the url while it is checked: the baseline is not applied (not counted),
          // and the record takes off only the strike its claim added.
          const stale = await runDue(mailer, [other], async () => {
            const { error } = await admin.from("monitors").update({ url: movedUrl }).eq("id", other);
            if (error) throw new Error(`Failed to edit the url mid-check: ${error.message}`);
          });
          expect(stale).toEqual({ ...QUIET_RUN, urls: [STALE_MONITOR_URL], claimed: 1, strikerClaimed: 1, strikes: [{ strikes: 1 }] });

          // A good check of the seeded monitor in a later run (prior_strikes 1) repays the killed
          // check's strike.
          expect(await runDue(mailer, [seededMonitorId])).toEqual(
            { ...QUIET_RUN, urls: [SEED_MONITOR_URL], claimed: 1, strikerClaimed: 1, unchanged: 1, strikes: [{ strikes: 0 }] },
          );

          // The owner deletes the other monitor while it is checked: its record finds no owner, so
          // the strike its claim added stays.
          const deleted = await runDue(mailer, [other], async () => {
            const { error } = await admin.from("monitors").delete().eq("id", other);
            if (error) throw new Error(`Failed to delete the monitor mid-check: ${error.message}`);
          });
          expect(deleted).toEqual({ ...QUIET_RUN, urls: [movedUrl], claimed: 1, strikes: [{ strikes: 1 }] });
          const { data: gone, error: goneErr } = await admin.from("monitors").select("id").eq("id", other);
          expect([gone, goneErr]).toEqual([[], null]);

          // The owner's good check in the next run (prior_strikes 1) repays it; one more good check
          // on 0 (prior_strikes 0) stays at 0.
          const good = [await runDue(mailer, [seededMonitorId]), await runDue(mailer, [seededMonitorId])];
          expect(good).toEqual([1, 0].map((strikerClaimed) => (
            { ...QUIET_RUN, urls: [SEED_MONITOR_URL], claimed: 1, strikerClaimed, unchanged: 1, strikes: [{ strikes: 0 }] }
          )));
          expect(captured).toEqual([]);
        } finally {
          const { error } = await admin.from("monitors").delete().eq("id", other);
          if (error) cleanupErrors.push(`stale monitor: ${error.message}`);
        }
      },
      120_000,
    );

    it(
      "ENG-AC3live4: a good check recorded before the owner's killing page in the same run does not repay that page's strike (0 → 2 → 1); the next run claims only the owner's oldest due monitor, whose good check repays it (1 → 2 → 0)",
      async () => {
        expect(await readStrikes()).toEqual([{ strikes: 0 }]);
        // A second monitor of the owner, created after the seeded one: with both never checked, the
        // seeded one (a good page, H) is checked first and this one (P) kills the check.
        const killer = await insertOwnerMonitor(KILL_MONITOR_URL);
        try {
          const { mailer, captured } = makeCapturingMailer();
          currentPage = { type: "html", body: "<html><body><p>Recovered page</p></body></html>" };
          const killP = async (url: string) => {
            if (url === KILL_MONITOR_URL) await killedMidCheck();
          };

          // One claim leases both (no strikes before it, so +2 and p_repay false for both): H's good
          // record takes off only its own strike, P is never recorded.
          expect(await runDue(mailer, [seededMonitorId, killer], killP)).toEqual({
            ...QUIET_RUN,
            urls: [SEED_MONITOR_URL, KILL_MONITOR_URL],
            claimed: 2,
            unchanged: 1,
            rpcErrors: 1,
            strikes: [{ strikes: 1 }],
          });

          // Both due again: with a strike the owner gets only the oldest due monitor (H), whose good
          // record (prior_strikes 1, so p_repay) takes off its own claim's strike and P's.
          expect(await runDue(mailer, [seededMonitorId, killer], killP)).toEqual(
            { ...QUIET_RUN, urls: [SEED_MONITOR_URL], claimed: 1, strikerClaimed: 1, unchanged: 1, strikes: [{ strikes: 0 }] },
          );
          expect(captured).toEqual([]);
        } finally {
          const { error } = await makeAdminClient().from("monitors").delete().eq("id", killer);
          if (error) cleanupErrors.push(`kill monitor: ${error.message}`);
        }
      },
      60_000,
    );

    it(
      "ENG-AC3live5: two owners on equal intervals, the killing page K first by id — the run dying on K leaves the other owner's V unrecorded (both owners 0 → 1); the next run takes K alone and dies again (V is not leased: its failure count stays 1); the one after takes V alone, whose baseline repays its owner (1 → 2 → 0); from then on V is checked before K, whose kills cost it nothing",
      async () => {
        const admin = makeAdminClient();
        const owners: string[] = [];
        try {
          const killerOwner = await createOwner("killer");
          owners.push(killerOwner);
          const victimOwner = await createOwner("victim");
          owners.push(victimOwner);
          const { data: roles, error: rolesErr } = await admin.from("profiles").select("role").in("user_id", owners);
          expect([roles, rolesErr]).toEqual([[{ role: "monitor_user" }, { role: "monitor_user" }], null]);

          // K takes the lower of two fresh ids (uuid order is the order of their lowercase hex text),
          // so with K and V equally old the claim puts K first.
          const [first, second] = [randomUUID(), randomUUID()];
          const [killerId, victimId] = first < second ? [first, second] : [second, first];
          const { error: insertErr } = await admin.from("monitors").insert([
            { id: killerId, user_id: killerOwner, url: KILL_MONITOR_URL, label: "Kill test", interval_minutes: 60, status: "active" },
            { id: victimId, user_id: victimOwner, url: VICTIM_MONITOR_URL, label: "Victim test", interval_minutes: 60, status: "active" },
          ]);
          if (insertErr) throw new Error(`Failed to seed K and V: ${insertErr.message}`);

          const { mailer, captured } = makeCapturingMailer();
          currentPage = { type: "html", body: "<html><body><p>Recovered page</p></body></html>" };
          /**
           * A Worker that dies on K: K and every check after it in the run are never recorded (the
           * run still calls fetchPage for them, so they show in `urls`).
           */
          const diesOnK = () => {
            let dead = false;
            return async (url: string) => {
              if (url === KILL_MONITOR_URL) dead = true;
              if (dead) await killedMidCheck();
            };
          };
          /**
           * One run a day after the last: K and V age 1440 minutes (due again whatever their
           * backoff, at most 60 × 16 = 960 minutes, in the same queue order; never checked, they
           * start equally old), then the run, dying on K. Returns the run, both owners' strikes and
           * both failure counts after it.
           */
          const nextRun = async () => {
            await ageMonitors([killerId, victimId], 1440);
            const run = await runChecks(mailer, diesOnK());
            return {
              ...run,
              strikes: { killer: await readStrikes(killerOwner), victim: await readStrikes(victimOwner) },
              errors: {
                killer: (await readMonitorState(killerId)).consecutive_errors,
                victim: (await readMonitorState(victimId)).consecutive_errors,
              },
            };
          };

          // Nobody with strikes: K, then V. The run dies on K, so V is not recorded either.
          expect(await nextRun()).toEqual({
            ...QUIET_RUN,
            urls: [KILL_MONITOR_URL, VICTIM_MONITOR_URL],
            claimed: 2,
            rpcErrors: 2,
            strikes: { killer: [{ strikes: 1 }], victim: [{ strikes: 1 }] },
            errors: { killer: 1, victim: 1 },
          });
          // Both owners have strikes and share the batch's one slot; K and V are equally old (one
          // claim stamped both), so K, the lower id, goes alone and dies again. V is not leased.
          expect(await nextRun()).toEqual({
            ...QUIET_RUN,
            urls: [KILL_MONITOR_URL],
            claimed: 1,
            strikerClaimed: 1,
            rpcErrors: 1,
            strikes: { killer: [{ strikes: 2 }], victim: [{ strikes: 1 }] },
            errors: { killer: 2, victim: 1 },
          });
          // K's lease moved it behind V, now the older of the two: V alone, a baseline that repays
          // its owner (prior_strikes 1).
          expect(await nextRun()).toEqual({
            ...QUIET_RUN,
            urls: [VICTIM_MONITOR_URL],
            claimed: 1,
            strikerClaimed: 1,
            baselines: 1,
            strikes: { killer: [{ strikes: 2 }], victim: [{ strikes: 0 }] },
            errors: { killer: 2, victim: 0 },
          });
          // V's owner is back at 0: V first, K the batch's last check. K dies every run; V is
          // recorded every time.
          for (const strikes of [3, 4]) {
            expect(await nextRun()).toEqual({
              ...QUIET_RUN,
              urls: [VICTIM_MONITOR_URL, KILL_MONITOR_URL],
              claimed: 2,
              strikerClaimed: 1,
              unchanged: 1,
              rpcErrors: 1,
              strikes: { killer: [{ strikes }], victim: [{ strikes: 0 }] },
              errors: { killer: strikes, victim: 0 },
            });
          }
          expect(captured).toEqual([]);
        } finally {
          if (owners.length > 0) {
            // Monitors first (PostgREST), so a failed user delete (GoTrue) cannot leave a due monitor.
            const { error } = await admin.from("monitors").delete().in("user_id", owners);
            if (error) cleanupErrors.push(`live5 monitors: ${error.message}`);
            for (const id of owners) {
              const { error: userErr } = await admin.auth.admin.deleteUser(id);
              if (userErr) cleanupErrors.push(`live5 user: ${userErr.message}`);
            }
          }
        }
      },
      120_000,
    );
  });

  describe("ENG-AC4: the daily cap counts the engine's send log, error emails included", () => {
    it(
      "ENG-AC4live1: at the cap an error notification is not claimed (error_notified_at stays null); once the log frees, the next failure sends it",
      async () => {
        await setEmailLog(MONITOR_DAILY_EMAIL_CAP);
        await updateSeededMonitor({ consecutive_errors: MONITOR_ERROR_THRESHOLD - 1, error_notified_at: null });
        currentPage = { type: "status", code: 500 };

        const atCap = makeCapturingMailer();
        const capped = await runEngine(atCap.mailer);
        expect([capped.errors, capped.errorEmails]).toEqual([1, 0]);
        expect(atCap.captured).toEqual([]);
        expect(await readMonitorState(seededMonitorId)).toEqual({
          last_hash: await hashPageText("Recovered page"),
          last_snapshot: "Recovered page",
          consecutive_errors: MONITOR_ERROR_THRESHOLD,
          error_notified_at: null,
        });

        await setEmailLog(0);
        const freed = makeCapturingMailer();
        const sent = await runEngine(freed.mailer);
        expect([sent.errors, sent.errorEmails]).toEqual([1, 1]);
        const state = await readMonitorState(seededMonitorId);
        expect(state.consecutive_errors).toBe(MONITOR_ERROR_THRESHOLD + 1);
        expect(freed.captured.map((mail) => mail.idempotencyKey)).toEqual([
          `monitor-error/${seededMonitorId}/${state.error_notified_at}`,
        ]);
        expect(await readEmailLogKinds()).toEqual(["error"]);
      },
      60_000,
    );

    it(
      "ENG-AC4live2: at the cap a new change waits unemailed; once the log frees, the next run emails it",
      async () => {
        await setEmailLog(MONITOR_DAILY_EMAIL_CAP);
        currentPage = { type: "html", body: "<html><body><p>Capped change</p></body></html>" };

        const atCap = makeCapturingMailer();
        const capped = await runEngine(atCap.mailer);
        expect([capped.changed, capped.emailsSent]).toEqual([1, 0]);
        expect(atCap.captured).toEqual([]);
        const event = (await readMonitorEvents(seededMonitorId))[0];
        if (event === undefined) throw new Error("The capped change created no event");
        expect(event.emailed_at).toBeNull();

        await setEmailLog(0);
        const freed = makeCapturingMailer();
        const sent = await runEngine(freed.mailer);
        expect([sent.unchanged, sent.emailsSent]).toEqual([1, 1]);
        expect(freed.captured.map((mail) => mail.idempotencyKey)).toEqual([`monitor-event/${event.id}`]);
        expect((await readMonitorEvents(seededMonitorId))[0]?.emailed_at).not.toBeNull();
        expect(await readEmailLogKinds()).toEqual(["change"]);
      },
      60_000,
    );
  });

  describe("ENG-AC2: an overdue monitor is claimed before a newly created one", () => {
    it(
      "ENG-AC2live1: with a batch of 1 the overdue seeded monitor is claimed; the new, never-checked one waits",
      async () => {
        const userId = seededUserId;
        if (userId === undefined) throw new Error("Seeded user missing");
        const admin = makeAdminClient();
        const overdueSince = Date.now() - 2 * 60 * 60 * 1000;
        await updateSeededMonitor({ last_checked_at: new Date(overdueSince).toISOString() });
        const { data: fresh, error: freshErr } = await admin
          .from("monitors")
          .insert({ user_id: userId, url: "https://example.com/alnyron-e2e/queue", label: "Queue test", interval_minutes: 60, status: "active" })
          .select("id")
          .single();
        if (freshErr) throw new Error(`Failed to seed the new monitor: ${freshErr.message}`);
        try {
          const { mailer } = makeCapturingMailer();
          const summary = await runMonitorChecks({
            rpc: createSupabaseEngineRpc(SUPABASE_URL, SECRET_KEY),
            mailer,
            fetchPage: (url) => fetchMonitorPage(url, { fetchImpl: e2eFetch }),
            config: { ...RUN_CONFIG, batchSize: 1 },
            log: () => {},
          });
          expect([summary.claimed, summary.unchanged]).toEqual([1, 1]);
          const { data: rows, error } = await admin
            .from("monitors")
            .select("id, last_checked_at")
            .in("id", [seededMonitorId, fresh.id]);
          expect(error).toBeNull();
          const checkedAt = Object.fromEntries((rows ?? []).map((row) => [row.id, row.last_checked_at]));
          expect(checkedAt[fresh.id]).toBeNull();
          expect(Date.parse(checkedAt[seededMonitorId] ?? "")).toBeGreaterThan(overdueSince);
        } finally {
          const { error } = await admin.from("monitors").delete().eq("id", fresh.id);
          if (error) cleanupErrors.push(`queue monitor: ${error.message}`);
        }
      },
      30_000,
    );
  });
});
