/**
 * RLS integration tests — monitor engine RPCs and the engine-only tables
 * (migration 20261108000100_monitor_engine.sql)
 * Journey: monitor-engine  ENG-AC1–ENG-AC4, ENG-AC6
 *
 * Security round 1 coverage: claim order by coalesce(last_checked_at, created_at) (a re-created
 *   monitor queues behind overdue ones; users cannot write created_at), the claim's provisional
 *   failure (returns the pre-claim count, an error record does not count again, a killed run
 *   keeps the failure and backs off), the daily cap counted from monitor_email_log (change and
 *   error emails; survives event deletion and monitor delete + re-create; error notification
 *   suppressed at the cap without stamping error_notified_at), mark_emailed logging once, the
 *   48 h housekeeping of one user's rows, and the log table closed to anon/authenticated.
 * Review 8: the owner's new url also resets consecutive_errors and error_notified_at (the same
 *   url keeps them; the old url's in-flight record is stale) and the replaced trigger function
 *   keeps its empty search_path.
 * Security round 2 (S6): the claim returns its rows in claim order (owners without strikes
 *   first, then oldest coalesce(last_checked_at, created_at), then id — not id order); an owner
 *   with strikes sorts last with one monitor (the oldest due; S6d below: one for all of them), an
 *   owner without gets all of theirs (limit edges on both sides); the claim adds one strike per
 *   leased monitor; a killed run (claim without record) keeps the strikes of the monitor it died
 *   on and those after it, and the next claim puts that owner last; the owner's url edit and
 *   delete + re-create leave the strikes; monitor_engine_strikes is closed to anon/authenticated
 *   (42501 on select, insert, update, delete), checks strikes >= 0 and goes with the account;
 *   re-applying the migration over the earlier record overloads (8 arguments: round 1, 9: round 2)
 *   and a claim without prior_strikes leaves one record overload and the current claim, both
 *   service_role only.
 *   The skip-locked race uses two accounts (two claims leasing monitors of one account wait for
 *   each other's strike row).
 * S6b/S6c (strikes recover, repaying only strikes from before the claim): the claim returns each
 *   owner's strikes from before it (prior_strikes: 0 for every monitor of an owner without
 *   strikes, also two leased in one claim; the count for an owner with them); a record takes two
 *   strikes off only after an applied unchanged, baseline or changed with p_repay, one after the
 *   same without p_repay, an error or a result that was not applied (each outcome, each stale
 *   case, both p_repay values), none off another owner, never below 0 (2 → 0 and 1 → 0); NULL or
 *   omitted p_repay → 22023 for every outcome; a good check leased with the owner's killing page
 *   in one claim (no strikes before) leaves that page's strike, so the next claim puts the owner
 *   last with one monitor, and that claim's good check repays it; a healthy account with one
 *   strike is back at 0 after its next claim + good record (p_repay) and is no longer sorted
 *   last or held to one monitor; an account whose checks keep dying (claim without record, run
 *   after run) gains a strike per run, stays last with one monitor, and one good check takes off
 *   only one; a deleted monitor's record finds no owner, and the strike it left is repaid by a
 *   good check from a later claim.
 * S6d (one slot for strikes per batch; S6f went back to it from S6e's several): of all due
 *   monitors of owners with strikes only the oldest (on equal age the lower id) is claimed,
 *   whatever the owners' strike counts, after every monitor of the owners without strikes, who
 *   get all of theirs, so it comes last: exactly one at limits 2, 3, 10, 20, 24 (Paid), 40 and
 *   60 (several owners with different counts, the most struck one's monitor the oldest, with and
 *   without monitors of owners without strikes, limit edges); they drain one per claim, oldest
 *   first, at limits 10 and 40, one owner's two due monitors never in one claim, and a
 *   backed-off older monitor takes no slot; two owners on equal intervals with the killing page K
 *   first by id (limits 10 and 40): K's kill strikes both owners, the victim V is never leased
 *   with K while V's owner has strikes, gains no further provisional failure and is checked
 *   within two claims, then precedes K, whose repeated kills cost it nothing, while a third owner
 *   without strikes keeps its normal share; at limit 24 (Paid) a killing page, the oldest, takes
 *   the slot first, its lease moves it behind the two monitors an earlier kill of it left
 *   unchecked, which take the slot one claim each (each good check repaying its owner), and once
 *   they are back in plain order it is the batch's last check; another session holding the one
 *   candidate (limit 10) leaves the batch without a monitor of an owner with strikes (no other
 *   one instead), and once released the batch takes it, last.
 *
 * Skip policy:
 *   - e2e target (SUPABASE_E2E_REF set): NEVER skip — fail if the current functions or the
 *     engine-only tables are missing.
 *   - prod target: skip when to_regprocedure returns null (target lacks 20261108000100).
 *   - Every test uses ctx.skip() so the result is "skipped", not a spurious pass.
 *
 * Run: npm run test:integration:e2e-project -- tests/integration/rls/rls-monitor-engine.test.ts
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_AVAILABLE, getClient, type PoolClient } from "./helpers/db.js";
import { transactionControlStatements } from "./helpers/migration-sql.js";
import {
  ADMIN_EMAIL,
  ADMIN_UUID,
  ANON_CLAIMS,
  MYLIFE_EMAIL,
  MYLIFE_UUID,
  asRole,
  expectPgError,
  seedAuthUser,
  withTx,
  type JwtClaims,
} from "./helpers/roles.js";

// p_error_threshold used throughout — matches MONITOR_ERROR_THRESHOLD = 3
const ERROR_THRESHOLD = 3;
// p_daily_cap used unless a test sets its own — matches MONITOR_DAILY_EMAIL_CAP = 10
const DAILY_CAP = 10;

const ON_E2E_PROJECT = !!process.env.SUPABASE_E2E_REF;
const SKIP_REASON = "20261108000100 not on this target yet";

// ── Fixture identifiers unique to this file ───────────────────────────────────
const ENG_UUID   = "00000000-0000-0000-0000-000000000ee1";
const ENG_EMAIL  = "eng-monitor@test.local";
const ENG_CLAIMS: JwtClaims = { sub: ENG_UUID, role: "authenticated", email: ENG_EMAIL };
const ENG_URL    = "https://example.com/engine-test";
// A second account, for checks that one user's log rows leave another's alone.
const ENG2_UUID  = "00000000-0000-0000-0000-000000000ee2";
const ENG2_EMAIL = "eng-monitor-2@test.local";
// A third account, for strikes of an owner the claim leases nothing of.
const ENG3_UUID  = "00000000-0000-0000-0000-000000000ee3";
const ENG3_EMAIL = "eng-monitor-3@test.local";
// Fourth and fifth accounts, for several owners with strikes in one claim (still one slot).
const ENG4_UUID  = "00000000-0000-0000-0000-000000000ee4";
const ENG4_EMAIL = "eng-monitor-4@test.local";
const ENG5_UUID  = "00000000-0000-0000-0000-000000000ee5";
const ENG5_EMAIL = "eng-monitor-5@test.local";

const MIGRATION_SQL = fs.readFileSync(path.resolve("supabase/migrations/20261108000100_monitor_engine.sql"), "utf-8");

// ── Target schema probe ───────────────────────────────────────────────────────

interface EngineTarget { functionsExist: boolean; errorNotifiedAtExists: boolean }

async function probeEngineTarget(c: PoolClient): Promise<EngineTarget> {
  // The claim marks the migration; the 10-argument record (p_repay) and the log table mark its
  // current version, the strikes table its round 2 version.
  const { rows } = await c.query<{ claim: string | null; record: string | null; log: string | null; strikes: string | null }>(`
    SELECT to_regprocedure('public.monitor_engine_claim(integer,integer,integer)')::text AS claim,
           to_regprocedure('public.monitor_engine_record(uuid,text,text,text,text,text,text,integer,integer,boolean)')::text AS record,
           to_regclass('public.monitor_email_log')::text AS log,
           to_regclass('public.monitor_engine_strikes')::text AS strikes
  `);
  const { rows: colRows } = await c.query<{ column_name: string }>(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'monitors'
      AND column_name = 'error_notified_at'
  `);
  const probe = rows[0];
  return {
    functionsExist: probe?.claim != null && probe.record != null && probe.log != null && probe.strikes != null,
    errorNotifiedAtExists: colRows.length > 0,
  };
}

// ── Global pool client + target probe ────────────────────────────────────────

let client: PoolClient;
let target: EngineTarget;

beforeAll(async () => {
  if (!DB_AVAILABLE) return;
  client = await getClient();
  target = await probeEngineTarget(client);
});

afterAll(async () => { client?.release(); });

// ── Skip helper (uses ctx.skip() so result is "skipped", never "passed") ──────

function ensureFunctions(ctx: { skip: (note?: string) => void }): boolean {
  if (!DB_AVAILABLE) { ctx.skip(SKIP_REASON); return false; }
  if (!target.functionsExist) {
    if (ON_E2E_PROJECT)
      throw new Error("current monitor engine functions, monitor_email_log or monitor_engine_strikes not found on e2e project — apply 20261108000100_monitor_engine.sql");
    ctx.skip(SKIP_REASON);
    return false;
  }
  return true;
}

// ── Seeding helpers ───────────────────────────────────────────────────────────

async function seedEngineUser(c: PoolClient): Promise<void> {
  await seedAuthUser(c, ENG_UUID, ENG_EMAIL);
  const { rows } = await c.query<{ role: string | null }>(
    "SELECT role FROM public.profiles WHERE user_id = $1",
    [ENG_UUID],
  );
  expect(rows, "seedAuthUser without an allowlist role yields monitor_user").toEqual([{ role: "monitor_user" }]);
}

/**
 * Seeds one monitor, never checked (last_checked_at NULL): due edges set last_checked_at from the
 * database clock afterwards (see claimedAfter). `id` fixes the id (claim-order tests);
 * `createdMinutesAgo` sets created_at that far before the transaction's now() (default 0 = now()).
 */
async function seedMonitor(
  c: PoolClient,
  userId: string,
  opts: {
    id?: string; url?: string; intervalMinutes?: number; status?: "active" | "paused";
    lastHash?: string | null; lastSnapshot?: string | null;
    consecutiveErrors?: number; errorNotifiedAt?: string | null; createdMinutesAgo?: number;
  } = {},
): Promise<string> {
  const id = opts.id ?? randomUUID();
  await c.query(
    `INSERT INTO public.monitors
       (id, user_id, url, label, interval_minutes, status,
        last_hash, last_snapshot, consecutive_errors, error_notified_at, created_at)
     VALUES ($1,$2,$3,'Eng test',$4,$5,$6,$7,$8,$9, now() - make_interval(mins => $10::int))`,
    [
      id, userId, opts.url ?? ENG_URL, opts.intervalMinutes ?? 60,
      opts.status ?? "active", opts.lastHash ?? null, opts.lastSnapshot ?? null,
      opts.consecutiveErrors ?? 0, opts.errorNotifiedAt ?? null, opts.createdMinutesAgo ?? 0,
    ],
  );
  return id;
}

/**
 * Seeds one change event. Its times come from the database clock (the transaction's now()), so
 * the 23 h / 24 h window edges cannot flip on client/server clock skew: `detectedMinutesAgo`
 * (default 0) and `emailedMinutesAgo` (default null = still pending).
 */
async function seedEvent(
  c: PoolClient,
  monitorId: string,
  userId: string,
  opts: { emailedMinutesAgo?: number | null; detectedMinutesAgo?: number } = {},
): Promise<string> {
  const id = randomUUID();
  await c.query(
    `INSERT INTO public.monitor_events
       (id, monitor_id, user_id, old_hash, new_hash, summary, emailed_at, detected_at)
     VALUES ($1,$2,$3,'old','new','Changed',
             CASE WHEN $4::int IS NULL THEN NULL ELSE now() - make_interval(mins => $4::int) END,
             now() - make_interval(mins => $5::int))`,
    [id, monitorId, userId, opts.emailedMinutesAgo ?? null, opts.detectedMinutesAgo ?? 0],
  );
  return id;
}

/** Seeds one monitor_email_log row `minutesAgo` before the transaction's now() (database clock). */
async function seedLog(c: PoolClient, userId: string, kind: "change" | "error", minutesAgo: number): Promise<void> {
  await c.query(
    "INSERT INTO public.monitor_email_log (user_id, kind, sent_at) VALUES ($1, $2, now() - make_interval(mins => $3::int))",
    [userId, kind, minutesAgo],
  );
}

/** A user's monitor_email_log rows, newest first, as kind + whole minutes before now(). */
async function logRows(c: PoolClient, userId: string): Promise<Array<{ kind: string; minutes_ago: number }>> {
  const { rows } = await c.query<{ kind: string; minutes_ago: number }>(
    `SELECT kind, (extract(epoch FROM now() - sent_at) / 60)::int AS minutes_ago
       FROM public.monitor_email_log WHERE user_id = $1 ORDER BY sent_at DESC, id DESC`,
    [userId],
  );
  return rows;
}

/** Seeds a user's monitor_engine_strikes row, last written an hour before now() (so a write in the test shows as `touched`). */
async function seedStrikes(c: PoolClient, userId: string, strikes: number): Promise<void> {
  await c.query(
    "INSERT INTO public.monitor_engine_strikes (user_id, strikes, updated_at) VALUES ($1, $2, now() - interval '1 hour')",
    [userId, strikes],
  );
}

/** A user's monitor_engine_strikes row ([] without one): the count, and whether this transaction wrote it (updated_at = now()). */
async function strikeRows(c: PoolClient, userId: string): Promise<Array<{ strikes: number; touched: boolean }>> {
  const { rows } = await c.query<{ strikes: number; touched: boolean }>(
    "SELECT strikes, updated_at = now() AS touched FROM public.monitor_engine_strikes WHERE user_id = $1",
    [userId],
  );
  return rows;
}

// ── EXECUTE privilege ─────────────────────────────────────────────────────────

const FIVE_RPCS: Array<[string, string]> = [
  ["monitor_engine_claim(integer,integer,integer)",
   "SELECT * FROM public.monitor_engine_claim(2,5,3)"],
  [`monitor_engine_snapshot(uuid)`,
   `SELECT public.monitor_engine_snapshot('${randomUUID()}')`],
  [`monitor_engine_record(uuid,text,text,text,text,text,text,integer,integer,boolean)`,
   `SELECT * FROM public.monitor_engine_record('${randomUUID()}','https://x.com','unchanged',null,null,null,null,3,10,false)`],
  ["monitor_engine_pending_emails(integer,integer)",
   "SELECT * FROM public.monitor_engine_pending_emails(2,10)"],
  [`monitor_engine_mark_emailed(uuid)`,
   `SELECT public.monitor_engine_mark_emailed('${randomUUID()}')`],
];

describe("ENG-AC6: EXECUTE denied for anon and authenticated", () => {
  for (const [fnName, sql] of FIVE_RPCS) {
    it(`ENG-AC6rpc-anon-${fnName}: anon → 42501`, async (ctx) => {
      if (!ensureFunctions(ctx)) return;
      await withTx(client, async (c) => {
        await seedEngineUser(c);
        await asRole(c, "anon", ANON_CLAIMS);
        await expectPgError(c, () => c.query(sql), "42501");
      });
    });

    it(`ENG-AC6rpc-auth-${fnName}: authenticated → 42501`, async (ctx) => {
      if (!ensureFunctions(ctx)) return;
      await withTx(client, async (c) => {
        await seedEngineUser(c);
        await asRole(c, "authenticated", ENG_CLAIMS);
        await expectPgError(c, () => c.query(sql), "42501");
      });
    });
  }
});

// ── has_function_privilege ────────────────────────────────────────────────────

const SIGS = [
  "public.monitor_engine_claim(integer,integer,integer)",
  "public.monitor_engine_snapshot(uuid)",
  "public.monitor_engine_record(uuid,text,text,text,text,text,text,integer,integer,boolean)",
  "public.monitor_engine_pending_emails(integer,integer)",
  "public.monitor_engine_mark_emailed(uuid)",
];

