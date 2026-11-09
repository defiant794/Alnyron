/**
 * RLS integration tests — monitor signup-notice RPCs and signup_notified_at column
 * (migration 20261110000100_monitor_signup_notice.sql)
 * Journey: monitor-signup-notice  SNE-AC4a-d
 *
 * Covers:
 *   - EXECUTE denied to anon and authenticated via direct SQL → 42501
 *   - EXECUTE denied via real PostgREST call (publishable key / signed-in JWT) → permission error
 *   - has_function_privilege(role, sig, 'execute'): service_role→true; anon/authenticated/public→false
 *   - proconfig search_path='' on all three functions; pending_signups and purge_unconfirmed are
 *     SECURITY DEFINER owned by postgres, mark_signup_notified is SECURITY INVOKER
 *   - Migration is re-runnable: existing stamps unchanged (exact literal), a pending NULL stays
 *     NULL; backfill only on first column add
 *   - In-tx drop-column + re-add proves backfill: monitor_user gets its own created_at (a literal
 *     distinct from the transaction's now()) as stamp; other-role rows stay NULL; a re-apply
 *     keeps an existing stamp exactly and a pending NULL as NULL
 *
 * Skip policy:
 *   - e2e target (SUPABASE_E2E_REF set): NEVER skip — beforeAll throws the clear missing-migration
 *     message so every test fails with that message rather than "skipped" or ENOENT.
 *   - prod target: skip when to_regprocedure returns null for the new RPCs (ensureFunctions); the
 *     migration DDL tests (drop column / re-apply, locking public.profiles) and the PostgREST
 *     signed-in tests skip off the e2e project, with their reason.
 *
 * Run: npm run test:integration:e2e-project -- tests/integration/rls/rls-monitor-signup-notice.test.ts
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { DB_AVAILABLE, getClient, endPool, type PoolClient } from "./helpers/db.js";
import { transactionControlStatements } from "./helpers/migration-sql.js";
import {
  ANON_CLAIMS,
  asRole,
  expectPgError,
  seedAuthUser,
  withTx,
  type JwtClaims,
} from "./helpers/roles.js";
import { assertE2eTarget } from "../../helpers/assert-e2e-target.js";

const ON_E2E_PROJECT = !!process.env.SUPABASE_E2E_REF;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? "";
const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";

const SKIP_REASON = "20261110000100_monitor_signup_notice not on this target yet";

// Fixed UUIDs for this file (used in rolled-back transactions only)
const SN_UUID  = "00000000-0000-0000-0000-000000005e01";
const SN_EMAIL = "sn-rls-test@test.local";
const SN_CLAIMS: JwtClaims = { sub: SN_UUID, role: "authenticated", email: SN_EMAIL };
const OWN_UUID  = "00000000-0000-0000-0000-000000005e02";
const OWN_EMAIL = "sn-owner-test@test.local";
const PENDING_UUID  = "00000000-0000-0000-0000-000000005e03";
const PENDING_EMAIL = "sn-pending-test@test.local";

// Literal timestamps no apply could write: inside one transaction now() equals every
// `default now()` column (created_at included), so only distinct literals tell a stamp that was
// kept, copied from created_at or rewritten with now() apart. Compared as UTC text.
const CREATED_AT_UTC = "2026-01-02 03:04:05";
const KEPT_STAMP_UTC = "2026-02-03 04:05:06";

const MIGRATION_PATH = path.resolve("supabase/migrations/20261110000100_monitor_signup_notice.sql");

/** The migration's SQL; throws (never skips) when the file is missing. */
function readMigration(): string {
  if (!fs.existsSync(MIGRATION_PATH)) {
    throw new Error(`Migration file not found: ${MIGRATION_PATH} — apply 20261110000100_monitor_signup_notice.sql`);
  }
  return fs.readFileSync(MIGRATION_PATH, "utf-8");
}

