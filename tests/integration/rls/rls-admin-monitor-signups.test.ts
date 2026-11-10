/**
 * Integration tests — admin_list_monitor_signups RPC (admin-monitor-users)
 * Journey: admin-monitor-users  AC-AMU-10, AC-AMU-12, AC-AMU-14, AC-AMU-15,
 *          AC-AMU-22, AC-AMU-23, AC-AMU-24, AC-AMU-25
 *
 * Run against the isolated e2e project:
 *   npm run test:integration:e2e-project -- tests/integration/rls/rls-admin-monitor-signups.test.ts
 *
 * Covers:
 *   - Owner (AC-AMU-14) and admin (AC-AMU-15) can call admin_list_monitor_signups() — exact row shape
 *   - Newer signup before older signup (order: created_at desc, user_id)
 *   - Non-monitor_user profiles excluded (owner/admin/mylife_user/null role)
 *   - Every NON_ADMIN_FIXTURE + monitor_user caller → 42501
 *   - Anon caller → 42501 "permission denied for function"
 *   - Function hardening: prosecdef, search_path, owner, privilege flags
 *
 * All seeded data lives inside rolled-back transactions — no permanent DB mutation.
 * The e2e project is shared: assert on fixture rows only, never the full list count.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getClient, type PoolClient } from "./helpers/db.js";
import {
  ADMIN_CLAIMS,
  ADMIN_EMAIL,
  OWNER_CLAIMS,
  OWNER_UUID,
  OWNER_EMAIL,
  MYLIFE_UUID,
  MYLIFE_EMAIL,
  NULL_ROLE_UUID,
  NULL_ROLE_EMAIL,
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
// All hex; prefixed 0a30 (amu → hex-safe mnemonic segment).

/** Newer monitor_user — confirmed, 2 monitors. */
const MONITOR_NEWER_UUID  = "00000000-0000-0000-0a30-000000000001";
const MONITOR_NEWER_EMAIL = "e2e-amu-newer@alnyron-test.local";

/** Older monitor_user — unconfirmed, 0 monitors. */
const MONITOR_OLDER_UUID  = "00000000-0000-0000-0a30-000000000002";
const MONITOR_OLDER_EMAIL = "e2e-amu-older@alnyron-test.local";

/** monitor_user used only for the access-control fixture (NON_ADMIN-equivalent). */
const MONITOR_AC_UUID  = "00000000-0000-0000-0a30-000000000003";
const MONITOR_AC_EMAIL = "e2e-amu-ac@alnyron-test.local";

/**
 * Fixed timestamps. The function returns created_at as timestamptz;
 * node-postgres maps it to a JavaScript Date.
 */
const TS_NEWER = "2026-10-15T09:00:00.000Z";
const TS_OLDER = "2026-09-01T14:30:00.000Z";

/** Expected exact shapes (monitor_count is integer → number in node-postgres). */
const NEWER_ROW = {
  user_id: MONITOR_NEWER_UUID,
  email: MONITOR_NEWER_EMAIL,
  created_at: new Date(TS_NEWER),
  confirmed: true,
  monitor_count: 2,
};
const OLDER_ROW = {
  user_id: MONITOR_OLDER_UUID,
  email: MONITOR_OLDER_EMAIL,
  created_at: new Date(TS_OLDER),
  confirmed: false,
  monitor_count: 0,
};

/** monitor_user caller that must never pass private.is_admin(). */
const MONITOR_USER_FIXTURE: NonAdminFixture = {
  label: "profile role=monitor_user",
  claims: { sub: MONITOR_AC_UUID, role: "authenticated", email: MONITOR_AC_EMAIL },
  seed: async (c) => {
    await seedAuthUser(c, MONITOR_AC_UUID, MONITOR_AC_EMAIL);
    const { rows } = await c.query<{ role: string | null }>(
      "SELECT role FROM public.profiles WHERE user_id = $1",
      [MONITOR_AC_UUID],
    );
    expect(rows, "seedAuthUser without an allowlist role yields monitor_user").toEqual([
      { role: "monitor_user" },
    ]);
  },
};

// ── Seed helpers ──────────────────────────────────────────────────────────────

/**
 * Seed the two fixture monitor_users (newer + older) with fixed created_at
 * values and monitors. Does NOT seed admin/owner — callers do that themselves
 * so each test controls exactly who is in auth.users.
 * Also seeds mylife_user and null-role to verify they are excluded from results.
 */
