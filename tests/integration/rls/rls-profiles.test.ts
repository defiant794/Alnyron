/**
 * RLS integration tests — profiles and user_allowlist (owner manages access).
 *
 * Covers F0.4 policies profiles_select/update/delete and user_allowlist_owner:
 *   - anon has no grant on either table → 42501
 *   - a non-owner authenticated user (admin, role = NULL, 'mylife_user', no profile)
 *     reads only its own profile, cannot read or write user_allowlist, cannot escalate
 *     its own role and cannot change or delete anyone else's profile
 *   - the owner reads every profile and the allowlist, and can grant roles and manage
 *     the allowlist (positive control: the denials above are the policies, not a
 *     blanket failure)
 *
 * UPDATE / DELETE USING failures filter rows silently → rowCount 0, no error;
 * INSERT WITH CHECK failure → 42501.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_AVAILABLE, getClient, type PoolClient } from "./helpers/db.js";
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
  seedRolelessUser,
  type AppRole,
  type JwtClaims,
  withTx,
} from "./helpers/roles.js";

const SEEDED_USER_IDS = [OWNER_UUID, ADMIN_UUID, NULL_ROLE_UUID, MYLIFE_UUID];
const SEEDED_ALLOWLIST = [OWNER_EMAIL, ADMIN_EMAIL, MYLIFE_EMAIL];

/** Owner, admin, role = NULL and mylife_user accounts with their profiles rows. */
async function seedUsers(c: PoolClient): Promise<void> {
  await seedAuthUser(c, OWNER_UUID, OWNER_EMAIL, "owner");
  await seedAuthUser(c, ADMIN_UUID, ADMIN_EMAIL, "admin");
  await seedRolelessUser(c, NULL_ROLE_UUID, NULL_ROLE_EMAIL);
  await seedAuthUser(c, MYLIFE_UUID, MYLIFE_EMAIL, "mylife_user");
}

const NON_OWNERS: ReadonlyArray<{
  label: string;
  claims: JwtClaims;
  userId: string;
  /** Role on the caller's own profiles row; undefined = no row. */
  role: AppRole | null | undefined;
  escalateTo: AppRole;
}> = [
  { label: "admin", claims: ADMIN_CLAIMS, userId: ADMIN_UUID, role: "admin", escalateTo: "owner" },
  { label: "profile role=null", claims: NULL_ROLE_CLAIMS, userId: NULL_ROLE_UUID, role: null, escalateTo: "admin" },
  { label: "profile role=mylife_user", claims: MYLIFE_CLAIMS, userId: MYLIFE_UUID, role: "mylife_user", escalateTo: "admin" },
  { label: "no profile row", claims: NON_ADMIN_CLAIMS, userId: NON_ADMIN_UUID, role: undefined, escalateTo: "admin" },
];

