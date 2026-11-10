/**
 * Integration tests — admin_delete_monitor_user RPC (admin-monitor-users-cleanup)
 * Journey: admin-monitor-users-cleanup  AMC-29, AMC-30, AMC-31, AMC-32, AMC-33, AMC-34
 *
 * Migration: 20261111000200_admin_delete_monitor_user.sql
 *
 * Approach:
 *  - describe.skipIf(!process.env.SUPABASE_E2E_REF): all tests run only on
 *    the isolated e2e Supabase project where the migration is applied.
 *  - Every test runs inside withTx (always rolled back) — in-transaction
 *    visibility is sufficient to verify both deletion and row survival.
 *  - afterEach sweeps fixture emails as a belt-and-braces guard.
 *
 * Connection: postgres (superuser) throughout — asRole switches the JWT for
 * the duration of the RPC call.
 *
 * UUIDs: 0a32 namespace (amd → admin-monitor-delete) — no overlap with 0a30/0a31.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "./helpers/db.js";
import { getClient } from "./helpers/db.js";
import {
  ADMIN_CLAIMS,
  ANON_CLAIMS,
  NON_ADMIN_FIXTURES,
  asRole,
  expectPgError,
  seedAdmin,
  seedAuthUser,
  seedRolelessUser,
  withTx,
  type NonAdminFixture,
} from "./helpers/roles.js";

// ── Local fixture UUIDs/emails ────────────────────────────────────────────────
// Prefixed 0a32 (amd → admin-monitor-delete).

/** monitor_user to be deleted in the success test. */
const TARGET_UUID  = "00000000-0000-0000-0a32-000000000001";
const TARGET_EMAIL = "e2e-amd-target@alnyron-test.local";

/** owner account — admin_delete_monitor_user must NOT delete it (P0001). */
const OWNER_AC_UUID  = "00000000-0000-0000-0a32-000000000002";
const OWNER_AC_EMAIL = "e2e-amd-owner@alnyron-test.local";

/** mylife_user account — admin_delete_monitor_user must NOT delete it (P0001). */
const MYLIFE_AC_UUID  = "00000000-0000-0000-0a32-000000000003";
const MYLIFE_AC_EMAIL = "e2e-amd-mylife@alnyron-test.local";

/** admin account — admin_delete_monitor_user must NOT delete it (P0001). */
const ADMIN_AC_UUID  = "00000000-0000-0000-0a32-000000000004";
const ADMIN_AC_EMAIL = "e2e-amd-admin2@alnyron-test.local";

/** monitor_user used as the access-control fixture (non-admin caller). */
const MONITOR_AC_UUID  = "00000000-0000-0000-0a32-000000000005";
const MONITOR_AC_EMAIL = "e2e-amd-monac@alnyron-test.local";

/** null-role (staff, role cleared after creation) — P0001 not_monitor_user expected. */
const NULL_AC_UUID  = "00000000-0000-0000-0a32-000000000006";
const NULL_AC_EMAIL = "e2e-amd-null@alnyron-test.local";

// ── RPC helpers ───────────────────────────────────────────────────────────────

async function callDeleteRpc(c: PoolClient, userId: string | null): Promise<void> {
  await c.query("SELECT public.admin_delete_monitor_user($1::uuid)", [userId]);
}

// ── Seed helpers ──────────────────────────────────────────────────────────────

/**
 * Seed a monitor_user (TARGET_UUID) with 2 monitors, a monitor event, a
 * monitor_email_log row and a monitor_engine_strikes row (the engine-only
 * tables keyed on auth.users). Returns the monitor ids so callers can verify
 * cascade.
 */
