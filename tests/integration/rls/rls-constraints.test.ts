/**
 * RLS + constraint integration tests.
 *
 * Covers F0.4 acceptance:
 *   - routes_guard rejects adding a slug row for a system page (23514)
 *   - reserved slugs are rejected (23514)
 *   - duplicate slug (page vs category in same locale) is rejected (23505)
 *   - system page cannot be deleted (RLS USING: system_key IS NULL → 0 rows)
 *   - system page cannot be set to draft (pages_system_guard trigger, backed by the
 *     pages_system_always_published CHECK → 23514); see rls-system-pages.test.ts
 *   - routes_single_target requires exactly one of page_id / category_id (23514)
 *
 * System pages (home, contact, privacy) are created by the seed migration and exist as
 * committed rows. Tests SELECT them by system_key instead of INSERTing (system_key is
 * UNIQUE — a second INSERT would fail with 23505 before reaching the RLS assertion).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_AVAILABLE, getClient, type PoolClient } from "./helpers/db.js";
import {
  ADMIN_CLAIMS,
  ADMIN_UUID,
  asRole,
  expectPgError,
  seedAuthUser,
  seedCategory,
  seedPublishedPage,
  withTx,
} from "./helpers/roles.js";

describe.skipIf(!DB_AVAILABLE)("RLS + constraints — routes and system pages", () => {
  let client: PoolClient;

  beforeAll(async () => {
    client = await getClient();
  });

  afterAll(async () => {
    client.release();
  });

  // --------------------------------------------------------------------------
  // routes_guard: INSERT route for a system page raises 23514
  // SELECT the seeded 'contact' system page — do NOT insert (system_key is UNIQUE)
  // --------------------------------------------------------------------------

  it("routes_guard: INSERT route for a system page raises 23514", async () => {
    await withTx(client, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `SELECT id FROM public.pages WHERE system_key = 'contact'`,
      );
      expect(rows).toHaveLength(1);
      const sysPageId = rows[0]!.id;

      await expectPgError(
        c,
        () =>
          c.query(
            "INSERT INTO public.routes (locale, slug, page_id) VALUES ('da', 'kontakttest', $1)",
            [sysPageId],
          ),
        "23514",
        "routes_guard system page",
      );
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // Reserved slug check constraint (routes_slug_reserved)
  // --------------------------------------------------------------------------

  const RESERVED_SLUGS = [
    "admin", "auth", "api", "da", "en",
    "kontakt", "contact", "privatliv", "privacy",
  ] as const;

  for (const slug of RESERVED_SLUGS) {
    it(`reserved slug '${slug}' raises 23514`, async () => {
      await withTx(client, async (c) => {
        const pageId = await seedPublishedPage(c);
        await expectPgError(
          c,
          () =>
            c.query(
              "INSERT INTO public.routes (locale, slug, page_id) VALUES ('da', $1, $2)",
              [slug, pageId],
            ),
          "23514",
          `reserved slug '${slug}'`,
        );
      });
    }, 12_000);
  }

  // --------------------------------------------------------------------------
  // Duplicate (locale, slug) — PK violation (23505)
  // --------------------------------------------------------------------------

  it("duplicate (locale, slug) — page then category — raises 23505", async () => {
    await withTx(client, async (c) => {
      const pageId = await seedPublishedPage(c);
      const catId = await seedCategory(c);

      await c.query(
        "INSERT INTO public.routes (locale, slug, page_id) VALUES ('da', 'dupslug', $1)",
        [pageId],
      );
      await expectPgError(
        c,
        () =>
          c.query(
            "INSERT INTO public.routes (locale, slug, category_id) VALUES ('da', 'dupslug', $1)",
            [catId],
          ),
        "23505",
        "duplicate slug page vs category",
      );
    });
  }, 12_000);

  it("routes_single_target: both page_id and category_id set raises 23514", async () => {
    await withTx(client, async (c) => {
      const pageId = await seedPublishedPage(c);
      const catId = await seedCategory(c);
      await expectPgError(
        c,
        () =>
          c.query(
            "INSERT INTO public.routes (locale, slug, page_id, category_id) VALUES ('da', 'dualslug', $1, $2)",
            [pageId, catId],
          ),
        "23514",
        "routes_single_target",
      );
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // System page: DELETE blocked by RLS (0 rows, no error)
  // RLS policy: using ((select private.is_admin()) and system_key is null)
  // system_key IS NOT NULL for system pages → policy returns false → 0 rows deleted
  // SELECT the seeded 'privacy' system page — do NOT insert
  // --------------------------------------------------------------------------

  it("admin: DELETE system page returns 0 rows (RLS: system_key IS NULL guard)", async () => {
    await withTx(client, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `SELECT id FROM public.pages WHERE system_key = 'privacy'`,
      );
      expect(rows).toHaveLength(1);
      const sysId = rows[0]!.id;

      await seedAuthUser(c, ADMIN_UUID, "admin@test.local", "admin");
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      const result = await c.query(
        "DELETE FROM public.pages WHERE id = $1",
        [sysId],
      );
      expect(result.rowCount).toBe(0);
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // System page: UPDATE to 'draft' is rejected (pages_system_guard + CHECK, 23514)
  // SELECT the seeded 'home' system page — do NOT insert
  // --------------------------------------------------------------------------

  it("UPDATE system page to status='draft' raises 23514", async () => {
    await withTx(client, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `SELECT id FROM public.pages WHERE system_key = 'home'`,
      );
      expect(rows).toHaveLength(1);
      const sysId = rows[0]!.id;

      // pages_system_guard (BEFORE UPDATE) raises 23514 first; the CHECK
      // pages_system_always_published (system_key IS NULL OR status = 'published') backs it up
      await expectPgError(
        c,
        () => c.query("UPDATE public.pages SET status = 'draft' WHERE id = $1", [sysId]),
        "23514",
        "system page unpublish",
      );
    });
  }, 12_000);

  it("admin_set_page_status: setting system page to 'draft' raises 23514", async () => {
    await withTx(client, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `SELECT id FROM public.pages WHERE system_key = 'home'`,
      );
      expect(rows).toHaveLength(1);
      const sysId = rows[0]!.id;

      await seedAuthUser(c, ADMIN_UUID, "admin@test.local", "admin");
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      // admin_set_page_status issues UPDATE pages SET status='draft'
      // → pages_system_guard raises 23514
      await expectPgError(
        c,
        () =>
          c.query(
            "SELECT public.admin_set_page_status($1, 'draft'::public.content_status)",
            [sysId],
          ),
        "23514",
        "admin_set_page_status system page",
      );
    });
  }, 12_000);
});