describe("ENG-AC6: has_function_privilege for service_role", () => {
  for (const sig of SIGS) {
    it(`ENG-AC6priv-service: service_role EXECUTE on ${sig}`, async (ctx) => {
      if (!ensureFunctions(ctx)) return;
      const { rows } = await client.query<{ ok: boolean }>(
        `SELECT has_function_privilege('service_role', $1, 'execute') AS ok`, [sig],
      );
      expect(rows[0]?.ok).toBe(true);
    });

    it(`ENG-AC6priv-auth: authenticated no EXECUTE on ${sig}`, async (ctx) => {
      if (!ensureFunctions(ctx)) return;
      const { rows } = await client.query<{ ok: boolean }>(
        `SELECT has_function_privilege('authenticated', $1, 'execute') AS ok`, [sig],
      );
      expect(rows[0]?.ok).toBe(false);
    });

    it(`ENG-AC6priv-anon: anon no EXECUTE on ${sig}`, async (ctx) => {
      if (!ensureFunctions(ctx)) return;
      const { rows } = await client.query<{ ok: boolean }>(
        `SELECT has_function_privilege('anon', $1, 'execute') AS ok`, [sig],
      );
      expect(rows[0]?.ok).toBe(false);
    });
  }

  it("ENG-AC6priv-overload: exactly one monitor_engine_record overload, the one with p_daily_cap and p_repay", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    const { rows } = await client.query<{ args: string }>(
      `SELECT pg_get_function_identity_arguments(p.oid) AS args
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'monitor_engine_record'`,
    );
    expect(rows).toEqual([{
      args: "p_monitor_id uuid, p_claimed_url text, p_outcome text, p_expected_hash text, p_new_hash text, "
        + "p_snapshot text, p_summary text, p_error_threshold integer, p_daily_cap integer, p_repay boolean",
    }]);
  });

  it("ENG-AC6priv-reapply: re-applying the migration on a target that still has the 8- and 9-argument records and a claim without prior_strikes drops them and creates the current ones, service_role only; on the current version it drops nothing", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    // A COMMIT (or BEGIN/END) in the file would end withTx's transaction and persist the re-apply.
    expect(transactionControlStatements(MIGRATION_SQL)).toEqual([]);
    /** The engine's claim and record functions, each with its arguments, result, oid and who may EXECUTE it. */
    const functions = async (c: PoolClient) => {
      const { rows } = await c.query<{
        name: string; args: string; result: string; oid: string; service_role: boolean; authenticated: boolean; anon: boolean;
      }>(
        `SELECT p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args,
                pg_get_function_result(p.oid) AS result, p.oid::text AS oid,
                has_function_privilege('service_role', p.oid, 'execute') AS service_role,
                has_function_privilege('authenticated', p.oid, 'execute') AS authenticated,
                has_function_privilege('anon', p.oid, 'execute') AS anon
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname IN ('monitor_engine_claim', 'monitor_engine_record')
          ORDER BY 1, 2`,
      );
      return rows;
    };
    const eightArgs = "p_monitor_id uuid, p_claimed_url text, p_outcome text, p_expected_hash text, p_new_hash text, "
      + "p_snapshot text, p_summary text, p_error_threshold integer";
    const nineArgs = `${eightArgs}, p_daily_cap integer`;
    const claimArgs = "p_limit integer, p_grace_minutes integer, p_error_threshold integer";
    const oldClaimColumns = "id uuid, user_id uuid, url text, last_hash text, consecutive_errors integer";
    const recordResult = "TABLE(applied boolean, event_id uuid, notify_error boolean, notified_at timestamp with time zone, "
      + "email text, url text, label text, consecutive_errors integer)";
    await withTx(client, async (c) => {
      // Stand-ins for the round-1 and round-2 records and the round-2 claim: the record drops go by
      // argument types, the claim's by its result columns; the bodies are irrelevant.
      for (const args of [eightArgs, nineArgs]) {
        await c.query(`CREATE FUNCTION public.monitor_engine_record(${args}) RETURNS boolean LANGUAGE sql AS 'SELECT true'`);
      }
      await c.query("DROP FUNCTION public.monitor_engine_claim(integer, integer, integer)");
      await c.query(
        `CREATE FUNCTION public.monitor_engine_claim(${claimArgs}) RETURNS TABLE (${oldClaimColumns})
         LANGUAGE sql AS 'SELECT null::uuid, null::uuid, null::text, null::text, null::integer WHERE false'`,
      );
      expect((await functions(c)).map(({ name, args, result }) => [name, args, result])).toEqual([
        ["monitor_engine_claim", claimArgs, `TABLE(${oldClaimColumns})`],
        ["monitor_engine_record", eightArgs, "boolean"],
        ["monitor_engine_record", nineArgs, "boolean"],
        ["monitor_engine_record", `${nineArgs}, p_repay boolean`, recordResult],
      ]);

      await c.query(MIGRATION_SQL);
      expect((await functions(c)).map(({ name, args, result, service_role, authenticated, anon }) => (
        [name, args, result, service_role, authenticated, anon]
      ))).toEqual([
        ["monitor_engine_claim", claimArgs, `TABLE(${oldClaimColumns}, prior_strikes integer)`, true, false, false],
        ["monitor_engine_record", `${nineArgs}, p_repay boolean`, recordResult, true, false, false],
      ]);
    });
    // On the current version every drop is a no-op: both functions keep their oids (replaced in place).
    await withTx(client, async (c) => {
      const before = await functions(c);
      await c.query(MIGRATION_SQL);
      expect(await functions(c)).toEqual(before);
    });
  });
});

// ── error_notified_at column ──────────────────────────────────────────────────

describe("ENG-AC6: error_notified_at column on monitors", () => {
  it("ENG-AC6col1: error_notified_at column exists", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    expect(target.errorNotifiedAtExists).toBe(true);
  });

  it("ENG-AC6col2: authenticated cannot UPDATE error_notified_at", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      const id = await seedMonitor(c, ENG_UUID);
      await asRole(c, "authenticated", ENG_CLAIMS);
      await expectPgError(
        c,
        () => c.query("UPDATE public.monitors SET error_notified_at = now() WHERE id = $1", [id]),
        "42501",
      );
    });
  });
});

// ── monitor_email_log ─────────────────────────────────────────────────────────

describe("ENG-AC6: monitor_email_log is engine-only", () => {
  it("ENG-AC6log1: RLS on, no policy, no anon/authenticated privilege on the table, its columns or its sequence; service_role reads and writes", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    // A comma list in has_table_privilege means "any of them", so every privilege is asked alone;
    // has_any_column_privilege also sees column-level grants, which has_table_privilege ignores.
    const { rows } = await client.query(`
      SELECT c.relrowsecurity AS rls_on,
             (SELECT count(*)::int FROM pg_policies
               WHERE schemaname = 'public' AND tablename = 'monitor_email_log') AS policies,
             (SELECT bool_or(has_table_privilege(r, 'public.monitor_email_log', p))
                FROM unnest(ARRAY['anon', 'authenticated']) AS r,
                     unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p) AS api_table_any,
             (SELECT bool_or(has_any_column_privilege(r, 'public.monitor_email_log', p))
                FROM unnest(ARRAY['anon', 'authenticated']) AS r,
                     unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) AS p) AS api_column_any,
             (SELECT bool_or(has_sequence_privilege(r, 'public.monitor_email_log_id_seq', p))
                FROM unnest(ARRAY['anon', 'authenticated']) AS r,
                     unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) AS p) AS api_sequence_any,
             (SELECT bool_and(has_table_privilege('service_role', 'public.monitor_email_log', p))
                FROM unnest(ARRAY['SELECT', 'INSERT', 'DELETE']) AS p) AS service_role_rw
        FROM pg_class c
       WHERE c.oid = 'public.monitor_email_log'::regclass
    `);
    expect(rows).toEqual([{
      rls_on: true, policies: 0, api_table_any: false, api_column_any: false, api_sequence_any: false, service_role_rw: true,
    }]);
  });

  const ROLES: Array<[role: "anon" | "authenticated", claims: JwtClaims]> = [
    ["anon", ANON_CLAIMS],
    ["authenticated", ENG_CLAIMS],
  ];
  const STATEMENTS: Array<[name: string, sql: string, params: string[]]> = [
    ["select", "SELECT * FROM public.monitor_email_log WHERE user_id = $1", [ENG_UUID]],
    ["insert", "INSERT INTO public.monitor_email_log (user_id, kind) VALUES ($1, 'change')", [ENG_UUID]],
    ["delete", "DELETE FROM public.monitor_email_log WHERE user_id = $1", [ENG_UUID]],
  ];
  for (const [role, claims] of ROLES) {
    for (const [name, sql, params] of STATEMENTS) {
      it(`ENG-AC6log2-${role}-${name}: ${role} ${name} on its own rows → 42501; the stored row is untouched`, async (ctx) => {
        if (!ensureFunctions(ctx)) return;
        await withTx(client, async (c) => {
          await seedEngineUser(c);
          await seedLog(c, ENG_UUID, "change", 60);
          await asRole(c, role, claims);
          await expectPgError(c, () => c.query(sql, params), "42501");
          await c.query("RESET ROLE");
          expect(await logRows(c, ENG_UUID)).toEqual([{ kind: "change", minutes_ago: 60 }]);
        });
      });
    }
  }

  it("ENG-AC6log3: indexed on (user_id, sent_at desc); kind is change or error (23514 otherwise)", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    const { rows } = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'monitor_email_log' AND indexname = 'monitor_email_log_user_sent_idx'`,
    );
    expect(rows).toEqual([{
      indexdef: "CREATE INDEX monitor_email_log_user_sent_idx ON public.monitor_email_log USING btree (user_id, sent_at DESC)",
    }]);
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      await seedLog(c, ENG_UUID, "change", 0);
      await seedLog(c, ENG_UUID, "error", 0);
      await expectPgError(
        c,
        () => c.query("INSERT INTO public.monitor_email_log (user_id, kind) VALUES ($1, 'other')", [ENG_UUID]),
        "23514",
      );
      expect(await logRows(c, ENG_UUID)).toEqual([{ kind: "error", minutes_ago: 0 }, { kind: "change", minutes_ago: 0 }]);
    });
  });

  it("ENG-AC6log4: an account's rows go with it (auth.users cascade)", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      await seedLog(c, ENG_UUID, "change", 0);
      await c.query("DELETE FROM auth.users WHERE id = $1", [ENG_UUID]);
      expect(await logRows(c, ENG_UUID)).toEqual([]);
    });
  });
});

// ── monitor_engine_strikes ────────────────────────────────────────────────────

describe("ENG-AC6: monitor_engine_strikes is engine-only", () => {
  it("ENG-AC6strikes1: RLS on, no policy, no anon/authenticated privilege on the table or its columns; service_role reads and writes", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    // Every privilege is asked alone (a comma list means "any of them"); has_any_column_privilege
    // also sees column-level grants, which has_table_privilege ignores.
    const { rows } = await client.query(`
      SELECT c.relrowsecurity AS rls_on,
             (SELECT count(*)::int FROM pg_policies
               WHERE schemaname = 'public' AND tablename = 'monitor_engine_strikes') AS policies,
             (SELECT bool_or(has_table_privilege(r, 'public.monitor_engine_strikes', p))
                FROM unnest(ARRAY['anon', 'authenticated']) AS r,
                     unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p) AS api_table_any,
             (SELECT bool_or(has_any_column_privilege(r, 'public.monitor_engine_strikes', p))
                FROM unnest(ARRAY['anon', 'authenticated']) AS r,
                     unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) AS p) AS api_column_any,
             (SELECT bool_and(has_table_privilege('service_role', 'public.monitor_engine_strikes', p))
                FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS p) AS service_role_rw
        FROM pg_class c
       WHERE c.oid = 'public.monitor_engine_strikes'::regclass
    `);
    expect(rows).toEqual([{ rls_on: true, policies: 0, api_table_any: false, api_column_any: false, service_role_rw: true }]);
  });

  const ROLES: Array<[role: "anon" | "authenticated", claims: JwtClaims]> = [
    ["anon", ANON_CLAIMS],
    ["authenticated", ENG_CLAIMS],
  ];
  const STATEMENTS: Array<[name: string, sql: string]> = [
    ["select", "SELECT * FROM public.monitor_engine_strikes WHERE user_id = $1"],
    ["insert", "INSERT INTO public.monitor_engine_strikes (user_id, strikes) VALUES ($1, 0)"],
    ["update", "UPDATE public.monitor_engine_strikes SET strikes = 0 WHERE user_id = $1"],
    ["delete", "DELETE FROM public.monitor_engine_strikes WHERE user_id = $1"],
  ];
  for (const [role, claims] of ROLES) {
    for (const [name, sql] of STATEMENTS) {
      it(`ENG-AC6strikes2-${role}-${name}: ${role} ${name} on the user's own strikes → 42501; the stored row is untouched`, async (ctx) => {
        if (!ensureFunctions(ctx)) return;
        await withTx(client, async (c) => {
          await seedEngineUser(c);
          await seedStrikes(c, ENG_UUID, 2);
          await asRole(c, role, claims);
          await expectPgError(c, () => c.query(sql, [ENG_UUID]), "42501");
          await c.query("RESET ROLE");
          expect(await strikeRows(c, ENG_UUID)).toEqual([{ strikes: 2, touched: false }]);
        });
      });
    }
  }

  it("ENG-AC6strikes3: strikes default to 0 (updated_at now()), cannot go below 0 (23514), and go with the account (auth.users cascade)", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      await c.query("INSERT INTO public.monitor_engine_strikes (user_id) VALUES ($1)", [ENG_UUID]);
      expect(await strikeRows(c, ENG_UUID)).toEqual([{ strikes: 0, touched: true }]);
      await expectPgError(
        c,
        () => c.query("UPDATE public.monitor_engine_strikes SET strikes = -1 WHERE user_id = $1", [ENG_UUID]),
        "23514",
      );
      await c.query("DELETE FROM auth.users WHERE id = $1", [ENG_UUID]);
      expect(await strikeRows(c, ENG_UUID)).toEqual([]);
    });
  });
});

// ── monitor_engine_claim ──────────────────────────────────────────────────────

/** Mark all pre-existing active monitors as just-checked so they are not due.
 *  Runs inside withTx (rolled back after the test), preventing committed
 *  rows from other test runs contaminating claim results. */
async function neutraliseExistingMonitors(c: PoolClient): Promise<void> {
  await c.query("UPDATE public.monitors SET last_checked_at = now() WHERE status = 'active'");
}

/** The ids claim(limit, 5, threshold) returns, in its order. */
async function claimIds(c: PoolClient, limit: number): Promise<string[]> {
  const { rows } = await c.query<{ id: string }>(
    "SELECT * FROM public.monitor_engine_claim($1,5,$2)", [limit, ERROR_THRESHOLD],
  );
  return rows.map((r) => r.id);
}

/** The rows claim(limit, 5, threshold) returns, in its order: each id with its owner's strikes from before the claim. */
async function claimRows(c: PoolClient, limit: number): Promise<Array<{ id: string; prior_strikes: number }>> {
  const { rows } = await c.query<{ id: string; prior_strikes: number }>(
    "SELECT id, prior_strikes FROM public.monitor_engine_claim($1,5,$2)", [limit, ERROR_THRESHOLD],
  );
  return rows;
}