async function seedFixtures(c: PoolClient): Promise<void> {
  // Non-monitor_user profiles that must be absent from results.
  await seedAuthUser(c, MYLIFE_UUID, MYLIFE_EMAIL, "mylife_user");
  await seedRolelessUser(c, NULL_ROLE_UUID, NULL_ROLE_EMAIL);

  // Newer monitor_user: confirmed (email_confirmed_at = now()), 2 monitors.
  await c.query(
    `INSERT INTO auth.users
       (id, aud, role, email, email_confirmed_at, created_at, updated_at,
        raw_app_meta_data, raw_user_meta_data, is_super_admin, encrypted_password)
     VALUES ($1, 'authenticated', 'authenticated', $2, now(), $3::timestamptz, now(),
             '{}'::jsonb, '{}'::jsonb, false, '')`,
    [MONITOR_NEWER_UUID, MONITOR_NEWER_EMAIL, TS_NEWER],
  );
  // Lift monitor_limit so we can insert 2 monitors without hitting the cap.
  await c.query(
    `INSERT INTO public.profiles (user_id, email, role, monitor_limit)
     VALUES ($1, $2, 'monitor_user', NULL)
     ON CONFLICT (user_id) DO UPDATE SET monitor_limit = NULL`,
    [MONITOR_NEWER_UUID, MONITOR_NEWER_EMAIL],
  );
  await c.query(
    `INSERT INTO public.monitors (user_id, url, label, status, consecutive_errors, interval_minutes)
     VALUES ($1, 'https://amu-newer-a.example.com', 'AMU A', 'active', 0, 1440),
            ($1, 'https://amu-newer-b.example.com', 'AMU B', 'active', 0, 1440)`,
    [MONITOR_NEWER_UUID],
  );

  // Older monitor_user: unconfirmed (email_confirmed_at = NULL), 0 monitors.
  await c.query(
    `INSERT INTO auth.users
       (id, aud, role, email, email_confirmed_at, created_at, updated_at,
        raw_app_meta_data, raw_user_meta_data, is_super_admin, encrypted_password)
     VALUES ($1, 'authenticated', 'authenticated', $2, NULL, $3::timestamptz, now(),
             '{}'::jsonb, '{}'::jsonb, false, '')`,
    [MONITOR_OLDER_UUID, MONITOR_OLDER_EMAIL, TS_OLDER],
  );
  await c.query(
    `INSERT INTO public.profiles (user_id, email, role, monitor_limit)
     VALUES ($1, $2, 'monitor_user', NULL)
     ON CONFLICT (user_id) DO UPDATE SET monitor_limit = NULL`,
    [MONITOR_OLDER_UUID, MONITOR_OLDER_EMAIL],
  );
}

interface SignupRow {
  user_id: string;
  email: string;
  created_at: Date;
  confirmed: boolean;
  monitor_count: number;
}

async function callRpc(c: PoolClient): Promise<SignupRow[]> {
  const { rows } = await c.query<SignupRow>("SELECT * FROM public.admin_list_monitor_signups()");
  return rows;
}

// ── describe.skipIf: skip when SUPABASE_E2E_REF is absent ────────────────────

