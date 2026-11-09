/**
 * RLS integration tests — page-change monitor (monitors, monitor_events).
 *
 * Covers the P4 monitor schema (migrations 20261106000100_monitor_role.sql and
 * 20261106000200_monitor_schema.sql). Every policy requires `(select auth.uid()) = user_id` AND
 * `(select private.is_monitor())` (role owner or monitor_user):
 *   - a monitor user (monitor_user, owner) reads, inserts, edits and deletes its own monitors and
 *     reads and deletes its own events (positive control: the denials below are the policies and
 *     grants, not a blanket failure)
 *   - user A cannot select, update or delete B's monitors or events, cannot insert a monitor
 *     carrying B's user_id, cannot move its own monitor to B and cannot upsert onto B's monitor;
 *     the owner role gives no read-all
 *   - a signed-in account without a monitor role (admin, mylife_user, role = NULL, no profile
 *     row) is denied on both tables, its own rows included; a monitor_user in turn gets nothing
 *     from is_admin / is_owner (admin-only tables) or is_mylife (MyLife tables)
 *   - INSERT and UPDATE on monitors are column-level (users write url, label, interval_minutes,
 *     status, and user_id on insert): the cron's columns (last_hash, last_snapshot,
 *     last_checked_at, consecutive_errors), id, created_at and updated_at raise 42501 on both,
 *     user_id on UPDATE, also through an upsert
 *   - url is an http(s) URL without whitespace or <>" of at most 2048 characters and label at
 *     most 200 characters (23514); a new url clears last_hash and last_snapshot (and resets
 *     consecutive_errors where the target's url trigger does so: rls-monitor-engine covers the rest)
 *   - monitor_events: users hold no INSERT or UPDATE privilege (42501); the service role (the
 *     cron) inserts events and writes the cron columns; an event's user_id is always its
 *     monitor's owner (23503) and deleting the monitor deletes its events
 *   - monitors_limit_per_user: the default cap of 2 refuses a 3rd monitor (P0001
 *     monitor_limit_reached), for the service role too; NULL is unlimited, 0 allows none, a
 *     negative cap is refused (23514); the owner role is unlimited whatever its cap, so a
 *     promoted owner is too and a demoted one falls back to its cap; a user cannot lift its own
 *     cap; inserting for another user gets RLS's 42501, never that user's P0001; concurrent
 *     at-cap inserts serialize on the user's profile row
 *   - anon has no grant on either table and TRUNCATE is granted to nobody → 42501
 *   - exactly the six monitor policies exist, and the table, column and function privileges
 *
 * UPDATE / DELETE USING failures filter rows silently → rowCount 0, no error;
 * INSERT WITH CHECK failures and missing (column) privileges → 42501.
 * Denied writes are checked against the stored rows as postgres (RESET ROLE, RLS bypassed).
 *
 * Target state: 20261106000100 must be committed on the target. A value added by ALTER TYPE ...
 * ADD VALUE is unusable in the transaction that adds it (55P04), so that migration cannot run
 * inside a test transaction; until the target holds it every test skips. It is committed on the
 * e2e project. Until the target also holds 20261106000200, every test applies that migration in
 * its own rolled-back transaction (withTx), after seeding the accounts (so they exist when it
 * runs, as on a real deploy), so nothing persists. It locks public.profiles and auth.users until
 * ROLLBACK, so lock_timeout bounds the wait for them.
 *
 * Those locks are on live tables, so the in-transaction migration runs only on the isolated e2e
 * project, never on production. While production lacks either migration, every test skips (with
 * that note). Run it against the e2e project:
 *   env -u SUPABASE_DB_PASSWORD node --env-file=tests/.env.e2e-project \
 *     node_modules/vitest/vitest.mjs run --project integration rls-monitor
 * Once both migrations are on production, the plain `npm run test:integration` runs it there,
 * without DDL.
 *
 * The column default of profiles.monitor_limit (the free cap) is 2 on a target holding
 * 20261107000300 and 5 on one holding only 20261106000200. The test of the default cap of 2
 * skips while the target lacks 20261107000300; the other tests compare with whatever default
 * the target (or the in-transaction 20261106000200) gives.
 *
 * private.monitors_reset_on_url_change also resets consecutive_errors once 20261108000100 has
 * replaced it. The url test expects that reset exactly when the target's trigger function body
 * (pg_get_functiondef) mentions consecutive_errors; where the function is missing, the
 * in-transaction 20261106000200 creates the body without it.
 *
 * The concurrency test needs two connections to share the schema and one user, and neither
 * sees what the other's open transaction wrote. It therefore runs only on the e2e project once
 * 20261106000200 is committed there, and commits its own fixture user (removed before and after).
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB_AVAILABLE, getClient, type PoolClient } from "./helpers/db.js";
import { transactionControlStatements } from "./helpers/migration-sql.js";
import { FREE_LIMIT_SKIP_REASON, freeLimitApplied, monitorLimitDefault } from "./helpers/monitor-limit.js";
import {
  ADMIN_CLAIMS,
  ADMIN_EMAIL,
  ADMIN_UUID,
  ANON_CLAIMS,
  MYLIFE_CLAIMS,
  MYLIFE_EMAIL,
  MYLIFE_UUID,
  NON_ADMIN_CLAIMS,
  NON_ADMIN_UUID,
  NULL_ROLE_CLAIMS,
  NULL_ROLE_EMAIL,
  NULL_ROLE_UUID,
  OWNER_CLAIMS,
  OWNER_EMAIL,
  OWNER_UUID,
  asRole,
  expectPgError,
  seedAuthUser,
  seedDraftPage,
  seedRolelessUser,
  seedSiteSettings,
  type JwtClaims,
  withTx,
} from "./helpers/roles.js";

const ROLE_MIGRATION_SQL = fs.readFileSync(path.resolve("supabase/migrations/20261106000100_monitor_role.sql"), "utf-8");
const SCHEMA_MIGRATION_SQL = fs.readFileSync(
  path.resolve("supabase/migrations/20261106000200_monitor_schema.sql"),
  "utf-8",
);

/** What the target DB already holds, read as postgres outside any transaction. */
interface TargetSchema {
  /** 'monitor_user' is a committed app_role value (20261106000100 applied). */
  roleCommitted: boolean;
  /** public.monitors exists (20261106000200 applied). */
  schemaApplied: boolean;
  /** The MyLife tables and private.is_mylife() exist (20261105000300 / 0400 applied). */
  myLifeApplied: boolean;
  /** profiles.monitor_limit defaults to 2 (20261107000300 applied). */
  freeLimitApplied: boolean;
  /**
   * The body of private.monitors_reset_on_url_change() mentions consecutive_errors: the function
   * as replaced by 20261108000100, which also resets it (and error_notified_at) on a new url.
   * False while the function is missing (the in-transaction 20261106000200 creates the old body).
   */
  urlTriggerResetsErrors: boolean;
}

/** db.ts connects to the isolated e2e project exactly when SUPABASE_E2E_REF is set; else production. */
const ON_E2E_PROJECT = !!process.env.SUPABASE_E2E_REF;

/** A signed-in caller and how to seed its auth.users / profiles rows (as postgres, before asRole). */
interface Account {
  label: string;
  claims: JwtClaims;
  userId: string;
  seed: (c: PoolClient) => Promise<void>;
}

const MONITOR_UUID = "00000000-0000-0000-0000-000000000007";
const MONITOR_EMAIL = "monitor@test.local";
const MONITOR_CLAIMS: JwtClaims = { sub: MONITOR_UUID, role: "authenticated", email: MONITOR_EMAIL };

