/**
 * RLS integration tests — category and item visibility.
 *
 * Covers F0.4 acceptance:
 *   - category hidden until it has ≥1 published item, then visible — and hidden again
 *     once its only published item goes back to draft
 *   - category_translations and the category's routes follow the same visibility
 *     (routes_select category branch); a draft category stays hidden even with a
 *     published item
 *   - item, item_translations and media visibility require a published item in a
 *     published category
 *   - category_translations / item_translations DA row cannot be deleted
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_AVAILABLE, getClient, type PoolClient } from "./helpers/db.js";
import {
  ADMIN_CLAIMS,
  ADMIN_UUID,
  ANON_CLAIMS,
  asRole,
  seedAdmin,
  seedAuthUser,
  seedCategory,
  seedCategoryTranslation,
  seedItem,
  seedItemTranslation,
  seedMedia,
  seedRoute,
  withTx,
} from "./helpers/roles.js";

describe.skipIf(!DB_AVAILABLE)("RLS — category / item visibility", () => {
  let client: PoolClient;

  beforeAll(async () => {
    client = await getClient();
  });

  afterAll(async () => {
    client.release();
  });

  // --------------------------------------------------------------------------
  // Category visibility: gated by published items
  // --------------------------------------------------------------------------

  it("anon: category with no items is not visible", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      await asRole(c, "anon", ANON_CLAIMS);

      const { rows } = await c.query(
        "SELECT id FROM public.categories WHERE id = $1",
        [catId],
      );
      expect(rows).toHaveLength(0);
    });
  }, 12_000);

  it("anon: category with only draft items is not visible", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      await seedItem(c, catId, "draft");
      await asRole(c, "anon", ANON_CLAIMS);

      const { rows } = await c.query(
        "SELECT id FROM public.categories WHERE id = $1",
        [catId],
      );
      expect(rows).toHaveLength(0);
    });
  }, 12_000);

  it("anon: category with at least one published item is visible", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      await seedItem(c, catId, "published");
      await asRole(c, "anon", ANON_CLAIMS);

      const { rows } = await c.query(
        "SELECT id FROM public.categories WHERE id = $1",
        [catId],
      );
      expect(rows).toHaveLength(1);
    });
  }, 12_000);

  it("anon: category_translations hidden when category has no published item", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      await seedCategoryTranslation(c, catId, "da");
      await asRole(c, "anon", ANON_CLAIMS);

      const { rows } = await c.query(
        "SELECT category_id FROM public.category_translations WHERE category_id = $1",
        [catId],
      );
      expect(rows).toHaveLength(0);
    });
  }, 12_000);

  it("anon: category_translations returned once a published item exists", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      await seedCategoryTranslation(c, catId, "da");
      await seedItem(c, catId, "published");
      await asRole(c, "anon", ANON_CLAIMS);

      const { rows } = await c.query(
        "SELECT locale FROM public.category_translations WHERE category_id = $1",
        [catId],
      );
      expect(rows).toHaveLength(1);
    });
  }, 12_000);

  it("anon: draft item is not visible", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      const itemId = await seedItem(c, catId, "draft");
      await asRole(c, "anon", ANON_CLAIMS);

      const { rows } = await c.query(
        "SELECT id FROM public.items WHERE id = $1",
        [itemId],
      );
      expect(rows).toHaveLength(0);
    });
  }, 12_000);

  it("anon: published item in a published category is visible", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      const itemId = await seedItem(c, catId, "published");
      await asRole(c, "anon", ANON_CLAIMS);

      const { rows } = await c.query(
        "SELECT id FROM public.items WHERE id = $1",
        [itemId],
      );
      expect(rows).toHaveLength(1);
    });
  }, 12_000);

  it("anon: category hides again after its only published item is set back to draft", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      await seedCategoryTranslation(c, catId, "da");
      await seedRoute(c, "da", "rls-kat-flip", { categoryId: catId });
      const itemId = await seedItem(c, catId, "published");
      await seedAdmin(c);

      await asRole(c, "anon", ANON_CLAIMS);
      expect(await visibleCategoryRows(c, catId)).toEqual({ categories: 1, translations: 1, routes: 1 });

      await asRole(c, "authenticated", ADMIN_CLAIMS);
      const unpublish = await c.query("UPDATE public.items SET status = 'draft' WHERE id = $1", [itemId]);
      expect(unpublish.rowCount).toBe(1);

      await asRole(c, "anon", ANON_CLAIMS);
      expect(await visibleCategoryRows(c, catId)).toEqual({ categories: 0, translations: 0, routes: 0 });
    });
  }, 12_000);

  it("anon: draft category with a published item is hidden (category, translations, routes)", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c, { status: "draft" });
      await seedCategoryTranslation(c, catId, "da");
      await seedRoute(c, "da", "rls-kat-draft", { categoryId: catId });
      await seedItem(c, catId, "published");
      await asRole(c, "anon", ANON_CLAIMS);

      expect(await visibleCategoryRows(c, catId)).toEqual({ categories: 0, translations: 0, routes: 0 });
    });
  }, 12_000);

  it("anon: published item inside a draft category is hidden (item, translations, media)", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c, { status: "draft" });
      const itemId = await seedItem(c, catId, "published");
      await seedItemTranslation(c, itemId, "da", "rls-vare-draftkat");
      await seedMedia(c, itemId);
      await asRole(c, "anon", ANON_CLAIMS);

      expect(await visibleItemRows(c, itemId)).toEqual({ items: 0, translations: 0, media: 0 });
    });
  }, 12_000);

  it("anon: category route is hidden while the category has no published item", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      await seedRoute(c, "da", "rls-kat-tom", { categoryId: catId });
      await seedItem(c, catId, "draft");
      await asRole(c, "anon", ANON_CLAIMS);

      const { rows } = await c.query("SELECT slug FROM public.routes WHERE category_id = $1", [catId]);
      expect(rows).toHaveLength(0);
    });
  }, 12_000);

  it("anon: category route is returned once the category has a published item", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      await seedRoute(c, "da", "rls-kat-synlig", { categoryId: catId });
      await seedItem(c, catId, "published");
      await asRole(c, "anon", ANON_CLAIMS);

      const { rows } = await c.query<{ slug: string }>(
        "SELECT slug FROM public.routes WHERE category_id = $1",
        [catId],
      );
      expect(rows.map((r) => r.slug)).toEqual(["rls-kat-synlig"]);
    });
  }, 12_000);

  it("anon: item_translations and media of a published item in a published category are returned", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      const itemId = await seedItem(c, catId, "published");
      await seedItemTranslation(c, itemId, "da", "rls-vare-synlig");
      await seedMedia(c, itemId);
      await asRole(c, "anon", ANON_CLAIMS);

      expect(await visibleItemRows(c, itemId)).toEqual({ items: 1, translations: 1, media: 1 });
    });
  }, 12_000);

  it("anon: item_translations and media of a draft item are not returned", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      const itemId = await seedItem(c, catId, "draft");
      await seedItemTranslation(c, itemId, "da", "rls-vare-kladde");
      await seedMedia(c, itemId);
      await asRole(c, "anon", ANON_CLAIMS);

      expect(await visibleItemRows(c, itemId)).toEqual({ items: 0, translations: 0, media: 0 });
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // DA translation delete guard — category_translations and item_translations
  // --------------------------------------------------------------------------

  it("admin: DELETE category_translation locale='da' deletes 0 rows", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      await seedCategoryTranslation(c, catId, "da");
      await seedAuthUser(c, ADMIN_UUID, "admin@test.local", "admin");
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      const result = await c.query(
        "DELETE FROM public.category_translations WHERE category_id = $1 AND locale = 'da'",
        [catId],
      );
      expect(result.rowCount).toBe(0);
    });
  }, 12_000);

  it("admin: DELETE category_translation locale='en' succeeds", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      await seedCategoryTranslation(c, catId, "da");
      await seedCategoryTranslation(c, catId, "en");
      await seedAuthUser(c, ADMIN_UUID, "admin@test.local", "admin");
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      const result = await c.query(
        "DELETE FROM public.category_translations WHERE category_id = $1 AND locale = 'en'",
        [catId],
      );
      expect(result.rowCount).toBe(1);
    });
  }, 12_000);

  it("admin: DELETE item_translation locale='da' deletes 0 rows", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      const itemId = await seedItem(c, catId, "published");
      await seedItemTranslation(c, itemId, "da", "testprodukt-da");
      await seedAuthUser(c, ADMIN_UUID, "admin@test.local", "admin");
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      const result = await c.query(
        "DELETE FROM public.item_translations WHERE item_id = $1 AND locale = 'da'",
        [itemId],
      );
      expect(result.rowCount).toBe(0);
    });
  }, 12_000);

  it("admin: DELETE item_translation locale='en' succeeds", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      const itemId = await seedItem(c, catId, "published");
      await seedItemTranslation(c, itemId, "da", "testprodukt-da2");
      await seedItemTranslation(c, itemId, "en", "testprodukt-en");
      await seedAuthUser(c, ADMIN_UUID, "admin@test.local", "admin");
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      const result = await c.query(
        "DELETE FROM public.item_translations WHERE item_id = $1 AND locale = 'en'",
        [itemId],
      );
      expect(result.rowCount).toBe(1);
    });
  }, 12_000);
});

/** Row counts the current role can see for a category, its translations and its routes. */
async function visibleCategoryRows(
  c: PoolClient,
  categoryId: string,
): Promise<{ categories: number; translations: number; routes: number }> {
  const { rows } = await c.query<{ categories: number; translations: number; routes: number }>(
    `SELECT (SELECT count(*) FROM public.categories WHERE id = $1)::int AS categories,
            (SELECT count(*) FROM public.category_translations WHERE category_id = $1)::int AS translations,
            (SELECT count(*) FROM public.routes WHERE category_id = $1)::int AS routes`,
    [categoryId],
  );
  return rows[0]!;
}

/** Row counts the current role can see for an item, its translations and its media. */
async function visibleItemRows(
  c: PoolClient,
  itemId: string,
): Promise<{ items: number; translations: number; media: number }> {
  const { rows } = await c.query<{ items: number; translations: number; media: number }>(
    `SELECT (SELECT count(*) FROM public.items WHERE id = $1)::int AS items,
            (SELECT count(*) FROM public.item_translations WHERE item_id = $1)::int AS translations,
            (SELECT count(*) FROM public.media WHERE item_id = $1)::int AS media`,
    [itemId],
  );
  return rows[0]!;
}