async function seedTargetWithMonitors(c: PoolClient): Promise<{ monitorIds: string[] }> {
  await c.query(
    `INSERT INTO auth.users
       (id, aud, role, email, email_confirmed_at, created_at, updated_at,
        raw_app_meta_data, raw_user_meta_data, is_super_admin, encrypted_password)
     VALUES ($1, 'authenticated', 'authenticated', $2, now(), now(), now(),
             '{}'::jsonb, '{}'::jsonb, false, '')`,
    [TARGET_UUID, TARGET_EMAIL],
  );
  // profile auto-created by trigger; set monitor_limit
  await c.query(
    `UPDATE public.profiles SET monitor_limit = 5 WHERE user_id = $1`,
    [TARGET_UUID],
  );

  const { rows: monRows } = await c.query<{ id: string }>(
    `INSERT INTO public.monitors (user_id, url, label, status, consecutive_errors, interval_minutes)
     VALUES ($1, 'https://amd-a.example.com', 'AMD A', 'active', 0, 1440),
            ($1, 'https://amd-b.example.com', 'AMD B', 'active', 0, 1440)
     RETURNING id`,
    [TARGET_UUID],
  );
  const monitorIds = monRows.map((r) => r.id);

  // Seed a monitor event on monitor[0]
  if (monitorIds[0]) {
    await c.query(
      `INSERT INTO public.monitor_events (monitor_id, user_id, detected_at, summary)
       VALUES ($1, $2, now(), 'test event')`,
      [monitorIds[0], TARGET_UUID],
    );
  }

  // Engine-only rows of the account (20261108000100_monitor_engine.sql)
  await c.query(
    `INSERT INTO public.monitor_email_log (user_id, kind) VALUES ($1, 'change')`,
    [TARGET_UUID],
  );
  await c.query(
    `INSERT INTO public.monitor_engine_strikes (user_id, strikes) VALUES ($1, 1)`,
    [TARGET_UUID],
  );

  return { monitorIds };
}

/** TARGET_UUID's monitor_email_log and monitor_engine_strikes row counts (read as postgres). */
async function engineRowCounts(c: PoolClient): Promise<{ email_log: number; strikes: number }> {
  const { rows } = await c.query<{ email_log: number; strikes: number }>(
    `SELECT (SELECT count(*)::int FROM public.monitor_email_log WHERE user_id = $1) AS email_log,
            (SELECT count(*)::int FROM public.monitor_engine_strikes WHERE user_id = $1) AS strikes`,
    [TARGET_UUID],
  );
  return rows[0]!;
}

// ── monitor_user caller (non-admin) ──────────────────────────────────────────

const MONITOR_USER_FIXTURE: NonAdminFixture = {
  label: "profile role=monitor_user",
  claims: { sub: MONITOR_AC_UUID, role: "authenticated", email: MONITOR_AC_EMAIL },
  seed: async (c) => {
    await seedAuthUser(c, MONITOR_AC_UUID, MONITOR_AC_EMAIL);
    // No allowlist row → trigger creates monitor_user profile
    const { rows } = await c.query<{ role: string | null }>(
      "SELECT role FROM public.profiles WHERE user_id = $1",
      [MONITOR_AC_UUID],
    );
    expect(rows, "seedAuthUser without allowlist row yields monitor_user").toEqual([
      { role: "monitor_user" },
    ]);
  },
};

// ── describe.skipIf: skip when SUPABASE_E2E_REF is absent ────────────────────