const MONITOR: Account = {
  label: "monitor_user",
  claims: MONITOR_CLAIMS,
  userId: MONITOR_UUID,
  // seedAuthUser's AppRole predates monitor_user: allowlist the role here and let
  // on_auth_user_created copy it into the new profile.
  seed: async (c) => {
    await c.query("INSERT INTO public.user_allowlist (email, role) VALUES ($1, 'monitor_user')", [MONITOR_EMAIL]);
    await seedAuthUser(c, MONITOR_UUID, MONITOR_EMAIL);
  },
};
const OWNER: Account = {
  label: "owner",
  claims: OWNER_CLAIMS,
  userId: OWNER_UUID,
  seed: (c) => seedAuthUser(c, OWNER_UUID, OWNER_EMAIL, "owner"),
};
const ADMIN: Account = {
  label: "admin",
  claims: ADMIN_CLAIMS,
  userId: ADMIN_UUID,
  seed: (c) => seedAuthUser(c, ADMIN_UUID, ADMIN_EMAIL, "admin"),
};
const MYLIFE: Account = {
  label: "mylife_user",
  claims: MYLIFE_CLAIMS,
  userId: MYLIFE_UUID,
  seed: (c) => seedAuthUser(c, MYLIFE_UUID, MYLIFE_EMAIL, "mylife_user"),
};
const NULL_ROLE: Account = {
  label: "profile role=null",
  claims: NULL_ROLE_CLAIMS,
  userId: NULL_ROLE_UUID,
  seed: (c) => seedRolelessUser(c, NULL_ROLE_UUID, NULL_ROLE_EMAIL),
};
const NO_PROFILE: Account = {
  // An auth user whose profiles row is gone (the owner may delete profiles): the FK to
  // auth.users still lets rows exist, and current_role_in() finds no row at all.
  label: "no profile row",
  claims: NON_ADMIN_CLAIMS,
  userId: NON_ADMIN_UUID,
  seed: async (c) => {
    await seedAuthUser(c, NON_ADMIN_UUID, "noprofile@test.local");
    await c.query("DELETE FROM public.profiles WHERE user_id = $1", [NON_ADMIN_UUID]);
  },
};

/** The roles the monitor lets in. */
const MONITOR_ACCOUNTS: readonly Account[] = [MONITOR, OWNER];

/** Signed-in accounts that must never pass private.is_monitor(). */
const NON_MONITOR_ACCOUNTS: readonly Account[] = [ADMIN, MYLIFE, NULL_ROLE, NO_PROFILE];

/** [A, B]: A acts on B's rows. Both directions, so the owner role is covered as attacker and victim. */
const PAIRS: ReadonlyArray<readonly [Account, Account]> = [
  [MONITOR, OWNER],
  [OWNER, MONITOR],
];

/**
 * The concurrency test's fixture user, COMMITTED on the e2e project for the test's duration: no
 * other test uses this id or email, so its rows never collide with theirs.
 */
const RACE_UUID = "00000000-0000-0000-0000-0000000e2e07";
const RACE_EMAIL = "e2e-monitor-race@test.local";
const RACE_CLAIMS: JwtClaims = { sub: RACE_UUID, role: "authenticated", email: RACE_EMAIL };

/** Every seeded monitor, including the cron-written state. */
const SEED = {
  url: "https://example.com/watched",
  label: "Seeded",
  interval_minutes: 60,
  status: "active",
  last_hash: "seed-hash",
  last_snapshot: "seed snapshot",
  last_checked_at: "2026-11-06T08:00:00Z",
  consecutive_errors: 2,
} as const;

const INSERT_MONITOR = `INSERT INTO public.monitors (user_id, url, label, interval_minutes)
  VALUES ($1, 'https://example.com/new', 'New', 30) RETURNING id`;
const INSERT_EVENT = `INSERT INTO public.monitor_events (monitor_id, user_id, old_hash, new_hash, summary)
  VALUES ($1, $2, 'old', 'new', 'Changed')`;

/**
 * The columns `authenticated` may not update, each with a value a user might try. user_id is
 * set to itself: the privilege is refused before any row is looked at.
 */
const PROTECTED_COLUMNS: ReadonlyArray<readonly [column: string, value: string]> = [
  ["last_hash", "'forged'"],
  ["last_snapshot", "'forged'"],
  ["last_checked_at", "now() + interval '1 year'"],
  ["consecutive_errors", "0"],
  ["user_id", "user_id"],
  ["id", "gen_random_uuid()"],
  ["created_at", "now()"],
  ["updated_at", "now()"],
];

/** The columns `authenticated` may not name on INSERT: all but user_id, which the policy checks instead. */
const INSERT_PROTECTED_COLUMNS = PROTECTED_COLUMNS.filter(([column]) => column !== "user_id");

/** A monitor insert for $1 with url $2 and label $3. */
const INSERT_URL_LABEL = "INSERT INTO public.monitors (user_id, url, label, interval_minutes) VALUES ($1, $2, $3, 30)";

/** "https://example.com/" is 20 characters: these paths make the url exactly 2048 or 2049 long. */
const URL_OF_2048 = `https://example.com/${"a".repeat(2028)}`;
const URL_OF_2049 = `https://example.com/${"a".repeat(2029)}`;

/** urls the monitors_url_valid CHECK refuses. */
const INVALID_URLS: ReadonlyArray<readonly [kind: string, url: string]> = [
  ["javascript:", "javascript:alert(1)"],
  ["file:", "file:///etc/passwd"],
  ["data:", "data:text/html,<script>alert(1)</script>"],
  ["ftp:", "ftp://example.com/file"],
  ["scheme-relative", "//example.com/page"],
  ["no host", "https://"],
  ["space", "https://example.com/a b"],
  ["newline", "https://example.com/\nX-Injected: 1"],
  ["<", "https://example.com/<script>"],
  ['"', 'https://example.com/"onmouseover=alert(1)'],
  ["2049 characters", URL_OF_2049],
];

/** urls the monitors_url_valid CHECK accepts. */
const VALID_URLS: readonly string[] = ["http://example.com/", "https://example.com/path?q=1&r=%20#frag", URL_OF_2048];

/** A monitor with the SEED values for `userId`, as postgres. Returns its id. */
async function seedMonitor(c: PoolClient, userId: string): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO public.monitors
       (user_id, url, label, interval_minutes, status, last_hash, last_snapshot, last_checked_at, consecutive_errors)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      userId,
      SEED.url,
      SEED.label,
      SEED.interval_minutes,
      SEED.status,
      SEED.last_hash,
      SEED.last_snapshot,
      SEED.last_checked_at,
      SEED.consecutive_errors,
    ],
  );
  return rows[0]!.id;
}

/** A seeded monitor for `userId` and one change event on it, as postgres. */
async function seedMonitorRows(c: PoolClient, userId: string): Promise<{ monitorId: string; eventId: string }> {
  const monitorId = await seedMonitor(c, userId);
  const { rows } = await c.query<{ id: string }>(`${INSERT_EVENT} RETURNING id`, [monitorId, userId]);
  return { monitorId, eventId: rows[0]!.id };
}

/**
 * The cron's session: service_role (bypasses RLS) with a JWT that has no `sub`, so auth.uid() is
 * NULL as with the Worker's service key. Like asRole: inside withTx, after seeding.
 */
async function asServiceRole(c: PoolClient): Promise<void> {
  await c.query("SET LOCAL role = service_role");
  await c.query(`SET LOCAL "request.jwt.claims" = '{"role":"service_role"}'`);
}

interface StoredMonitor {
  user_id: string;
  url: string;
  label: string | null;
  interval_minutes: number;
  status: string;
  last_hash: string | null;
  last_snapshot: string | null;
  last_checked_at: string | null;
  consecutive_errors: number;
}

/** Monitor `monitorId` as stored, read as postgres (leaves the caller's role). */
async function storedMonitor(c: PoolClient, monitorId: string): Promise<StoredMonitor[]> {
  await c.query("RESET ROLE");
  const { rows } = await c.query<StoredMonitor>(
    `SELECT user_id, url, label, interval_minutes, status, last_hash, last_snapshot,
            to_char(last_checked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_checked_at,
            consecutive_errors
       FROM public.monitors WHERE id = $1`,
    [monitorId],
  );
  return rows;
}

/** The monitor seedMonitor wrote, untouched. */
function unchangedMonitor(userId: string): StoredMonitor[] {
  return [{ user_id: userId, ...SEED }];
}

/** The ids of event `eventId` as stored, read as postgres (leaves the caller's role). */
async function storedEvent(c: PoolClient, eventId: string): Promise<Array<{ id: string }>> {
  await c.query("RESET ROLE");
  return (await c.query<{ id: string }>("SELECT id FROM public.monitor_events WHERE id = $1", [eventId])).rows;
}