describe("monitor_engine_claim — ENG-AC2/ENG-AC3", () => {
  /**
   * Seeds one active monitor of the engine user, last checked exactly `checkedMinutesAgo` before
   * the transaction's now() (the database clock: no client/server skew at the due edges), and
   * reports whether claim(10, 5, threshold) returns it. Every other active monitor is neutralised
   * first, so the claim returns this monitor or nothing.
   */
  async function claimedAfter(
    c: PoolClient,
    opts: { intervalMinutes: number; consecutiveErrors: number; checkedMinutesAgo: number },
  ): Promise<boolean> {
    await seedEngineUser(c);
    await neutraliseExistingMonitors(c);
    const id = await seedMonitor(c, ENG_UUID, {
      intervalMinutes: opts.intervalMinutes, consecutiveErrors: opts.consecutiveErrors,
    });
    await c.query(
      "UPDATE public.monitors SET last_checked_at = now() - make_interval(mins => $2) WHERE id = $1",
      [id, opts.checkedMinutesAgo],
    );
    const { rows } = await c.query<{ id: string }>(
      "SELECT * FROM public.monitor_engine_claim(10,5,$1)", [ERROR_THRESHOLD],
    );
    const ids = rows.map((r) => r.id);
    expect([[], [id]], "the claim returns the seeded monitor or nothing").toContainEqual(ids);
    return ids.length === 1;
  }

  it("ENG-AC2claim1: null last_checked_at → returned (due) with the claim's columns; consecutive_errors as before the claim; prior_strikes 0 without a strike row", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      await neutraliseExistingMonitors(c);
      const lastHash = "v1:" + "c".repeat(64);
      const id = await seedMonitor(c, ENG_UUID, { lastHash, consecutiveErrors: 1 });
      const { rows } = await c.query(
        "SELECT * FROM public.monitor_engine_claim(2,5,$1)", [ERROR_THRESHOLD],
      );
      expect(rows).toEqual([{ id, user_id: ENG_UUID, url: ENG_URL, last_hash: lastHash, consecutive_errors: 1, prior_strikes: 0 }]);
    });
  });

  it.for<[label: string, seeded: number | null, prior: number]>([
    ["no strike row → 0", null, 0],
    ["0 strikes → 0", 0, 0],
    ["1 strike → 1", 1, 1],
    ["4 strikes → 4", 4, 4],
  ])("ENG-AC3claim32: prior_strikes is the owner's count from before the claim, which then adds its one — %s", async ([, seeded, prior], ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      await neutraliseExistingMonitors(c);
      if (seeded !== null) await seedStrikes(c, ENG_UUID, seeded);
      const id = await seedMonitor(c, ENG_UUID);
      expect(await claimRows(c, 10)).toEqual([{ id, prior_strikes: prior }]);
      expect(await strikeRows(c, ENG_UUID)).toEqual([{ strikes: prior + 1, touched: true }]);
    });
  });

  it("ENG-AC2claim2: checked 120 min ago with interval=60 → returned (due)", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      expect(await claimedAfter(c, { intervalMinutes: 60, consecutiveErrors: 0, checkedMinutesAgo: 120 })).toBe(true);
    });
  });

  it("ENG-AC2claim3: checked 30 min ago with interval=60 → not returned (not due)", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      // 30 min ago < (60 - 5 = 55 min threshold) → not due
      expect(await claimedAfter(c, { intervalMinutes: 60, consecutiveErrors: 0, checkedMinutesAgo: 30 })).toBe(false);
    });
  });

  it("ENG-AC2claim4: grace edge — 56 min ago with interval=60, grace=5 → due", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      // 56 > (60 - 5 = 55) → due
      expect(await claimedAfter(c, { intervalMinutes: 60, consecutiveErrors: 0, checkedMinutesAgo: 56 })).toBe(true);
    });
  });

  it("ENG-AC2claim5: grace edge — 54 min ago with interval=60, grace=5 → not due", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      // 54 < (60 - 5 = 55) → not due
      expect(await claimedAfter(c, { intervalMinutes: 60, consecutiveErrors: 0, checkedMinutesAgo: 54 })).toBe(false);
    });
  });

  it("ENG-AC2claim6: paused monitor excluded", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      await neutraliseExistingMonitors(c);
      await seedMonitor(c, ENG_UUID, { status: "paused" });
      const { rows } = await c.query<{ id: string }>(
        "SELECT * FROM public.monitor_engine_claim(2,5,$1)", [ERROR_THRESHOLD],
      );
      expect(rows).toEqual([]);
    });
  });

  it("ENG-AC6claim7: non-monitor role (admin) owner excluded from claim", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      // Seed an admin user (not monitor_user/owner) and their monitor
      await seedAuthUser(c, ADMIN_UUID, ADMIN_EMAIL, "admin");
      await neutraliseExistingMonitors(c);
      await seedMonitor(c, ADMIN_UUID, { url: "https://example.com/admin-engine" });
      const { rows } = await c.query<{ id: string }>(
        "SELECT * FROM public.monitor_engine_claim(10,5,$1)", [ERROR_THRESHOLD],
      );
      // Admin role is not 'owner' or 'monitor_user' → excluded
      expect(rows).toEqual([]);
    });
  });

  it("ENG-AC6claim8: mylife_user owner excluded from claim", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedAuthUser(c, MYLIFE_UUID, MYLIFE_EMAIL, "mylife_user");
      await neutraliseExistingMonitors(c);
      await seedMonitor(c, MYLIFE_UUID, { url: "https://example.com/mylife-engine" });
      const { rows } = await c.query<{ id: string }>(
        "SELECT * FROM public.monitor_engine_claim(10,5,$1)", [ERROR_THRESHOLD],
      );
      expect(rows).toEqual([]);
    });
  });

  it("ENG-AC2claim9: stamps last_checked_at = now() and adds the provisional failure on the claimed monitor", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      await neutraliseExistingMonitors(c);
      const id = await seedMonitor(c, ENG_UUID);
      await c.query("SELECT * FROM public.monitor_engine_claim(2,5,$1)", [ERROR_THRESHOLD]);
      const { rows } = await c.query<{ stamped: boolean; consecutive_errors: number }>(
        "SELECT last_checked_at = now() AS stamped, consecutive_errors FROM public.monitors WHERE id = $1", [id],
      );
      expect(rows).toEqual([{ stamped: true, consecutive_errors: 1 }]);
    });
  });

  it("ENG-AC2claim10: p_limit limits returned rows", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      // Three monitors exceed the default free cap (profiles.monitor_limit = 2, migration 0300).
      await c.query("UPDATE public.profiles SET monitor_limit = NULL WHERE user_id = $1", [ENG_UUID]);
      for (let i = 0; i < 3; i++)
        await seedMonitor(c, ENG_UUID, { url: `https://example.com/eng-limit-${i}` });
      const { rows } = await c.query("SELECT * FROM public.monitor_engine_claim(2,5,$1)", [ERROR_THRESHOLD]);
      // Three due monitors, limit 2: exactly 2 proves p_limit binds (<= 2 would pass with none).
      expect(rows).toHaveLength(2);
    });
  });

  it("ENG-AC3claim11: backoff ×2 at errors=threshold (3) — 61 min ago with interval=60 → not due", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      // errors=3 → effective = max(60, min(60*2,10080)) = 120
      // 61 min ago < 120 → not due
      expect(await claimedAfter(c, { intervalMinutes: 60, consecutiveErrors: ERROR_THRESHOLD, checkedMinutesAgo: 61 })).toBe(false);
    });
  });

  it("ENG-AC3claim12: backoff ×16 at errors=6 — 500 min ago with interval=60 → not due (effective=960)", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      // errors=6 → 2^min(6-2,4)=2^4=16 → effective = max(60, min(60*16,10080)) = 960
      // 500 min < 960 → not due
      expect(await claimedAfter(c, { intervalMinutes: 60, consecutiveErrors: 6, checkedMinutesAgo: 500 })).toBe(false);
    });
  });

  it("ENG-AC3claim13: 7-day cap — errors=6, interval=1440 → effective=10080; checked 10083 min ago → due", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      // 1440*16=23040 > 10080 → effective=10080; 10083 > (10080-5)=10075 → due
      expect(await claimedAfter(c, { intervalMinutes: 1440, consecutiveErrors: 6, checkedMinutesAgo: 10_083 })).toBe(true);
    });
  });

  it("ENG-AC3claim14: floor — interval=20160 (> 7 days), errors=6 → effective stays 20160; checked 10083 min ago → not due", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      // least(least(20160,10080)*16, 10080) = 10080 < 20160 → greatest(...) = 20160; 10083 < 20155 → not due
      expect(await claimedAfter(c, { intervalMinutes: 20_160, consecutiveErrors: 6, checkedMinutesAgo: 10_083 })).toBe(false);
    });
  });

  it("ENG-AC3claim18: floor — interval=20160, errors=6, checked 20156 min ago → due", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      // effective 20160 - grace 5 = 20155 ≤ 20156 → due
      expect(await claimedAfter(c, { intervalMinutes: 20_160, consecutiveErrors: 6, checkedMinutesAgo: 20_156 })).toBe(true);
    });
  });

  it("ENG-AC3claim19: backoff ×2 at errors=3, interval=60 — checked 116 min ago → due (effective 120)", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      // 120 - 5 = 115 ≤ 116 → due
      expect(await claimedAfter(c, { intervalMinutes: 60, consecutiveErrors: 3, checkedMinutesAgo: 116 })).toBe(true);
    });
  });

  it("ENG-AC3claim20: backoff ×4 at errors=4, interval=60 — checked 236 min ago → due, 234 min ago → not due (effective 240)", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      expect(await claimedAfter(c, { intervalMinutes: 60, consecutiveErrors: 4, checkedMinutesAgo: 236 })).toBe(true);
    });
    await withTx(client, async (c) => {
      expect(await claimedAfter(c, { intervalMinutes: 60, consecutiveErrors: 4, checkedMinutesAgo: 234 })).toBe(false);
    });
  });

  it("ENG-AC3claim21: backoff ×16 at errors=6, interval=60 — checked 956 min ago → due (effective 960; the exponent cap is claim23 at errors 7)", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      expect(await claimedAfter(c, { intervalMinutes: 60, consecutiveErrors: 6, checkedMinutesAgo: 956 })).toBe(true);
    });
  });

  it("ENG-AC3claim22: interval_minutes = 2147483647 with errors=3 does not overflow; other due monitors are still claimed", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      await neutraliseExistingMonitors(c);
      // A user may set any interval >= 30 (column-level UPDATE grant); before the cap-first fix
      // interval * 2 raised 22003 and failed the claim for every monitor.
      const huge = await seedMonitor(c, ENG_UUID, {
        url: "https://example.com/eng-overflow",
        intervalMinutes: 2_147_483_647,
        consecutiveErrors: ERROR_THRESHOLD,
      });
      await c.query(
        "UPDATE public.monitors SET last_checked_at = now() - interval '24 hours' WHERE id = $1", [huge],
      );
      const due = await seedMonitor(c, ENG_UUID, { url: "https://example.com/eng-overflow-other" });
      const { rows } = await c.query<{ id: string }>(
        "SELECT * FROM public.monitor_engine_claim(10,5,$1)", [ERROR_THRESHOLD],
      );
      expect(rows.map((r) => r.id)).toEqual([due]);
    });
  });

  // Exact due edges: a monitor is due once it was last checked at least its effective interval
  // minus the 5-minute grace ago (inclusive); one minute later than that it is not. Counterparts
  // already above: claim5 (54 min, errors 0), claim20 (234 min, errors 4), claim18 (20156 min).
  it.for<[edge: string, intervalMinutes: number, consecutiveErrors: number, checkedMinutesAgo: number, due: boolean]>([
    ["×1 at errors 0: exactly 60 − 5", 60, 0, 55, true],
    ["×1 at errors 2 (threshold − 1): exactly 60 − 5", 60, 2, 55, true],
    ["×1 at errors 2 (threshold − 1): one minute short", 60, 2, 54, false],
    ["×2 at errors 3 (threshold): exactly 120 − 5", 60, 3, 115, true],
    ["×2 at errors 3 (threshold): one minute short", 60, 3, 114, false],
    ["×4 at errors 4: exactly 240 − 5", 60, 4, 235, true],
    ["×8 at errors 5: exactly 480 − 5", 60, 5, 475, true],
    ["×8 at errors 5: one minute short", 60, 5, 474, false],
    ["×16 at errors 6: exactly 960 − 5", 60, 6, 955, true],
    ["×16 at errors 6: one minute short", 60, 6, 954, false],
    ["×16 at errors 7 (exponent capped at 4, not ×32): exactly 960 − 5", 60, 7, 955, true],
    ["×16 at errors 7: one minute short", 60, 7, 954, false],
    ["7-day cap (interval 1440, errors 6): exactly 10080 − 5", 1440, 6, 10_075, true],
    ["7-day cap (interval 1440, errors 6): one minute short", 1440, 6, 10_074, false],
    ["own interval floor (20160, errors 6): exactly 20160 − 5", 20_160, 6, 20_155, true],
    ["own interval floor (20160, errors 6): one minute short", 20_160, 6, 20_154, false],
  ])("ENG-AC3claim23: %s (interval %i, errors %i, checked %i min ago) → due %s", async ([, intervalMinutes, consecutiveErrors, checkedMinutesAgo, due], ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      expect(await claimedAfter(c, { intervalMinutes, consecutiveErrors, checkedMinutesAgo })).toBe(due);
    });
  });

  it.for<[limit: number, graceMinutes: number, errorThreshold: number]>([
    [1, 5, 3],
    [500, 5, 3],
    [2, 0, 3],
    [2, 5, 1],
  ])("ENG-AC6claim24: the accepted edge claim(%i, %i, %i) runs (other monitors neutralised → no rows)", async ([limit, graceMinutes, errorThreshold], ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await neutraliseExistingMonitors(c);
      const { rows } = await c.query(
        "SELECT * FROM public.monitor_engine_claim($1,$2,$3)", [limit, graceMinutes, errorThreshold],
      );
      expect(rows).toEqual([]);
    });
  });

  it("ENG-AC6claim25: 22023 on p_limit 501 (> 500)", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await expectPgError(c, () => c.query("SELECT * FROM public.monitor_engine_claim(501,5,3)"), "22023");
    });
  });

  it("ENG-AC6claim15: 22023 on p_limit 0 (< 1)", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await expectPgError(c, () => c.query("SELECT * FROM public.monitor_engine_claim(0,5,3)"), "22023");
    });
  });

  it("ENG-AC6claim16: 22023 on p_error_threshold 0 (< 1)", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await expectPgError(c, () => c.query("SELECT * FROM public.monitor_engine_claim(2,5,0)"), "22023");
    });
  });

  it("ENG-AC6claim17: 22023 on p_grace_minutes -1 (< 0)", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await expectPgError(c, () => c.query("SELECT * FROM public.monitor_engine_claim(2,-1,3)"), "22023");
    });
  });

  // ── Claim order (security round 1, S1) ──────────────────────────────────────

  const LOW_ID = "00000000-0000-0000-0000-00000000e0a1";
  const HIGH_ID = "00000000-0000-0000-0000-00000000e0a2";

  it("ENG-AC2claim26: a re-created monitor (never checked, created now) queues behind an overdue one, even with the lower id", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      await neutraliseExistingMonitors(c);
      await seedMonitor(c, ENG_UUID, { id: HIGH_ID, url: "https://example.com/eng-overdue" });
      await c.query("UPDATE public.monitors SET last_checked_at = now() - interval '120 minutes' WHERE id = $1", [HIGH_ID]);
      await seedMonitor(c, ENG_UUID, { id: LOW_ID, url: "https://example.com/eng-recreated" });
      // Before the fix (`last_checked_at nulls first, id`) the re-created monitor came first.
      expect(await claimIds(c, 1)).toEqual([HIGH_ID]);
      // It is still due, so the next claim takes it.
      expect(await claimIds(c, 1)).toEqual([LOW_ID]);
    });
  });

  it.for<[edge: string, createdMinutesAgo: number, neverCheckedId: string, overdueId: string, first: string]>([
    ["created 121 min ago, before the overdue one's last check (120 min ago): first, despite the higher id", 121, HIGH_ID, LOW_ID, HIGH_ID],
    ["created 119 min ago, after that check: second, despite the lower id", 119, LOW_ID, HIGH_ID, HIGH_ID],
    ["created exactly at that check: the lower id decides", 120, HIGH_ID, LOW_ID, LOW_ID],
  ])("ENG-AC2claim27: a never-checked monitor %s", async ([, createdMinutesAgo, neverCheckedId, overdueId, first], ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      await neutraliseExistingMonitors(c);
      await seedMonitor(c, ENG_UUID, { id: overdueId, url: "https://example.com/eng-overdue" });
      await c.query("UPDATE public.monitors SET last_checked_at = now() - interval '120 minutes' WHERE id = $1", [overdueId]);
      await seedMonitor(c, ENG_UUID, { id: neverCheckedId, url: "https://example.com/eng-never-checked", createdMinutesAgo });
      expect(await claimIds(c, 1)).toEqual([first]);
    });
  });

  it("ENG-AC2claim28: users cannot write created_at (the claim order's tie-breaker): insert and update → 42501", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      const id = await seedMonitor(c, ENG_UUID, { createdMinutesAgo: 30 });
      await asRole(c, "authenticated", ENG_CLAIMS);
      await expectPgError(
        c,
        () => c.query(
          `INSERT INTO public.monitors (user_id, url, label, interval_minutes, status, created_at)
           VALUES ($1, 'https://example.com/eng-backdated', null, 60, 'active', now() - interval '1 year')`,
          [ENG_UUID],
        ),
        "42501",
      );
      await expectPgError(
        c,
        () => c.query("UPDATE public.monitors SET created_at = now() - interval '1 year' WHERE id = $1", [id]),
        "42501",
      );
      await c.query("RESET ROLE");
      const { rows } = await c.query<{ unchanged: boolean }>(
        "SELECT created_at = now() - interval '30 minutes' AS unchanged FROM public.monitors WHERE user_id = $1",
        [ENG_UUID],
      );
      expect(rows).toEqual([{ unchanged: true }]);
    });
  });

  // ── Provisional failure (security round 1, S3) ──────────────────────────────

  it.for([0, ERROR_THRESHOLD - 1, 6])("ENG-AC3claim29: stored errors %i → the claim returns that count and stores one more", async (errors, ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      await neutraliseExistingMonitors(c);
      const id = await seedMonitor(c, ENG_UUID, { consecutiveErrors: errors });
      const { rows } = await c.query<{ id: string; consecutive_errors: number }>(
        "SELECT id, consecutive_errors FROM public.monitor_engine_claim(2,5,$1)", [ERROR_THRESHOLD],
      );
      expect(rows).toEqual([{ id, consecutive_errors: errors }]);
      const { rows: stored } = await c.query<{ consecutive_errors: number }>(
        "SELECT consecutive_errors FROM public.monitors WHERE id = $1", [id],
      );
      expect(stored).toEqual([{ consecutive_errors: errors + 1 }]);
    });
  });

  it("ENG-AC3claim30: killed run (claim, never a record): the failure stays and the next claim backs off", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      await neutraliseExistingMonitors(c);
      // Two failures (threshold − 1): still the plain 60-minute interval.
      const id = await seedMonitor(c, ENG_UUID, { intervalMinutes: 60, consecutiveErrors: ERROR_THRESHOLD - 1 });
      const { rows: first } = await c.query<{ id: string; consecutive_errors: number }>(
        "SELECT id, consecutive_errors FROM public.monitor_engine_claim(10,5,$1)", [ERROR_THRESHOLD],
      );
      expect(first).toEqual([{ id, consecutive_errors: ERROR_THRESHOLD - 1 }]);
      // The run dies here. Three failures now: ×2, due after 120 − 5 = 115 minutes, not 55.
      await c.query("UPDATE public.monitors SET last_checked_at = now() - interval '114 minutes' WHERE id = $1", [id]);
      expect(await claimIds(c, 10)).toEqual([]);
      await c.query("UPDATE public.monitors SET last_checked_at = now() - interval '115 minutes' WHERE id = $1", [id]);
      const { rows: second } = await c.query<{ id: string; consecutive_errors: number }>(
        "SELECT id, consecutive_errors FROM public.monitor_engine_claim(10,5,$1)", [ERROR_THRESHOLD],
      );
      expect(second).toEqual([{ id, consecutive_errors: ERROR_THRESHOLD }]);
      const { rows: stored } = await c.query<{ consecutive_errors: number }>(
        "SELECT consecutive_errors FROM public.monitors WHERE id = $1", [id],
      );
      expect(stored).toEqual([{ consecutive_errors: ERROR_THRESHOLD + 1 }]);
    });
  });
});

// ── monitor_engine_snapshot ───────────────────────────────────────────────────

describe("monitor_engine_snapshot — ENG-AC2", () => {
  it("ENG-AC2snap1: null snapshot returns null", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      const id = await seedMonitor(c, ENG_UUID, { lastSnapshot: null });
      const { rows } = await c.query<{ monitor_engine_snapshot: string | null }>(
        "SELECT public.monitor_engine_snapshot($1)", [id],
      );
      expect(rows[0]?.monitor_engine_snapshot).toBeNull();
    });
  });

  it("ENG-AC2snap2: returns stored snapshot text", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      const id = await seedMonitor(c, ENG_UUID, { lastSnapshot: "Stored snapshot" });
      const { rows } = await c.query<{ monitor_engine_snapshot: string | null }>(
        "SELECT public.monitor_engine_snapshot($1)", [id],
      );
      expect(rows[0]?.monitor_engine_snapshot).toBe("Stored snapshot");
    });
  });
});

// ── monitor_engine_record ─────────────────────────────────────────────────────

