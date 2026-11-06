/**
 * RLS integration tests — MyLife health data (mylife_profile, mylife_events).
 *
 * Covers the P3 mylife-app policies (migration 20261105000300_mylife_schema.sql) with the
 * MyLife role gate (migration 20261105000400_mylife_role_gate.sql): every policy requires
 * `(select auth.uid()) = user_id` AND `(select private.is_mylife())` (role owner or mylife_user).
 *   - a MyLife user (owner, mylife_user) selects, inserts, updates, upserts and deletes its own
 *     rows on both tables, decimals round-tripping as the exact strings written (positive
 *     control: the denials below are the policies, not a blanket failure)
 *   - spec step 6, user A cannot read user B: A cannot select, update or delete B's rows,
 *     cannot insert a row carrying B's user_id, cannot re-parent its own row to B, and an
 *     upsert on B's id is blocked. The owner role gives no read-all on health data.
 *   - a signed-in account without a MyLife role (admin, monitor_user, role = NULL, no profile
 *     row) is denied on both tables, its own rows included. monitor_user (20261106000100) must
 *     be a committed app_role value on the target; until it is, its cases skip.
 *   - anon has no grant on either table and TRUNCATE is granted to nobody → 42501
 *   - exactly the eight mylife policies exist, permissive for authenticated, each gated
 *
 * UPDATE / DELETE USING failures filter rows silently → rowCount 0, no error;
 * INSERT / UPDATE WITH CHECK and ON CONFLICT DO UPDATE failures → 42501.
 * Denied writes are checked against the stored rows as postgres (RESET ROLE, RLS bypassed).
 */

import { randomUUID } from "node:crypto";
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
  type JwtClaims,
  withTx,
} from "./helpers/roles.js";

/** A signed-in caller and how to seed its auth.users / profiles rows (as postgres, before asRole). */
interface Account {
  label: string;
  claims: JwtClaims;
  userId: string;
  seed: (c: PoolClient) => Promise<void>;
  /** The seed assigns monitor_user, which the target must hold as a committed app_role value. */
  requiresMonitorRole?: true;
}

const OWNER: Account = {
  label: "owner",
  claims: OWNER_CLAIMS,
  userId: OWNER_UUID,
  seed: (c) => seedAuthUser(c, OWNER_UUID, OWNER_EMAIL, "owner"),
};
const MYLIFE: Account = {
  label: "mylife_user",
  claims: MYLIFE_CLAIMS,
  userId: MYLIFE_UUID,
  seed: (c) => seedAuthUser(c, MYLIFE_UUID, MYLIFE_EMAIL, "mylife_user"),
};

const MONITOR_UUID = "00000000-0000-0000-0000-000000000007";
const MONITOR_EMAIL = "monitor@test.local";
const MONITOR_ROLE_MISSING =
  "app_role has no committed 'monitor_user' on the target: apply 20261106000100 first";

/** The roles MyLife lets in. */
const MYLIFE_ACCOUNTS: readonly Account[] = [OWNER, MYLIFE];

/** Signed-in accounts that must never pass private.is_mylife(). */
const NON_MYLIFE_ACCOUNTS: readonly Account[] = [
  {
    label: "admin",
    claims: ADMIN_CLAIMS,
    userId: ADMIN_UUID,
    seed: (c) => seedAuthUser(c, ADMIN_UUID, ADMIN_EMAIL, "admin"),
  },
  {
    // The page-change monitor's public sign-up role. seedAuthUser's AppRole predates it:
    // allowlist it here and let on_auth_user_created copy it into the new profile.
    label: "monitor_user",
    claims: { sub: MONITOR_UUID, role: "authenticated", email: MONITOR_EMAIL },
    userId: MONITOR_UUID,
    requiresMonitorRole: true,
    seed: async (c) => {
      await c.query("INSERT INTO public.user_allowlist (email, role) VALUES ($1, 'monitor_user')", [MONITOR_EMAIL]);
      await seedAuthUser(c, MONITOR_UUID, MONITOR_EMAIL);
    },
  },
  {
    label: "profile role=null",
    claims: NULL_ROLE_CLAIMS,
    userId: NULL_ROLE_UUID,
    seed: (c) => seedAuthUser(c, NULL_ROLE_UUID, NULL_ROLE_EMAIL),
  },
  {
    // An auth user whose profiles row is gone (the owner may delete profiles): the FK to
    // auth.users still lets rows exist, and current_role_in() finds no row at all.
    label: "no profile row",
    claims: NON_ADMIN_CLAIMS,
    userId: NON_ADMIN_UUID,
    seed: async (c) => {
      await seedAuthUser(c, NON_ADMIN_UUID, "noprofile@test.local");
      await c.query("DELETE FROM public.profiles WHERE user_id = $1", [NON_ADMIN_UUID]);
    },
  },
];