/** A profile's signup_notified_at as UTC text, or null. */
async function stampUtc(c: PoolClient, userId: string): Promise<string | null> {
  const { rows } = await c.query<{ stamp: string | null }>(
    "SELECT (signup_notified_at AT TIME ZONE 'UTC')::text AS stamp FROM public.profiles WHERE user_id = $1",
    [userId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.stamp;
}

// ── Probe helpers ─────────────────────────────────────────────────────────────

interface SignupTarget {
  pendingSignupsExists: boolean;
  markSignupNotifiedExists: boolean;
  purgeUnconfirmedExists: boolean;
  columnExists: boolean;
}

async function probeTarget(c: PoolClient): Promise<SignupTarget> {
  const { rows } = await c.query<{ pending: string | null; mark: string | null; purge: string | null }>(`
    SELECT
      to_regprocedure('public.monitor_engine_pending_signups(integer,integer)')::text AS pending,
      to_regprocedure('public.monitor_engine_mark_signup_notified(uuid)')::text       AS mark,
      to_regprocedure('public.monitor_engine_purge_unconfirmed(integer)')::text       AS purge
  `);
  const { rows: colRows } = await c.query<{ column_name: string }>(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles'
      AND column_name = 'signup_notified_at'
  `);
  const probe = rows[0];
  return {
    pendingSignupsExists: probe?.pending != null,
    markSignupNotifiedExists: probe?.mark != null,
    purgeUnconfirmedExists: probe?.purge != null,
    columnExists: colRows.length > 0,
  };
}

// ── Global pool client + probe ────────────────────────────────────────────────

let client: PoolClient;
let target: SignupTarget;

beforeAll(async () => {
  if (!DB_AVAILABLE) return;
  // Guard: verify the env targets the e2e project, not prod,
  // before the first supabase-js client is built in the PostgREST describe below.
  if (ON_E2E_PROJECT) assertE2eTarget();
  client = await getClient();
  target = await probeTarget(client);

  // On the e2e project the migration must exist — throw the clear message so every
  // test fails with it instead of being silently skipped or dying on ENOENT.
  if (ON_E2E_PROJECT && (!target.pendingSignupsExists || !target.markSignupNotifiedExists || !target.purgeUnconfirmedExists)) {
    throw new Error(
      "monitor_engine_pending_signups, monitor_engine_mark_signup_notified, or " +
        "monitor_engine_purge_unconfirmed not found on e2e project — " +
        "apply 20261110000100_monitor_signup_notice.sql",
    );
  }
  if (ON_E2E_PROJECT && !PUBLISHABLE_KEY) {
    throw new Error("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is empty on the e2e target — check tests/.env.e2e");
  }
});

afterAll(async () => {
  client?.release();
  await endPool();
});

// ── Skip helper ───────────────────────────────────────────────────────────────

function ensureFunctions(ctx: { skip: (note?: string) => void }): boolean {
  if (!DB_AVAILABLE) { ctx.skip(SKIP_REASON); return false; }
  if (!target.pendingSignupsExists || !target.markSignupNotifiedExists || !target.purgeUnconfirmedExists) {
    ctx.skip(SKIP_REASON); return false;
  }
  return true;
}

// ── Three new RPCs under test ─────────────────────────────────────────────────

const THREE_RPCS: Array<[string, string]> = [
  ["monitor_engine_pending_signups(integer,integer)", "SELECT * FROM public.monitor_engine_pending_signups(1,10)"],
  ["monitor_engine_mark_signup_notified(uuid)",       `SELECT public.monitor_engine_mark_signup_notified('${randomUUID()}')`],
  ["monitor_engine_purge_unconfirmed(integer)",       "SELECT public.monitor_engine_purge_unconfirmed(1)"],
];

const THREE_SIGS = [
  "public.monitor_engine_pending_signups(integer,integer)",
  "public.monitor_engine_mark_signup_notified(uuid)",
  "public.monitor_engine_purge_unconfirmed(integer)",
];

// ── SNE-AC4a: EXECUTE denied via direct SQL for anon and authenticated ────────

describe("SNE-AC4a: EXECUTE denied for anon and authenticated (direct SQL)", () => {
  for (const [fnName, sql] of THREE_RPCS) {
    it(`SNE-AC4a-rls-anon-${fnName}: anon → 42501`, async (ctx) => {
      if (!ensureFunctions(ctx)) return;
      await withTx(client, async (c) => {
        await asRole(c, "anon", ANON_CLAIMS);
        await expectPgError(c, () => c.query(sql), "42501");
      });
    });

    it(`SNE-AC4a-rls-auth-${fnName}: authenticated → 42501`, async (ctx) => {
      if (!ensureFunctions(ctx)) return;
      await withTx(client, async (c) => {
        await seedAuthUser(c, SN_UUID, SN_EMAIL);
        await asRole(c, "authenticated", SN_CLAIMS);
        await expectPgError(c, () => c.query(sql), "42501");
      });
    });
  }
});

// ── SNE-AC4a: EXECUTE denied via real PostgREST call ─────────────────────────

/** All three RPCs with minimal safe args for a PostgREST call. */
const POSTGREST_RPCS = [
  { fn: "monitor_engine_pending_signups",  args: { p_limit: 1, p_daily_cap: 10 } },
  { fn: "monitor_engine_mark_signup_notified", args: { p_user_id: randomUUID() } },
  { fn: "monitor_engine_purge_unconfirmed",    args: { p_limit: 1 } },
] as const;

describe("SNE-AC4a: EXECUTE denied via PostgREST (publishable key / signed-in JWT) for all three RPCs", () => {
  const postgrestEmail = `sn-postgrest-${Date.now()}@alnyron-test.local`;
  const postgrestPassword = "TestSnPostgREST999!";
  let postgrestUserId: string | undefined;

  beforeAll(async () => {
    if (!ON_E2E_PROJECT || !target?.pendingSignupsExists) return;
    const admin = createClient(SUPABASE_URL, SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await admin.auth.admin.createUser({
      email: postgrestEmail,
      password: postgrestPassword,
      email_confirm: true,
      user_metadata: {},
    });
    if (error) throw new Error(`Failed to create PostgREST test user: ${error.message}`);
    postgrestUserId = data.user.id;
    // Stamp signup_notified_at immediately — a confirmed monitor_user that leaks would trip
    // the live files' pending-signup precondition on subsequent runs. 25 h back, outside the
    // 24 h window, so the stamp holds no daily-cap slot either.
    const c = await getClient();
    try {
      const { rowCount } = await c.query<never>(
        "UPDATE public.profiles SET signup_notified_at = now() - interval '25 hours' WHERE user_id = $1",
        [postgrestUserId],
      );
      if (rowCount !== 1) throw new Error(`Expected 1 profile row to stamp, got ${rowCount ?? 0}`);
    } catch (stampErr) {
      await admin.auth.admin.deleteUser(postgrestUserId).catch(() => {});
      throw stampErr;
    } finally {
      c.release();
    }
  });

  afterAll(async () => {
    if (!postgrestUserId) return;
    const admin = createClient(SUPABASE_URL, SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { error } = await admin.auth.admin.deleteUser(postgrestUserId);
    if (error) throw new Error(`Failed to delete PostgREST test user ${postgrestUserId}: ${error.message}`);
  });

  for (const { fn, args } of POSTGREST_RPCS) {
    it(`SNE-AC4a-postgrest-anon-${fn}: anon PostgREST call → 42501`, async (ctx) => {
      if (!ensureFunctions(ctx)) return;
      if (!ON_E2E_PROJECT) {
        ctx.skip("anon PostgREST calls against the publishable key target the linked project — e2e project only");
        return;
      }
      const anonClient = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      const { error } = await anonClient.rpc(fn, args);
      expect(error).not.toBeNull();
      expect(error!.code).toBe("42501");
    });

    it(`SNE-AC4a-postgrest-auth-${fn}: signed-in user PostgREST call with real JWT → 42501`, async (ctx) => {
      if (!ensureFunctions(ctx)) return;
      if (!postgrestUserId) {
        ctx.skip("the signed-in PostgREST user is created on the e2e project only");
        return;
      }
      const authClient = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      const { data: sessionData, error: signInErr } = await authClient.auth.signInWithPassword({
        email: postgrestEmail,
        password: postgrestPassword,
      });
      if (signInErr || !sessionData.session) throw new Error(`Sign-in failed: ${signInErr?.message}`);
      // Confirm a real authenticated JWT was obtained.
      expect(sessionData.session.access_token).toBeTruthy();
      const { error } = await authClient.rpc(fn, args);
      expect(error).not.toBeNull();
      expect(error!.code).toBe("42501");
    });
  }
});

// ── SNE-AC4b: has_function_privilege ─────────────────────────────────────────

describe("SNE-AC4b: has_function_privilege", () => {
  for (const sig of THREE_SIGS) {
    it(`SNE-AC4b-priv-service: service_role EXECUTE on ${sig}`, async (ctx) => {
      if (!ensureFunctions(ctx)) return;
      const { rows } = await client.query<{ ok: boolean }>(
        `SELECT has_function_privilege('service_role', $1, 'execute') AS ok`, [sig],
      );
      expect(rows[0]?.ok).toBe(true);
    });

    it(`SNE-AC4b-priv-auth: authenticated no EXECUTE on ${sig}`, async (ctx) => {
      if (!ensureFunctions(ctx)) return;
      const { rows } = await client.query<{ ok: boolean }>(
        `SELECT has_function_privilege('authenticated', $1, 'execute') AS ok`, [sig],
      );
      expect(rows[0]?.ok).toBe(false);
    });

    it(`SNE-AC4b-priv-anon: anon no EXECUTE on ${sig}`, async (ctx) => {
      if (!ensureFunctions(ctx)) return;
      const { rows } = await client.query<{ ok: boolean }>(
        `SELECT has_function_privilege('anon', $1, 'execute') AS ok`, [sig],
      );
      expect(rows[0]?.ok).toBe(false);
    });

    it(`SNE-AC4b-priv-public: has_function_privilege('public', …) false on ${sig}`, async (ctx) => {
      if (!ensureFunctions(ctx)) return;
      const { rows } = await client.query<{ ok: boolean }>(
        `SELECT has_function_privilege('public', $1, 'execute') AS ok`, [sig],
      );
      expect(rows[0]?.ok).toBe(false);
    });
  }
});

// ── SNE-AC4c: search_path='', SECURITY DEFINER / INVOKER and owner ───────────

const DEFINER_SIGS = [
  "public.monitor_engine_pending_signups(integer,integer)",
  "public.monitor_engine_purge_unconfirmed(integer)",
];

describe("SNE-AC4c: search_path='' on all three; the two auth.users functions are SECURITY DEFINER owned by postgres, mark_signup_notified is SECURITY INVOKER", () => {
  for (const sig of THREE_SIGS) {
    it(`SNE-AC4c-searchpath: ${sig}`, async (ctx) => {
      if (!ensureFunctions(ctx)) return;
      const { rows } = await client.query<{ proconfig: string[] | null }>(
        `SELECT proconfig FROM pg_proc WHERE oid = $1::regprocedure`, [sig],
      );
      expect(rows[0]?.proconfig).toEqual(['search_path=""']);
    });
  }

  for (const sig of DEFINER_SIGS) {
    it(`SNE-AC4c-definer: ${sig} is SECURITY DEFINER owned by postgres`, async (ctx) => {
      if (!ensureFunctions(ctx)) return;
      const { rows } = await client.query<{ definer: boolean; owner: string }>(
        "SELECT prosecdef AS definer, pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid = $1::regprocedure",
        [sig],
      );
      expect(rows).toEqual([{ definer: true, owner: "postgres" }]);
    });
  }

  it("SNE-AC4c-invoker: public.monitor_engine_mark_signup_notified(uuid) is SECURITY INVOKER", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    const { rows } = await client.query<{ definer: boolean }>(
      "SELECT prosecdef AS definer FROM pg_proc WHERE oid = 'public.monitor_engine_mark_signup_notified(uuid)'::regprocedure",
    );
    expect(rows).toEqual([{ definer: false }]);
  });
});

// ── SNE-AC4d: migration idempotent ───────────────────────────────────────────

const ENGINE_FUNCTION_OIDS_SQL = `
  SELECT p.oid::text AS oid, p.proname AS name
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('monitor_engine_pending_signups', 'monitor_engine_mark_signup_notified', 'monitor_engine_purge_unconfirmed')
   ORDER BY 2`;

/** Sets a profile's timestamp column to a UTC literal, inside the caller's transaction (exactly one row). */
async function setUtc(c: PoolClient, column: "signup_notified_at" | "created_at", userId: string, utc: string): Promise<void> {
  const { rowCount } = await c.query(
    `UPDATE public.profiles SET ${column} = $2::timestamp AT TIME ZONE 'UTC' WHERE user_id = $1`,
    [userId, utc],
  );
  expect(rowCount).toBe(1);
}

describe("SNE-AC4d: migration re-apply is idempotent — existing stamps untouched", () => {
  it("SNE-AC4d-reapply0: migration file exists and has no COMMIT/BEGIN/ROLLBACK", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    expect(transactionControlStatements(readMigration())).toEqual([]);
  });

  it("SNE-AC4d-reapply1: re-applying the migration in a rolled-back tx keeps the three function oids, an existing stamp exactly and a pending account's NULL", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    if (!ON_E2E_PROJECT) {
      ctx.skip("re-runs the migration's DDL on public.profiles: e2e project only");
      return;
    }
    const MIGRATION_SQL = readMigration();
    await withTx(client, async (c) => {
      // The re-apply locks public.profiles until ROLLBACK: bound the wait on the shared project.
      await c.query("SET LOCAL lock_timeout = '5s'");
      const { rows: before } = await c.query<{ oid: string; name: string }>(ENGINE_FUNCTION_OIDS_SQL);
      expect(before).toHaveLength(3);

      await seedAuthUser(c, SN_UUID, SN_EMAIL);
      await seedAuthUser(c, PENDING_UUID, PENDING_EMAIL);
      await setUtc(c, "signup_notified_at", SN_UUID, KEPT_STAMP_UTC);
      expect(await stampUtc(c, PENDING_UUID)).toBeNull();

      await c.query(MIGRATION_SQL);

      const { rows: after } = await c.query<{ oid: string; name: string }>(ENGINE_FUNCTION_OIDS_SQL);
      expect(after).toEqual(before);
      // A backfill run on every apply would rewrite the stamp (to created_at, this
      // transaction's now()) or stamp the pending account.
      expect(await stampUtc(c, SN_UUID)).toBe(KEPT_STAMP_UTC);
      expect(await stampUtc(c, PENDING_UUID)).toBeNull();
    });
  });
});

// ── SNE-AC4d: backfill behavior ───────────────────────────────────────────────

describe("SNE-AC4d: backfill on first-add stamps monitor_user rows with created_at, leaves others NULL", () => {
  it("SNE-AC4d-backfill1: in-tx drop + re-add proves backfill: monitor_user gets its own created_at (a literal) as stamp; owner stays null; a re-apply keeps an existing stamp exactly and a pending account's NULL", async (ctx) => {
    if (!ensureFunctions(ctx)) return;
    if (!ON_E2E_PROJECT) {
      ctx.skip("drops and re-adds a column of public.profiles: e2e project only");
      return;
    }
    const MIGRATION_SQL = readMigration();
    await withTx(client, async (c) => {
      // DROP COLUMN holds an ACCESS EXCLUSIVE lock on public.profiles until ROLLBACK: bound the wait.
      await c.query("SET LOCAL lock_timeout = '5s'");
      await seedAuthUser(c, SN_UUID, SN_EMAIL);
      await seedAuthUser(c, OWN_UUID, OWN_EMAIL, "owner");
      // A created_at other than this transaction's now(), so a backfill writing now() cannot pass.
      await setUtc(c, "created_at", SN_UUID, CREATED_AT_UTC);

      await c.query("ALTER TABLE public.profiles DROP COLUMN IF EXISTS signup_notified_at");
      await c.query(MIGRATION_SQL);

      expect(await stampUtc(c, SN_UUID)).toBe(CREATED_AT_UTC);
      expect(await stampUtc(c, OWN_UUID)).toBeNull();

      // Re-apply with the column present: a stamp other than created_at must stay exactly, and a
      // monitor_user still pending (NULL) must stay NULL.
      await setUtc(c, "signup_notified_at", SN_UUID, KEPT_STAMP_UTC);
      await seedAuthUser(c, PENDING_UUID, PENDING_EMAIL);
      expect(await stampUtc(c, PENDING_UUID)).toBeNull();
      await c.query(MIGRATION_SQL);
      expect(await stampUtc(c, SN_UUID)).toBe(KEPT_STAMP_UTC);
      expect(await stampUtc(c, PENDING_UUID)).toBeNull();
      expect(await stampUtc(c, OWN_UUID)).toBeNull();
    });
  });
});
