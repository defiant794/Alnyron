/**
 * RLS integration tests — write permissions.
 *
 * Covers F0.4 acceptance:
 *   - non-admin authenticated users cannot INSERT into any content table — checked for a
 *     caller with no profile, a profile with role = NULL and a 'mylife_user' profile
 *   - non-admin UPDATE / DELETE on published (i.e. readable) pages, page_translations and
 *     routes rows affects 0 rows and leaves them unchanged
 *   - admin can INSERT pages, categories, items
 *   - admin can UPDATE and DELETE non-system pages
 *
 * INSERT WITH CHECK failure → 42501. UPDATE / DELETE USING failure filters rows silently →
 * rowCount 0, no error. Non-admin site_settings writes live in rls-site-settings.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_AVAILABLE, getClient, type PoolClient } from "./helpers/db.js";
import {
  ADMIN_CLAIMS,
  NON_ADMIN_FIXTURES,
  asRole,
  expectPgError,
  seedAdmin,
  seedCategory,
  seedDraftPage,
  seedItem,
  seedPageTranslation,
  seedPublishedPage,
  seedRoute,
  withTx,
} from "./helpers/roles.js";

/** INSERT statements a non-admin must not run; `seed` returns the `$1` parameter, if any. */
const NON_ADMIN_INSERTS: ReadonlyArray<{
  table: string;
  seed: (c: PoolClient) => Promise<string[]>;
  sql: string;
}> = [
  { table: "pages", seed: async () => [], sql: "INSERT INTO public.pages (status) VALUES ('draft')" },
  {
    table: "page_translations",
    seed: async (c) => [await seedPublishedPage(c)],
    sql: "INSERT INTO public.page_translations (page_id, locale, title) VALUES ($1, 'da', 'Test')",
  },
  {
    table: "routes",
    seed: async (c) => [await seedPublishedPage(c)],
    sql: "INSERT INTO public.routes (locale, slug, page_id) VALUES ('da', 'testslug', $1)",
  },
  { table: "categories", seed: async () => [], sql: "INSERT INTO public.categories (kind) VALUES ('apps')" },
  {
    table: "category_translations",
    seed: async (c) => [await seedCategory(c)],
    sql: "INSERT INTO public.category_translations (category_id, locale, title) VALUES ($1, 'da', 'Test')",
  },
  {
    table: "items",
    seed: async (c) => [await seedCategory(c)],
    sql: "INSERT INTO public.items (category_id, status) VALUES ($1, 'draft')",
  },
  {
    table: "item_translations",
    seed: async (c) => [await seedItem(c, await seedCategory(c), "draft")],
    sql: "INSERT INTO public.item_translations (item_id, locale, slug, title) VALUES ($1, 'da', 'test-slug', 'Test')",
  },
  {
    // A row valid in every other respect (path in the item's folder), so only RLS refuses it.
    table: "media",
    seed: async (c) => [await seedItem(c, await seedCategory(c), "published")],
    sql: `INSERT INTO public.media (item_id, storage_path, alt_da, width, height, mime_type)
          VALUES ($1::uuid, 'items/' || $1::uuid || '/11111111-2222-4333-8444-555555555555.jpg',
                  'Test billede', 100, 100, 'image/jpeg')`,
  },
];

/**
 * UPDATE / DELETE attempts against a published page's rows ($1 = page id). `check` reads
 * the value the attempt would change; non-admins can read it (published) but not write it.
 */
const PUBLISHED_ROW_MUTATIONS: ReadonlyArray<{
  label: string;
  sql: string;
  check: string;
  expected: string;
}> = [
  {
    label: "UPDATE pages",
    sql: "UPDATE public.pages SET show_in_nav = true WHERE id = $1",
    check: "SELECT show_in_nav::text AS v FROM public.pages WHERE id = $1",
    expected: "false",
  },
  {
    label: "DELETE pages",
    sql: "DELETE FROM public.pages WHERE id = $1",
    check: "SELECT count(*)::text AS v FROM public.pages WHERE id = $1",
    expected: "1",
  },
  {
    label: "UPDATE page_translations",
    sql: "UPDATE public.page_translations SET title = 'Hacked' WHERE page_id = $1",
    check: "SELECT title AS v FROM public.page_translations WHERE page_id = $1 AND locale = 'da'",
    expected: "Testside",
  },
  {
    label: "DELETE page_translations",
    sql: "DELETE FROM public.page_translations WHERE page_id = $1",
    check: "SELECT count(*)::text AS v FROM public.page_translations WHERE page_id = $1",
    expected: "2",
  },
  {
    label: "UPDATE routes",
    sql: "UPDATE public.routes SET slug = 'hacked-slug' WHERE page_id = $1",
    check: "SELECT slug AS v FROM public.routes WHERE page_id = $1 AND locale = 'da'",
    expected: "rls-write-da",
  },
  {
    label: "DELETE routes",
    sql: "DELETE FROM public.routes WHERE page_id = $1",
    check: "SELECT count(*)::text AS v FROM public.routes WHERE page_id = $1",
    expected: "2",
  },
];

