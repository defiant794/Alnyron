/**
 * Integration tests — admin_set_page_nav RPC (monitor-nav Slice B)
 * Journey: monitor-nav  AC-MONNAV-5
 *
 * Migrations: supabase/migrations/20261107000100_monitor_page_key.sql (enum value) +
 *             supabase/migrations/20261107000200_monitor_nav_page.sql (row + RPC)
 * Run against the isolated e2e project AFTER both migrations are committed:
 *   npm run test:integration:e2e-project -- tests/integration/rls/rls-page-nav-toggle.test.ts
 *
 * Covers:
 *   - Admin can call admin_set_page_nav(monitor_page_id, true/false) → show_in_nav changes
 *   - Admin call sets updated_by = auth.uid()
 *   - Admin call with an id that is no page raises P0002 page_not_found
 *   - Non-admin callers (all NON_ADMIN_FIXTURES, plus a monitor_user) are rejected with 42501.
 *     app_role has no 'editor' value (owner/admin/mylife_user/monitor_user), so there is no
 *     editor caller to test.
 *   - Anon caller is rejected
 *
 * The monitor row (system_key='monitor') is seeded by the migration. If it is
 * absent, beforeAll fails loudly — a silent green pass would hide a missing seed.
 * All tests run inside rolled-back transactions so they do not permanently mutate the DB.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_AVAILABLE, getClient, type PoolClient } from "./helpers/db.js";
import {
  ADMIN_CLAIMS,
  ADMIN_UUID,
  ANON_CLAIMS,
  NON_ADMIN_FIXTURES,
  asRole,
  expectPgError,
  seedAdmin,
  seedAuthUser,
  withTx,
  type NonAdminFixture,
} from "./helpers/roles.js";

/** A well-formed uuid that no page has. */
const BOGUS_UUID = "00000000-0000-0000-0000-999999999996";

// MONITOR_UUID/EMAIL are local to the monitor test files (not in shared roles.ts).
const MONITOR_UUID = "00000000-0000-0000-0000-000000000007";
const MONITOR_EMAIL = "monitor@test.local";

/**
 * A public monitor sign-up: seedAuthUser without an allowlist role gets role = 'monitor_user'
 * from on_auth_user_created (20261106000400). The seed asserts that role, so the case cannot
 * silently test some other role.
 */
const MONITOR_USER_FIXTURE: NonAdminFixture = {
  label: "profile role=monitor_user",
  claims: { sub: MONITOR_UUID, role: "authenticated", email: MONITOR_EMAIL },
  seed: async (c) => {
    await seedAuthUser(c, MONITOR_UUID, MONITOR_EMAIL);
    const { rows } = await c.query<{ role: string | null }>(
      "SELECT role FROM public.profiles WHERE user_id = $1",
      [MONITOR_UUID],
    );
    expect(rows, "seedAuthUser without an allowlist role yields a monitor_user").toEqual([{ role: "monitor_user" }]);
  },
};

describe.skipIf(!DB_AVAILABLE)("RLS — admin_set_page_nav", () => {
  let client: PoolClient;
  let monitorId: string;

  beforeAll(async () => {
    client = await getClient();

    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM public.pages WHERE system_key = 'monitor' LIMIT 1`,
    );
    // Fail loudly: the monitor row must be seeded by 20261107000200_monitor_nav_page.sql.
    // A silent return/skip here would let every AC5 test report as passing with nothing verified.
    expect(rows[0]?.id, "monitor row seeded by 20261107000200_monitor_nav_page.sql").toBeTruthy();
    monitorId = rows[0]!.id;
  });

  afterAll(async () => {
    client.release();
  });

  // --------------------------------------------------------------------------
  // Non-admin is rejected from admin_set_page_nav (42501)
  // --------------------------------------------------------------------------

  for (const fixture of [...NON_ADMIN_FIXTURES, MONITOR_USER_FIXTURE]) {
    describe(`non-admin (${fixture.label})`, () => {
      it(`AC-MONNAV-5o: admin_set_page_nav raises 42501 for ${fixture.label}`, async () => {
        await withTx(client, async (c) => {
          await fixture.seed(c);
          await asRole(c, "authenticated", fixture.claims);
          await expectPgError(
            c,
            () =>
              c.query("SELECT public.admin_set_page_nav($1::uuid, $2::boolean)", [
                monitorId,
                true,
              ]),
            "42501",
            `admin_set_page_nav ${fixture.label}`,
          );
        });
      }, 12_000);
    });
  }

  // --------------------------------------------------------------------------
  // Anon is rejected
  // --------------------------------------------------------------------------

  it("AC-MONNAV-5p: admin_set_page_nav raises 42501 for anon caller", async () => {
    await withTx(client, async (c) => {
      await asRole(c, "anon", ANON_CLAIMS);
      await expectPgError(
        c,
        () =>
          c.query("SELECT public.admin_set_page_nav($1::uuid, $2::boolean)", [monitorId, true]),
        "42501",
        "admin_set_page_nav anon",
      );
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // Admin can toggle show_in_nav
  // --------------------------------------------------------------------------

  it("AC-MONNAV-5m: admin sets show_in_nav=true via admin_set_page_nav", async () => {
    await withTx(client, async (c) => {
      // Start from a known state: set show_in_nav=false as postgres before the test.
      await c.query(
        "UPDATE public.pages SET show_in_nav = false WHERE id = $1",
        [monitorId],
      );

      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      await c.query("SELECT public.admin_set_page_nav($1::uuid, $2::boolean)", [monitorId, true]);

      const { rows } = await c.query<{ show_in_nav: boolean }>(
        "SELECT show_in_nav FROM public.pages WHERE id = $1",
        [monitorId],
      );
      expect(rows[0]?.show_in_nav).toBe(true);
    });
  }, 12_000);

  it("AC-MONNAV-5m-false: admin sets show_in_nav=false via admin_set_page_nav (flips from true)", async () => {
    await withTx(client, async (c) => {
      // Start from show_in_nav=true as postgres so the flip to false is observable.
      await c.query(
        "UPDATE public.pages SET show_in_nav = true WHERE id = $1",
        [monitorId],
      );

      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      await c.query("SELECT public.admin_set_page_nav($1::uuid, $2::boolean)", [monitorId, false]);

      const { rows } = await c.query<{ show_in_nav: boolean }>(
        "SELECT show_in_nav FROM public.pages WHERE id = $1",
        [monitorId],
      );
      expect(rows[0]?.show_in_nav).toBe(false);
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // updated_by is stamped with auth.uid()
  // --------------------------------------------------------------------------

  it("AC-MONNAV-5n: admin_set_page_nav sets updated_by = auth.uid()", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      await c.query("SELECT public.admin_set_page_nav($1::uuid, $2::boolean)", [monitorId, true]);

      const { rows } = await c.query<{ updated_by: string }>(
        "SELECT updated_by FROM public.pages WHERE id = $1",
        [monitorId],
      );
      expect(rows[0]?.updated_by).toBe(ADMIN_UUID);
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // Unknown page id (P0002)
  // --------------------------------------------------------------------------

  it("AC-MONNAV-5q: admin_set_page_nav raises P0002 page_not_found for an id that is no page", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await expectPgError(
        c,
        () => c.query("SELECT public.admin_set_page_nav($1::uuid, $2::boolean)", [BOGUS_UUID, true]),
        "P0002",
        "admin_set_page_nav unknown id",
        { messageIncludes: "page_not_found" },
      );
    });
  }, 12_000);
});