describe.skipIf(!process.env.SUPABASE_E2E_REF)("RLS — admin_list_monitor_signups", () => {
  let client: PoolClient;

  beforeAll(async () => {
    client = await getClient();
  });

  afterAll(async () => {
    client.release();
  });

  // ── AC-AMU-14: owner can call the RPC — exact row shape ──────────────────

  it("AC-AMU-14: owner — fixture rows returned with exact shape, newer before older", async () => {
    await withTx(client, async (c) => {
      await seedAuthUser(c, OWNER_UUID, OWNER_EMAIL, "owner");
      await seedFixtures(c);
      await asRole(c, "authenticated", OWNER_CLAIMS);

      const rows = await callRpc(c);
      const newerIdx = rows.findIndex((r) => r.email === MONITOR_NEWER_EMAIL);
      const olderIdx = rows.findIndex((r) => r.email === MONITOR_OLDER_EMAIL);

      expect(newerIdx).toBeGreaterThanOrEqual(0);
      expect(olderIdx).toBeGreaterThanOrEqual(0);
      expect(newerIdx).toBeLessThan(olderIdx);
      expect(rows[newerIdx]).toEqual(NEWER_ROW);
      expect(rows[olderIdx]).toEqual(OLDER_ROW);
    });
  }, 15_000);

  // ── AC-AMU-15: admin can call the RPC — exact row shape ───────────────────

  it("AC-AMU-15: admin — fixture rows returned with exact shape, newer before older", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      await seedAuthUser(c, OWNER_UUID, OWNER_EMAIL, "owner");
      await seedFixtures(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      const rows = await callRpc(c);
      const newerIdx = rows.findIndex((r) => r.email === MONITOR_NEWER_EMAIL);
      const olderIdx = rows.findIndex((r) => r.email === MONITOR_OLDER_EMAIL);

      expect(newerIdx).toBeGreaterThanOrEqual(0);
      expect(olderIdx).toBeGreaterThanOrEqual(0);
      expect(newerIdx).toBeLessThan(olderIdx);
      expect(rows[newerIdx]).toEqual(NEWER_ROW);
      expect(rows[olderIdx]).toEqual(OLDER_ROW);
    });
  }, 15_000);

  // ── AC-AMU-10: order guaranteed ───────────────────────────────────────────

  it("AC-AMU-10: newer signup appears before older signup in results", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      await seedFixtures(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      const rows = await callRpc(c);
      const newerIdx = rows.findIndex((r) => r.email === MONITOR_NEWER_EMAIL);
      const olderIdx = rows.findIndex((r) => r.email === MONITOR_OLDER_EMAIL);

      expect(newerIdx).toBeGreaterThanOrEqual(0);
      expect(olderIdx).toBeGreaterThanOrEqual(0);
      expect(newerIdx).toBeLessThan(olderIdx);
    });
  }, 15_000);

  // ── AC-AMU-12: non-monitor_user profiles excluded ─────────────────────────

  it("AC-AMU-12: fixture monitor_users listed; admin/owner/mylife_user/null-role profiles absent", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      await seedAuthUser(c, OWNER_UUID, OWNER_EMAIL, "owner");
      await seedFixtures(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      const rows = await callRpc(c);
      const emails = rows.map((r) => r.email);

      expect(emails).toEqual(expect.arrayContaining([MONITOR_NEWER_EMAIL, MONITOR_OLDER_EMAIL]));
      expect(emails).not.toContain(ADMIN_EMAIL);
      expect(emails).not.toContain(OWNER_EMAIL);
      expect(emails).not.toContain(MYLIFE_EMAIL);
      expect(emails).not.toContain(NULL_ROLE_EMAIL);
    });
  }, 15_000);

  // ── AC-AMU-22: non-admin callers / AC-AMU-23: monitor_user → 42501 ────────

  const deniedCallers: readonly (readonly [string, NonAdminFixture])[] = [
    ...NON_ADMIN_FIXTURES.map((fixture) => ["AC-AMU-22", fixture] as const),
    ["AC-AMU-23", MONITOR_USER_FIXTURE],
  ];

  for (const [ac, fixture] of deniedCallers) {
    it(`${ac}: ${fixture.label} → 42501 (insufficient_privilege)`, async () => {
      await withTx(client, async (c) => {
        await fixture.seed(c);
        await asRole(c, "authenticated", fixture.claims);

        await expectPgError(
          c,
          () => callRpc(c),
          "42501",
          `admin_list_monitor_signups as ${fixture.label}`,
        );
      });
    }, 15_000);
  }

  // ── AC-AMU-24: anon → 42501 ───────────────────────────────────────────────

  it("AC-AMU-24: anon caller → 42501 permission denied for function", async () => {
    await withTx(client, async (c) => {
      await asRole(c, "anon", ANON_CLAIMS);

      await expectPgError(
        c,
        () => callRpc(c),
        "42501",
        "admin_list_monitor_signups as anon",
        { messageIncludes: "permission denied for function" },
      );
    });
  }, 15_000);

  // ── AC-AMU-25: function hardening via pg_proc ─────────────────────────────

  it("AC-AMU-25: prosecdef=true, search_path='', owner=postgres, PUBLIC/anon=false, authenticated=true", async () => {
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
            AND p.proname = 'admin_list_monitor_signups'`,
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