/** [A, B]: A acts on B's rows. Both directions, so the owner role is covered as attacker and victim. */
const PAIRS: ReadonlyArray<readonly [Account, Account]> = [
  [OWNER, MYLIFE],
  [MYLIFE, OWNER],
];

// Seeded values; decimals are exact strings, never numbers.
const SEED_HYPO = "70";
const SEED_VALUE = "5.4";
const UTC_MS = "1762300000000";
const CALC = {
  enabled: true,
  minBgMgdl: "70",
  maxBolus: "10",
  diaMinutes: 240,
  targetBg: [{ s: 0, e: 1440, v: "110" }],
  correctionFactor: [{ s: 0, e: 1440, v: "2.5" }],
  icRatio: [{ s: 0, e: 720, v: "12.5" }, { s: 720, e: 1440, v: "10.0" }],
};

const INSERT_PROFILE = "INSERT INTO public.mylife_profile (user_id) VALUES ($1)";
const UPSERT_PROFILE_HYPO = `INSERT INTO public.mylife_profile (user_id, hypo) VALUES ($1, $2)
  ON CONFLICT (user_id) DO UPDATE SET hypo = excluded.hypo`;
const INSERT_EVENT = "INSERT INTO public.mylife_events (id, user_id, utc_ms, type, value) VALUES ($1, $2, $3, 1, $4)";
/** PostgREST's upsert (merge-duplicates): every column from the payload, the owner included. */
const UPSERT_EVENT = `INSERT INTO public.mylife_events (id, user_id, utc_ms, type, value) VALUES ($1, $2, $3, 1, $4)
  ON CONFLICT (id) DO UPDATE SET user_id = excluded.user_id, value = excluded.value`;

/** A mylife_profile row and one diary event for `userId`, as postgres. Returns the event id. */
async function seedMyLifeRows(c: PoolClient, userId: string): Promise<string> {
  const eventId = randomUUID();
  await c.query("INSERT INTO public.mylife_profile (user_id, name, hypo) VALUES ($1, 'Seeded', $2)", [
    userId,
    SEED_HYPO,
  ]);
  await c.query(INSERT_EVENT, [eventId, userId, UTC_MS, SEED_VALUE]);
  return eventId;
}

interface StoredRows {
  profiles: Array<{ hypo: string }>;
  events: Array<{ user_id: string; value: string | null }>;
}

/** `userId`'s profile and the event `eventId` as stored, read as postgres (leaves the caller's role). */
async function storedRows(c: PoolClient, userId: string, eventId: string): Promise<StoredRows> {
  await c.query("RESET ROLE");
  const profiles = await c.query<{ hypo: string }>("SELECT hypo FROM public.mylife_profile WHERE user_id = $1", [
    userId,
  ]);
  const events = await c.query<{ user_id: string; value: string | null }>(
    "SELECT user_id, value FROM public.mylife_events WHERE id = $1",
    [eventId],
  );
  return { profiles: profiles.rows, events: events.rows };
}