describe("monitor_engine_record — ENG-AC1/ENG-AC2/ENG-AC3", () => {
  type RecordRow = {
    applied: boolean; event_id: string | null; notify_error: boolean; notified_at: Date | null;
    email: string | null; url: string | null; label: string | null; consecutive_errors: number | null;
  };

  /** An applied record without an event or a notification (consecutive_errors after the write). */
  const APPLIED: RecordRow = {
    applied: true, event_id: null, notify_error: false, notified_at: null,
    email: null, url: null, label: null, consecutive_errors: 0,
  };

  /** What every stale (not applied) record returns: one row; the monitor is not written. */
  const STALE: RecordRow = {
    applied: false, event_id: null, notify_error: false, notified_at: null,
    email: null, url: null, label: null, consecutive_errors: null,
  };

  /** A notification stamp from an earlier streak: a fixed past value, never the transaction's now(). */
  const NOTIFIED_AT = "2026-11-01T10:00:00.000Z";

  const OLD_HASH = "v1:" + "e".repeat(64);
  const NEW_HASH = "v1:" + "f".repeat(64);

  /**
   * Calls monitor_engine_record for the monitor with the file's threshold, the given daily cap
   * (default {@link DAILY_CAP}) and p_repay false (the strike tests below cover p_repay); omitted
   * args are NULL.
   */
  async function record(
    c: PoolClient,
    id: string,
    outcome: string,
    args: {
      claimedUrl?: string; expectedHash?: string; newHash?: string; snapshot?: string; summary?: string;
      dailyCap?: number;
    } = {},
  ): Promise<RecordRow[]> {
    const { rows } = await c.query<RecordRow>(
      "SELECT * FROM public.monitor_engine_record($1,$2,$3,$4,$5,$6,$7,$8,$9,false)",
      [
        id, args.claimedUrl ?? ENG_URL, outcome, args.expectedHash ?? null, args.newHash ?? null,
        args.snapshot ?? null, args.summary ?? null, ERROR_THRESHOLD, args.dailyCap ?? DAILY_CAP,
      ],
    );
    return rows;
  }

  /** The columns monitor_engine_record writes on the monitor. */
  async function monitorState(c: PoolClient, id: string) {
    const { rows } = await c.query<{
      last_hash: string | null; last_snapshot: string | null; consecutive_errors: number; error_notified_at: Date | null;
    }>(
      "SELECT last_hash, last_snapshot, consecutive_errors, error_notified_at FROM public.monitors WHERE id = $1",
      [id],
    );
    return rows;
  }

  /** The monitor's change events. */
  async function eventsOf(c: PoolClient, monitorId: string) {
    const { rows } = await c.query<{
      id: string; user_id: string; old_hash: string | null; new_hash: string; summary: string | null; emailed_at: Date | null;
    }>(
      "SELECT id, user_id, old_hash, new_hash, summary, emailed_at FROM public.monitor_events WHERE monitor_id = $1",
      [monitorId],
    );
    return rows;
  }

  it("ENG-AC2rec1: unchanged resets consecutive_errors to 0 and error_notified_at to null, keeps hash and snapshot", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      const id = await seedMonitor(c, ENG_UUID, {
        lastHash: OLD_HASH, lastSnapshot: "kept", consecutiveErrors: ERROR_THRESHOLD, errorNotifiedAt: NOTIFIED_AT,
      });
      expect(await record(c, id, "unchanged")).toEqual([APPLIED]);
      expect(await monitorState(c, id)).toEqual([
        { last_hash: OLD_HASH, last_snapshot: "kept", consecutive_errors: 0, error_notified_at: null },
      ]);
    });
  });

  it("ENG-AC2rec2: baseline stores hash and snapshot and resets the error streak", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      const id = await seedMonitor(c, ENG_UUID, {
        lastHash: OLD_HASH, lastSnapshot: "old", consecutiveErrors: ERROR_THRESHOLD, errorNotifiedAt: NOTIFIED_AT,
      });
      expect(await record(c, id, "baseline", { newHash: NEW_HASH, snapshot: "snap" })).toEqual([APPLIED]);
      expect(await monitorState(c, id)).toEqual([
        { last_hash: NEW_HASH, last_snapshot: "snap", consecutive_errors: 0, error_notified_at: null },
      ]);
      expect(await eventsOf(c, id)).toEqual([]);
    });
  });

  it("ENG-AC1rec3: changed inserts the monitor_events row and returns its event_id", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      const id = await seedMonitor(c, ENG_UUID, { lastHash: OLD_HASH, lastSnapshot: "old", consecutiveErrors: 1 });
      const rows = await record(c, id, "changed", {
        expectedHash: OLD_HASH, newHash: NEW_HASH, snapshot: "snap", summary: "+ Added",
      });
      expect(rows).toEqual([{ ...APPLIED, event_id: expect.any(String) }]);
      expect(await eventsOf(c, id)).toEqual([
        { id: rows[0]!.event_id, user_id: ENG_UUID, old_hash: OLD_HASH, new_hash: NEW_HASH, summary: "+ Added", emailed_at: null },
      ]);
      expect(await monitorState(c, id)).toEqual([
        { last_hash: NEW_HASH, last_snapshot: "snap", consecutive_errors: 0, error_notified_at: null },
      ]);
    });
  });

  it("ENG-AC1rec4: changed guard: expected_hash mismatch → applied=false, no event, nothing written", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      const id = await seedMonitor(c, ENG_UUID, { lastHash: OLD_HASH, lastSnapshot: "old" });
      const wrongExpected = "v1:" + "0".repeat(64);
      expect(await record(c, id, "changed", { expectedHash: wrongExpected, newHash: NEW_HASH, snapshot: "snap" })).toEqual([STALE]);
      expect(await eventsOf(c, id)).toEqual([]);
      expect(await monitorState(c, id)).toEqual([
        { last_hash: OLD_HASH, last_snapshot: "old", consecutive_errors: 0, error_notified_at: null },
      ]);
    });
  });

  it("ENG-AC1rec5: url changed mid-run → applied=false, nothing written (guard: url = p_claimed_url)", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      const id = await seedMonitor(c, ENG_UUID, { consecutiveErrors: 1 });
      expect(await record(c, id, "unchanged", { claimedUrl: "https://changed.example.com/" })).toEqual([STALE]);
      expect(await monitorState(c, id)).toEqual([
        { last_hash: null, last_snapshot: null, consecutive_errors: 1, error_notified_at: null },
      ]);
    });
  });

  it("ENG-AC3rec19: the owner's new url resets consecutive_errors and error_notified_at with hash and snapshot; the same url keeps them; the old url's in-flight record is then stale", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      // A notified streak plus the provisional failure of a claim whose check is still running.
      const id = await seedMonitor(c, ENG_UUID, {
        lastHash: OLD_HASH, lastSnapshot: "old page", consecutiveErrors: ERROR_THRESHOLD + 1, errorNotifiedAt: NOTIFIED_AT,
      });
      const updateUrl = async (url: string) => {
        await asRole(c, "authenticated", ENG_CLAIMS);
        const { rowCount } = await c.query("UPDATE public.monitors SET url = $1 WHERE id = $2", [url, id]);
        await c.query("RESET ROLE");
        return rowCount;
      };

      expect(await updateUrl(ENG_URL)).toBe(1);
      expect(await monitorState(c, id)).toEqual([{
        last_hash: OLD_HASH, last_snapshot: "old page", consecutive_errors: ERROR_THRESHOLD + 1,
        error_notified_at: new Date(NOTIFIED_AT),
      }]);

      expect(await updateUrl(`${ENG_URL}-moved`)).toBe(1);
      const restarted = { last_hash: null, last_snapshot: null, consecutive_errors: 0, error_notified_at: null };
      expect(await monitorState(c, id)).toEqual([restarted]);

      expect(await record(c, id, "error", { claimedUrl: ENG_URL })).toEqual([STALE]);
      expect(await monitorState(c, id)).toEqual([restarted]);
      expect(await logRows(c, ENG_UUID)).toEqual([]);
    });
  });

  it("ENG-AC6rec20: the replaced private.monitors_reset_on_url_change keeps its empty search_path", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    const { rows } = await client.query<{ proconfig: string[] | null }>(
      "SELECT proconfig FROM pg_proc WHERE oid = 'private.monitors_reset_on_url_change()'::regprocedure",
    );
    expect(rows).toEqual([{ proconfig: ['search_path=""'] }]);
  });

  it("ENG-AC1rec6: paused monitor → changed returns applied=false, no event", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      const id = await seedMonitor(c, ENG_UUID, { status: "paused", lastHash: OLD_HASH });
      expect(await record(c, id, "changed", { expectedHash: OLD_HASH, newHash: NEW_HASH, snapshot: "snap" })).toEqual([STALE]);
      expect(await eventsOf(c, id)).toEqual([]);
    });
  });

  it("ENG-AC1rec7: deleted monitor → applied=false (no matching row)", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      const id = await seedMonitor(c, ENG_UUID);
      await c.query("DELETE FROM public.monitors WHERE id = $1", [id]);
      expect(await record(c, id, "unchanged")).toEqual([STALE]);
    });
  });

  it("ENG-AC3rec8: error at the threshold (as the claim counted it), none notified yet → notify_error with stamp, owner email, url, label; logged once", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      const id = await seedMonitor(c, ENG_UUID, {
        consecutiveErrors: ERROR_THRESHOLD,
        errorNotifiedAt: null,
      });
      const { rows: nowRows } = await c.query<{ now: Date }>("SELECT now() AS now");
      const now = nowRows[0]!.now;
      expect(await record(c, id, "error")).toEqual([{
        applied: true, event_id: null, notify_error: true, notified_at: now,
        email: ENG_EMAIL, url: ENG_URL, label: "Eng test", consecutive_errors: ERROR_THRESHOLD,
      }]);
      expect(await monitorState(c, id)).toEqual([
        { last_hash: null, last_snapshot: null, consecutive_errors: ERROR_THRESHOLD, error_notified_at: now },
      ]);
      expect(await logRows(c, ENG_UUID)).toEqual([{ kind: "error", minutes_ago: 0 }]);
    });
  });

  it("ENG-AC3rec9: error when error_notified_at already set → notify_error=false, stamp and count kept, nothing logged", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      const id = await seedMonitor(c, ENG_UUID, {
        consecutiveErrors: ERROR_THRESHOLD + 1,
        errorNotifiedAt: NOTIFIED_AT,
      });
      expect(await record(c, id, "error")).toEqual([{ ...APPLIED, consecutive_errors: ERROR_THRESHOLD + 1 }]);
      expect(await monitorState(c, id)).toEqual([
        { last_hash: null, last_snapshot: null, consecutive_errors: ERROR_THRESHOLD + 1, error_notified_at: new Date(NOTIFIED_AT) },
      ]);
      expect(await logRows(c, ENG_UUID)).toEqual([]);
    });
  });

  it("ENG-AC3rec10: a success ends the streak, so the next streak (claim + error record per run) notifies once again", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      await neutraliseExistingMonitors(c);
      const id = await seedMonitor(c, ENG_UUID, {
        consecutiveErrors: ERROR_THRESHOLD + 1,
        errorNotifiedAt: NOTIFIED_AT,
      });
      expect(await record(c, id, "unchanged")).toEqual([APPLIED]);
      const notified: boolean[] = [];
      for (let run = 0; run < ERROR_THRESHOLD + 1; run++) {
        // Each run: the claim counts the failure, then the error record decides on the notification.
        await c.query("UPDATE public.monitors SET last_checked_at = NULL WHERE id = $1", [id]);
        const { rows: claimed } = await c.query<{ id: string }>(
          "SELECT id FROM public.monitor_engine_claim(10,5,$1)", [ERROR_THRESHOLD],
        );
        expect(claimed).toEqual([{ id }]);
        const rows = await record(c, id, "error");
        notified.push(rows[0]!.notify_error);
      }
      // Below the threshold no notification, at it exactly one, after it none.
      expect(notified).toEqual([false, false, true, false]);
      expect((await monitorState(c, id))[0]?.consecutive_errors).toBe(ERROR_THRESHOLD + 1);
    });
  });

  it("ENG-AC3rec14: an error record does not count the failure again: one claim + one error record = one failure", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      await neutraliseExistingMonitors(c);
      const id = await seedMonitor(c, ENG_UUID, { consecutiveErrors: ERROR_THRESHOLD - 2 });
      const { rows: claimed } = await c.query<{ consecutive_errors: number }>(
        "SELECT consecutive_errors FROM public.monitor_engine_claim(10,5,$1)", [ERROR_THRESHOLD],
      );
      expect(claimed).toEqual([{ consecutive_errors: ERROR_THRESHOLD - 2 }]);
      // One below the threshold after this run's failure: no notification, the count stays.
      expect(await record(c, id, "error")).toEqual([{ ...APPLIED, consecutive_errors: ERROR_THRESHOLD - 1 }]);
      expect((await monitorState(c, id))[0]?.consecutive_errors).toBe(ERROR_THRESHOLD - 1);
      // The next run's failure reaches it exactly.
      await c.query("UPDATE public.monitors SET last_checked_at = NULL WHERE id = $1", [id]);
      await c.query("SELECT * FROM public.monitor_engine_claim(10,5,$1)", [ERROR_THRESHOLD]);
      const rows = await record(c, id, "error");
      expect(rows.map((r) => [r.notify_error, r.consecutive_errors])).toEqual([[true, ERROR_THRESHOLD]]);
      expect((await monitorState(c, id))[0]?.consecutive_errors).toBe(ERROR_THRESHOLD);
    });
  });

  // The daily cap counts monitor_email_log rows of the last 24 h, change and error alike.
  it.for<[edge: string, seeded: Array<[kind: "change" | "error", minutesAgo: number]>, cap: number, notify: boolean,
    log: Array<{ kind: string; minutes_ago: number }>]>([
    ["one below the cap (cap 2, one change email)", [["change", 0]], 2, true,
      [{ kind: "error", minutes_ago: 0 }, { kind: "change", minutes_ago: 0 }]],
    ["at the cap (cap 2, one change and one error email)", [["change", 0], ["error", 0]], 2, false,
      [{ kind: "error", minutes_ago: 0 }, { kind: "change", minutes_ago: 0 }]],
    ["an email exactly 24 h old no longer counts (cap 1)", [["change", 1440]], 1, true,
      [{ kind: "error", minutes_ago: 0 }, { kind: "change", minutes_ago: 1440 }]],
    ["an email 24 h − 1 min old still counts (cap 1)", [["change", 1439]], 1, false,
      [{ kind: "change", minutes_ago: 1439 }]],
  ])("ENG-AC4rec16: error notification %s", async ([, seeded, cap, notify, log], ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      const id = await seedMonitor(c, ENG_UUID, { consecutiveErrors: ERROR_THRESHOLD });
      for (const [kind, minutesAgo] of seeded) await seedLog(c, ENG_UUID, kind, minutesAgo);
      const rows = await record(c, id, "error", { dailyCap: cap });
      expect(rows.map((r) => r.notify_error)).toEqual([notify]);
      const { rows: stamp } = await c.query<{ stamped: boolean | null }>(
        "SELECT error_notified_at = now() AS stamped FROM public.monitors WHERE id = $1", [id],
      );
      // At the cap error_notified_at stays NULL, so a later failure of the streak can notify.
      expect(stamp).toEqual([{ stamped: notify ? true : null }]);
      expect(await logRows(c, ENG_UUID)).toEqual(log);
    });
  });

  it("ENG-AC4rec17: suppressed at the cap, the streak notifies at a later failure once the window frees", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      const id = await seedMonitor(c, ENG_UUID, { consecutiveErrors: ERROR_THRESHOLD });
      await seedLog(c, ENG_UUID, "change", 60);
      expect((await record(c, id, "error", { dailyCap: 1 }))[0]?.notify_error).toBe(false);
      // A day later the change email has left the 24 h window; the streak goes on failing.
      await c.query("UPDATE public.monitor_email_log SET sent_at = now() - interval '25 hours' WHERE user_id = $1", [ENG_UUID]);
      await c.query("UPDATE public.monitors SET consecutive_errors = $2 WHERE id = $1", [id, ERROR_THRESHOLD + 1]);
      const rows = await record(c, id, "error", { dailyCap: 1 });
      expect(rows.map((r) => [r.notify_error, r.consecutive_errors])).toEqual([[true, ERROR_THRESHOLD + 1]]);
      expect(await logRows(c, ENG_UUID)).toEqual([{ kind: "error", minutes_ago: 0 }, { kind: "change", minutes_ago: 1500 }]);
    });
  });

  it("ENG-AC4rec18: the error-notify path prunes that user's log rows older than 48 h (exactly 48 h kept), no other user's", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      await seedAuthUser(c, ENG2_UUID, ENG2_EMAIL);
      const id = await seedMonitor(c, ENG_UUID, { consecutiveErrors: ERROR_THRESHOLD });
      await seedLog(c, ENG_UUID, "change", 48 * 60 + 1);
      await seedLog(c, ENG_UUID, "error", 48 * 60);
      await seedLog(c, ENG2_UUID, "change", 48 * 60 + 1);
      expect((await record(c, id, "error"))[0]?.notify_error).toBe(true);
      expect(await logRows(c, ENG_UUID)).toEqual([{ kind: "error", minutes_ago: 0 }, { kind: "error", minutes_ago: 48 * 60 }]);
      expect(await logRows(c, ENG2_UUID)).toEqual([{ kind: "change", minutes_ago: 48 * 60 + 1 }]);
    });
  });

  it("ENG-AC6rec11: 22023 on invalid outcome", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await expectPgError(
        c,
        () => c.query(
          `SELECT * FROM public.monitor_engine_record('${randomUUID()}','https://x.com','bad_outcome',null,null,null,null,3,10,false)`,
        ),
        "22023",
      );
    });
  });

  it("ENG-AC6rec12: 22023 on p_error_threshold 0; after one failure, threshold 2 does not notify and 1 does", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      // One failure, counted by the claim.
      const id = await seedMonitor(c, ENG_UUID, { consecutiveErrors: 1 });
      const recordErrorSql = "SELECT * FROM public.monitor_engine_record($1,$2,'error',null,null,null,null,$3,10,false)";
      await expectPgError(c, () => c.query(recordErrorSql, [id, ENG_URL, 0]), "22023");
      expect((await c.query<RecordRow>(recordErrorSql, [id, ENG_URL, 2])).rows).toEqual([{ ...APPLIED, consecutive_errors: 1 }]);
      const { rows: nowRows } = await c.query<{ now: Date }>("SELECT now() AS now");
      const { rows } = await c.query<RecordRow>(recordErrorSql, [id, ENG_URL, 1]);
      expect(rows).toEqual([{
        applied: true, event_id: null, notify_error: true, notified_at: nowRows[0]!.now,
        email: ENG_EMAIL, url: ENG_URL, label: "Eng test", consecutive_errors: 1,
      }]);
    });
  });

  it("ENG-AC6rec15: p_daily_cap NULL or −1 → 22023 for every outcome (otherwise valid calls); 0 is accepted (an error at the threshold is then never notified)", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      const id = await seedMonitor(c, ENG_UUID, { lastHash: OLD_HASH, lastSnapshot: "kept", consecutiveErrors: ERROR_THRESHOLD });
      const sql = "SELECT * FROM public.monitor_engine_record($1,$2,$3,$4,$5,$6,null,3,$7,false)";
      // baseline / changed carry a new hash (changed also the stored one as expected), so the cap
      // is the only invalid argument.
      const calls: Array<[outcome: string, expectedHash: string | null, newHash: string | null, snapshot: string | null]> = [
        ["unchanged", null, null, null],
        ["baseline", null, NEW_HASH, "new"],
        ["changed", OLD_HASH, NEW_HASH, "new"],
        ["error", null, null, null],
      ];
      for (const [outcome, expectedHash, newHash, snapshot] of calls) {
        const args = [id, ENG_URL, outcome, expectedHash, newHash, snapshot];
        await expectPgError(c, () => c.query(sql, [...args, null]), "22023", `${outcome}, NULL cap`);
        await expectPgError(c, () => c.query(sql, [...args, -1]), "22023", `${outcome}, cap −1`);
      }
      // The same calls with cap 0 run (each undone again), so the 22023 above came from the cap.
      const accepted: Array<[string, boolean]> = [];
      for (const [outcome, expectedHash, newHash, snapshot] of calls) {
        await c.query("SAVEPOINT rec15");
        const { rows } = await c.query<RecordRow>(sql, [id, ENG_URL, outcome, expectedHash, newHash, snapshot, 0]);
        await c.query("ROLLBACK TO SAVEPOINT rec15");
        accepted.push([outcome, rows[0]?.applied ?? false]);
      }
      expect(accepted).toEqual([["unchanged", true], ["baseline", true], ["changed", true], ["error", true]]);
      expect(await eventsOf(c, id)).toEqual([]);

      expect(await record(c, id, "error", { dailyCap: 0 })).toEqual([{ ...APPLIED, consecutive_errors: ERROR_THRESHOLD }]);
      expect(await monitorState(c, id)).toEqual([
        { last_hash: OLD_HASH, last_snapshot: "kept", consecutive_errors: ERROR_THRESHOLD, error_notified_at: null },
      ]);
      expect(await logRows(c, ENG_UUID)).toEqual([]);
    });
  });

  it("ENG-AC6rec21: p_repay NULL or omitted (its default) → 22023 for every outcome (otherwise valid calls); true and false are accepted", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      const id = await seedMonitor(c, ENG_UUID, { lastHash: OLD_HASH, lastSnapshot: "kept", consecutiveErrors: ERROR_THRESHOLD });
      const withRepay = "SELECT * FROM public.monitor_engine_record($1,$2,$3,$4,$5,$6,null,3,10,$7)";
      const omitted = "SELECT * FROM public.monitor_engine_record($1,$2,$3,$4,$5,$6,null,3,10)";
      // baseline / changed carry a new hash (changed also the stored one as expected), so p_repay
      // is the only invalid argument.
      const calls: Array<[outcome: string, expectedHash: string | null, newHash: string | null, snapshot: string | null]> = [
        ["unchanged", null, null, null],
        ["baseline", null, NEW_HASH, "new"],
        ["changed", OLD_HASH, NEW_HASH, "new"],
        ["error", null, null, null],
      ];
      for (const [outcome, expectedHash, newHash, snapshot] of calls) {
        const args = [id, ENG_URL, outcome, expectedHash, newHash, snapshot];
        await expectPgError(c, () => c.query(withRepay, [...args, null]), "22023", `${outcome}, NULL p_repay`);
        await expectPgError(c, () => c.query(omitted, args), "22023", `${outcome}, p_repay omitted`);
      }
      // The same calls with p_repay true and false run (each undone again), so the 22023 above came
      // from p_repay.
      const accepted: Array<[string, boolean, boolean]> = [];
      for (const repay of [true, false]) {
        for (const [outcome, expectedHash, newHash, snapshot] of calls) {
          await c.query("SAVEPOINT rec21");
          const { rows } = await c.query<RecordRow>(withRepay, [id, ENG_URL, outcome, expectedHash, newHash, snapshot, repay]);
          await c.query("ROLLBACK TO SAVEPOINT rec21");
          accepted.push([outcome, repay, rows[0]?.applied ?? false]);
        }
      }
      expect(accepted).toEqual([
        ["unchanged", true, true], ["baseline", true, true], ["changed", true, true], ["error", true, true],
        ["unchanged", false, true], ["baseline", false, true], ["changed", false, true], ["error", false, true],
      ]);
    });
  });

  it.for(["baseline", "changed"])("ENG-AC6rec13: 22023 on %s without a new hash; nothing written", async (outcome, ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      const id = await seedMonitor(c, ENG_UUID, { lastHash: OLD_HASH, lastSnapshot: "kept" });
      await expectPgError(c, () => record(c, id, outcome, { expectedHash: OLD_HASH, snapshot: "new" }), "22023");
      expect(await monitorState(c, id)).toEqual([
        { last_hash: OLD_HASH, last_snapshot: "kept", consecutive_errors: 0, error_notified_at: null },
      ]);
    });
  });
});