/** Published page with DA+EN translations and DA+EN routes, seeded as postgres. */
async function seedPublishedPageWithRows(c: PoolClient): Promise<string> {
  const pageId = await seedPublishedPage(c);
  await seedPageTranslation(c, pageId, "da");
  await seedPageTranslation(c, pageId, "en", "Test page");
  await seedRoute(c, "da", "rls-write-da", { pageId });
  await seedRoute(c, "en", "rls-write-en", { pageId });
  return pageId;
}

describe.skipIf(!DB_AVAILABLE)("RLS — write permissions", () => {
  let client: PoolClient;

  beforeAll(async () => {
    client = await getClient();
  });

  afterAll(async () => {
    client.release();
  });

  for (const fixture of NON_ADMIN_FIXTURES) {
    describe(`non-admin (${fixture.label})`, () => {
      for (const ins of NON_ADMIN_INSERTS) {
        it(`INSERT into ${ins.table} raises 42501`, async () => {
          await withTx(client, async (c) => {
            const params = await ins.seed(c);
            await fixture.seed(c);
            await asRole(c, "authenticated", fixture.claims);
            await expectPgError(
              c,
              () => c.query(ins.sql, params),
              "42501",
              `${ins.table} INSERT ${fixture.label}`,
            );
          });
        }, 12_000);
      }

      for (const m of PUBLISHED_ROW_MUTATIONS) {
        it(`${m.label} on a published page affects 0 rows`, async () => {
          await withTx(client, async (c) => {
            const pageId = await seedPublishedPageWithRows(c);
            await fixture.seed(c);
            await asRole(c, "authenticated", fixture.claims);

            // The row is readable (published), so a 0 rowCount is the write policy at work.
            const before = await c.query<{ v: string }>(m.check, [pageId]);
            expect(before.rows[0]?.v).toBe(m.expected);

            const result = await c.query(m.sql, [pageId]);
            expect(result.rowCount).toBe(0);

            const after = await c.query<{ v: string }>(m.check, [pageId]);
            expect(after.rows[0]?.v).toBe(m.expected);
          });
        }, 12_000);
      }
    });
  }

  // --------------------------------------------------------------------------
  // Admin: INSERT / UPDATE / DELETE succeed
  // --------------------------------------------------------------------------

  it("admin: INSERT into pages succeeds", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      const { rows } = await c.query<{ id: string }>(
        "INSERT INTO public.pages (status) VALUES ('draft') RETURNING id",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBeTruthy();
    });
  }, 12_000);

  it("admin: INSERT into categories succeeds", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      const { rows } = await c.query<{ id: string }>(
        "INSERT INTO public.categories (kind) VALUES ('apps') RETURNING id",
      );
      expect(rows).toHaveLength(1);
    });
  }, 12_000);

  it("admin: INSERT into items succeeds", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      const { rows } = await c.query<{ id: string }>(
        "INSERT INTO public.items (category_id, status) VALUES ($1, 'draft') RETURNING id",
        [catId],
      );
      expect(rows).toHaveLength(1);
    });
  }, 12_000);

  it("admin: UPDATE page succeeds", async () => {
    await withTx(client, async (c) => {
      const pageId = await seedDraftPage(c);
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      const result = await c.query(
        "UPDATE public.pages SET show_in_nav = true WHERE id = $1",
        [pageId],
      );
      expect(result.rowCount).toBe(1);
    });
  }, 12_000);

  it("admin: DELETE non-system page succeeds", async () => {
    await withTx(client, async (c) => {
      const pageId = await seedDraftPage(c);
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      const result = await c.query(
        "DELETE FROM public.pages WHERE id = $1",
        [pageId],
      );
      expect(result.rowCount).toBe(1);
    });
  }, 12_000);
});