describe.skipIf(!DB_AVAILABLE)("RLS — profiles + user_allowlist", () => {
  let client: PoolClient;

  beforeAll(async () => {
    client = await getClient();
  });

  afterAll(async () => {
    client.release();
  });

  // --------------------------------------------------------------------------
  // anon: no table privileges at all
  // --------------------------------------------------------------------------

  const ANON_STATEMENTS = [
    { label: "SELECT profiles", sql: "SELECT user_id FROM public.profiles" },
    { label: "UPDATE profiles", sql: "UPDATE public.profiles SET role = 'owner'" },
    { label: "SELECT user_allowlist", sql: "SELECT email FROM public.user_allowlist" },
    {
      label: "INSERT user_allowlist",
      sql: "INSERT INTO public.user_allowlist (email, role) VALUES ('anon-wants-in@test.local', 'owner')",
    },
  ] as const;

  for (const stmt of ANON_STATEMENTS) {
    it(`anon: ${stmt.label} raises 42501`, async () => {
      await withTx(client, async (c) => {
        await seedUsers(c);
        await asRole(c, "anon", ANON_CLAIMS);
        await expectPgError(c, () => c.query(stmt.sql), "42501", `anon ${stmt.label}`);
      });
    }, 12_000);
  }

  // --------------------------------------------------------------------------
  // Non-owner authenticated callers
  // --------------------------------------------------------------------------

  for (const who of NON_OWNERS) {
    describe(`non-owner (${who.label})`, () => {
      it("reads only its own profile row", async () => {
        await withTx(client, async (c) => {
          await seedUsers(c);
          await asRole(c, "authenticated", who.claims);

          const { rows } = await c.query<{ user_id: string }>("SELECT user_id FROM public.profiles");
          expect(rows.map((r) => r.user_id)).toEqual(who.role === undefined ? [] : [who.userId]);
        });
      }, 12_000);

      it("cannot read user_allowlist", async () => {
        await withTx(client, async (c) => {
          await seedUsers(c);
          await asRole(c, "authenticated", who.claims);

          const { rows } = await c.query("SELECT email FROM public.user_allowlist");
          expect(rows).toHaveLength(0);
        });
      }, 12_000);

      it("cannot INSERT into user_allowlist (42501)", async () => {
        await withTx(client, async (c) => {
          await seedUsers(c);
          await asRole(c, "authenticated", who.claims);

          await expectPgError(
            c,
            () =>
              c.query(
                "INSERT INTO public.user_allowlist (email, role) VALUES ('friend@test.local', 'owner')",
              ),
            "42501",
            `allowlist INSERT ${who.label}`,
          );
        });
      }, 12_000);

      it("cannot UPDATE or DELETE user_allowlist rows", async () => {
        await withTx(client, async (c) => {
          await seedUsers(c);
          await asRole(c, "authenticated", who.claims);

          const update = await c.query(
            "UPDATE public.user_allowlist SET role = 'owner' WHERE email = ANY($1::text[])",
            [SEEDED_ALLOWLIST],
          );
          expect(update.rowCount).toBe(0);
          const del = await c.query("DELETE FROM public.user_allowlist WHERE email = ANY($1::text[])", [
            SEEDED_ALLOWLIST,
          ]);
          expect(del.rowCount).toBe(0);
        });
      }, 12_000);

      it(`cannot escalate its own role to '${who.escalateTo}'`, async () => {
        await withTx(client, async (c) => {
          await seedUsers(c);
          await asRole(c, "authenticated", who.claims);

          const result = await c.query("UPDATE public.profiles SET role = $1 WHERE user_id = $2", [
            who.escalateTo,
            who.userId,
          ]);
          expect(result.rowCount).toBe(0);

          const { rows } = await c.query<{ role: AppRole | null }>(
            "SELECT role FROM public.profiles WHERE user_id = $1",
            [who.userId],
          );
          expect(rows.map((r) => r.role)).toEqual(who.role === undefined ? [] : [who.role]);
        });
      }, 12_000);

      it("cannot change or delete another user's profile", async () => {
        await withTx(client, async (c) => {
          await seedUsers(c);
          await asRole(c, "authenticated", who.claims);

          const update = await c.query("UPDATE public.profiles SET role = NULL WHERE user_id = $1", [
            OWNER_UUID,
          ]);
          expect(update.rowCount).toBe(0);
          const del = await c.query("DELETE FROM public.profiles WHERE user_id <> $1", [who.userId]);
          expect(del.rowCount).toBe(0);
        });
      }, 12_000);
    });
  }

  // --------------------------------------------------------------------------
  // Owner (positive control)
  // --------------------------------------------------------------------------

  it("owner: reads every profile and the allowlist", async () => {
    await withTx(client, async (c) => {
      await seedUsers(c);
      await asRole(c, "authenticated", OWNER_CLAIMS);

      const profiles = await c.query<{ user_id: string }>(
        "SELECT user_id FROM public.profiles WHERE user_id = ANY($1::uuid[])",
        [SEEDED_USER_IDS],
      );
      expect(profiles.rows.map((r) => r.user_id).sort()).toEqual([...SEEDED_USER_IDS].sort());

      const allowlist = await c.query<{ email: string }>(
        "SELECT email FROM public.user_allowlist WHERE email = ANY($1::text[])",
        [SEEDED_ALLOWLIST],
      );
      expect(allowlist.rows.map((r) => r.email).sort()).toEqual([...SEEDED_ALLOWLIST].sort());
    });
  }, 12_000);

  it("owner: grants a role and manages the allowlist", async () => {
    await withTx(client, async (c) => {
      await seedUsers(c);
      await asRole(c, "authenticated", OWNER_CLAIMS);

      const grant = await c.query("UPDATE public.profiles SET role = 'admin' WHERE user_id = $1", [
        NULL_ROLE_UUID,
      ]);
      expect(grant.rowCount).toBe(1);

      await c.query("INSERT INTO public.user_allowlist (email, role) VALUES ('newadmin@test.local', 'admin')");
      const revoke = await c.query("DELETE FROM public.user_allowlist WHERE email = $1", [MYLIFE_EMAIL]);
      expect(revoke.rowCount).toBe(1);

      const { rows } = await c.query<{ email: string; role: AppRole }>(
        "SELECT email, role FROM public.user_allowlist WHERE email = ANY($1::text[]) ORDER BY email",
        [["newadmin@test.local", MYLIFE_EMAIL]],
      );
      expect(rows).toEqual([{ email: "newadmin@test.local", role: "admin" }]);
    });
  }, 12_000);
});