describe.skipIf(!process.env.SUPABASE_E2E_REF)("RLS — admin_delete_monitor_user", () => {
  let client: PoolClient;

  beforeAll(async () => {
    client = await getClient();
  });

  afterAll(async () => {
    client.release();
  });

  // Best-effort cleanup of any leftovers from aborted runs
  afterEach(async () => {
    await client.query(
      `DELETE FROM auth.users WHERE email = ANY($1::text[])`,
      [[TARGET_EMAIL, OWNER_AC_EMAIL, MYLIFE_AC_EMAIL, ADMIN_AC_EMAIL, MONITOR_AC_EMAIL, NULL_AC_EMAIL]],
    );
  });

  // ── AMC-29: anon → 42501 ─────────────────────────────────────────────────

  it("AMC-29: anon caller → 42501 permission denied for function", async () => {
    await withTx(client, async (c) => {
      await asRole(c, "anon", ANON_CLAIMS);

      await expectPgError(
        c,
        () => callDeleteRpc(c, TARGET_UUID),
        "42501",
        "admin_delete_monitor_user as anon",
        { messageIncludes: "permission denied for function" },
      );
    });
  }, 15_000);

  // ── AMC-30: non-admin authenticated → 42501, nothing deleted ─────────────

  const deniedCallers: readonly (readonly [string, NonAdminFixture])[] = [
    ...NON_ADMIN_FIXTURES.map((f) => ["AMC-30", f] as const),
    ["AMC-30", MONITOR_USER_FIXTURE],
  ];

  for (const [ac, fixture] of deniedCallers) {
    it(`${ac}: ${fixture.label} → 42501 (insufficient_privilege), no row deleted`, async () => {
      await withTx(client, async (c) => {
        await fixture.seed(c);
        await seedTargetWithMonitors(c);
        await asRole(c, "authenticated", fixture.claims);

        await expectPgError(
          c,
          () => callDeleteRpc(c, TARGET_UUID),
          "42501",
          `admin_delete_monitor_user as ${fixture.label}`,
          { messageIncludes: "forbidden" },
        );

        // Reset to postgres before checking — authenticated role lacks SELECT on auth.users.
        await c.query("RESET role; RESET request.jwt.claims");

        // auth.users row still present
        const { rows: authRows } = await c.query<{ id: string }>(
          "SELECT id FROM auth.users WHERE id = $1",
          [TARGET_UUID],
        );
        expect(authRows).toHaveLength(1);

        // profile still present
        const { rows: profRows } = await c.query<{ user_id: string }>(
          "SELECT user_id FROM public.profiles WHERE user_id = $1",
          [TARGET_UUID],
        );
        expect(profRows).toHaveLength(1);
      });
    }, 15_000);
  }

  // ── AMC-31: admin deletes monitor_user → cascade ─────────────────────────
  // withTx rolls back, but the DELETE is visible inside the transaction, so
  // we can verify all cascaded rows disappear before rollback cleans up.

  it("AMC-31: admin deletes monitor_user → auth.users + profiles + monitors + events + monitor_email_log + monitor_engine_strikes gone (in-tx)", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const { monitorIds } = await seedTargetWithMonitors(c);

      // The engine-only rows exist before the delete (so their absence afterwards is the cascade).
      expect(await engineRowCounts(c)).toEqual({ email_log: 1, strikes: 1 });

      await asRole(c, "authenticated", ADMIN_CLAIMS);

      await callDeleteRpc(c, TARGET_UUID);

      // Reset to postgres to verify cascade inside the transaction
      await c.query("RESET role; RESET request.jwt.claims");

      // auth.users gone
      const { rows: authRows } = await c.query<{ id: string }>(
        "SELECT id FROM auth.users WHERE id = $1",
        [TARGET_UUID],
      );
      expect(authRows).toHaveLength(0);

      // profiles cascade
      const { rows: profileRows } = await c.query<{ user_id: string }>(
        "SELECT user_id FROM public.profiles WHERE user_id = $1",
        [TARGET_UUID],
      );
      expect(profileRows).toHaveLength(0);

      // monitors cascade
      const { rows: monRows } = await c.query<{ id: string }>(
        "SELECT id FROM public.monitors WHERE id = ANY($1::uuid[])",
        [monitorIds],
      );
      expect(monRows).toHaveLength(0);

      // monitor_events cascade (via monitors)
      const { rows: eventRows } = await c.query<{ id: string }>(
        "SELECT id FROM public.monitor_events WHERE monitor_id = ANY($1::uuid[])",
        [monitorIds],
      );
      expect(eventRows).toHaveLength(0);

      // monitor_email_log + monitor_engine_strikes cascade (auth.users on delete cascade)
      expect(await engineRowCounts(c)).toEqual({ email_log: 0, strikes: 0 });
    });
  }, 20_000);

  // ── AMC-32: admin on non-monitor_user role → P0001 not_monitor_user ────────
  // Covers: owner, admin, mylife_user, and null-role (SQL NULL <> 'monitor_user'
  // is NULL, not TRUE, so the guard must handle it explicitly).

  const nonMonitorRoles: Array<{
    label: string;
    uuid: string;
    seed: (c: PoolClient) => Promise<void>;
  }> = [
    {
      label: "role=owner",
      uuid: OWNER_AC_UUID,
      seed: (c) => seedAuthUser(c, OWNER_AC_UUID, OWNER_AC_EMAIL, "owner"),
    },
    {
      label: "role=admin",
      uuid: ADMIN_AC_UUID,
      seed: (c) => seedAuthUser(c, ADMIN_AC_UUID, ADMIN_AC_EMAIL, "admin"),
    },
    {
      label: "role=mylife_user",
      uuid: MYLIFE_AC_UUID,
      seed: (c) => seedAuthUser(c, MYLIFE_AC_UUID, MYLIFE_AC_EMAIL, "mylife_user"),
    },
    {
      label: "role=NULL (staff with cleared allowlist)",
      uuid: NULL_AC_UUID,
      seed: (c) => seedRolelessUser(c, NULL_AC_UUID, NULL_AC_EMAIL),
    },
  ];

  for (const { label, uuid, seed } of nonMonitorRoles) {
    it(`AMC-32: admin deletes ${label} → P0001 not_monitor_user, row intact`, async () => {
      await withTx(client, async (c) => {
        await seedAdmin(c);
        await seed(c);
        await asRole(c, "authenticated", ADMIN_CLAIMS);

        await expectPgError(
          c,
          () => callDeleteRpc(c, uuid),
          "P0001",
          `admin_delete_monitor_user on ${label}`,
          { messageIncludes: "not_monitor_user" },
        );

        // Reset to postgres before verifying — authenticated lacks auth.users access
        await c.query("RESET role; RESET request.jwt.claims");

        // Target auth.users row still present
        const { rows: authRows } = await c.query<{ id: string }>(
          "SELECT id FROM auth.users WHERE id = $1",
          [uuid],
        );
        expect(authRows).toHaveLength(1);

        // Target profiles row still present
        const { rows: profRows } = await c.query<{ user_id: string }>(
          "SELECT user_id FROM public.profiles WHERE user_id = $1",
          [uuid],
        );
        expect(profRows).toHaveLength(1);
      });
    }, 15_000);
  }

  // ── AMC-33: unknown or null id → P0002 ───────────────────────────────────

  it("AMC-33a: admin, unknown UUID → P0002 not_found", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      const unknownId = "00000000-0000-0000-ffff-000000000099";
      await expectPgError(
        c,
        () => callDeleteRpc(c, unknownId),
        "P0002",
        "admin_delete_monitor_user with unknown UUID",
        { messageIncludes: "not_found" },
      );
    });
  }, 15_000);

  it("AMC-33b: admin, null p_user_id → P0002 not_found", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      await expectPgError(
        c,
        () => callDeleteRpc(c, null),
        "P0002",
        "admin_delete_monitor_user with null UUID",
        { messageIncludes: "not_found" },
      );
    });
  }, 15_000);

  // ── AMC-34: function hardening via pg_proc ────────────────────────────────

  it("AMC-34: admin_delete_monitor_user: prosecdef=true, search_path='', owner=postgres, PUBLIC/anon=false, authenticated=true", async () => {
    await withTx(client, async (c) => {
      interface ProcRow {
        prosecdef: boolean;
        proconfig: string[] | null;
        proowner: string;
        public_exec: boolean;
        anon_exec: boolean;
        authenticated_exec: boolean;
      }

      const { rows } = await c.query<ProcRow>(
        `SELECT p.prosecdef,
                p.proconfig,
                r.rolname AS proowner,
                has_function_privilege('public',        p.oid, 'EXECUTE') AS public_exec,
                has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon_exec,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
           JOIN pg_roles r     ON r.oid = p.proowner
          WHERE n.nspname = 'public'
            AND p.proname = 'admin_delete_monitor_user'`,
      );

      expect(rows).toHaveLength(1);
      const fn = rows[0]!;

      expect(fn.prosecdef).toBe(true);
      expect(fn.proconfig).toContain('search_path=""');
      expect(fn.proowner).toBe("postgres");
      expect(fn.public_exec).toBe(false);
      expect(fn.anon_exec).toBe(false);
      expect(fn.authenticated_exec).toBe(true);
    });
  }, 15_000);
});