// ── Claim order and per-user strikes (security rounds 2–4: S6, S6b, S6c, S6d, S6f) ──

describe("monitor_engine_claim + monitor_engine_record — ENG-AC2/ENG-AC3: claim order and per-user strikes", () => {
  // Fixed ids, so an id-ordered result cannot pass for the claim order: A* of ENG, B* of ENG2,
  // C* of ENG3, D1 of ENG4, E1 of ENG5.
  const A1 = "00000000-0000-0000-0000-00000000f0a1";
  const A2 = "00000000-0000-0000-0000-00000000f0a2";
  const B1 = "00000000-0000-0000-0000-00000000f0b1";
  const B2 = "00000000-0000-0000-0000-00000000f0b2";
  const B3 = "00000000-0000-0000-0000-00000000f0b3";
  const C1 = "00000000-0000-0000-0000-00000000f0c1";
  const C2 = "00000000-0000-0000-0000-00000000f0c2";
  const D1 = "00000000-0000-0000-0000-00000000f0d1";
  const E1 = "00000000-0000-0000-0000-00000000f0e1";

  const OLD_HASH = "v1:" + "e".repeat(64);
  const NEW_HASH = "v1:" + "f".repeat(64);

  /** The url of a monitor seeded by {@link seedDue}. */
  const urlOf = (id: string) => `https://example.com/eng-s6-${id.slice(-3)}`;

  /** Seeds ENG and ENG2 as monitor_user accounts without a monitor cap. */
  async function seedOwners(c: PoolClient): Promise<void> {
    await seedEngineUser(c);
    await seedAuthUser(c, ENG2_UUID, ENG2_EMAIL);
    await c.query("UPDATE public.profiles SET monitor_limit = NULL WHERE user_id IN ($1, $2)", [ENG_UUID, ENG2_UUID]);
  }

  /** Sets a monitor's last_checked_at `minutesAgo` before the transaction's now() (database clock). */
  async function setChecked(c: PoolClient, id: string, minutesAgo: number): Promise<void> {
    await c.query("UPDATE public.monitors SET last_checked_at = now() - make_interval(mins => $2) WHERE id = $1", [id, minutesAgo]);
  }

  /** Seeds an active 60-minute monitor (url {@link urlOf}) last checked `checkedMinutesAgo` ago: due from 55 on. */
  async function seedDue(c: PoolClient, userId: string, id: string, checkedMinutesAgo: number): Promise<void> {
    await seedMonitor(c, userId, { id, url: urlOf(id) });
    await setChecked(c, id, checkedMinutesAgo);
  }

  /**
   * monitor_engine_record with the file's threshold and daily cap, no snapshot or summary: the
   * `applied` column. `repay` is p_repay; where the test claimed the monitor it is what the run
   * passes, that claim's prior_strikes > 0.
   */
  async function recordApplied(
    c: PoolClient,
    id: string,
    outcome: string,
    claimedUrl: string,
    repay: boolean,
    hashes: { expected?: string; new?: string } = {},
  ): Promise<boolean[]> {
    const { rows } = await c.query<{ applied: boolean }>(
      "SELECT applied FROM public.monitor_engine_record($1,$2,$3,$4,$5,null,null,$6,$7,$8)",
      [id, claimedUrl, outcome, hashes.expected ?? null, hashes.new ?? null, ERROR_THRESHOLD, DAILY_CAP, repay],
    );
    return rows.map((row) => row.applied);
  }

  it("ENG-AC2claim31: the claim returns its rows in claim order (oldest coalesce(last_checked_at, created_at) first, across users), not in id order", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedOwners(c);
      await neutraliseExistingMonitors(c);
      await seedDue(c, ENG2_UUID, B1, 100);
      await seedDue(c, ENG2_UUID, B2, 300);
      await seedDue(c, ENG2_UUID, B3, 200);
      // Never checked, created 250 minutes ago: between B2 and B3. Id order would be A1, B1, B2, B3.
      await seedMonitor(c, ENG_UUID, { id: A1, url: urlOf(A1), createdMinutesAgo: 250 });
      expect(await claimIds(c, 10)).toEqual([B2, A1, B3, B1]);
    });
  });

  // ENG2's three monitors and ENG3's C1 are older than ENG's two; ENG2's oldest (B2) has neither
  // the lowest nor the highest id. One monitor per owner with strikes (S6) would add the oldest of
  // EACH such owner; S6d takes one for all of them together, in queue order, whatever their strike
  // counts (ranking by strikes, as S6e did, would take the least struck owner's).
  it.for<[label: string, strikes: { eng: number; eng2: number; eng3: number }, c1CheckedAgo: number, limit: number, expected: string[]]>([
    ["nobody with strikes, limit 10: all six, oldest first", { eng: 0, eng2: 0, eng3: 0 }, 295, 10, [B2, C1, B3, B1, A1, A2]],
    ["ENG2 with strikes, limit 10: every monitor of the others, then ENG2's oldest", { eng: 0, eng2: 1, eng3: 0 }, 295, 10, [C1, A1, A2, B2]],
    ["ENG2 and ENG3 with strikes, limit 10: ENG's two, then only the older of B2 (300 min) and C1 (295 min)", { eng: 0, eng2: 1, eng3: 1 }, 295, 10, [A1, A2, B2]],
    ["ENG2 and ENG3 with strikes, limit 24 (Paid): still only B2", { eng: 0, eng2: 1, eng3: 1 }, 295, 24, [A1, A2, B2]],
    ["ENG2 and ENG3 with strikes, C1 the oldest (310 min), ENG3 with more (4 vs 1): ENG's two, then only C1", { eng: 0, eng2: 1, eng3: 4 }, 310, 10, [A1, A2, C1]],
    ["ENG2 and ENG3 with strikes, B2 the oldest (C1 295 min), ENG2 with more (4 vs 1): ENG's two, then only B2", { eng: 0, eng2: 4, eng3: 1 }, 295, 10, [A1, A2, B2]],
    ["ENG2 and ENG3 with strikes, B2 and C1 equally old (300 min): ENG's two, then only the lower id, B2", { eng: 0, eng2: 1, eng3: 1 }, 300, 10, [A1, A2, B2]],
    ["all three with strikes, ENG with the fewest (1 vs 2), limit 10: only the oldest monitor of all, B2", { eng: 1, eng2: 2, eng3: 2 }, 295, 10, [B2]],
    ["all three with strikes, limit 40: still only B2", { eng: 1, eng2: 2, eng3: 2 }, 295, 40, [B2]],
    ["all three with strikes, limit 2: only B2, though room for two", { eng: 1, eng2: 2, eng3: 2 }, 295, 2, [B2]],
    ["ENG2 and ENG3 with strikes, limit 3: their one monitor just fits", { eng: 0, eng2: 1, eng3: 1 }, 295, 3, [A1, A2, B2]],
    ["ENG2 and ENG3 with strikes, limit 2: their older monitors wait behind ENG's newer ones", { eng: 0, eng2: 1, eng3: 1 }, 295, 2, [A1, A2]],
    ["nobody with strikes, limit 2: the two oldest", { eng: 0, eng2: 0, eng3: 0 }, 295, 2, [B2, C1]],
  ])("ENG-AC3strike1: owners with strikes get one monitor per batch together (at limits 2, 3, 10, 24 and 40), the oldest due one of all of theirs, then lowest id, whatever their strike counts, after every monitor of the owners without, who get all of theirs — %s", async ([, strikes, c1CheckedAgo, limit, expected], ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedOwners(c);
      await seedAuthUser(c, ENG3_UUID, ENG3_EMAIL);
      await neutraliseExistingMonitors(c);
      await seedStrikes(c, ENG_UUID, strikes.eng);
      await seedStrikes(c, ENG2_UUID, strikes.eng2);
      await seedStrikes(c, ENG3_UUID, strikes.eng3);
      await seedDue(c, ENG2_UUID, B1, 280);
      await seedDue(c, ENG2_UUID, B2, 300);
      await seedDue(c, ENG2_UUID, B3, 290);
      await seedDue(c, ENG3_UUID, C1, c1CheckedAgo);
      await seedDue(c, ENG_UUID, A1, 200);
      await seedDue(c, ENG_UUID, A2, 100);
      expect(await claimIds(c, limit)).toEqual(expected);
    });
  });

  it("ENG-AC3strike2: the claim adds one strike per leased monitor to its owner, on top of earlier strikes, and returns each owner's count from before it (0 for both of ENG's monitors, 3 for ENG2's); an owner with nothing leased keeps theirs", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    const seed = async (c: PoolClient) => {
      await seedOwners(c);
      await seedAuthUser(c, ENG3_UUID, ENG3_EMAIL);
      await neutraliseExistingMonitors(c);
      await seedStrikes(c, ENG2_UUID, 3);
      await seedStrikes(c, ENG3_UUID, 2);
      await seedDue(c, ENG_UUID, A1, 200);
      await seedDue(c, ENG_UUID, A2, 100);
      await seedDue(c, ENG2_UUID, B1, 300);
      await seedDue(c, ENG2_UUID, B2, 290);
      // Checked 54 minutes ago: one minute short of due.
      await seedDue(c, ENG3_UUID, C1, 54);
    };
    await withTx(client, async (c) => {
      await seed(c);
      expect(await claimRows(c, 10)).toEqual([
        { id: A1, prior_strikes: 0 },
        { id: A2, prior_strikes: 0 },
        { id: B1, prior_strikes: 3 },
      ]);
      expect(await strikeRows(c, ENG_UUID)).toEqual([{ strikes: 2, touched: true }]);
      expect(await strikeRows(c, ENG2_UUID)).toEqual([{ strikes: 4, touched: true }]);
      expect(await strikeRows(c, ENG3_UUID)).toEqual([{ strikes: 2, touched: false }]);
    });
    // Only what the limit lets through counts: ENG2's monitor waits, so its strikes stay.
    await withTx(client, async (c) => {
      await seed(c);
      expect(await claimRows(c, 1)).toEqual([{ id: A1, prior_strikes: 0 }]);
      expect(await strikeRows(c, ENG_UUID)).toEqual([{ strikes: 1, touched: true }]);
      expect(await strikeRows(c, ENG2_UUID)).toEqual([{ strikes: 3, touched: false }]);
    });
  });

  it.for<[label: string, outcome: string, claimedUrl: string, hashes: { expected?: string; new?: string },
    status: "active" | "paused", applied: boolean, leftWithRepay: number, leftWithoutRepay: number]>([
    ["unchanged, applied: two off with p_repay, one without", "unchanged", ENG_URL, {}, "active", true, 1, 2],
    ["baseline, applied: two off with p_repay, one without", "baseline", ENG_URL, { new: NEW_HASH }, "active", true, 1, 2],
    ["changed, applied: two off with p_repay, one without", "changed", ENG_URL, { expected: OLD_HASH, new: NEW_HASH }, "active", true, 1, 2],
    ["error, applied: one off either way", "error", ENG_URL, {}, "active", true, 2, 2],
    ["unchanged for a url edited mid-check, not applied: one off either way", "unchanged", `${ENG_URL}-old`, {}, "active", false, 2, 2],
    ["baseline for a url edited mid-check, not applied: one off either way", "baseline", `${ENG_URL}-old`, { new: NEW_HASH }, "active", false, 2, 2],
    ["error for a url edited mid-check, not applied: one off either way", "error", `${ENG_URL}-old`, {}, "active", false, 2, 2],
    ["changed with a moved stored hash, not applied: one off either way", "changed", ENG_URL, { expected: "v1:" + "0".repeat(64), new: NEW_HASH }, "active", false, 2, 2],
    ["changed on a monitor paused mid-check, not applied: one off either way", "changed", ENG_URL, { expected: OLD_HASH, new: NEW_HASH }, "paused", false, 2, 2],
  ])("ENG-AC3strike3: a record takes two strikes off the monitor's owner only after an applied unchanged/baseline/changed with p_repay (3 → 1), one after the same without p_repay, an error or a result not applied (3 → 2), none off another owner — %s", async ([, outcome, claimedUrl, hashes, status, applied, leftWithRepay, leftWithoutRepay], ctx) => {
    if (!ensureFunctions(ctx)) return;
    for (const [repay, left] of [[true, leftWithRepay], [false, leftWithoutRepay]] as const) {
      await withTx(client, async (c) => {
        await seedOwners(c);
        await seedStrikes(c, ENG_UUID, 3);
        await seedStrikes(c, ENG2_UUID, 3);
        const id = await seedMonitor(c, ENG_UUID, { status, lastHash: OLD_HASH });
        expect(await recordApplied(c, id, outcome, claimedUrl, repay, hashes), `p_repay ${repay}`).toEqual([applied]);
        expect(await strikeRows(c, ENG_UUID), `p_repay ${repay}`).toEqual([{ strikes: left, touched: true }]);
        expect(await strikeRows(c, ENG2_UUID), `p_repay ${repay}`).toEqual([{ strikes: 3, touched: false }]);
      });
    }
  });

  it.for<[label: string, outcome: "unchanged" | "error", repay: boolean, seeded: number | null, after: Array<{ strikes: number; touched: boolean }>]>([
    ["good record with p_repay on 2 strikes → 0", "unchanged", true, 2, [{ strikes: 0, touched: true }]],
    ["good record with p_repay on 1 strike → 0, not −1", "unchanged", true, 1, [{ strikes: 0, touched: true }]],
    ["good record without p_repay on 1 strike → 0", "unchanged", false, 1, [{ strikes: 0, touched: true }]],
    ["error record with p_repay on 1 strike → 0", "error", true, 1, [{ strikes: 0, touched: true }]],
    ["good record with p_repay on 0 strikes → stays 0, the row is not written", "unchanged", true, 0, [{ strikes: 0, touched: false }]],
    ["error record with p_repay on 0 strikes → stays 0, the row is not written", "error", true, 0, [{ strikes: 0, touched: false }]],
    ["good record with p_repay without a strike row → none is created", "unchanged", true, null, []],
    ["error record with p_repay without a strike row → none is created", "error", true, null, []],
  ])("ENG-AC3strike4: a record never takes strikes below 0 — %s", async ([, outcome, repay, seeded, after], ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      if (seeded !== null) await seedStrikes(c, ENG_UUID, seeded);
      const id = await seedMonitor(c, ENG_UUID);
      expect(await recordApplied(c, id, outcome, ENG_URL, repay)).toEqual([true]);
      expect(await strikeRows(c, ENG_UUID)).toEqual(after);
    });
  });

  it("ENG-AC3strike5: a record for a monitor deleted mid-check finds no owner, so its strike stays until a good check from a later claim repays it", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedOwners(c);
      await neutraliseExistingMonitors(c);
      await seedDue(c, ENG_UUID, A1, 300);
      // Checked 54 minutes ago: one minute short of due.
      await seedDue(c, ENG_UUID, A2, 54);
      expect(await claimRows(c, 10)).toEqual([{ id: A1, prior_strikes: 0 }]);
      expect(await strikeRows(c, ENG_UUID)).toEqual([{ strikes: 1, touched: true }]);

      // The owner deletes A1 while it is checked: its record finds neither the monitor nor its owner.
      await asRole(c, "authenticated", ENG_CLAIMS);
      const deleted = await c.query("DELETE FROM public.monitors WHERE id = $1", [A1]);
      await c.query("RESET ROLE");
      expect(deleted.rowCount).toBe(1);
      expect(await recordApplied(c, A1, "unchanged", urlOf(A1), false)).toEqual([false]);
      expect(await strikeRows(c, ENG_UUID)).toEqual([{ strikes: 1, touched: true }]);

      // The owner's next claim finds that strike (prior_strikes 1, so p_repay): its good check
      // takes off its own claim's strike and the one left.
      await setChecked(c, A2, 300);
      expect(await claimRows(c, 10)).toEqual([{ id: A2, prior_strikes: 1 }]);
      expect(await strikeRows(c, ENG_UUID)).toEqual([{ strikes: 2, touched: true }]);
      expect(await recordApplied(c, A2, "baseline", urlOf(A2), true, { new: NEW_HASH })).toEqual([true]);
      expect(await strikeRows(c, ENG_UUID)).toEqual([{ strikes: 0, touched: true }]);
    });
  });

  it("ENG-AC3strike6: killed run — the monitor the run died on and those after it keep their owner's strikes, and the next claim puts that owner last with one monitor", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedOwners(c);
      await neutraliseExistingMonitors(c);
      await seedDue(c, ENG_UUID, A1, 400);
      await seedDue(c, ENG_UUID, A2, 390);
      await seedDue(c, ENG2_UUID, B1, 300);
      await seedDue(c, ENG2_UUID, B2, 290);
      expect(await claimRows(c, 10)).toEqual([
        { id: A1, prior_strikes: 0 },
        { id: A2, prior_strikes: 0 },
        { id: B1, prior_strikes: 0 },
        { id: B2, prior_strikes: 0 },
      ]);
      // The run records A1 and A2 (p_repay false), then dies on B1: no record for B1 or for B2 after it.
      for (const id of [A1, A2]) expect(await recordApplied(c, id, "baseline", urlOf(id), false, { new: NEW_HASH })).toEqual([true]);
      expect(await strikeRows(c, ENG_UUID)).toEqual([{ strikes: 0, touched: true }]);
      expect(await strikeRows(c, ENG2_UUID)).toEqual([{ strikes: 2, touched: true }]);

      // All due again, ENG2's monitors now the oldest: without the strikes B1, B2, A1, A2.
      await setChecked(c, B1, 500);
      await setChecked(c, B2, 490);
      await setChecked(c, A1, 200);
      await setChecked(c, A2, 190);
      expect(await claimRows(c, 10)).toEqual([
        { id: A1, prior_strikes: 0 },
        { id: A2, prior_strikes: 0 },
        { id: B1, prior_strikes: 2 },
      ]);
      expect(await strikeRows(c, ENG2_UUID)).toEqual([{ strikes: 3, touched: true }]);
    });
  });

  it("ENG-AC3strike7: the owner's url edit and deleting + re-creating a monitor leave their strikes, so their monitor still sorts last", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedOwners(c);
      await neutraliseExistingMonitors(c);
      await seedStrikes(c, ENG_UUID, 2);
      await seedDue(c, ENG_UUID, A1, 300);
      await seedDue(c, ENG2_UUID, B1, 100);

      await asRole(c, "authenticated", ENG_CLAIMS);
      const edited = await c.query("UPDATE public.monitors SET url = 'https://example.com/eng-s6-moved' WHERE id = $1", [A1]);
      await c.query("RESET ROLE");
      expect(edited.rowCount).toBe(1);
      expect(await strikeRows(c, ENG_UUID)).toEqual([{ strikes: 2, touched: false }]);
      // ENG's older monitor still goes after ENG2's newer one. The run then records both as good
      // checks: B1's owner had no strikes before the claim, so only B1's own goes (ENG2 1 → 0); A1's
      // had 2, so its own and one of those go (ENG 3 → 1).
      expect(await claimRows(c, 10)).toEqual([{ id: B1, prior_strikes: 0 }, { id: A1, prior_strikes: 2 }]);
      expect(await recordApplied(c, B1, "baseline", urlOf(B1), false, { new: NEW_HASH })).toEqual([true]);
      expect(await recordApplied(c, A1, "baseline", "https://example.com/eng-s6-moved", true, { new: NEW_HASH })).toEqual([true]);
      expect(await strikeRows(c, ENG_UUID)).toEqual([{ strikes: 1, touched: true }]);
      expect(await strikeRows(c, ENG2_UUID)).toEqual([{ strikes: 0, touched: true }]);

      await asRole(c, "authenticated", ENG_CLAIMS);
      const deleted = await c.query("DELETE FROM public.monitors WHERE id = $1", [A1]);
      const { rows: created } = await c.query<{ id: string }>(
        `INSERT INTO public.monitors (user_id, url, label, interval_minutes, status)
         VALUES ($1, 'https://example.com/eng-s6-moved', null, 60, 'active') RETURNING id`,
        [ENG_UUID],
      );
      await c.query("RESET ROLE");
      expect(deleted.rowCount).toBe(1);
      const recreated = created[0]!.id;
      expect(await strikeRows(c, ENG_UUID)).toEqual([{ strikes: 1, touched: true }]);
      // Make the re-created monitor the oldest due one: it still goes last.
      await setChecked(c, recreated, 500);
      await setChecked(c, B1, 100);
      expect(await claimRows(c, 10)).toEqual([{ id: B1, prior_strikes: 0 }, { id: recreated, prior_strikes: 1 }]);
      expect(await strikeRows(c, ENG_UUID)).toEqual([{ strikes: 2, touched: true }]);
    });
  });

  it("ENG-AC3strike8: a healthy account hit once recovers — 1 strike, claim (+1, prior_strikes 1), good record with p_repay (−2) → 0, and its next claim neither sorts it last nor holds it to one monitor", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedOwners(c);
      await neutraliseExistingMonitors(c);
      await seedStrikes(c, ENG_UUID, 1);
      await seedDue(c, ENG_UUID, A1, 300);
      await seedDue(c, ENG_UUID, A2, 290);
      await seedDue(c, ENG2_UUID, B1, 100);
      // Struck: ENG's oldest due monitor only, after ENG2's newer one.
      expect(await claimRows(c, 10)).toEqual([{ id: B1, prior_strikes: 0 }, { id: A1, prior_strikes: 1 }]);
      expect(await strikeRows(c, ENG_UUID)).toEqual([{ strikes: 2, touched: true }]);
      expect(await recordApplied(c, B1, "baseline", urlOf(B1), false, { new: NEW_HASH })).toEqual([true]);
      expect(await recordApplied(c, A1, "baseline", urlOf(A1), true, { new: NEW_HASH })).toEqual([true]);
      expect(await strikeRows(c, ENG_UUID)).toEqual([{ strikes: 0, touched: true }]);
      expect(await strikeRows(c, ENG2_UUID)).toEqual([{ strikes: 0, touched: true }]);

      // All due again (A2 still from before): plain age order, both of ENG's monitors.
      await setChecked(c, A1, 200);
      await setChecked(c, B1, 100);
      expect(await claimRows(c, 10)).toEqual([
        { id: A2, prior_strikes: 0 },
        { id: A1, prior_strikes: 0 },
        { id: B1, prior_strikes: 0 },
      ]);
      expect(await strikeRows(c, ENG_UUID)).toEqual([{ strikes: 2, touched: true }]);
    });
  });

  it("ENG-AC3strike9: an account whose checks keep dying gains a strike with every claim it never records and stays last with one monitor per batch; one good check then takes off only one", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedOwners(c);
      await neutraliseExistingMonitors(c);
      // ENG's two monitors are the oldest; ENG2's are recorded (good) in every run, ENG's never.
      const allDue = async () => {
        await setChecked(c, A1, 400);
        await setChecked(c, A2, 390);
        await setChecked(c, B1, 300);
        await setChecked(c, B2, 290);
      };
      await seedDue(c, ENG_UUID, A1, 400);
      await seedDue(c, ENG_UUID, A2, 390);
      await seedDue(c, ENG2_UUID, B1, 300);
      await seedDue(c, ENG2_UUID, B2, 290);
      // ENG2 has no strikes before any of these claims: its good records take off only their own.
      const recordEng2 = async () => {
        for (const id of [B1, B2]) expect(await recordApplied(c, id, "baseline", urlOf(id), false, { new: NEW_HASH })).toEqual([true]);
      };

      expect(await claimRows(c, 10)).toEqual([
        { id: A1, prior_strikes: 0 },
        { id: A2, prior_strikes: 0 },
        { id: B1, prior_strikes: 0 },
        { id: B2, prior_strikes: 0 },
      ]);
      await recordEng2();
      expect(await strikeRows(c, ENG_UUID)).toEqual([{ strikes: 2, touched: true }]);
      expect(await strikeRows(c, ENG2_UUID)).toEqual([{ strikes: 0, touched: true }]);
      for (const strikes of [3, 4]) {
        await allDue();
        expect(await claimRows(c, 10)).toEqual([
          { id: B1, prior_strikes: 0 },
          { id: B2, prior_strikes: 0 },
          { id: A1, prior_strikes: strikes - 1 },
        ]);
        await recordEng2();
        expect(await strikeRows(c, ENG_UUID)).toEqual([{ strikes, touched: true }]);
        expect(await strikeRows(c, ENG2_UUID)).toEqual([{ strikes: 0, touched: true }]);
      }

      // One good check of ENG (prior_strikes 4, so p_repay): its own claim's strike and one from
      // before (5 → 3), still last.
      await allDue();
      expect(await claimRows(c, 10)).toEqual([
        { id: B1, prior_strikes: 0 },
        { id: B2, prior_strikes: 0 },
        { id: A1, prior_strikes: 4 },
      ]);
      await recordEng2();
      expect(await recordApplied(c, A1, "baseline", urlOf(A1), true, { new: NEW_HASH })).toEqual([true]);
      expect(await strikeRows(c, ENG_UUID)).toEqual([{ strikes: 3, touched: true }]);
      await allDue();
      expect(await claimIds(c, 10)).toEqual([B1, B2, A1]);
      expect(await strikeRows(c, ENG_UUID)).toEqual([{ strikes: 4, touched: true }]);
    });
  });

  it("ENG-AC3strike10: a good check never repays a strike of its own claim — the owner's good check H, leased with their killing page P in one claim (no strikes before), leaves P's strike (0 → 2 → 1), so the next claim puts that owner last with one monitor; that claim's good check (p_repay) repays it (1 → 2 → 0)", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedOwners(c);
      await neutraliseExistingMonitors(c);
      // ENG2's B1, then ENG's H (A1) before P (A2): nobody has strikes, so plain age order.
      await seedDue(c, ENG2_UUID, B1, 400);
      await seedDue(c, ENG_UUID, A1, 300);
      await seedDue(c, ENG_UUID, A2, 290);
      expect(await claimRows(c, 10)).toEqual([
        { id: B1, prior_strikes: 0 },
        { id: A1, prior_strikes: 0 },
        { id: A2, prior_strikes: 0 },
      ]);
      expect(await strikeRows(c, ENG_UUID)).toEqual([{ strikes: 2, touched: true }]);
      // The run records B1 and H as good checks (p_repay false), then P kills it: no record for P.
      expect(await recordApplied(c, B1, "baseline", urlOf(B1), false, { new: NEW_HASH })).toEqual([true]);
      expect(await recordApplied(c, A1, "baseline", urlOf(A1), false, { new: NEW_HASH })).toEqual([true]);
      expect(await strikeRows(c, ENG_UUID)).toEqual([{ strikes: 1, touched: true }]);
      expect(await strikeRows(c, ENG2_UUID)).toEqual([{ strikes: 0, touched: true }]);

      // All due again, ENG's now the oldest: without the strike A1, A2, B1. ENG goes last with
      // its oldest due monitor only.
      await setChecked(c, A1, 200);
      await setChecked(c, A2, 190);
      await setChecked(c, B1, 100);
      expect(await claimRows(c, 10)).toEqual([{ id: B1, prior_strikes: 0 }, { id: A1, prior_strikes: 1 }]);
      expect(await strikeRows(c, ENG_UUID)).toEqual([{ strikes: 2, touched: true }]);
      expect(await recordApplied(c, B1, "baseline", urlOf(B1), false, { new: NEW_HASH })).toEqual([true]);
      expect(await recordApplied(c, A1, "baseline", urlOf(A1), true, { new: NEW_HASH })).toEqual([true]);
      expect(await strikeRows(c, ENG_UUID)).toEqual([{ strikes: 0, touched: true }]);

      // Repaid: plain age order again, both of ENG's monitors.
      await setChecked(c, A1, 200);
      await setChecked(c, A2, 190);
      await setChecked(c, B1, 100);
      expect(await claimRows(c, 10)).toEqual([
        { id: A1, prior_strikes: 0 },
        { id: A2, prior_strikes: 0 },
        { id: B1, prior_strikes: 0 },
      ]);
    });
  });

  it.for([10, 40])("ENG-AC3strike11 at limit %i: two owners on equal intervals, the killing page K (ENG) first by id — K's kill leaves V (ENG2) unchecked and strikes both owners; V is never leased with K while ENG2 has strikes (one slot for all owners with strikes) and gains no further provisional failure, and it is checked within two claims (K's lease moves K behind it); from then on V precedes K, whose repeated kills cost it nothing; C1 (ENG3, no strikes) keeps its normal share", async (limit, ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedOwners(c);
      await seedAuthUser(c, ENG3_UUID, ENG3_EMAIL);
      await neutraliseExistingMonitors(c);
      // K = A1 and V = B1: 60-minute monitors last checked at the same moment, so K (the lower id)
      // goes first. C1, checked earlier, is checked before K in the first claim.
      await seedDue(c, ENG_UUID, A1, 120);
      await seedDue(c, ENG2_UUID, B1, 120);
      await seedDue(c, ENG3_UUID, C1, 130);
      /**
       * A day passes: the three last_checked_at move 1440 minutes back (now() is fixed inside the
       * transaction), so each monitor is due again whatever its backoff (at most 60 × 16 = 960
       * minutes) and keeps its place in the queue.
       */
      const nextDay = async () => {
        await c.query(
          "UPDATE public.monitors SET last_checked_at = last_checked_at - interval '1440 minutes' WHERE id = ANY($1::uuid[])",
          [[A1, B1, C1]],
        );
      };
      /** consecutive_errors of K, V and C1, and the strikes of ENG, ENG2 and ENG3. */
      const state = async () => {
        const { rows } = await c.query<{ k: number; v: number; c1: number; eng: number; eng2: number; eng3: number }>(
          `SELECT (SELECT consecutive_errors FROM public.monitors WHERE id = $1) AS k,
                  (SELECT consecutive_errors FROM public.monitors WHERE id = $2) AS v,
                  (SELECT consecutive_errors FROM public.monitors WHERE id = $3) AS c1,
                  (SELECT strikes FROM public.monitor_engine_strikes WHERE user_id = $4) AS eng,
                  (SELECT strikes FROM public.monitor_engine_strikes WHERE user_id = $5) AS eng2,
                  (SELECT strikes FROM public.monitor_engine_strikes WHERE user_id = $6) AS eng3`,
          [A1, B1, C1, ENG_UUID, ENG2_UUID, ENG3_UUID],
        );
        return rows[0];
      };
      /** Records a good check (unchanged) of a claimed monitor with the run's p_repay. */
      const good = async (id: string, repay: boolean) => {
        expect(await recordApplied(c, id, "unchanged", urlOf(id), repay), id).toEqual([true]);
      };

      // Claim 1, nobody with strikes: plain age order. The run records C1, then dies on K: neither K
      // nor V after it is recorded, so both keep the provisional failure and strike their owners.
      expect(await claimRows(c, limit)).toEqual([
        { id: C1, prior_strikes: 0 },
        { id: A1, prior_strikes: 0 },
        { id: B1, prior_strikes: 0 },
      ]);
      await good(C1, false);
      expect(await state()).toEqual({ k: 1, v: 1, c1: 0, eng: 1, eng2: 1, eng3: 0 });

      // Claim 2: K and V share the one slot and their queue time (claim 1 stamped both), so K, the
      // lower id, goes alone, after C1. K kills again; V, not leased, gains no provisional failure.
      await nextDay();
      expect(await claimRows(c, limit)).toEqual([{ id: C1, prior_strikes: 0 }, { id: A1, prior_strikes: 1 }]);
      await good(C1, false);
      expect(await state()).toEqual({ k: 2, v: 1, c1: 0, eng: 2, eng2: 1, eng3: 0 });

      // Claim 3: K's lease moved it behind V (stamped by claim 1, V is now the older), so V takes
      // the slot (again not with K); its good check (prior_strikes 1, so p_repay) repays ENG2
      // (1 + 1 − 2 = 0) and ends its failure.
      await nextDay();
      expect(await claimRows(c, limit)).toEqual([{ id: C1, prior_strikes: 0 }, { id: B1, prior_strikes: 1 }]);
      await good(C1, false);
      await good(B1, true);
      expect(await state()).toEqual({ k: 2, v: 0, c1: 0, eng: 2, eng2: 0, eng3: 0 });

      // Claims 4–6: ENG2 is back at 0, so V comes with C1 (equally old: the lower id first) before
      // K, the batch's last check. K kills every run; V and C1 are recorded every time.
      for (const engStrikes of [3, 4, 5]) {
        await nextDay();
        expect(await claimRows(c, limit), `ENG at ${engStrikes - 1}`).toEqual([
          { id: B1, prior_strikes: 0 },
          { id: C1, prior_strikes: 0 },
          { id: A1, prior_strikes: engStrikes - 1 },
        ]);
        await good(B1, false);
        await good(C1, false);
        expect(await state(), `ENG at ${engStrikes - 1}`).toEqual({ k: engStrikes, v: 0, c1: 0, eng: engStrikes, eng2: 0, eng3: 0 });
      }
    });
  });

  it.for([10, 40])("ENG-AC3strike12 at limit %i: owners with strikes drain one monitor per claim together, the oldest due one first whatever their strike counts (ENG2's B1 with 2 before ENG3's C1 with 1), and ENG2's two due monitors never share a claim; after the batch's monitors of owners without strikes; an older monitor still backed off takes no slot", async (limit, ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedOwners(c);
      await seedAuthUser(c, ENG3_UUID, ENG3_EMAIL);
      await neutraliseExistingMonitors(c);
      await seedStrikes(c, ENG2_UUID, 2);
      await seedStrikes(c, ENG3_UUID, 1);
      await seedDue(c, ENG2_UUID, B1, 300);
      await seedDue(c, ENG3_UUID, C1, 290);
      await seedDue(c, ENG2_UUID, B2, 280);
      // The oldest of all, but 6 failures back it off to 960 minutes: not due, so it is not ranked.
      await seedMonitor(c, ENG2_UUID, { id: B3, url: urlOf(B3), consecutiveErrors: 6 });
      await setChecked(c, B3, 400);
      await seedDue(c, ENG_UUID, A1, 100);
      // No record in between: each claim's leases stay (now() is fixed inside the transaction), so
      // the next claim takes the next due monitor of an owner with strikes, oldest first.
      expect(await claimRows(c, limit)).toEqual([{ id: A1, prior_strikes: 0 }, { id: B1, prior_strikes: 2 }]);
      expect(await claimRows(c, limit)).toEqual([{ id: C1, prior_strikes: 1 }]);
      expect(await claimRows(c, limit)).toEqual([{ id: B2, prior_strikes: 3 }]);
      expect(await claimRows(c, limit)).toEqual([]);
      expect(await strikeRows(c, ENG_UUID)).toEqual([{ strikes: 1, touched: true }]);
      expect(await strikeRows(c, ENG2_UUID)).toEqual([{ strikes: 4, touched: true }]);
      expect(await strikeRows(c, ENG3_UUID)).toEqual([{ strikes: 2, touched: true }]);
    });
  });

  // Owners with different strike counts. Their due monitors in queue order: ENG5's E1 (5 strikes,
  // 500 min: the oldest of all, the most struck owner), ENG4's D1 (2, 400 min), ENG2's B2 (3, 310
  // min) and B1 (3, 300 min), ENG3's C2 (1, 260 min) and C1 (1, 250 min). ENG's A1 (200 min) and
  // A2 (100 min) have no strikes. Ranking by strikes (S6e) would take C2 first, and more than one
  // from limit 20 on.
  it.for<[label: string, withoutStrikes: boolean, limit: number, expected: string[]]>([
    ["limit 2 (Free): ENG's two fill the batch", true, 2, [A1, A2]],
    ["limit 2 (Free) with no monitor of an owner without strikes: only E1, though room for two", false, 2, [E1]],
    ["limit 3: E1, after ENG's two", true, 3, [A1, A2, E1]],
    ["limit 10: only E1", true, 10, [A1, A2, E1]],
    ["limit 20: only E1", true, 20, [A1, A2, E1]],
    ["limit 24 (Paid): only E1", true, 24, [A1, A2, E1]],
    ["limit 40 with no monitor of an owner without strikes: only E1, though room for all six", false, 40, [E1]],
    ["limit 60: only E1", true, 60, [A1, A2, E1]],
  ])("ENG-AC3strike14: several owners with different strike counts get exactly one monitor together at every limit, the oldest due one of all of theirs (ENG5's E1, though the most struck), last, after every monitor of ENG (no strikes) — %s", async ([, withoutStrikes, limit, expected], ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedOwners(c);
      await seedAuthUser(c, ENG3_UUID, ENG3_EMAIL);
      await seedAuthUser(c, ENG4_UUID, ENG4_EMAIL);
      await seedAuthUser(c, ENG5_UUID, ENG5_EMAIL);
      await neutraliseExistingMonitors(c);
      await seedStrikes(c, ENG3_UUID, 1);
      await seedStrikes(c, ENG4_UUID, 2);
      await seedStrikes(c, ENG2_UUID, 3);
      await seedStrikes(c, ENG5_UUID, 5);
      await seedDue(c, ENG3_UUID, C1, 250);
      await seedDue(c, ENG3_UUID, C2, 260);
      await seedDue(c, ENG4_UUID, D1, 400);
      await seedDue(c, ENG2_UUID, B1, 300);
      await seedDue(c, ENG2_UUID, B2, 310);
      await seedDue(c, ENG5_UUID, E1, 500);
      if (withoutStrikes) {
        await seedDue(c, ENG_UUID, A1, 200);
        await seedDue(c, ENG_UUID, A2, 100);
      }
      const prior: Record<string, number> = { [A1]: 0, [A2]: 0, [E1]: 5 };
      expect(await claimRows(c, limit)).toEqual(expected.map((id) => ({ id, prior_strikes: prior[id] })));
    });
  });

  it("ENG-AC3strike15: at limit 24 (Paid) the owners with strikes still get one monitor per claim — the killing page K (ENG5, 3 strikes), the oldest, takes the slot first and kills again; its lease moves it behind V1 (ENG2) and V2 (ENG3), left unchecked by an earlier kill of it (1 strike each, equally old), which take the slot one claim each, the lower id first, each good check repaying its owner; then they come in plain order and K is the batch's last check", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedOwners(c);
      await seedAuthUser(c, ENG3_UUID, ENG3_EMAIL);
      await seedAuthUser(c, ENG5_UUID, ENG5_EMAIL);
      await neutraliseExistingMonitors(c);
      // K = E1 (ENG5) has killed runs before: 3 strikes. V1 = B1 (ENG2) and V2 = C1 (ENG3) were
      // left unchecked by one of its kills: 1 strike each. K is the oldest of the three.
      await seedStrikes(c, ENG5_UUID, 3);
      await seedStrikes(c, ENG2_UUID, 1);
      await seedStrikes(c, ENG3_UUID, 1);
      await seedDue(c, ENG5_UUID, E1, 200);
      await seedDue(c, ENG2_UUID, B1, 120);
      await seedDue(c, ENG3_UUID, C1, 120);
      await seedDue(c, ENG_UUID, A1, 100);
      const strikes = async () => {
        const { rows } = await c.query<{ eng: number; eng2: number; eng3: number; eng5: number }>(
          `SELECT (SELECT strikes FROM public.monitor_engine_strikes WHERE user_id = $1) AS eng,
                  (SELECT strikes FROM public.monitor_engine_strikes WHERE user_id = $2) AS eng2,
                  (SELECT strikes FROM public.monitor_engine_strikes WHERE user_id = $3) AS eng3,
                  (SELECT strikes FROM public.monitor_engine_strikes WHERE user_id = $4) AS eng5`,
          [ENG_UUID, ENG2_UUID, ENG3_UUID, ENG5_UUID],
        );
        return rows[0];
      };
      /**
       * A day passes: the four last_checked_at move 1440 minutes back (now() is fixed inside the
       * transaction), so each monitor is due again whatever its backoff and keeps its place in the
       * queue.
       */
      const nextDay = async () => {
        await c.query(
          "UPDATE public.monitors SET last_checked_at = last_checked_at - interval '1440 minutes' WHERE id = ANY($1::uuid[])",
          [[A1, B1, C1, E1]],
        );
      };

      // Claim 1: A1 (no strikes), then only K, the oldest monitor of the owners with strikes. The
      // run records A1, then K kills it.
      expect(await claimRows(c, 24)).toEqual([{ id: A1, prior_strikes: 0 }, { id: E1, prior_strikes: 3 }]);
      expect(await recordApplied(c, A1, "unchanged", urlOf(A1), false)).toEqual([true]);
      expect(await strikes()).toEqual({ eng: 0, eng2: 1, eng3: 1, eng5: 4 });

      // Claim 2: K's lease moved it behind V1 and V2: V1, the lower id of the two, alone after A1.
      // Its good check (prior_strikes 1, so p_repay) repays ENG2 (1 + 1 − 2 = 0).
      await nextDay();
      expect(await claimRows(c, 24)).toEqual([{ id: A1, prior_strikes: 0 }, { id: B1, prior_strikes: 1 }]);
      expect(await recordApplied(c, A1, "unchanged", urlOf(A1), false)).toEqual([true]);
      expect(await recordApplied(c, B1, "unchanged", urlOf(B1), true)).toEqual([true]);
      expect(await strikes()).toEqual({ eng: 0, eng2: 0, eng3: 1, eng5: 4 });

      // Claim 3: V1 comes with A1 in plain order (equally old: the lower id first); V2, still older
      // than K, takes the slot and is repaid.
      await nextDay();
      expect(await claimRows(c, 24)).toEqual([
        { id: A1, prior_strikes: 0 },
        { id: B1, prior_strikes: 0 },
        { id: C1, prior_strikes: 1 },
      ]);
      for (const id of [A1, B1]) expect(await recordApplied(c, id, "unchanged", urlOf(id), false), id).toEqual([true]);
      expect(await recordApplied(c, C1, "unchanged", urlOf(C1), true)).toEqual([true]);
      expect(await strikes()).toEqual({ eng: 0, eng2: 0, eng3: 0, eng5: 4 });

      // Claim 4: V1 and V2 come with A1 in plain order, and K is the batch's last check.
      await nextDay();
      expect(await claimRows(c, 24)).toEqual([
        { id: A1, prior_strikes: 0 },
        { id: B1, prior_strikes: 0 },
        { id: C1, prior_strikes: 0 },
        { id: E1, prior_strikes: 4 },
      ]);
    });
  });
});

