/**
 * Integration tests — access-management hardening (migrations 20261101000500_auth_hardening.sql,
 * 20261101000600_allowlist_insert_sync.sql and 20261101000700_profile_email_sync.sql).
 *
 * Covers the F0.4 security-audit and review fixes:
 *   - allowlist → profiles sync: removing an allowlist entry revokes the existing account's
 *     role, changing the entry's role (or email) carries over to the account, re-adding an
 *     entry (re-grant, or a role change by delete + insert) restores the account's role, for
 *     owner writes through RLS and for writes that bypass RLS (postgres / service role)
 *   - login email → profiles sync: a login email change moves profiles.email to the new
 *     address and re-resolves the role from the allowlist (non-allowlisted → revoked), so an
 *     allowlist write for the old address no longer reaches the moved account; one profile
 *     per normalised address
 *   - last-owner guard: the final `owner` cannot be demoted or deleted — directly, through
 *     the allowlist sync, by deleting the auth.users row, by a login email change, or in one
 *     statement removing every owner — while a transfer to a second owner still works;
 *     concurrent owner removals in two transactions are serialised by the guard's advisory
 *     lock
 *   - spoofed claims: a non-admin whose JWT carries app_metadata/user_metadata role "owner"
 *     is neither admin nor owner and cannot write; roles come from public.profiles only
 *
 * Every test runs inside a rolled-back transaction. Owners that already exist in the
 * cloud DB are demoted inside that transaction (seedSoleOwner), so "last owner" means the
 * seeded owner regardless of real data.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_AVAILABLE, getClient, type PoolClient } from "./helpers/db.js";
import {
  ADMIN_CLAIMS,
  ADMIN_EMAIL,
  ADMIN_UUID,
  MYLIFE_CLAIMS,
  MYLIFE_EMAIL,
  MYLIFE_UUID,
  NON_ADMIN_FIXTURES,
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

const SECOND_OWNER_UUID = "00000000-0000-0000-0000-000000000006";
const SECOND_OWNER_EMAIL = "owner2@test.local";
const SECOND_OWNER_CLAIMS: JwtClaims = { sub: SECOND_OWNER_UUID, role: "authenticated", email: SECOND_OWNER_EMAIL };
const LAST_OWNER = "cannot remove the last owner";
/** Two owners for the second connection of the concurrency test, disjoint from the first's. */
const RACE_OWNERS: ReadonlyArray<{ id: string; email: string }> = [
  { id: "00000000-0000-0000-0000-000000000007", email: "owner3@test.local" },
  { id: "00000000-0000-0000-0000-000000000008", email: "owner4@test.local" },
];
const DEMOTE_TO_ADMIN = "UPDATE public.profiles SET role = 'admin' WHERE user_id = $1";
const MOVED_EMAIL = "moved@test.local";
/**
 * A confirmed login email change (auth.updateUser) as GoTrue writes it: UPDATE auth.users.email.
 * Run as postgres: `SET ROLE supabase_auth_admin` is impossible from the test connection, and
 * the security-definer trigger writes profiles the same way whoever updates auth.users.
 */
const CHANGE_LOGIN_EMAIL = "UPDATE auth.users SET email = $2 WHERE id = $1";
/** An admin-only write: RLS pages_insert WITH CHECK is_admin() → 42501 for everyone else. */
const INSERT_PAGE = "INSERT INTO public.pages (status) VALUES ('draft')";

/** The seeded owner becomes the only owner: real owners are demoted inside this transaction. */
async function seedSoleOwner(c: PoolClient): Promise<void> {
  await seedAuthUser(c, OWNER_UUID, OWNER_EMAIL, "owner");
  await c.query("UPDATE public.profiles SET role = 'admin' WHERE role = 'owner' AND user_id <> $1", [OWNER_UUID]);
}