/** `userId`'s profiles.monitor_limit, read as postgres (leaves the caller's role). */
async function monitorLimit(c: PoolClient, userId: string): Promise<number | null> {
  await c.query("RESET ROLE");
  const { rows } = await c.query<{ monitor_limit: number | null }>(
    "SELECT monitor_limit FROM public.profiles WHERE user_id = $1",
    [userId],
  );
  return rows[0]!.monitor_limit;
}

/**
 * The monitor_limit a new profile gets in `c`'s transaction, read as postgres (leaves the
 * caller's role): the column default, 2 with 20261107000300 and 5 with only 20261106000200.
 */
async function defaultCap(c: PoolClient): Promise<number> {
  await c.query("RESET ROLE");
  const columnDefault = await monitorLimitDefault(c);
  expect(columnDefault).toMatch(/^\d+$/);
  return Number(columnDefault);
}

/** How many monitors `userId` holds, read as postgres (leaves the caller's role). */
async function monitorCount(c: PoolClient, userId: string): Promise<number> {
  await c.query("RESET ROLE");
  const { rows } = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM public.monitors WHERE user_id = $1", [
    userId,
  ]);
  return rows[0]!.n;
}

/**
 * Resolves once backend `waiter` waits for a lock held by backend `holder`, polling as postgres
 * via `c`. The other backend's lock wait is server state with no event to await, so this polls
 * pg_blocking_pids on the real clock (fake timers cannot advance a server).
 */
async function waitUntilBlocked(c: PoolClient, waiter: number, holder: number): Promise<void> {
  await c.query("RESET ROLE");
  for (let attempt = 0; attempt < 100; attempt++) {
    const { rows } = await c.query<{ blocked: boolean }>(
      "SELECT $1::int = ANY (pg_blocking_pids($2::int)) AS blocked",
      [holder, waiter],
    );
    if (rows[0]!.blocked) return;
    await sleep(50);
  }
  throw new Error(`backend ${waiter} never waited for a lock of backend ${holder}`);
}

/** COMMITS the race user (monitor_user, cap 1) on the e2e project; `c` must be outside a transaction. */
async function seedRaceUser(c: PoolClient): Promise<void> {
  await c.query("INSERT INTO public.user_allowlist (email, role) VALUES ($1, 'monitor_user')", [RACE_EMAIL]);
  await seedAuthUser(c, RACE_UUID, RACE_EMAIL);
  await c.query("UPDATE public.profiles SET monitor_limit = 1 WHERE user_id = $1", [RACE_UUID]);
}

/** Removes every committed trace of the race user (its profile, monitors and events cascade). */
async function removeRaceUser(c: PoolClient): Promise<void> {
  await c.query("DELETE FROM auth.users WHERE id = $1", [RACE_UUID]);
  await c.query("DELETE FROM public.user_allowlist WHERE email = $1", [RACE_EMAIL]);
}