// ── monitor_engine_pending_emails ─────────────────────────────────────────────

describe("monitor_engine_pending_emails — ENG-AC4", () => {
  /**
   * The event ids pending_emails(500, dailyCap) returns for one monitor, in its order. 500 is the
   * largest limit: pending events of other users on the shared project would have to fill all of
   * it to push the seeded ones out.
   */
  async function pendingIds(c: PoolClient, monitorId: string, dailyCap: number): Promise<string[]> {
    const { rows } = await c.query<{ event_id: string }>(
      "SELECT event_id FROM public.monitor_engine_pending_emails(500, $2) WHERE monitor_id = $1",
      [monitorId, dailyCap],
    );
    return rows.map((r) => r.event_id);
  }

  it("ENG-AC4pend1: returns an unemailed event within the 23 h window with the email's fields", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      const monitorId = await seedMonitor(c, ENG_UUID, { url: "https://example.com/pend1" });
      const eventId = await seedEvent(c, monitorId, ENG_UUID);
      const { rows: nowRows } = await c.query<{ now: Date }>("SELECT now() AS now");
      const { rows } = await c.query(
        "SELECT * FROM public.monitor_engine_pending_emails(500, 10) WHERE monitor_id = $1", [monitorId],
      );
      expect(rows).toEqual([{
        event_id: eventId, monitor_id: monitorId, user_id: ENG_UUID, email: ENG_EMAIL,
        url: "https://example.com/pend1", label: "Eng test", detected_at: nowRows[0]!.now, summary: "Changed",
      }]);
    });
  });

  it("ENG-AC4pend2: does not return already-emailed events", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      const monitorId = await seedMonitor(c, ENG_UUID, { url: "https://example.com/pend2" });
      await seedEvent(c, monitorId, ENG_UUID, { emailedMinutesAgo: 0 });
      expect(await pendingIds(c, monitorId, 10)).toEqual([]);
    });
  });

  it("ENG-AC4pend3: 23 h edge — event detected exactly 23 h ago is not returned (window is under 23 h)", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      const monitorId = await seedMonitor(c, ENG_UUID, { url: "https://example.com/pend3" });
      await seedEvent(c, monitorId, ENG_UUID, { detectedMinutesAgo: 23 * 60 });
      expect(await pendingIds(c, monitorId, 10)).toEqual([]);
    });
  });

  it("ENG-AC4pend4: 23 h edge — event detected 23 h minus 1 min ago IS returned", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      const monitorId = await seedMonitor(c, ENG_UUID, { url: "https://example.com/pend4" });
      const eventId = await seedEvent(c, monitorId, ENG_UUID, { detectedMinutesAgo: 23 * 60 - 1 });
      expect(await pendingIds(c, monitorId, 10)).toEqual([eventId]);
    });
  });

  it("ENG-AC4pend5: user at daily cap — zero pending returned", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      const monitorId = await seedMonitor(c, ENG_UUID, { url: "https://example.com/pend5" });
      // 1 email logged within 24 h → at cap=1
      await seedLog(c, ENG_UUID, "change", 0);
      await seedEvent(c, monitorId, ENG_UUID);
      expect(await pendingIds(c, monitorId, 1)).toEqual([]);
    });
  });

  it("ENG-AC4pend6: partial cap — 1 of cap=2 used → 1 more pending returned", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      const monitorId = await seedMonitor(c, ENG_UUID, { url: "https://example.com/pend6" });
      // 1 email logged within 24 h → 1 of cap=2 used
      await seedLog(c, ENG_UUID, "change", 0);
      const pendingId = await seedEvent(c, monitorId, ENG_UUID);
      expect(await pendingIds(c, monitorId, 2)).toEqual([pendingId]);
    });
  });

  it("ENG-AC4pend7: results ordered by detected_at ascending", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      const monitorId = await seedMonitor(c, ENG_UUID, { url: "https://example.com/pend7" });
      // Seeded newest first, so insertion order cannot pass for detected_at order.
      const newer = await seedEvent(c, monitorId, ENG_UUID, { detectedMinutesAgo: 60 });
      const older = await seedEvent(c, monitorId, ENG_UUID, { detectedMinutesAgo: 120 });
      expect(await pendingIds(c, monitorId, 10)).toEqual([older, newer]);
    });
  });

  it("ENG-AC6pend8: 22023 on p_limit 0", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await expectPgError(
        c, () => c.query("SELECT * FROM public.monitor_engine_pending_emails(0,10)"), "22023",
      );
    });
  });

  it("ENG-AC4pend9: monitor_events_pending_idx is a partial index on detected_at where emailed_at is null", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    const { rows } = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'monitor_events' AND indexname = 'monitor_events_pending_idx'`,
    );
    expect(rows).toEqual([{
      indexdef: "CREATE INDEX monitor_events_pending_idx ON public.monitor_events USING btree (detected_at) WHERE (emailed_at IS NULL)",
    }]);
  });

  it("ENG-AC4pend10: 24 h edge — an email logged exactly 24 h ago no longer counts; 24 h minus 1 min ago it does", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      const monitorId = await seedMonitor(c, ENG_UUID, { url: "https://example.com/pend10" });
      await seedLog(c, ENG_UUID, "change", 24 * 60);
      const pendingId = await seedEvent(c, monitorId, ENG_UUID);
      expect(await pendingIds(c, monitorId, 1)).toEqual([pendingId]);
    });
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      const monitorId = await seedMonitor(c, ENG_UUID, { url: "https://example.com/pend10" });
      await seedLog(c, ENG_UUID, "change", 24 * 60 - 1);
      await seedEvent(c, monitorId, ENG_UUID);
      expect(await pendingIds(c, monitorId, 1)).toEqual([]);
    });
  });

  it("ENG-AC4pend11: allowance edge — 1 of cap 2 used: of 2 pending only the older; with cap 3 both", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      const monitorId = await seedMonitor(c, ENG_UUID, { url: "https://example.com/pend11" });
      await seedLog(c, ENG_UUID, "change", 0);
      const older = await seedEvent(c, monitorId, ENG_UUID, { detectedMinutesAgo: 120 });
      const newer = await seedEvent(c, monitorId, ENG_UUID, { detectedMinutesAgo: 60 });
      expect(await pendingIds(c, monitorId, 2)).toEqual([older]);
      expect(await pendingIds(c, monitorId, 3)).toEqual([older, newer]);
    });
  });

  it("ENG-AC4pend13: only the send log counts — an emailed event without a log row leaves the cap free", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      const monitorId = await seedMonitor(c, ENG_UUID, { url: "https://example.com/pend13" });
      await seedEvent(c, monitorId, ENG_UUID, { emailedMinutesAgo: 0 });
      const pendingId = await seedEvent(c, monitorId, ENG_UUID);
      expect(await pendingIds(c, monitorId, 1)).toEqual([pendingId]);
    });
  });

  it("ENG-AC4pend14: error emails count toward the cap: one logged error email fills cap 1, cap 2 leaves one", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      const monitorId = await seedMonitor(c, ENG_UUID, { url: "https://example.com/pend14" });
      await seedLog(c, ENG_UUID, "error", 0);
      const pendingId = await seedEvent(c, monitorId, ENG_UUID);
      expect(await pendingIds(c, monitorId, 1)).toEqual([]);
      expect(await pendingIds(c, monitorId, 2)).toEqual([pendingId]);
    });
  });

  it("ENG-AC4pend15: the cap survives the user deleting the emailed event", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      const monitorId = await seedMonitor(c, ENG_UUID, { url: "https://example.com/pend15" });
      const emailed = await seedEvent(c, monitorId, ENG_UUID, { detectedMinutesAgo: 60 });
      await c.query("SELECT public.monitor_engine_mark_emailed($1)", [emailed]);
      const pendingId = await seedEvent(c, monitorId, ENG_UUID);
      await asRole(c, "authenticated", ENG_CLAIMS);
      expect((await c.query("DELETE FROM public.monitor_events WHERE id = $1", [emailed])).rowCount).toBe(1);
      await c.query("RESET ROLE");
      expect(await pendingIds(c, monitorId, 1)).toEqual([]);
      expect(await pendingIds(c, monitorId, 2)).toEqual([pendingId]);
    });
  });

  it("ENG-AC4pend16: the cap survives the user deleting the monitor and creating it again", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      const oldMonitorId = await seedMonitor(c, ENG_UUID, { url: "https://example.com/pend16" });
      const emailed = await seedEvent(c, oldMonitorId, ENG_UUID, { detectedMinutesAgo: 60 });
      await c.query("SELECT public.monitor_engine_mark_emailed($1)", [emailed]);
      await asRole(c, "authenticated", ENG_CLAIMS);
      expect((await c.query("DELETE FROM public.monitors WHERE id = $1", [oldMonitorId])).rowCount).toBe(1);
      const { rows: created } = await c.query<{ id: string }>(
        `INSERT INTO public.monitors (user_id, url, label, interval_minutes, status)
         VALUES ($1, 'https://example.com/pend16', null, 60, 'active') RETURNING id`,
        [ENG_UUID],
      );
      await c.query("RESET ROLE");
      const { rows: events } = await c.query("SELECT id FROM public.monitor_events WHERE id = $1", [emailed]);
      expect(events, "the emailed event went with its monitor").toEqual([]);
      const newMonitorId = created[0]!.id;
      const pendingId = await seedEvent(c, newMonitorId, ENG_UUID);
      expect(await pendingIds(c, newMonitorId, 1)).toEqual([]);
      expect(await pendingIds(c, newMonitorId, 2)).toEqual([pendingId]);
    });
  });

  it("ENG-AC6pend12: argument edges — p_limit 1 and p_daily_cap 0 accepted; p_limit 501 and p_daily_cap −1 → 22023", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      const monitorId = await seedMonitor(c, ENG_UUID, { url: "https://example.com/pend12" });
      await seedEvent(c, monitorId, ENG_UUID);
      // At least the seeded event is pending, so limit 1 returns exactly one row (whoever's is oldest).
      const { rows } = await c.query("SELECT * FROM public.monitor_engine_pending_emails(1, 10)");
      expect(rows).toHaveLength(1);
      expect(await pendingIds(c, monitorId, 0)).toEqual([]);
      await expectPgError(c, () => c.query("SELECT * FROM public.monitor_engine_pending_emails(501,10)"), "22023");
      await expectPgError(c, () => c.query("SELECT * FROM public.monitor_engine_pending_emails(10,-1)"), "22023");
    });
  });
});

// ── monitor_engine_mark_emailed ───────────────────────────────────────────────

describe("monitor_engine_mark_emailed — ENG-AC1: idempotent, logs the email once", () => {
  it("ENG-AC1mark1: first call stamps emailed_at = now(), logs one change email and returns true", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      const monitorId = await seedMonitor(c, ENG_UUID, { url: "https://example.com/mark1" });
      const eventId = await seedEvent(c, monitorId, ENG_UUID);
      const { rows } = await c.query<{ monitor_engine_mark_emailed: boolean }>(
        "SELECT public.monitor_engine_mark_emailed($1)", [eventId],
      );
      expect(rows).toEqual([{ monitor_engine_mark_emailed: true }]);
      const { rows: evtRows } = await c.query<{ stamped: boolean }>(
        "SELECT emailed_at = now() AS stamped FROM public.monitor_events WHERE id = $1", [eventId],
      );
      expect(evtRows).toEqual([{ stamped: true }]);
      expect(await logRows(c, ENG_UUID)).toEqual([{ kind: "change", minutes_ago: 0 }]);
    });
  });

  it("ENG-AC1mark2: an already-stamped event → false, emailed_at keeps its earlier value, nothing logged", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      const monitorId = await seedMonitor(c, ENG_UUID, { url: "https://example.com/mark2" });
      // A stamp 2 h before the transaction's now(): a re-stamp inside this transaction would
      // write now() and so differ from it.
      const eventId = await seedEvent(c, monitorId, ENG_UUID, { detectedMinutesAgo: 180, emailedMinutesAgo: 120 });

      const { rows } = await c.query<{ monitor_engine_mark_emailed: boolean }>(
        "SELECT public.monitor_engine_mark_emailed($1)", [eventId],
      );
      expect(rows).toEqual([{ monitor_engine_mark_emailed: false }]);

      const { rows: after } = await c.query<{ kept: boolean }>(
        "SELECT emailed_at = now() - interval '120 minutes' AS kept FROM public.monitor_events WHERE id = $1", [eventId],
      );
      expect(after).toEqual([{ kept: true }]);
      expect(await logRows(c, ENG_UUID)).toEqual([]);
    });
  });

  it("ENG-AC1mark3: called twice for one event → true then false, exactly one log row; an unknown event logs nothing", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      const monitorId = await seedMonitor(c, ENG_UUID, { url: "https://example.com/mark3" });
      const eventId = await seedEvent(c, monitorId, ENG_UUID);
      const results: boolean[] = [];
      for (const id of [eventId, eventId, randomUUID()]) {
        const { rows } = await c.query<{ ok: boolean }>("SELECT public.monitor_engine_mark_emailed($1) AS ok", [id]);
        results.push(rows[0]!.ok);
      }
      expect(results).toEqual([true, false, false]);
      expect(await logRows(c, ENG_UUID)).toEqual([{ kind: "change", minutes_ago: 0 }]);
    });
  });

  it("ENG-AC1mark4: housekeeping prunes that user's log rows older than 48 h (exactly 48 h kept), no other user's", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    await withTx(client, async (c) => {
      await seedEngineUser(c);
      await seedAuthUser(c, ENG2_UUID, ENG2_EMAIL);
      const monitorId = await seedMonitor(c, ENG_UUID, { url: "https://example.com/mark4" });
      const eventId = await seedEvent(c, monitorId, ENG_UUID);
      await seedLog(c, ENG_UUID, "error", 48 * 60 + 1);
      await seedLog(c, ENG_UUID, "change", 48 * 60);
      await seedLog(c, ENG2_UUID, "change", 48 * 60 + 1);
      await c.query("SELECT public.monitor_engine_mark_emailed($1)", [eventId]);
      expect(await logRows(c, ENG_UUID)).toEqual([{ kind: "change", minutes_ago: 0 }, { kind: "change", minutes_ago: 48 * 60 }]);
      expect(await logRows(c, ENG2_UUID)).toEqual([{ kind: "change", minutes_ago: 48 * 60 + 1 }]);
    });
  });
});

// ── skip-locked concurrency ───────────────────────────────────────────────────

describe("monitor_engine_claim — ENG-AC2: skip-locked prevents double-claim", () => {
  it(
    "ENG-AC2skl: a concurrent second claim skips the row the first holds and takes the next one (e2e target only)",
    async (ctx) => {
      if (!ensureFunctions(ctx)) return;
      if (!ON_E2E_PROJECT) { ctx.skip(); return; } // needs committed rows

      // Ordered by id (both never checked, created in one transaction), so a claim of one takes
      // raceA first. Two accounts: a claim also adds a strike to the owner of every monitor it
      // leases, so a second claim leasing a monitor of the same account would wait for the first
      // claim's strike row until that transaction ends.
      const raceA = "00000000-0000-0000-0000-0000000e2ee1";
      const raceB = "00000000-0000-0000-0000-0000000e2ee2";

      const setup = await getClient();
      let sessionA: PoolClient | undefined;
      let sessionB: PoolClient | undefined;
      try {
        await setup.query("BEGIN");
        await seedAuthUser(setup, ENG_UUID, ENG_EMAIL);
        await seedAuthUser(setup, ENG2_UUID, ENG2_EMAIL);
        const { rows: roleRows } = await setup.query<{ role: string | null }>(
          "SELECT role FROM public.profiles WHERE user_id IN ($1, $2)", [ENG_UUID, ENG2_UUID],
        );
        expect(roleRows, "seedAuthUser without allowlist row yields monitor_user").toEqual([
          { role: "monitor_user" }, { role: "monitor_user" },
        ]);
        await setup.query(
          `INSERT INTO public.monitors (id,user_id,url,label,interval_minutes,status,last_checked_at)
           VALUES ($1,$3,'https://example.com/engine-skip-lock-a','Skip-lock test',60,'active',null),
                  ($2,$4,'https://example.com/engine-skip-lock-b','Skip-lock test',60,'active',null)`,
          [raceA, raceB, ENG_UUID, ENG2_UUID],
        );
        await setup.query("COMMIT");

        // Both sessions only ever roll back: no claim stamp is committed, on these rows or on any
        // other monitor of the shared e2e project. Session A first makes every other active
        // monitor not due (and so row-locks it), which scopes both claims to raceA / raceB.
        sessionA = await getClient();
        await sessionA.query("BEGIN");
        await sessionA.query(
          "UPDATE public.monitors SET last_checked_at = now() WHERE status = 'active' AND id NOT IN ($1, $2)",
          [raceA, raceB],
        );
        const { rows: rowsA } = await sessionA.query<{ id: string }>(
          "SELECT * FROM public.monitor_engine_claim(1,5,$1)", [ERROR_THRESHOLD],
        );
        expect(rowsA.map((r) => r.id)).toEqual([raceA]);

        // Without SKIP LOCKED this claim would wait on raceA's lock: lock_timeout fails it with
        // 55P03 instead of hanging the test.
        sessionB = await getClient();
        await sessionB.query("BEGIN");
        await sessionB.query("SET LOCAL lock_timeout = '5s'");
        const { rows: rowsB } = await sessionB.query<{ id: string }>(
          "SELECT * FROM public.monitor_engine_claim(1,5,$1)", [ERROR_THRESHOLD],
        );
        expect(rowsB.map((r) => r.id)).toEqual([raceB]);
      } finally {
        await sessionB?.query("ROLLBACK").catch(() => {});
        await sessionA?.query("ROLLBACK").catch(() => {});
        sessionB?.release();
        sessionA?.release();
        try {
          // A setup that failed or stopped before COMMIT leaves its transaction open or aborted:
          // end it first, so the cleanup runs (and reports) on its own. After COMMIT a no-op.
          await setup.query("ROLLBACK").catch(() => {});
          await setup.query("DELETE FROM public.monitors WHERE id IN ($1, $2)", [raceA, raceB]);
          await setup.query("DELETE FROM auth.users WHERE id IN ($1, $2)", [ENG_UUID, ENG2_UUID]);
        } finally {
          setup.release();
        }
      }
    },
  );
});

describe("monitor_engine_claim — ENG-AC3: a slot of the owners with strikes, held by another session", () => {
  it(
    "ENG-AC3strike13: at limit 10, while another session holds the row lock on the one candidate of the owners with strikes (as an overlapping claim holds every monitor it leased), the claim takes no monitor of an owner with strikes — not the next one instead — but still the monitor of the owner without; once the lock is released, the claim takes the candidate, last (e2e target only)",
    async (ctx) => {
      if (!ensureFunctions(ctx)) return;
      if (!ON_E2E_PROJECT) { ctx.skip(); return; } // needs committed rows

      // N of ENG (no strikes); S1 of ENG2 and S2 of ENG3, both owners with one strike. All three
      // are due; S1 is the older, so it is the one candidate of the owners with strikes.
      const slotN = "00000000-0000-0000-0000-0000000e2ee3";
      const slotS1 = "00000000-0000-0000-0000-0000000e2ee4";
      const slotS2 = "00000000-0000-0000-0000-0000000e2ee5";
      const ids = [slotN, slotS1, slotS2];

      /**
       * claim(10) in its own transaction, always rolled back: every other active monitor is made
       * not due first, which scopes the claim to N, S1 and S2. Returns the claimed rows and the
       * three owners' strikes as that transaction saw them after the claim.
       */
      const claimScoped = async (session: PoolClient) => {
        await session.query("BEGIN");
        try {
          // Without SKIP LOCKED the claim would wait on S1's lock: lock_timeout fails it with 55P03
          // instead of hanging the test.
          await session.query("SET LOCAL lock_timeout = '5s'");
          await session.query(
            "UPDATE public.monitors SET last_checked_at = now() WHERE status = 'active' AND id <> ALL($1::uuid[])",
            [ids],
          );
          const { rows } = await session.query<{ id: string; prior_strikes: number }>(
            "SELECT id, prior_strikes FROM public.monitor_engine_claim(10,5,$1)", [ERROR_THRESHOLD],
          );
          const { rows: strikes } = await session.query<{ user_id: string; strikes: number }>(
            "SELECT user_id, strikes FROM public.monitor_engine_strikes WHERE user_id = ANY($1::uuid[]) ORDER BY user_id",
            [[ENG_UUID, ENG2_UUID, ENG3_UUID]],
          );
          return { rows, strikes };
        } finally {
          await session.query("ROLLBACK");
        }
      };

      const setup = await getClient();
      let holder: PoolClient | undefined;
      let claimer: PoolClient | undefined;
      try {
        await setup.query("BEGIN");
        await seedAuthUser(setup, ENG_UUID, ENG_EMAIL);
        await seedAuthUser(setup, ENG2_UUID, ENG2_EMAIL);
        await seedAuthUser(setup, ENG3_UUID, ENG3_EMAIL);
        const { rows: roleRows } = await setup.query<{ role: string | null }>(
          "SELECT role FROM public.profiles WHERE user_id IN ($1, $2, $3)", [ENG_UUID, ENG2_UUID, ENG3_UUID],
        );
        expect(roleRows, "seedAuthUser without allowlist row yields monitor_user").toEqual([
          { role: "monitor_user" }, { role: "monitor_user" }, { role: "monitor_user" },
        ]);
        await setup.query(
          `INSERT INTO public.monitors (id,user_id,url,label,interval_minutes,status,last_checked_at)
           VALUES ($1,$4,'https://example.com/engine-slot-lock-n','Slot-lock test',60,'active',now() - interval '100 minutes'),
                  ($2,$5,'https://example.com/engine-slot-lock-s1','Slot-lock test',60,'active',now() - interval '300 minutes'),
                  ($3,$6,'https://example.com/engine-slot-lock-s2','Slot-lock test',60,'active',now() - interval '200 minutes')`,
          [slotN, slotS1, slotS2, ENG_UUID, ENG2_UUID, ENG3_UUID],
        );
        await setup.query(
          "INSERT INTO public.monitor_engine_strikes (user_id, strikes) VALUES ($1, 1), ($2, 1)", [ENG2_UUID, ENG3_UUID],
        );
        await setup.query("COMMIT");

        // The holder locks S1 the way an overlapping claim locks a monitor it leased (FOR UPDATE,
        // until its transaction ends). The claimer's ranking still sees S1 due (the holder wrote
        // nothing), keeps it as the one candidate, then skips it as locked.
        holder = await getClient();
        await holder.query("BEGIN");
        const { rows: held } = await holder.query<{ id: string }>(
          "SELECT id FROM public.monitors WHERE id = $1 FOR UPDATE", [slotS1],
        );
        expect(held).toEqual([{ id: slotS1 }]);

        claimer = await getClient();
        expect(await claimScoped(claimer)).toEqual({
          rows: [{ id: slotN, prior_strikes: 0 }],
          strikes: [
            { user_id: ENG_UUID, strikes: 1 },
            { user_id: ENG2_UUID, strikes: 1 },
            { user_id: ENG3_UUID, strikes: 1 },
          ],
        });

        // Released: the same claim now takes S1, after N; S2 still waits.
        await holder.query("ROLLBACK");
        expect(await claimScoped(claimer)).toEqual({
          rows: [{ id: slotN, prior_strikes: 0 }, { id: slotS1, prior_strikes: 1 }],
          strikes: [
            { user_id: ENG_UUID, strikes: 1 },
            { user_id: ENG2_UUID, strikes: 2 },
            { user_id: ENG3_UUID, strikes: 1 },
          ],
        });
      } finally {
        await claimer?.query("ROLLBACK").catch(() => {});
        await holder?.query("ROLLBACK").catch(() => {});
        claimer?.release();
        holder?.release();
        try {
          // A setup that failed or stopped before COMMIT leaves its transaction open or aborted:
          // end it first, so the cleanup runs (and reports) on its own. After COMMIT a no-op.
          await setup.query("ROLLBACK").catch(() => {});
          await setup.query("DELETE FROM public.monitors WHERE id = ANY($1::uuid[])", [ids]);
          // The owners' strike rows go with them (auth.users cascade).
          await setup.query("DELETE FROM auth.users WHERE id IN ($1, $2, $3)", [ENG_UUID, ENG2_UUID, ENG3_UUID]);
        } finally {
          setup.release();
        }
      }
    },
  );
});