/** Role on a user's profiles row; the caller must be able to see the row (owner or postgres). */
async function roleOf(c: PoolClient, userId: string): Promise<AppRole | null> {
  const { rows } = await c.query<{ role: AppRole | null }>("SELECT role FROM public.profiles WHERE user_id = $1", [
    userId,
  ]);
  if (rows.length !== 1) throw new Error(`profile ${userId} not visible`);
  return rows[0]!.role;
}

/** Email and role on a user's profiles row, read as postgres. */
async function profileOf(c: PoolClient, userId: string): Promise<{ email: string; role: AppRole | null }> {
  const { rows } = await c.query<{ email: string; role: AppRole | null }>(
    "SELECT email, role FROM public.profiles WHERE user_id = $1",
    [userId],
  );
  if (rows.length !== 1) throw new Error(`profile ${userId} not visible`);
  return rows[0]!;
}

async function isAdminAndOwner(c: PoolClient): Promise<{ is_admin: boolean; is_owner: boolean }> {
  const { rows } = await c.query<{ is_admin: boolean; is_owner: boolean }>(
    "SELECT private.is_admin() AS is_admin, private.is_owner() AS is_owner",
  );
  return rows[0]!;
}

describe.skipIf(!DB_AVAILABLE)("Auth hardening — allowlist, last owner, spoofed claims", () => {
  let client: PoolClient;

  beforeAll(async () => {
    client = await getClient();
  });

  afterAll(async () => {
    client.release();
  });

  // --------------------------------------------------------------------------
  // Allowlist → profiles role sync
  // --------------------------------------------------------------------------

  describe("allowlist changes reach existing accounts", () => {
    it("owner removing an allowlist entry revokes the account's role and admin access", async () => {
      await withTx(client, async (c) => {
        await seedSoleOwner(c);
        await seedAuthUser(c, ADMIN_UUID, ADMIN_EMAIL, "admin");
        await asRole(c, "authenticated", OWNER_CLAIMS);

        const del = await c.query("DELETE FROM public.user_allowlist WHERE email = $1", [ADMIN_EMAIL]);
        expect(del.rowCount).toBe(1);
        expect(await roleOf(c, ADMIN_UUID)).toBeNull();

        await asRole(c, "authenticated", ADMIN_CLAIMS);
        expect(await isAdminAndOwner(c)).toEqual({ is_admin: false, is_owner: false });
        await expectPgError(c, () => c.query(INSERT_PAGE), "42501", "revoked admin INSERT pages");
      });
    }, 12_000);

    const ROLE_CHANGES: ReadonlyArray<{
      label: string;
      userId: string;
      email: string;
      claims: JwtClaims;
      from: AppRole;
      to: AppRole;
      isAdminAfter: boolean;
    }> = [
      { label: "downgrade admin → mylife_user", userId: ADMIN_UUID, email: ADMIN_EMAIL, claims: ADMIN_CLAIMS, from: "admin", to: "mylife_user", isAdminAfter: false },
      { label: "upgrade mylife_user → admin", userId: MYLIFE_UUID, email: MYLIFE_EMAIL, claims: MYLIFE_CLAIMS, from: "mylife_user", to: "admin", isAdminAfter: true },
    ];

    for (const change of ROLE_CHANGES) {
      it(`owner changing an allowlist role carries over to the account (${change.label})`, async () => {
        await withTx(client, async (c) => {
          await seedSoleOwner(c);
          await seedAuthUser(c, change.userId, change.email, change.from);
          await asRole(c, "authenticated", OWNER_CLAIMS);

          const update = await c.query("UPDATE public.user_allowlist SET role = $1 WHERE email = $2", [
            change.to,
            change.email,
          ]);
          expect(update.rowCount).toBe(1);
          expect(await roleOf(c, change.userId)).toBe(change.to);

          await asRole(c, "authenticated", change.claims);
          expect((await isAdminAndOwner(c)).is_admin).toBe(change.isAdminAfter);
        });
      }, 12_000);
    }

    it("owner changing an allowlist email revokes the old address's account and grants the new one", async () => {
      await withTx(client, async (c) => {
        await seedSoleOwner(c);
        await seedAuthUser(c, ADMIN_UUID, ADMIN_EMAIL, "admin");
        await seedRolelessUser(c, NULL_ROLE_UUID, NULL_ROLE_EMAIL);
        await asRole(c, "authenticated", OWNER_CLAIMS);

        const update = await c.query("UPDATE public.user_allowlist SET email = $1 WHERE email = $2", [
          NULL_ROLE_EMAIL,
          ADMIN_EMAIL,
        ]);
        expect(update.rowCount).toBe(1);
        expect(await roleOf(c, ADMIN_UUID)).toBeNull();
        expect(await roleOf(c, NULL_ROLE_UUID)).toBe("admin");
      });
    }, 12_000);

    const RE_ADDS: ReadonlyArray<{ label: string; role: AppRole; isAdminAfter: boolean }> = [
      { label: "re-grant with the same role", role: "admin", isAdminAfter: true },
      { label: "role change by delete + insert", role: "mylife_user", isAdminAfter: false },
    ];

    for (const reAdd of RE_ADDS) {
      it(`owner re-adding a removed allowlist entry restores the account's role (${reAdd.label})`, async () => {
        await withTx(client, async (c) => {
          await seedSoleOwner(c);
          await seedAuthUser(c, ADMIN_UUID, ADMIN_EMAIL, "admin");
          await asRole(c, "authenticated", OWNER_CLAIMS);

          await c.query("DELETE FROM public.user_allowlist WHERE email = $1", [ADMIN_EMAIL]);
          expect(await roleOf(c, ADMIN_UUID)).toBeNull();

          const insert = await c.query("INSERT INTO public.user_allowlist (email, role) VALUES ($1, $2)", [
            ADMIN_EMAIL,
            reAdd.role,
          ]);
          expect(insert.rowCount).toBe(1);
          expect(await roleOf(c, ADMIN_UUID)).toBe(reAdd.role);

          await asRole(c, "authenticated", ADMIN_CLAIMS);
          expect((await isAdminAndOwner(c)).is_admin).toBe(reAdd.isAdminAfter);
        });
      }, 12_000);
    }

    it("an allowlist update that changes neither email nor role leaves the account's role alone", async () => {
      await withTx(client, async (c) => {
        await seedSoleOwner(c);
        await seedAuthUser(c, MYLIFE_UUID, MYLIFE_EMAIL, "mylife_user");
        await asRole(c, "authenticated", OWNER_CLAIMS);

        // The owner grants the account a role directly, then touches the allowlist row.
        await c.query("UPDATE public.profiles SET role = 'admin' WHERE user_id = $1", [MYLIFE_UUID]);
        const touch = await c.query("UPDATE public.user_allowlist SET created_by = $1 WHERE email = $2", [
          OWNER_UUID,
          MYLIFE_EMAIL,
        ]);
        expect(touch.rowCount).toBe(1);
        expect(await roleOf(c, MYLIFE_UUID)).toBe("admin");
      });
    }, 12_000);

    it("the sync also applies to allowlist writes that bypass RLS (postgres / service role)", async () => {
      await withTx(client, async (c) => {
        await seedSoleOwner(c);
        await seedAuthUser(c, ADMIN_UUID, ADMIN_EMAIL, "admin");
        await seedAuthUser(c, MYLIFE_UUID, MYLIFE_EMAIL, "mylife_user");
        await seedRolelessUser(c, NULL_ROLE_UUID, NULL_ROLE_EMAIL);

        await c.query("DELETE FROM public.user_allowlist WHERE email = $1", [ADMIN_EMAIL]);
        await c.query("UPDATE public.user_allowlist SET role = 'admin' WHERE email = $1", [MYLIFE_EMAIL]);
        await c.query("INSERT INTO public.user_allowlist (email, role) VALUES ($1, 'mylife_user')", [NULL_ROLE_EMAIL]);
        expect(await roleOf(c, ADMIN_UUID)).toBeNull();
        expect(await roleOf(c, MYLIFE_UUID)).toBe("admin");
        expect(await roleOf(c, NULL_ROLE_UUID)).toBe("mylife_user");
      });
    }, 12_000);
  });

  // --------------------------------------------------------------------------
  // Login email → profiles sync
  // --------------------------------------------------------------------------

  describe("login email changes keep the allowlist authoritative", () => {
    it("a change to a non-allowlisted address moves profiles.email (normalised) and revokes the role", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, ADMIN_UUID, ADMIN_EMAIL, "admin");

        const change = await c.query(CHANGE_LOGIN_EMAIL, [ADMIN_UUID, "Moved@Test.Local"]);
        expect(change.rowCount).toBe(1);
        expect(await profileOf(c, ADMIN_UUID)).toEqual({ email: MOVED_EMAIL, role: null });

        await asRole(c, "authenticated", ADMIN_CLAIMS);
        expect(await isAdminAndOwner(c)).toEqual({ is_admin: false, is_owner: false });
        await expectPgError(c, () => c.query(INSERT_PAGE), "42501", "moved admin INSERT pages");
      });
    }, 12_000);

    const RE_RESOLVES: ReadonlyArray<{
      label: string;
      userId: string;
      email: string;
      claims: JwtClaims;
      from: AppRole;
      to: AppRole;
      isAdminAfter: boolean;
    }> = [
      { label: "admin → address allowlisted as mylife_user", userId: ADMIN_UUID, email: ADMIN_EMAIL, claims: ADMIN_CLAIMS, from: "admin", to: "mylife_user", isAdminAfter: false },
      { label: "mylife_user → address allowlisted as admin", userId: MYLIFE_UUID, email: MYLIFE_EMAIL, claims: MYLIFE_CLAIMS, from: "mylife_user", to: "admin", isAdminAfter: true },
    ];

    for (const move of RE_RESOLVES) {
      it(`a change to an allowlisted address takes that entry's role (${move.label})`, async () => {
        await withTx(client, async (c) => {
          await seedAuthUser(c, move.userId, move.email, move.from);
          await c.query("INSERT INTO public.user_allowlist (email, role) VALUES ($1, $2)", [MOVED_EMAIL, move.to]);

          await c.query(CHANGE_LOGIN_EMAIL, [move.userId, MOVED_EMAIL]);
          expect(await profileOf(c, move.userId)).toEqual({ email: MOVED_EMAIL, role: move.to });

          await asRole(c, "authenticated", move.claims);
          expect((await isAdminAndOwner(c)).is_admin).toBe(move.isAdminAfter);
        });
      }, 12_000);
    }

    /** seedRole: the account's allowlist role before the move; undefined = a role-less account. */
    const OLD_ADDRESS_WRITES: ReadonlyArray<{ label: string; seedRole?: AppRole; sql: string }> = [
      {
        label: "INSERT of the old address",
        sql: "INSERT INTO public.user_allowlist (email, role) VALUES ($1, 'owner')",
      },
      {
        label: "role UPDATE of the old address",
        seedRole: "admin",
        sql: "UPDATE public.user_allowlist SET role = 'owner' WHERE email = $1",
      },
    ];

    for (const write of OLD_ADDRESS_WRITES) {
      it(`after a change, an allowlist write for the old address grants the moved account nothing (${write.label})`, async () => {
        await withTx(client, async (c) => {
          await seedSoleOwner(c);
          if (write.seedRole) await seedAuthUser(c, ADMIN_UUID, ADMIN_EMAIL, write.seedRole);
          else await seedRolelessUser(c, ADMIN_UUID, ADMIN_EMAIL);
          await c.query(CHANGE_LOGIN_EMAIL, [ADMIN_UUID, MOVED_EMAIL]);
          expect(await profileOf(c, ADMIN_UUID)).toEqual({ email: MOVED_EMAIL, role: null });
          await asRole(c, "authenticated", OWNER_CLAIMS);

          const grant = await c.query(write.sql, [ADMIN_EMAIL]);
          expect(grant.rowCount).toBe(1);
          expect(await roleOf(c, ADMIN_UUID)).toBeNull();

          await asRole(c, "authenticated", ADMIN_CLAIMS);
          expect(await isAdminAndOwner(c)).toEqual({ is_admin: false, is_owner: false });
          await expectPgError(c, () => c.query(INSERT_PAGE), "42501", `moved account INSERT pages (${write.label})`);
        });
      }, 12_000);
    }

    it("a sole owner may move to an address allowlisted as owner and stays owner", async () => {
      await withTx(client, async (c) => {
        await seedSoleOwner(c);
        await c.query("INSERT INTO public.user_allowlist (email, role) VALUES ($1, 'owner')", [MOVED_EMAIL]);

        await c.query(CHANGE_LOGIN_EMAIL, [OWNER_UUID, MOVED_EMAIL]);
        expect(await profileOf(c, OWNER_UUID)).toEqual({ email: MOVED_EMAIL, role: "owner" });

        await asRole(c, "authenticated", OWNER_CLAIMS);
        expect(await isAdminAndOwner(c)).toEqual({ is_admin: true, is_owner: true });
      });
    }, 12_000);

    it("a change to another account's address in different case → 23505 profiles_email_key", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, ADMIN_UUID, ADMIN_EMAIL, "admin");
        await seedRolelessUser(c, NULL_ROLE_UUID, NULL_ROLE_EMAIL);

        // auth.users keeps emails unique case-sensitively only; profiles.email is normalised.
        await expectPgError(
          c,
          () => c.query(CHANGE_LOGIN_EMAIL, [NULL_ROLE_UUID, "Admin@Test.Local"]),
          "23505",
          "case variant of another account's email",
          { messageIncludes: "profiles_email_key" },
        );
        expect(await profileOf(c, NULL_ROLE_UUID)).toEqual({ email: NULL_ROLE_EMAIL, role: null });
      });
    }, 12_000);

    it("an auth.users update that keeps the email leaves the profile alone", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, MYLIFE_UUID, MYLIFE_EMAIL, "mylife_user");
        // A role set directly on the profile is only replaced when the email changes.
        await c.query("UPDATE public.profiles SET role = 'admin' WHERE user_id = $1", [MYLIFE_UUID]);

        const touch = await c.query("UPDATE auth.users SET email = email, updated_at = now() WHERE id = $1", [
          MYLIFE_UUID,
        ]);
        expect(touch.rowCount).toBe(1);
        expect(await profileOf(c, MYLIFE_UUID)).toEqual({ email: MYLIFE_EMAIL, role: "admin" });
      });
    }, 12_000);
  });

  // --------------------------------------------------------------------------
  // Last-owner guard
  // --------------------------------------------------------------------------

  describe("the last owner cannot be removed", () => {
    const OWNER_REMOVALS: ReadonlyArray<{ label: string; asOwner: boolean; sql: string; params: string[] }> = [
      {
        label: "owner demotes itself",
        asOwner: true,
        sql: "UPDATE public.profiles SET role = 'admin' WHERE user_id = $1",
        params: [OWNER_UUID],
      },
      {
        label: "owner deletes its own profile",
        asOwner: true,
        sql: "DELETE FROM public.profiles WHERE user_id = $1",
        params: [OWNER_UUID],
      },
      {
        label: "owner removes its own allowlist entry",
        asOwner: true,
        sql: "DELETE FROM public.user_allowlist WHERE email = $1",
        params: [OWNER_EMAIL],
      },
      {
        label: "owner changes its own allowlist role",
        asOwner: true,
        sql: "UPDATE public.user_allowlist SET role = 'admin' WHERE email = $1",
        params: [OWNER_EMAIL],
      },
      {
        label: "postgres demotes the owner (RLS bypassed)",
        asOwner: false,
        sql: "UPDATE public.profiles SET role = NULL WHERE user_id = $1",
        params: [OWNER_UUID],
      },
      {
        label: "postgres deletes the owner's auth.users account",
        asOwner: false,
        sql: "DELETE FROM auth.users WHERE id = $1",
        params: [OWNER_UUID],
      },
      {
        label: "the owner's login email changes to a non-allowlisted address",
        asOwner: false,
        sql: CHANGE_LOGIN_EMAIL,
        params: [OWNER_UUID, MOVED_EMAIL],
      },
    ];

    for (const removal of OWNER_REMOVALS) {
      it(`${removal.label} → 23514 and the owner stays`, async () => {
        await withTx(client, async (c) => {
          await seedSoleOwner(c);
          if (removal.asOwner) await asRole(c, "authenticated", OWNER_CLAIMS);

          await expectPgError(c, () => c.query(removal.sql, removal.params), "23514", removal.label, {
            messageIncludes: LAST_OWNER,
          });
          expect(await roleOf(c, OWNER_UUID)).toBe("owner");
          const { rows } = await c.query<{ role: AppRole }>("SELECT role FROM public.user_allowlist WHERE email = $1", [
            OWNER_EMAIL,
          ]);
          expect(rows).toEqual([{ role: "owner" }]);
        });
      }, 12_000);
    }

    it("one statement removing every owner → 23514", async () => {
      await withTx(client, async (c) => {
        await seedSoleOwner(c);
        await seedAuthUser(c, SECOND_OWNER_UUID, SECOND_OWNER_EMAIL, "owner");
        await asRole(c, "authenticated", OWNER_CLAIMS);

        await expectPgError(
          c,
          () => c.query("UPDATE public.profiles SET role = 'admin' WHERE role = 'owner'"),
          "23514",
          "demote all owners",
          { messageIncludes: LAST_OWNER },
        );
        expect(await roleOf(c, OWNER_UUID)).toBe("owner");
        expect(await roleOf(c, SECOND_OWNER_UUID)).toBe("owner");
      });
    }, 12_000);

    it("with a second owner, an owner can step down (ownership transfer)", async () => {
      await withTx(client, async (c) => {
        await seedSoleOwner(c);
        await seedAuthUser(c, SECOND_OWNER_UUID, SECOND_OWNER_EMAIL, "owner");
        await asRole(c, "authenticated", OWNER_CLAIMS);

        const demote = await c.query("UPDATE public.profiles SET role = 'admin' WHERE user_id = $1", [OWNER_UUID]);
        expect(demote.rowCount).toBe(1);

        await asRole(c, "authenticated", SECOND_OWNER_CLAIMS);
        expect(await roleOf(c, OWNER_UUID)).toBe("admin");
        expect(await isAdminAndOwner(c)).toEqual({ is_admin: true, is_owner: true });
      });
    }, 12_000);

    it("moving the sole owner's allowlist entry to another existing account transfers ownership", async () => {
      await withTx(client, async (c) => {
        await seedSoleOwner(c);
        await seedRolelessUser(c, SECOND_OWNER_UUID, SECOND_OWNER_EMAIL);
        await asRole(c, "authenticated", OWNER_CLAIMS);

        const move = await c.query("UPDATE public.user_allowlist SET email = $1 WHERE email = $2", [
          SECOND_OWNER_EMAIL,
          OWNER_EMAIL,
        ]);
        expect(move.rowCount).toBe(1);

        // The former owner may now read only its own profile; check as the new owner.
        await asRole(c, "authenticated", SECOND_OWNER_CLAIMS);
        expect(await roleOf(c, OWNER_UUID)).toBeNull();
        expect(await isAdminAndOwner(c)).toEqual({ is_admin: true, is_owner: true });
      });
    }, 12_000);

    it("a concurrent owner removal waits for the guard's lock (55P03 under lock_timeout), then passes once it is free", async () => {
      /** Race owners have their own ids/emails, so the first connection holds no row or key lock they need. */
      async function seedRaceOwners(c: PoolClient): Promise<void> {
        for (const owner of RACE_OWNERS) await seedAuthUser(c, owner.id, owner.email, "owner");
        // A wait on the first connection's lock fails fast instead of hanging the test.
        await c.query("SET LOCAL lock_timeout = '500ms'");
      }

      const second = await getClient();
      try {
        await withTx(client, async (a) => {
          await seedAuthUser(a, OWNER_UUID, OWNER_EMAIL, "owner");
          await seedAuthUser(a, SECOND_OWNER_UUID, SECOND_OWNER_EMAIL, "owner");
          // Another owner remains, so the guard passes and holds its lock until this tx ends.
          const demote = await a.query(DEMOTE_TO_ADMIN, [OWNER_UUID]);
          expect(demote.rowCount).toBe(1);

          await withTx(second, async (b) => {
            await seedRaceOwners(b);
            await expectPgError(b, () => b.query(DEMOTE_TO_ADMIN, [RACE_OWNERS[0]!.id]), "55P03", "concurrent demote", {
              messageIncludes: "lock timeout",
            });
          });
        });

        // The first transaction has ended: the same removal on the second connection passes.
        await withTx(second, async (b) => {
          await seedRaceOwners(b);
          const demote = await b.query(DEMOTE_TO_ADMIN, [RACE_OWNERS[0]!.id]);
          expect(demote.rowCount).toBe(1);
        });
      } finally {
        second.release();
      }
    }, 20_000);
  });

  // --------------------------------------------------------------------------
  // Spoofed role claims in the JWT
  // --------------------------------------------------------------------------

  for (const fixture of NON_ADMIN_FIXTURES) {
    describe(`spoofed JWT role claims (${fixture.label})`, () => {
      const spoofed: JwtClaims = {
        ...fixture.claims,
        app_metadata: { role: "owner" },
        user_metadata: { role: "owner" },
      };

      it("the spoofed claims are in effect, yet is_admin() and is_owner() are false", async () => {
        await withTx(client, async (c) => {
          await fixture.seed(c);
          await asRole(c, "authenticated", spoofed);

          const { rows } = await c.query<{ app_role: string; user_role: string }>(
            `SELECT auth.jwt() -> 'app_metadata' ->> 'role'  AS app_role,
                    auth.jwt() -> 'user_metadata' ->> 'role' AS user_role`,
          );
          expect(rows[0]).toEqual({ app_role: "owner", user_role: "owner" });
          expect(await isAdminAndOwner(c)).toEqual({ is_admin: false, is_owner: false });
        });
      }, 12_000);

      it("admin and owner writes are still denied", async () => {
        await withTx(client, async (c) => {
          await seedSoleOwner(c);
          await fixture.seed(c);
          await asRole(c, "authenticated", spoofed);

          await expectPgError(c, () => c.query(INSERT_PAGE), "42501", `spoofed ${fixture.label} INSERT pages`);
          await expectPgError(
            c,
            () =>
              c.query("SELECT public.admin_save_page($1::jsonb)", [
                JSON.stringify({ translations: { da: { title: "Test" } } }),
              ]),
            "42501",
            `spoofed ${fixture.label} admin_save_page`,
          );
          await expectPgError(
            c,
            () => c.query("INSERT INTO public.user_allowlist (email, role) VALUES ('spoof@test.local', 'owner')"),
            "42501",
            `spoofed ${fixture.label} INSERT user_allowlist`,
          );
          const escalate = await c.query("UPDATE public.profiles SET role = 'owner' WHERE user_id = $1", [
            fixture.claims.sub,
          ]);
          expect(escalate.rowCount).toBe(0);
          const demote = await c.query("UPDATE public.profiles SET role = NULL WHERE user_id = $1", [OWNER_UUID]);
          expect(demote.rowCount).toBe(0);
        });
      }, 12_000);
    });
  }
});