describe.skipIf(!DB_AVAILABLE)("RLS — page-change monitor (monitors + monitor_events)", () => {
  let client: PoolClient;
  let target: TargetSchema;

  beforeAll(async () => {
    client = await getClient();
    const { rows } = await client.query<{
      role_committed: boolean; schema_applied: boolean; mylife_applied: boolean; url_trigger_resets_errors: boolean;
    }>(
      `SELECT EXISTS (SELECT 1 FROM pg_enum
                       WHERE enumtypid = 'public.app_role'::regtype AND enumlabel = 'monitor_user') AS role_committed,
              to_regclass('public.monitors') IS NOT NULL AS schema_applied,
              to_regclass('public.mylife_profile') IS NOT NULL AND to_regclass('public.mylife_events') IS NOT NULL
                AND to_regprocedure('private.is_mylife()') IS NOT NULL AS mylife_applied,
              coalesce(pg_get_functiondef(to_regprocedure('private.monitors_reset_on_url_change()'))
                         LIKE '%consecutive_errors%', false) AS url_trigger_resets_errors`,
    );
    target = {
      roleCommitted: rows[0]!.role_committed,
      schemaApplied: rows[0]!.schema_applied,
      myLifeApplied: rows[0]!.mylife_applied,
      freeLimitApplied: await freeLimitApplied(client),
      urlTriggerResetsErrors: rows[0]!.url_trigger_resets_errors,
    };
    if (target.schemaApplied && !target.roleCommitted) {
      throw new Error("public.monitors exists but app_role has no committed 'monitor_user'");
    }
  });

  beforeEach(({ skip }) => {
    skip(
      !target.roleCommitted,
      "app_role has no committed 'monitor_user': apply 20261106000100 to the target first (an added enum value is unusable inside its own transaction)",
    );
    skip(
      !ON_E2E_PROJECT && !target.schemaApplied,
      "20261106000200 not on production: the in-transaction migration would lock live tables; run on the e2e project (module doc)",
    );
  });

  afterAll(async () => {
    client.release();
  });

  /**
   * Inside withTx, as postgres: brings the transaction to the migrated state, seeding `accounts`
   * before 20261106000200 runs (as on a real deploy, where the profiles already exist).
   */
  async function prepare(c: PoolClient, accounts: readonly Account[]): Promise<void> {
    await c.query("SET LOCAL lock_timeout = '5s'");
    for (const account of accounts) await account.seed(c);
    if (!target.schemaApplied) await c.query(SCHEMA_MIGRATION_SQL);
  }

  // --------------------------------------------------------------------------
  // The migrations themselves
  // --------------------------------------------------------------------------

  it("neither migration holds transaction control, so running one inside withTx cannot commit it", () => {
    // The guard finds transaction control, but not in a comment or a function body.
    expect(transactionControlStatements("-- commit\nbegin;\nupdate x set y = 1;\ncommit;")).toEqual(["begin", "commit"]);
    expect(transactionControlStatements("do $$ begin perform 1; end $$;")).toEqual([]);
    expect(transactionControlStatements(ROLE_MIGRATION_SQL)).toEqual([]);
    expect(transactionControlStatements(SCHEMA_MIGRATION_SQL)).toEqual([]);
  });

  it("20261106000100 re-runs as a no-op on a target that holds monitor_user", async ({ skip }) => {
    skip(!ON_E2E_PROJECT, "runs ALTER TYPE: e2e project only");
    await withTx(client, async (c) => {
      await c.query("SET LOCAL lock_timeout = '5s'");
      await c.query(ROLE_MIGRATION_SQL);
      const { rows } = await c.query<{ enumlabel: string }>(
        "SELECT enumlabel FROM pg_enum WHERE enumtypid = 'public.app_role'::regtype ORDER BY enumsortorder",
      );
      expect(rows.map((r) => r.enumlabel)).toEqual(["owner", "admin", "mylife_user", "monitor_user"]);
    });
  }, 20_000);

  it("20261106000200 gives every existing profile the default cap of 5, owners included (the trigger, not the column, makes the owner role unlimited)", async ({
    skip,
  }) => {
    skip(target.schemaApplied, "the target already holds 20261106000200: no migration run to observe");
    await withTx(client, async (c) => {
      await prepare(c, [OWNER, MONITOR, MYLIFE, NULL_ROLE]);
      const { rows } = await c.query<{ user_id: string; monitor_limit: number | null }>(
        "SELECT user_id, monitor_limit FROM public.profiles WHERE user_id = ANY ($1::uuid[]) ORDER BY user_id",
        [[OWNER_UUID, MONITOR_UUID, MYLIFE_UUID, NULL_ROLE_UUID]],
      );
      expect(rows).toEqual(
        [OWNER_UUID, MONITOR_UUID, MYLIFE_UUID, NULL_ROLE_UUID]
          .sort()
          .map((user_id) => ({ user_id, monitor_limit: 5 })),
      );
    });
  }, 20_000);

  // --------------------------------------------------------------------------
  // anon: no table privileges at all
  // --------------------------------------------------------------------------

  it("anon: every statement on monitors and monitor_events raises 42501, TRUNCATE included", async () => {
    await withTx(client, async (c) => {
      await prepare(c, [OWNER]);
      const { monitorId } = await seedMonitorRows(c, OWNER_UUID);
      await asRole(c, "anon", ANON_CLAIMS);

      const statements: ReadonlyArray<{ label: string; sql: string; params?: unknown[] }> = [
        { label: "SELECT monitors", sql: "SELECT id FROM public.monitors" },
        { label: "INSERT monitors", sql: INSERT_MONITOR, params: [OWNER_UUID] },
        { label: "UPDATE monitors", sql: "UPDATE public.monitors SET label = 'x'" },
        { label: "DELETE monitors", sql: "DELETE FROM public.monitors" },
        { label: "TRUNCATE monitors", sql: "TRUNCATE public.monitors CASCADE" },
        { label: "SELECT monitor_events", sql: "SELECT id FROM public.monitor_events" },
        { label: "INSERT monitor_events", sql: INSERT_EVENT, params: [monitorId, OWNER_UUID] },
        { label: "UPDATE monitor_events", sql: "UPDATE public.monitor_events SET summary = 'x'" },
        { label: "DELETE monitor_events", sql: "DELETE FROM public.monitor_events" },
        { label: "TRUNCATE monitor_events", sql: "TRUNCATE public.monitor_events" },
      ];
      for (const stmt of statements) {
        await expectPgError(c, () => c.query(stmt.sql, stmt.params), "42501", `anon ${stmt.label}`);
      }
      expect(await storedMonitor(c, monitorId)).toEqual(unchangedMonitor(OWNER_UUID));
    });
  }, 20_000);

  // --------------------------------------------------------------------------
  // TRUNCATE is not subject to RLS, so not even a monitor user may run it
  // --------------------------------------------------------------------------

  it("monitor user (monitor_user): TRUNCATE on either table raises 42501", async () => {
    await withTx(client, async (c) => {
      await prepare(c, [MONITOR]);
      await seedMonitorRows(c, MONITOR_UUID);
      await asRole(c, "authenticated", MONITOR_CLAIMS);
      await expectPgError(c, () => c.query("TRUNCATE public.monitors CASCADE"), "42501", "TRUNCATE monitors");
      await expectPgError(c, () => c.query("TRUNCATE public.monitor_events"), "42501", "TRUNCATE monitor_events");
    });
  }, 20_000);

  // --------------------------------------------------------------------------
  // Monitor users on their own rows (positive control) + the column-level INSERT / UPDATE grants
  // --------------------------------------------------------------------------

  for (const who of MONITOR_ACCOUNTS) {
    describe(`monitor user (${who.label}) — own rows`, () => {
      it("reads only its own monitors and events", async () => {
        await withTx(client, async (c) => {
          await prepare(c, [MONITOR, OWNER]);
          const monitorRows = await seedMonitorRows(c, MONITOR_UUID);
          const ownerRows = await seedMonitorRows(c, OWNER_UUID);
          const own = who === MONITOR ? monitorRows : ownerRows;
          await asRole(c, "authenticated", who.claims);

          const monitors = await c.query("SELECT id, user_id FROM public.monitors");
          expect(monitors.rows).toEqual([{ id: own.monitorId, user_id: who.userId }]);
          const events = await c.query("SELECT id, monitor_id, user_id FROM public.monitor_events");
          expect(events.rows).toEqual([{ id: own.eventId, monitor_id: own.monitorId, user_id: who.userId }]);
        });
      }, 20_000);

      it("inserts with every insertable column, edits url / label / interval_minutes / status, and deletes its own monitor", async () => {
        await withTx(client, async (c) => {
          await prepare(c, [who]);
          await asRole(c, "authenticated", who.claims);

          const inserted = await c.query<{ id: string }>(
            `INSERT INTO public.monitors (user_id, url, label, interval_minutes, status)
             VALUES ($1, 'https://example.com/new', 'New', 30, 'paused') RETURNING id`,
            [who.userId],
          );
          expect(inserted.rowCount).toBe(1);
          const id = inserted.rows[0]!.id;
          const edit = await c.query(
            `UPDATE public.monitors
                SET url = 'https://example.com/edited', label = 'Edited', interval_minutes = 120, status = 'active'
              WHERE id = $1`,
            [id],
          );
          expect(edit.rowCount).toBe(1);
          const { rows } = await c.query(
            `SELECT user_id, url, label, interval_minutes, status, last_hash, last_snapshot, last_checked_at,
                    consecutive_errors
               FROM public.monitors`,
          );
          expect(rows).toEqual([
            {
              user_id: who.userId,
              url: "https://example.com/edited",
              label: "Edited",
              interval_minutes: 120,
              status: "active",
              last_hash: null,
              last_snapshot: null,
              last_checked_at: null,
              consecutive_errors: 0,
            },
          ]);

          const del = await c.query("DELETE FROM public.monitors WHERE id = $1", [id]);
          expect(del.rowCount).toBe(1);
          expect((await c.query("SELECT id FROM public.monitors")).rows).toEqual([]);
        });
      }, 20_000);

      it("deletes its own event but cannot insert or update one (42501: no privilege)", async () => {
        await withTx(client, async (c) => {
          await prepare(c, [who]);
          const { monitorId, eventId } = await seedMonitorRows(c, who.userId);
          await asRole(c, "authenticated", who.claims);

          await expectPgError(c, () => c.query(INSERT_EVENT, [monitorId, who.userId]), "42501", "INSERT own event");
          await expectPgError(
            c,
            () => c.query("UPDATE public.monitor_events SET emailed_at = now() WHERE id = $1", [eventId]),
            "42501",
            "UPDATE own event",
          );
          await expectPgError(
            c,
            () => c.query("UPDATE public.monitor_events SET summary = 'forged' WHERE id = $1", [eventId]),
            "42501",
            "UPDATE own event summary",
          );

          const del = await c.query("DELETE FROM public.monitor_events WHERE id = $1", [eventId]);
          expect(del.rowCount).toBe(1);
          expect(await storedEvent(c, eventId)).toEqual([]);
        });
      }, 20_000);

      it("cannot name the cron's columns, id, created_at or updated_at in an insert (42501: INSERT is column-level)", async () => {
        await withTx(client, async (c) => {
          await prepare(c, [who]);
          await asRole(c, "authenticated", who.claims);

          for (const [column, value] of INSERT_PROTECTED_COLUMNS) {
            await expectPgError(
              c,
              () =>
                c.query(
                  `INSERT INTO public.monitors (user_id, url, interval_minutes, ${column})
                   VALUES ($1, 'https://example.com/new', 30, ${value})`,
                  [who.userId],
                ),
              "42501",
              `INSERT ${column}`,
              { messageIncludes: "permission denied for table monitors" },
            );
          }
          expect(await monitorCount(c, who.userId)).toBe(0);
        });
      }, 20_000);

      it("cannot write the cron's columns, user_id, id, created_at or updated_at (42501), not even through an upsert; label and interval_minutes still update", async () => {
        await withTx(client, async (c) => {
          await prepare(c, [who]);
          const monitorId = await seedMonitor(c, who.userId);
          await asRole(c, "authenticated", who.claims);

          for (const [column, value] of PROTECTED_COLUMNS) {
            await expectPgError(
              c,
              () => c.query(`UPDATE public.monitors SET ${column} = ${value} WHERE id = $1`, [monitorId]),
              "42501",
              `UPDATE ${column}`,
            );
          }
          // One forbidden column refuses the whole statement, allowed columns included.
          await expectPgError(
            c,
            () => c.query("UPDATE public.monitors SET label = 'x', last_hash = 'forged' WHERE id = $1", [monitorId]),
            "42501",
            "UPDATE label + last_hash",
          );
          // An upsert (PostgREST merge-duplicates) must name the conflict key and the columns it
          // sets in its INSERT: id and the cron's columns are not insertable, so it is refused
          // before any conflict check.
          await expectPgError(
            c,
            () =>
              c.query(
                `INSERT INTO public.monitors (id, user_id, url, interval_minutes, last_hash, last_checked_at)
                 VALUES ($1, $2, $3, $4, 'forged', now() + interval '1 year')
                 ON CONFLICT (id) DO UPDATE SET last_hash = excluded.last_hash, last_checked_at = excluded.last_checked_at`,
                [monitorId, who.userId, SEED.url, SEED.interval_minutes],
              ),
            "42501",
            "upsert last_hash + last_checked_at",
          );
          expect(await storedMonitor(c, monitorId)).toEqual(unchangedMonitor(who.userId));

          await asRole(c, "authenticated", who.claims);
          const edit = await c.query("UPDATE public.monitors SET label = 'Renamed', interval_minutes = 90 WHERE id = $1", [
            monitorId,
          ]);
          expect(edit.rowCount).toBe(1);
          expect(await storedMonitor(c, monitorId)).toEqual([
            { ...unchangedMonitor(who.userId)[0]!, label: "Renamed", interval_minutes: 90 },
          ]);
        });
      }, 20_000);
    });
  }

  // --------------------------------------------------------------------------
  // url / label validation and the new-url baseline
  // --------------------------------------------------------------------------

  it("url must be an http(s) URL without whitespace or <>\" of at most 2048 characters and label at most 200 characters (23514), on insert and update", async () => {
    await withTx(client, async (c) => {
      await prepare(c, [MONITOR]);
      // The accepted inserts below must not meet the cap.
      await c.query("UPDATE public.profiles SET monitor_limit = NULL WHERE user_id = $1", [MONITOR_UUID]);
      const monitorId = await seedMonitor(c, MONITOR_UUID);
      await asRole(c, "authenticated", MONITOR_CLAIMS);

      for (const [kind, url] of INVALID_URLS) {
        await expectPgError(c, () => c.query(INSERT_URL_LABEL, [MONITOR_UUID, url, null]), "23514", `INSERT url ${kind}`, {
          messageIncludes: "monitors_url_valid",
        });
        await expectPgError(
          c,
          () => c.query("UPDATE public.monitors SET url = $1 WHERE id = $2", [url, monitorId]),
          "23514",
          `UPDATE url ${kind}`,
          { messageIncludes: "monitors_url_valid" },
        );
      }
      const label201 = "x".repeat(201);
      await expectPgError(
        c,
        () => c.query(INSERT_URL_LABEL, [MONITOR_UUID, "https://example.com/", label201]),
        "23514",
        "INSERT label of 201",
        { messageIncludes: "monitors_label_length" },
      );
      await expectPgError(
        c,
        () => c.query("UPDATE public.monitors SET label = $1 WHERE id = $2", [label201, monitorId]),
        "23514",
        "UPDATE label of 201",
        { messageIncludes: "monitors_label_length" },
      );
      expect(await storedMonitor(c, monitorId)).toEqual(unchangedMonitor(MONITOR_UUID));

      await asRole(c, "authenticated", MONITOR_CLAIMS);
      for (const url of VALID_URLS) {
        expect((await c.query(INSERT_URL_LABEL, [MONITOR_UUID, url, null])).rowCount).toBe(1);
      }
      expect((await c.query(INSERT_URL_LABEL, [MONITOR_UUID, "https://example.com/", "x".repeat(200)])).rowCount).toBe(1);
      expect(await monitorCount(c, MONITOR_UUID)).toBe(1 + VALID_URLS.length + 1);
    });
  }, 20_000);

  it("a new url clears last_hash and last_snapshot (a new baseline) and resets consecutive_errors where the target's url trigger does (20261108000100); other edits and re-setting the same url keep them", async () => {
    await withTx(client, async (c) => {
      await prepare(c, [MONITOR]);
      const monitorId = await seedMonitor(c, MONITOR_UUID);
      await asRole(c, "authenticated", MONITOR_CLAIMS);

      await c.query("UPDATE public.monitors SET label = 'Renamed', status = 'paused' WHERE id = $1", [monitorId]);
      await c.query("UPDATE public.monitors SET url = $1 WHERE id = $2", [SEED.url, monitorId]);
      const edited = { ...unchangedMonitor(MONITOR_UUID)[0]!, label: "Renamed", status: "paused" };
      expect(await storedMonitor(c, monitorId)).toEqual([edited]);

      await asRole(c, "authenticated", MONITOR_CLAIMS);
      const moved = await c.query("UPDATE public.monitors SET url = 'https://example.com/moved' WHERE id = $1", [
        monitorId,
      ]);
      expect(moved.rowCount).toBe(1);
      expect(await storedMonitor(c, monitorId)).toEqual([
        {
          ...edited, url: "https://example.com/moved", last_hash: null, last_snapshot: null,
          consecutive_errors: target.urlTriggerResetsErrors ? 0 : SEED.consecutive_errors,
        },
      ]);
    });
  }, 20_000);

  // --------------------------------------------------------------------------
  // User A cannot read (or write) user B's rows
  // --------------------------------------------------------------------------

  for (const [a, b] of PAIRS) {
    describe(`user A (${a.label}) on user B (${b.label})'s rows`, () => {
      it("A cannot read B's monitors or events", async () => {
        await withTx(client, async (c) => {
          await prepare(c, [a, b]);
          await seedMonitorRows(c, a.userId);
          const bRows = await seedMonitorRows(c, b.userId);
          await asRole(c, "authenticated", a.claims);

          const reads = [
            await c.query("SELECT id FROM public.monitors WHERE user_id = $1", [b.userId]),
            await c.query("SELECT id FROM public.monitors WHERE id = $1", [bRows.monitorId]),
            await c.query("SELECT id FROM public.monitor_events WHERE user_id = $1", [b.userId]),
            await c.query("SELECT id FROM public.monitor_events WHERE id = $1", [bRows.eventId]),
          ];
          expect(reads.map((r) => r.rows)).toEqual([[], [], [], []]);
        });
      }, 20_000);

      it("A cannot update or delete B's monitors or events", async () => {
        await withTx(client, async (c) => {
          await prepare(c, [a, b]);
          const bRows = await seedMonitorRows(c, b.userId);
          await asRole(c, "authenticated", a.claims);

          const writes = [
            await c.query("UPDATE public.monitors SET label = 'x', status = 'paused' WHERE id = $1", [bRows.monitorId]),
            await c.query("UPDATE public.monitors SET url = 'https://evil.example/' WHERE user_id = $1", [b.userId]),
            await c.query("DELETE FROM public.monitor_events WHERE id = $1", [bRows.eventId]),
            await c.query("DELETE FROM public.monitors WHERE user_id = $1", [b.userId]),
          ];
          expect(writes.map((r) => r.rowCount)).toEqual([0, 0, 0, 0]);

          expect(await storedMonitor(c, bRows.monitorId)).toEqual(unchangedMonitor(b.userId));
          expect(await storedEvent(c, bRows.eventId)).toEqual([{ id: bRows.eventId }]);
        });
      }, 20_000);

      it("A cannot insert a monitor carrying B's user_id, move its own monitor to B, or upsert onto B's monitor (42501)", async () => {
        await withTx(client, async (c) => {
          await prepare(c, [a, b]);
          const aMonitor = await seedMonitor(c, a.userId);
          const bMonitor = await seedMonitor(c, b.userId);
          await asRole(c, "authenticated", a.claims);

          await expectPgError(c, () => c.query(INSERT_MONITOR, [b.userId]), "42501", "INSERT monitor for B", {
            messageIncludes: "row-level security",
          });
          await expectPgError(
            c,
            () => c.query("UPDATE public.monitors SET user_id = $1 WHERE id = $2", [b.userId, aMonitor]),
            "42501",
            "move own monitor to B",
          );
          // A names B's monitor id to upsert onto it: id is not insertable, so no upsert reaches B's row.
          await expectPgError(
            c,
            () =>
              c.query(
                `INSERT INTO public.monitors (id, user_id, url, interval_minutes) VALUES ($1, $2, $3, $4)
                 ON CONFLICT (id) DO UPDATE SET label = excluded.label`,
                [bMonitor, a.userId, SEED.url, SEED.interval_minutes],
              ),
            "42501",
            "upsert onto B's monitor id",
          );

          expect(await storedMonitor(c, aMonitor)).toEqual(unchangedMonitor(a.userId));
          expect(await storedMonitor(c, bMonitor)).toEqual(unchangedMonitor(b.userId));
        });
      }, 20_000);
    });
  }

  // --------------------------------------------------------------------------
  // Role gate: signed in, but not owner / monitor_user
  // --------------------------------------------------------------------------

  for (const who of NON_MONITOR_ACCOUNTS) {
    describe(`no monitor role (${who.label})`, () => {
      it("cannot read, update or delete even its own monitors and events", async () => {
        await withTx(client, async (c) => {
          await prepare(c, [who]);
          const { monitorId, eventId } = await seedMonitorRows(c, who.userId);
          await asRole(c, "authenticated", who.claims);

          expect((await c.query("SELECT id FROM public.monitors")).rows).toEqual([]);
          expect((await c.query("SELECT id FROM public.monitor_events")).rows).toEqual([]);
          const writes = [
            await c.query("UPDATE public.monitors SET label = 'x' WHERE id = $1", [monitorId]),
            await c.query("DELETE FROM public.monitor_events WHERE id = $1", [eventId]),
            await c.query("DELETE FROM public.monitors WHERE id = $1", [monitorId]),
          ];
          expect(writes.map((r) => r.rowCount)).toEqual([0, 0, 0]);

          expect(await storedMonitor(c, monitorId)).toEqual(unchangedMonitor(who.userId));
          expect(await storedEvent(c, eventId)).toEqual([{ id: eventId }]);
        });
      }, 20_000);

      it("cannot insert its own monitor or event (42501)", async () => {
        await withTx(client, async (c) => {
          await prepare(c, [who]);
          const monitorId = await seedMonitor(c, who.userId);
          await asRole(c, "authenticated", who.claims);

          await expectPgError(c, () => c.query(INSERT_MONITOR, [who.userId]), "42501", `${who.label} INSERT monitor`);
          await expectPgError(
            c,
            () => c.query(INSERT_EVENT, [monitorId, who.userId]),
            "42501",
            `${who.label} INSERT event`,
          );
          expect(await monitorCount(c, who.userId)).toBe(1);
        });
      }, 20_000);
    });
  }

  // --------------------------------------------------------------------------
  // The other way round: monitor_user gets nothing from the admin and MyLife gates
  // --------------------------------------------------------------------------

  it("a monitor_user gets no admin or owner access: is_admin() and is_owner() are false, drafts and the allowlist stay hidden, admin-only writes are refused", async () => {
    await withTx(client, async (c) => {
      await prepare(c, [MONITOR]);
      const cap = await defaultCap(c);
      const draftId = await seedDraftPage(c);
      await seedSiteSettings(c);
      await asRole(c, "authenticated", MONITOR_CLAIMS);

      const gates = await c.query(
        "SELECT private.is_admin() AS is_admin, private.is_owner() AS is_owner, private.is_monitor() AS is_monitor",
      );
      expect(gates.rows).toEqual([{ is_admin: false, is_owner: false, is_monitor: true }]);
      expect((await c.query("SELECT id FROM public.pages WHERE id = $1", [draftId])).rows).toEqual([]);
      expect((await c.query("SELECT email FROM public.user_allowlist")).rows).toEqual([]);
      expect((await c.query("SELECT user_id FROM public.profiles")).rows).toEqual([{ user_id: MONITOR_UUID }]);

      const writes = [
        await c.query("UPDATE public.profiles SET role = 'owner' WHERE user_id = $1", [MONITOR_UUID]),
        await c.query("UPDATE public.profiles SET monitor_limit = NULL WHERE user_id = $1", [MONITOR_UUID]),
        await c.query("UPDATE public.site_settings SET company_name = 'Hijacked'"),
        await c.query("UPDATE public.pages SET status = 'published', published_at = now() WHERE id = $1", [draftId]),
        await c.query("DELETE FROM public.pages WHERE id = $1", [draftId]),
      ];
      expect(writes.map((r) => r.rowCount)).toEqual([0, 0, 0, 0, 0]);
      await expectPgError(
        c,
        () => c.query("INSERT INTO public.user_allowlist (email, role) VALUES ('takeover@test.local', 'owner')"),
        "42501",
        "allowlist insert",
      );
      await expectPgError(c, () => c.query("INSERT INTO public.pages (status) VALUES ('draft')"), "42501", "page insert");

      await c.query("RESET ROLE");
      const profile = await c.query("SELECT role, monitor_limit FROM public.profiles WHERE user_id = $1", [MONITOR_UUID]);
      expect(profile.rows).toEqual([{ role: "monitor_user", monitor_limit: cap }]);
      const draft = await c.query("SELECT status FROM public.pages WHERE id = $1", [draftId]);
      expect(draft.rows).toEqual([{ status: "draft" }]);
    });
  }, 20_000);

  it("a monitor_user gets no MyLife access: is_mylife() is false, its own MyLife rows stay hidden and unwritable (42501 on insert)", async ({
    skip,
  }) => {
    skip(
      !target.myLifeApplied,
      "the target has no MyLife schema (20261105000300 / 0400); rls-mylife covers monitor_user where it does",
    );
    await withTx(client, async (c) => {
      await prepare(c, [MONITOR]);
      const eventId = randomUUID();
      await c.query("INSERT INTO public.mylife_profile (user_id, name) VALUES ($1, 'Seeded')", [MONITOR_UUID]);
      await c.query(
        "INSERT INTO public.mylife_events (id, user_id, utc_ms, type, value) VALUES ($1, $2, 1762300000000, 1, '5.4')",
        [eventId, MONITOR_UUID],
      );
      await asRole(c, "authenticated", MONITOR_CLAIMS);

      expect((await c.query("SELECT private.is_mylife() AS is_mylife")).rows).toEqual([{ is_mylife: false }]);
      expect((await c.query("SELECT user_id FROM public.mylife_profile")).rows).toEqual([]);
      expect((await c.query("SELECT id FROM public.mylife_events")).rows).toEqual([]);
      const writes = [
        await c.query("UPDATE public.mylife_profile SET name = 'x' WHERE user_id = $1", [MONITOR_UUID]),
        await c.query("UPDATE public.mylife_events SET value = '1' WHERE id = $1", [eventId]),
        await c.query("DELETE FROM public.mylife_events WHERE id = $1", [eventId]),
      ];
      expect(writes.map((r) => r.rowCount)).toEqual([0, 0, 0]);
      await expectPgError(
        c,
        () =>
          c.query("INSERT INTO public.mylife_events (id, user_id, utc_ms, type) VALUES ($1, $2, 1762300000000, 1)", [
            randomUUID(),
            MONITOR_UUID,
          ]),
        "42501",
        "monitor_user INSERT mylife event",
      );

      await c.query("RESET ROLE");
      const stored = await c.query("SELECT value FROM public.mylife_events WHERE user_id = $1", [MONITOR_UUID]);
      expect(stored.rows).toEqual([{ value: "5.4" }]);
    });
  }, 20_000);

  // --------------------------------------------------------------------------
  // The cron: service role
  // --------------------------------------------------------------------------

  it("the service role inserts events and writes the cron's columns; the user then sees the event", async () => {
    await withTx(client, async (c) => {
      await prepare(c, [MONITOR]);
      const monitorId = await seedMonitor(c, MONITOR_UUID);
      await asServiceRole(c);

      const event = await c.query<{ id: string }>(`${INSERT_EVENT} RETURNING id`, [monitorId, MONITOR_UUID]);
      expect(event.rowCount).toBe(1);
      const eventId = event.rows[0]!.id;
      const emailed = await c.query("UPDATE public.monitor_events SET emailed_at = now() WHERE id = $1", [eventId]);
      expect(emailed.rowCount).toBe(1);
      const checked = await c.query(
        `UPDATE public.monitors
            SET last_hash = 'cron-hash', last_snapshot = 'cron snapshot',
                last_checked_at = '2026-11-06T09:00:00Z', consecutive_errors = 0
          WHERE id = $1`,
        [monitorId],
      );
      expect(checked.rowCount).toBe(1);

      await asRole(c, "authenticated", MONITOR_CLAIMS);
      const events = await c.query("SELECT id, monitor_id, summary, emailed_at IS NOT NULL AS emailed FROM public.monitor_events");
      expect(events.rows).toEqual([{ id: eventId, monitor_id: monitorId, summary: "Changed", emailed: true }]);
      expect(await storedMonitor(c, monitorId)).toEqual([
        {
          ...unchangedMonitor(MONITOR_UUID)[0]!,
          last_hash: "cron-hash",
          last_snapshot: "cron snapshot",
          last_checked_at: "2026-11-06T09:00:00Z",
          consecutive_errors: 0,
        },
      ]);
    });
  }, 20_000);

  it("an event's user_id is always its monitor's owner (23503, even for the service role), and deleting a monitor deletes its events", async () => {
    await withTx(client, async (c) => {
      await prepare(c, [MONITOR, OWNER]);
      const { monitorId, eventId } = await seedMonitorRows(c, MONITOR_UUID);
      await asServiceRole(c);

      await expectPgError(
        c,
        () => c.query(INSERT_EVENT, [monitorId, OWNER_UUID]),
        "23503",
        "event on MONITOR's monitor carrying OWNER's user_id",
        { messageIncludes: "monitor_events_monitor_owner_fkey" },
      );
      await expectPgError(
        c,
        () => c.query("UPDATE public.monitor_events SET user_id = $1 WHERE id = $2", [OWNER_UUID, eventId]),
        "23503",
        "re-own an event",
        { messageIncludes: "monitor_events_monitor_owner_fkey" },
      );

      await asRole(c, "authenticated", MONITOR_CLAIMS);
      expect((await c.query("DELETE FROM public.monitors WHERE id = $1", [monitorId])).rowCount).toBe(1);
      expect(await storedEvent(c, eventId)).toEqual([]);
    });
  }, 20_000);

  // --------------------------------------------------------------------------
  // monitors_limit_per_user
  // --------------------------------------------------------------------------

  it("MCH-AC5f: the default cap of 2 refuses a 3rd monitor (P0001 monitor_limit_reached), for the service role too; a user cannot lift its own cap", async ({
    skip,
  }) => {
    skip(!target.freeLimitApplied, FREE_LIMIT_SKIP_REASON);
    await withTx(client, async (c) => {
      await prepare(c, [MONITOR]);
      expect(await monitorLimit(c, MONITOR_UUID)).toBe(2);
      await asRole(c, "authenticated", MONITOR_CLAIMS);

      const ids: string[] = [];
      for (let i = 0; i < 2; i++) {
        ids.push((await c.query<{ id: string }>(INSERT_MONITOR, [MONITOR_UUID])).rows[0]!.id);
      }
      await expectPgError(c, () => c.query(INSERT_MONITOR, [MONITOR_UUID]), "P0001", "3rd monitor", {
        messageIncludes: "monitor_limit_reached",
      });

      // The cap counts the monitors held now: deleting one frees a slot.
      expect((await c.query("DELETE FROM public.monitors WHERE id = $1", [ids[0]])).rowCount).toBe(1);
      expect((await c.query(INSERT_MONITOR, [MONITOR_UUID])).rowCount).toBe(1);
      await expectPgError(c, () => c.query(INSERT_MONITOR, [MONITOR_UUID]), "P0001", "3rd monitor after refill", {
        messageIncludes: "monitor_limit_reached",
      });

      // profiles UPDATE is owner-only: the row is filtered out, the cap stays.
      const lift = await c.query("UPDATE public.profiles SET monitor_limit = NULL WHERE user_id = $1", [MONITOR_UUID]);
      expect(lift.rowCount).toBe(0);

      await asServiceRole(c);
      await expectPgError(c, () => c.query(INSERT_MONITOR, [MONITOR_UUID]), "P0001", "service role 3rd monitor", {
        messageIncludes: "monitor_limit_reached",
      });

      expect(await monitorCount(c, MONITOR_UUID)).toBe(2);
      expect(await monitorLimit(c, MONITOR_UUID)).toBe(2);
    });
  }, 20_000);

  it("monitor_limit NULL is unlimited and 0 allows none; a negative cap is refused (23514)", async () => {
    await withTx(client, async (c) => {
      await prepare(c, [MONITOR]);
      await expectPgError(
        c,
        () => c.query("UPDATE public.profiles SET monitor_limit = -1 WHERE user_id = $1", [MONITOR_UUID]),
        "23514",
        "negative cap",
        { messageIncludes: "profiles_monitor_limit_nonnegative" },
      );

      await c.query("UPDATE public.profiles SET monitor_limit = NULL WHERE user_id = $1", [MONITOR_UUID]);
      await asRole(c, "authenticated", MONITOR_CLAIMS);
      for (let i = 0; i < 8; i++) {
        expect((await c.query(INSERT_MONITOR, [MONITOR_UUID])).rowCount).toBe(1);
      }
      expect(await monitorCount(c, MONITOR_UUID)).toBe(8);

      await c.query("DELETE FROM public.monitors WHERE user_id = $1", [MONITOR_UUID]);
      await c.query("UPDATE public.profiles SET monitor_limit = 0 WHERE user_id = $1", [MONITOR_UUID]);
      await asRole(c, "authenticated", MONITOR_CLAIMS);
      await expectPgError(c, () => c.query(INSERT_MONITOR, [MONITOR_UUID]), "P0001", "first monitor at cap 0", {
        messageIncludes: "monitor_limit_reached",
      });
      expect(await monitorCount(c, MONITOR_UUID)).toBe(0);
    });
  }, 20_000);

  it("MCH-AC5g: the owner role is unlimited whatever monitor_limit holds: an owner with the default cap holds more than that cap, a promoted owner too, and a demoted one falls back to its cap", async () => {
    await withTx(client, async (c) => {
      await prepare(c, [OWNER, MONITOR]);
      // Both accounts start at the target's default cap, below the 7 and 8 monitors held below.
      const cap = await defaultCap(c);
      expect(cap).toBeLessThan(7);
      expect(await monitorLimit(c, OWNER_UUID)).toBe(cap);
      await asRole(c, "authenticated", OWNER_CLAIMS);
      for (let i = 0; i < 8; i++) {
        expect((await c.query(INSERT_MONITOR, [OWNER_UUID])).rowCount).toBe(1);
      }
      expect(await monitorCount(c, OWNER_UUID)).toBe(8);

      // Promoted later, with no monitor_limit change: unlimited at once.
      await c.query("UPDATE public.profiles SET role = 'owner' WHERE user_id = $1", [MONITOR_UUID]);
      await asRole(c, "authenticated", MONITOR_CLAIMS);
      for (let i = 0; i < 7; i++) {
        expect((await c.query(INSERT_MONITOR, [MONITOR_UUID])).rowCount).toBe(1);
      }

      // Demoted again (OWNER stays, so the last-owner guard passes): its own default cap applies.
      await c.query("RESET ROLE");
      await c.query("UPDATE public.profiles SET role = 'monitor_user' WHERE user_id = $1", [MONITOR_UUID]);
      await asRole(c, "authenticated", MONITOR_CLAIMS);
      await expectPgError(c, () => c.query(INSERT_MONITOR, [MONITOR_UUID]), "P0001", "demoted owner above its cap", {
        messageIncludes: "monitor_limit_reached",
      });
      expect(await monitorCount(c, MONITOR_UUID)).toBe(7);
      expect(await monitorLimit(c, MONITOR_UUID)).toBe(cap);
    });
  }, 20_000);

  it("a user inserting for another user who is at their cap gets RLS's 42501, never that user's P0001; the service role's insert is still counted", async () => {
    await withTx(client, async (c) => {
      await prepare(c, [OWNER, MONITOR, MYLIFE]);
      // Both targets are at their cap: 0 allows none.
      await c.query("UPDATE public.profiles SET monitor_limit = 0 WHERE user_id = ANY ($1::uuid[])", [
        [MONITOR_UUID, MYLIFE_UUID],
      ]);

      await asRole(c, "authenticated", OWNER_CLAIMS);
      await expectPgError(c, () => c.query(INSERT_MONITOR, [MONITOR_UUID]), "42501", "owner inserts for a capped monitor_user", {
        messageIncludes: "row-level security",
      });
      await asRole(c, "authenticated", MONITOR_CLAIMS);
      await expectPgError(c, () => c.query(INSERT_MONITOR, [MYLIFE_UUID]), "42501", "monitor_user inserts for a capped mylife_user", {
        messageIncludes: "row-level security",
      });
      // Its own insert is counted.
      await expectPgError(c, () => c.query(INSERT_MONITOR, [MONITOR_UUID]), "P0001", "own insert at cap 0", {
        messageIncludes: "monitor_limit_reached",
      });

      await asServiceRole(c);
      await expectPgError(c, () => c.query(INSERT_MONITOR, [MONITOR_UUID]), "P0001", "service role at cap 0", {
        messageIncludes: "monitor_limit_reached",
      });

      expect(await monitorCount(c, MONITOR_UUID)).toBe(0);
      expect(await monitorCount(c, MYLIFE_UUID)).toBe(0);
    });
  }, 20_000);

  it("concurrent at-cap inserts serialize on the user's profile row: the second waits for the first (55P03 under lock_timeout) and, once the first commits, is refused (P0001)", async ({
    skip,
  }) => {
    skip(!ON_E2E_PROJECT, "commits a fixture user: e2e project only");
    skip(
      !target.schemaApplied,
      "two connections cannot share a migration applied in an open transaction: needs 20261106000200 committed on the e2e project",
    );

    const second = await getClient();
    try {
      // COMMITTED on the e2e project (client is outside a transaction): a user with a cap of 1.
      await removeRaceUser(client);
      await seedRaceUser(client);
      const PID = "SELECT pg_backend_pid() AS pid";
      const firstPid = (await client.query<{ pid: number }>(PID)).rows[0]!.pid;
      const secondPid = (await second.query<{ pid: number }>(PID)).rows[0]!.pid;

      await client.query("BEGIN");
      try {
        await asRole(client, "authenticated", RACE_CLAIMS);
        // Takes the last slot and holds the profile row lock until this transaction ends.
        expect((await client.query(INSERT_MONITOR, [RACE_UUID])).rowCount).toBe(1);

        await withTx(second, async (b) => {
          await b.query("SET LOCAL lock_timeout = '500ms'");
          await asRole(b, "authenticated", RACE_CLAIMS);
          await expectPgError(b, () => b.query(INSERT_MONITOR, [RACE_UUID]), "55P03", "concurrent at-cap insert", {
            messageIncludes: "lock timeout",
          });
        });

        // Without a timeout the second insert waits; once the first commits it counts that
        // monitor (a new snapshot per statement) and is refused.
        await second.query("BEGIN");
        const outcome = (async () => {
          await asRole(second, "authenticated", RACE_CLAIMS);
          await second.query(INSERT_MONITOR, [RACE_UUID]);
        })().then(
          () => undefined,
          (error: unknown) => error,
        );
        try {
          await waitUntilBlocked(client, secondPid, firstPid);
        } finally {
          // Ends the first transaction even when the wait failed, so the second can finish.
          await client.query("COMMIT");
        }
        expect(await outcome).toMatchObject({ code: "P0001", message: "monitor_limit_reached" });
      } finally {
        // No-ops for a transaction that already ended.
        await client.query("ROLLBACK");
        await second.query("ROLLBACK");
      }
      expect(await monitorCount(client, RACE_UUID)).toBe(1);
    } finally {
      await removeRaceUser(client);
      second.release();
    }
  }, 30_000);

  // --------------------------------------------------------------------------
  // Catalog: no other policy or grant can widen access
  // --------------------------------------------------------------------------

  it("exactly the six monitor policies exist, permissive for authenticated, each requiring ownership AND private.is_monitor()", async () => {
    await withTx(client, async (c) => {
      await prepare(c, []);
      const { rows } = await c.query<{
        policy: string;
        permissive: string;
        roles: string[];
        cmd: string;
        qual: string | null;
        with_check: string | null;
      }>(
        `SELECT tablename || '.' || policyname AS policy, permissive, roles::text[] AS roles, cmd, qual, with_check
           FROM pg_policies
          WHERE schemaname = 'public' AND tablename IN ('monitors', 'monitor_events')`,
      );
      /** null = no such clause; true = the clause checks both ownership and the monitor role. */
      const gated = (expr: string | null) =>
        expr === null ? null : expr.includes("auth.uid()") && expr.includes("private.is_monitor()");
      const actual = rows
        .map((r) => ({
          policy: r.policy,
          permissive: r.permissive,
          roles: r.roles,
          cmd: r.cmd,
          using: gated(r.qual),
          check: gated(r.with_check),
        }))
        .sort((x, y) => (x.policy < y.policy ? -1 : 1));

      // SELECT / DELETE: USING only; INSERT: WITH CHECK only; UPDATE: both.
      const policy = (table: "monitor_events" | "monitors", cmd: "SELECT" | "INSERT" | "UPDATE" | "DELETE") => ({
        policy: `${table}.${table}_${cmd.toLowerCase()}`,
        permissive: "PERMISSIVE",
        roles: ["authenticated"],
        cmd,
        using: cmd === "INSERT" ? null : true,
        check: cmd === "INSERT" || cmd === "UPDATE" ? true : null,
      });
      expect(actual).toEqual([
        policy("monitor_events", "DELETE"),
        policy("monitor_events", "SELECT"),
        policy("monitors", "DELETE"),
        policy("monitors", "INSERT"),
        policy("monitors", "SELECT"),
        policy("monitors", "UPDATE"),
      ]);
    });
  }, 20_000);

  it("privileges: anon none; authenticated SELECT/DELETE on monitors plus INSERT of user_id, url, label, interval_minutes, status and UPDATE of url, label, interval_minutes, status only, SELECT/DELETE on monitor_events; EXECUTE on is_monitor() only", async () => {
    await withTx(client, async (c) => {
      await prepare(c, []);
      const TABLE_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
      const tables = await c.query<{ grantee: string; tbl: string; privs: string[]; any_column: string[] }>(
        `SELECT g.grantee, t.tbl,
                ARRAY(SELECT p FROM unnest($1::text[]) WITH ORDINALITY AS u(p, n)
                       WHERE has_table_privilege(g.grantee, t.tbl, p) ORDER BY n) AS privs,
                ARRAY(SELECT p FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) WITH ORDINALITY AS u(p, n)
                       WHERE has_any_column_privilege(g.grantee, t.tbl, p) ORDER BY n) AS any_column
           FROM unnest(ARRAY['anon', 'authenticated']) AS g(grantee)
          CROSS JOIN unnest(ARRAY['public.monitors', 'public.monitor_events']) AS t(tbl)`,
        [TABLE_PRIVILEGES],
      );
      expect(
        Object.fromEntries(tables.rows.map((r) => [`${r.grantee} ${r.tbl}`, { table: r.privs, anyColumn: r.any_column }])),
      ).toEqual({
        "anon public.monitors": { table: [], anyColumn: [] },
        "anon public.monitor_events": { table: [], anyColumn: [] },
        "authenticated public.monitors": {
          table: ["SELECT", "DELETE"],
          anyColumn: ["SELECT", "INSERT", "UPDATE"],
        },
        "authenticated public.monitor_events": { table: ["SELECT", "DELETE"], anyColumn: ["SELECT"] },
      });

      const columns = await c.query<{ privilege: string; columns: string[] }>(
        `SELECT p.privilege,
                ARRAY(SELECT a.attname::text FROM pg_attribute a
                       WHERE a.attrelid = 'public.monitors'::regclass AND a.attnum > 0 AND NOT a.attisdropped
                         AND has_column_privilege('authenticated', a.attrelid, a.attnum, p.privilege)
                       ORDER BY a.attnum) AS columns
           FROM unnest(ARRAY['INSERT', 'UPDATE']) AS p(privilege)`,
      );
      expect(Object.fromEntries(columns.rows.map((r) => [r.privilege, r.columns]))).toEqual({
        INSERT: ["user_id", "url", "label", "interval_minutes", "status"],
        UPDATE: ["url", "label", "interval_minutes", "status"],
      });

      const functions = await c.query<{ fn: string; grantee: string; can: boolean }>(
        `SELECT f.fn, g.grantee, has_function_privilege(g.grantee, f.fn, 'EXECUTE') AS can
           FROM unnest(ARRAY['private.is_monitor()', 'private.monitors_limit_per_user()',
                             'private.monitors_reset_on_url_change()']) AS f(fn)
          CROSS JOIN unnest(ARRAY['public', 'anon', 'authenticated']) AS g(grantee)`,
      );
      expect(Object.fromEntries(functions.rows.map((r) => [`${r.grantee} ${r.fn}`, r.can]))).toEqual({
        "public private.is_monitor()": false,
        "anon private.is_monitor()": false,
        "authenticated private.is_monitor()": true,
        "public private.monitors_limit_per_user()": false,
        "anon private.monitors_limit_per_user()": false,
        "authenticated private.monitors_limit_per_user()": false,
        "public private.monitors_reset_on_url_change()": false,
        "anon private.monitors_reset_on_url_change()": false,
        "authenticated private.monitors_reset_on_url_change()": false,
      });
    });
  }, 20_000);
});
