/**
 * RLS integration tests — site_settings.
 *
 * Covers F0.4 acceptance:
 *   - site_settings is world-readable (anon + any authenticated)
 *   - non-admin authenticated cannot UPDATE — USING is_admin() filters rows → rowCount 0,
 *     no error (UPDATE USING failures are silent row-filters, not 42501). Checked for a
 *     caller with no profile, a profile with role = NULL and a 'mylife_user' profile.
 *   - admin can UPDATE
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_AVAILABLE, getClient, type PoolClient } from "./helpers/db.js";
import {
  ADMIN_CLAIMS,
  ANON_CLAIMS,
  NON_ADMIN_FIXTURES,
  asRole,
  seedAdmin,
  seedSiteSettings,
  withTx,
} from "./helpers/roles.js";

describe.skipIf(!DB_AVAILABLE)("RLS — site_settings", () => {
  let client: PoolClient;

  beforeAll(async () => {
    client = await getClient();
  });

  afterAll(async () => {
    client.release();
  });

  it("anon: can SELECT from site_settings", async () => {
    await withTx(client, async (c) => {
      await seedSiteSettings(c);
      await asRole(c, "anon", ANON_CLAIMS);

      const { rows } = await c.query("SELECT company_name FROM public.site_settings");
      expect(rows).toHaveLength(1);
    });
  }, 12_000);

  for (const fixture of NON_ADMIN_FIXTURES) {
    it(`non-admin authenticated (${fixture.label}): can SELECT from site_settings`, async () => {
      await withTx(client, async (c) => {
        await seedSiteSettings(c);
        await fixture.seed(c);
        // site_settings_select uses `using (true)`, any role can read
        await asRole(c, "authenticated", fixture.claims);

        const { rows } = await c.query("SELECT company_name FROM public.site_settings");
        expect(rows).toHaveLength(1);
      });
    }, 12_000);

    it(`non-admin authenticated (${fixture.label}): UPDATE site_settings returns rowCount 0 (USING filter, not error)`, async () => {
      await withTx(client, async (c) => {
        await seedSiteSettings(c);
        await fixture.seed(c);
        // is_admin() is false → USING clause filters to 0 rows (silent, not a 42501 error)
        await asRole(c, "authenticated", fixture.claims);

        const result = await c.query(
          "UPDATE public.site_settings SET company_name = 'Hacked'",
        );
        expect(result.rowCount).toBe(0);

        const { rows } = await c.query<{ company_name: string }>(
          "SELECT company_name FROM public.site_settings",
        );
        expect(rows[0]?.company_name).not.toBe("Hacked");
      });
    }, 12_000);
  }

  it("admin: UPDATE site_settings succeeds", async () => {
    await withTx(client, async (c) => {
      await seedSiteSettings(c);
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      const result = await c.query(
        "UPDATE public.site_settings SET company_name = 'Opdateret Firma'",
      );
      expect(result.rowCount).toBe(1);
    });
  }, 12_000);
});