/** The rows seedMyLifeRows wrote, untouched. */
function unchanged(userId: string): StoredRows {
  return { profiles: [{ hypo: SEED_HYPO }], events: [{ user_id: userId, value: SEED_VALUE }] };
}

describe.skipIf(!DB_AVAILABLE)("RLS — MyLife health data (mylife_profile + mylife_events)", () => {
  let client: PoolClient;
  /** 'monitor_user' is a committed app_role value on the target (20261106000100 applied). */
  let monitorRoleCommitted: boolean;

  beforeAll(async () => {
    client = await getClient();
    const { rows } = await client.query<{ committed: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_enum
                       WHERE enumtypid = 'public.app_role'::regtype AND enumlabel = 'monitor_user') AS committed`,
    );
    monitorRoleCommitted = rows[0]!.committed;
  });

  afterAll(async () => {
    client.release();
  });

  // --------------------------------------------------------------------------
  // anon: no table privileges at all
  // --------------------------------------------------------------------------

  const ANON_STATEMENTS: ReadonlyArray<{ label: string; sql: string; params?: unknown[] }> = [
    { label: "SELECT mylife_profile", sql: "SELECT user_id FROM public.mylife_profile" },
    { label: "INSERT mylife_profile", sql: INSERT_PROFILE, params: [OWNER_UUID] },
    { label: "UPDATE mylife_profile", sql: "UPDATE public.mylife_profile SET hypo = '1'" },
    { label: "DELETE mylife_profile", sql: "DELETE FROM public.mylife_profile" },
    { label: "SELECT mylife_events", sql: "SELECT id FROM public.mylife_events" },
    { label: "INSERT mylife_events", sql: INSERT_EVENT, params: [randomUUID(), OWNER_UUID, UTC_MS, "1"] },
    { label: "UPDATE mylife_events", sql: "UPDATE public.mylife_events SET value = '1'" },
    { label: "DELETE mylife_events", sql: "DELETE FROM public.mylife_events" },
    { label: "TRUNCATE mylife_profile", sql: "TRUNCATE public.mylife_profile" },
    { label: "TRUNCATE mylife_events", sql: "TRUNCATE public.mylife_events" },
  ];

  for (const stmt of ANON_STATEMENTS) {
    it(`anon: ${stmt.label} raises 42501`, async () => {
      await withTx(client, async (c) => {
        await OWNER.seed(c);
        await seedMyLifeRows(c, OWNER_UUID);
        await asRole(c, "anon", ANON_CLAIMS);
        await expectPgError(c, () => c.query(stmt.sql, stmt.params), "42501", `anon ${stmt.label}`);
      });
    }, 12_000);
  }

  // --------------------------------------------------------------------------
  // TRUNCATE is not subject to RLS, so not even a MyLife user may run it
  // --------------------------------------------------------------------------

  for (const table of ["mylife_profile", "mylife_events"] as const) {
    it(`MyLife user (owner): TRUNCATE ${table} raises 42501`, async () => {
      await withTx(client, async (c) => {
        await OWNER.seed(c);
        await seedMyLifeRows(c, OWNER_UUID);
        await asRole(c, "authenticated", OWNER_CLAIMS);
        await expectPgError(c, () => c.query(`TRUNCATE public.${table}`), "42501", `owner TRUNCATE ${table}`);
      });
    }, 12_000);
  }

  // --------------------------------------------------------------------------
  // MyLife users on their own rows (positive control)
  // --------------------------------------------------------------------------

  for (const who of MYLIFE_ACCOUNTS) {
    describe(`MyLife user (${who.label}) — own rows`, () => {
      it("reads only its own rows on both tables", async () => {
        await withTx(client, async (c) => {
          await OWNER.seed(c);
          await MYLIFE.seed(c);
          const ownerEvent = await seedMyLifeRows(c, OWNER_UUID);
          const mylifeEvent = await seedMyLifeRows(c, MYLIFE_UUID);
          const ownEvent = who === OWNER ? ownerEvent : mylifeEvent;
          await asRole(c, "authenticated", who.claims);

          const profiles = await c.query<{ user_id: string }>("SELECT user_id FROM public.mylife_profile");
          expect(profiles.rows).toEqual([{ user_id: who.userId }]);
          const events = await c.query<{ id: string; user_id: string }>("SELECT id, user_id FROM public.mylife_events");
          expect(events.rows).toEqual([{ id: ownEvent, user_id: who.userId }]);
        });
      }, 12_000);

      it("inserts, updates, upserts and deletes its own profile; decimals stay exact strings", async () => {
        await withTx(client, async (c) => {
          await who.seed(c);
          await asRole(c, "authenticated", who.claims);

          const insert = await c.query(
            `INSERT INTO public.mylife_profile (user_id, name, unit, hypo, hyper, calc)
             VALUES ($1, 'Mig', 'mmol', '3.90', '10.0', $2::jsonb)`,
            [who.userId, JSON.stringify(CALC)],
          );
          expect(insert.rowCount).toBe(1);
          const update = await c.query("UPDATE public.mylife_profile SET hyper = '11.10' WHERE user_id = $1", [
            who.userId,
          ]);
          expect(update.rowCount).toBe(1);
          const upsert = await c.query(UPSERT_PROFILE_HYPO, [who.userId, "4.05"]);
          expect(upsert.rowCount).toBe(1);

          const { rows } = await c.query("SELECT user_id, name, unit, hypo, hyper, calc FROM public.mylife_profile");
          expect(rows).toEqual([
            { user_id: who.userId, name: "Mig", unit: "mmol", hypo: "4.05", hyper: "11.10", calc: CALC },
          ]);

          const del = await c.query("DELETE FROM public.mylife_profile WHERE user_id = $1", [who.userId]);
          expect(del.rowCount).toBe(1);
          expect((await c.query("SELECT user_id FROM public.mylife_profile")).rows).toEqual([]);
        });
      }, 12_000);

      it("inserts, updates, upserts and deletes its own events; decimals stay exact strings", async () => {
        await withTx(client, async (c) => {
          await who.seed(c);
          await asRole(c, "authenticated", who.claims);
          const eventId = randomUUID();

          const insert = await c.query(INSERT_EVENT, [eventId, who.userId, UTC_MS, "6.10"]);
          expect(insert.rowCount).toBe(1);
          const update = await c.query("UPDATE public.mylife_events SET comment = 'efter mad' WHERE id = $1", [eventId]);
          expect(update.rowCount).toBe(1);
          const upsert = await c.query(UPSERT_EVENT, [eventId, who.userId, UTC_MS, "6.15"]);
          expect(upsert.rowCount).toBe(1);

          const { rows } = await c.query("SELECT id, user_id, value, comment FROM public.mylife_events");
          expect(rows).toEqual([{ id: eventId, user_id: who.userId, value: "6.15", comment: "efter mad" }]);

          const del = await c.query("DELETE FROM public.mylife_events WHERE id = $1", [eventId]);
          expect(del.rowCount).toBe(1);
          expect((await c.query("SELECT id FROM public.mylife_events")).rows).toEqual([]);
        });
      }, 12_000);
    });
  }

  // --------------------------------------------------------------------------
  // Spec step 6: user A cannot read (or write) user B's rows
  // --------------------------------------------------------------------------

  for (const [a, b] of PAIRS) {
    describe(`user A (${a.label}) on user B (${b.label})'s rows`, () => {
      it("A cannot read B's profile or events", async () => {
        await withTx(client, async (c) => {
          await a.seed(c);
          await b.seed(c);
          await seedMyLifeRows(c, a.userId);
          const bEvent = await seedMyLifeRows(c, b.userId);
          await asRole(c, "authenticated", a.claims);

          const profiles = await c.query("SELECT user_id FROM public.mylife_profile WHERE user_id = $1", [b.userId]);
          expect(profiles.rows).toEqual([]);
          const byOwner = await c.query("SELECT id FROM public.mylife_events WHERE user_id = $1", [b.userId]);
          expect(byOwner.rows).toEqual([]);
          const byId = await c.query("SELECT id FROM public.mylife_events WHERE id = $1", [bEvent]);
          expect(byId.rows).toEqual([]);
        });
      }, 12_000);

      it("A cannot update or delete B's rows", async () => {
        await withTx(client, async (c) => {
          await a.seed(c);
          await b.seed(c);
          const bEvent = await seedMyLifeRows(c, b.userId);
          await asRole(c, "authenticated", a.claims);

          const updates = [
            await c.query("UPDATE public.mylife_profile SET hypo = '1' WHERE user_id = $1", [b.userId]),
            await c.query("UPDATE public.mylife_events SET value = '1' WHERE id = $1", [bEvent]),
            await c.query("UPDATE public.mylife_events SET user_id = $1 WHERE id = $2", [a.userId, bEvent]),
          ];
          expect(updates.map((r) => r.rowCount)).toEqual([0, 0, 0]);
          const deletes = [
            await c.query("DELETE FROM public.mylife_profile WHERE user_id = $1", [b.userId]),
            await c.query("DELETE FROM public.mylife_events WHERE user_id = $1", [b.userId]),
          ];
          expect(deletes.map((r) => r.rowCount)).toEqual([0, 0]);

          expect(await storedRows(c, b.userId, bEvent)).toEqual(unchanged(b.userId));
        });
      }, 12_000);

      it("A cannot insert a row carrying B's user_id (42501)", async () => {
        await withTx(client, async (c) => {
          await a.seed(c);
          await b.seed(c);
          await asRole(c, "authenticated", a.claims);

          await expectPgError(c, () => c.query(INSERT_PROFILE, [b.userId]), "42501", "INSERT profile for B");
          await expectPgError(
            c,
            () => c.query(INSERT_EVENT, [randomUUID(), b.userId, UTC_MS, "1"]),
            "42501",
            "INSERT event for B",
          );
        });
      }, 12_000);

      it("A cannot re-parent its own rows to B (42501)", async () => {
        await withTx(client, async (c) => {
          await a.seed(c);
          await b.seed(c);
          const aEvent = await seedMyLifeRows(c, a.userId);
          await asRole(c, "authenticated", a.claims);

          await expectPgError(
            c,
            () => c.query("UPDATE public.mylife_profile SET user_id = $1 WHERE user_id = $2", [b.userId, a.userId]),
            "42501",
            "re-parent profile to B",
          );
          await expectPgError(
            c,
            () => c.query("UPDATE public.mylife_events SET user_id = $1 WHERE id = $2", [b.userId, aEvent]),
            "42501",
            "re-parent event to B",
          );

          expect(await storedRows(c, a.userId, aEvent)).toEqual(unchanged(a.userId));
        });
      }, 12_000);

      it("an upsert on B's id is blocked (42501)", async () => {
        await withTx(client, async (c) => {
          await a.seed(c);
          await b.seed(c);
          const bEvent = await seedMyLifeRows(c, b.userId);
          await asRole(c, "authenticated", a.claims);

          await expectPgError(c, () => c.query(UPSERT_PROFILE_HYPO, [b.userId, "1"]), "42501", "upsert B's profile");
          // A claims B's event id as its own: the conflicting row fails A's UPDATE policy.
          await expectPgError(
            c,
            () => c.query(UPSERT_EVENT, [bEvent, a.userId, UTC_MS, "1"]),
            "42501",
            "upsert B's event id as A",
          );
          await expectPgError(
            c,
            () => c.query(UPSERT_EVENT, [bEvent, b.userId, UTC_MS, "1"]),
            "42501",
            "upsert B's event id as B",
          );

          expect(await storedRows(c, b.userId, bEvent)).toEqual(unchanged(b.userId));
        });
      }, 12_000);
    });
  }

  // --------------------------------------------------------------------------
  // Role gate: signed in, but not owner / mylife_user
  // --------------------------------------------------------------------------

  for (const who of NON_MYLIFE_ACCOUNTS) {
    describe(`no MyLife role (${who.label})`, () => {
      it("cannot read, update or delete even its own rows", async ({ skip }) => {
        skip(!!who.requiresMonitorRole && !monitorRoleCommitted, MONITOR_ROLE_MISSING);
        await withTx(client, async (c) => {
          await who.seed(c);
          const eventId = await seedMyLifeRows(c, who.userId);
          await asRole(c, "authenticated", who.claims);

          expect((await c.query("SELECT user_id FROM public.mylife_profile")).rows).toEqual([]);
          expect((await c.query("SELECT id FROM public.mylife_events")).rows).toEqual([]);
          const writes = [
            await c.query("UPDATE public.mylife_profile SET hypo = '1' WHERE user_id = $1", [who.userId]),
            await c.query("UPDATE public.mylife_events SET value = '1' WHERE id = $1", [eventId]),
            await c.query("DELETE FROM public.mylife_profile WHERE user_id = $1", [who.userId]),
            await c.query("DELETE FROM public.mylife_events WHERE id = $1", [eventId]),
          ];
          expect(writes.map((r) => r.rowCount)).toEqual([0, 0, 0, 0]);

          expect(await storedRows(c, who.userId, eventId)).toEqual(unchanged(who.userId));
        });
      }, 12_000);

      it("cannot insert or upsert its own rows (42501)", async ({ skip }) => {
        skip(!!who.requiresMonitorRole && !monitorRoleCommitted, MONITOR_ROLE_MISSING);
        await withTx(client, async (c) => {
          await who.seed(c);
          await asRole(c, "authenticated", who.claims);

          await expectPgError(c, () => c.query(INSERT_PROFILE, [who.userId]), "42501", `${who.label} INSERT profile`);
          await expectPgError(
            c,
            () => c.query(UPSERT_PROFILE_HYPO, [who.userId, "1"]),
            "42501",
            `${who.label} upsert profile`,
          );
          await expectPgError(
            c,
            () => c.query(INSERT_EVENT, [randomUUID(), who.userId, UTC_MS, "1"]),
            "42501",
            `${who.label} INSERT event`,
          );
        });
      }, 12_000);
    });
  }

  // --------------------------------------------------------------------------
  // Catalog: no other policy can widen access (permissive policies OR together)
  // --------------------------------------------------------------------------

  it("exactly the eight mylife policies exist, permissive for authenticated, each requiring ownership AND private.is_mylife()", async () => {
    await withTx(client, async (c) => {
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
          WHERE schemaname = 'public' AND tablename IN ('mylife_profile', 'mylife_events')`,
      );
      /** null = no such clause; true = the clause checks both ownership and the MyLife role. */
      const gated = (expr: string | null) =>
        expr === null ? null : expr.includes("auth.uid()") && expr.includes("private.is_mylife()");
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
      const policy = (table: "mylife_events" | "mylife_profile", cmd: "SELECT" | "INSERT" | "UPDATE" | "DELETE") => ({
        policy: `${table}.${table}_${cmd.toLowerCase()}`,
        permissive: "PERMISSIVE",
        roles: ["authenticated"],
        cmd,
        using: cmd === "INSERT" ? null : true,
        check: cmd === "INSERT" || cmd === "UPDATE" ? true : null,
      });
      expect(actual).toEqual([
        policy("mylife_events", "DELETE"),
        policy("mylife_events", "INSERT"),
        policy("mylife_events", "SELECT"),
        policy("mylife_events", "UPDATE"),
        policy("mylife_profile", "DELETE"),
        policy("mylife_profile", "INSERT"),
        policy("mylife_profile", "SELECT"),
        policy("mylife_profile", "UPDATE"),
      ]);
    });
  }, 12_000);
});
