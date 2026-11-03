/**
 * RLS integration tests — catalog visibility (F2.1 catalog-model)
 *
 * Covers:
 *   AC-CAT-47 — published category with no published items: invisible to anon
 *   AC-CAT-48 — gains first published item: category + translations + routes + item + media visible
 *   AC-CAT-49 — last published item unpublished: category hides again
 *   AC-CAT-50 — draft category hides its published items, translations, media
 *   AC-CAT-51 — media rows of a draft item invisible to anon
 *   AC-CAT-52 — admin sees everything (draft + published)
 *
 * All tests seed data as postgres (superuser, bypasses RLS) then switch role to
 * anon/admin for queries. Every test runs inside withTx (rolled back).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_AVAILABLE, getClient, type PoolClient } from "./helpers/db.js";
import {
  ADMIN_CLAIMS,
  ANON_CLAIMS,
  NON_ADMIN_FIXTURES,
  asRole,
  seedAdmin,
  seedCategory,
  seedCategoryTranslation,
  seedItem,
  seedItemTranslation,
  seedMedia,
  seedRoute,
  withTx,
} from "./helpers/roles.js";

/** Rows per table the current role sees of one category and one of its items (with one image). */
async function visibleCatalogRows(
  c: PoolClient,
  ids: { categoryId: string; itemId: string; mediaId: string },
): Promise<Record<string, number>> {
  const { rows } = await c.query<Record<string, number>>(
    `SELECT (SELECT count(*)::int FROM public.categories WHERE id = $1)                     AS categories,
            (SELECT count(*)::int FROM public.category_translations WHERE category_id = $1) AS category_translations,
            (SELECT count(*)::int FROM public.routes WHERE category_id = $1)                AS routes,
            (SELECT count(*)::int FROM public.items WHERE id = $2)                          AS items,
            (SELECT count(*)::int FROM public.item_translations WHERE item_id = $2)         AS item_translations,
            (SELECT count(*)::int FROM public.media WHERE id = $3)                          AS media`,
    [ids.categoryId, ids.itemId, ids.mediaId],
  );
  return rows[0]!;
}

const NOTHING_VISIBLE = {
  categories: 0,
  category_translations: 0,
  routes: 0,
  items: 0,
  item_translations: 0,
  media: 0,
};

/** A slug-safe form of a NON_ADMIN_FIXTURES label, so each fixture's seeded slugs are distinct. */
function fixtureSlug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

describe.skipIf(!DB_AVAILABLE)("RLS — catalog visibility", () => {
  let client: PoolClient;

  beforeAll(async () => {
    client = await getClient();
  });

  afterAll(async () => {
    client.release();
  });

  // --------------------------------------------------------------------------
  // AC-CAT-47: published category with no published items → invisible to anon
  // --------------------------------------------------------------------------

  it("AC-CAT-47: anon sees 0 categories when published category has no published items", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c, { status: "published" });
      await seedCategoryTranslation(c, catId, "da");
      await seedCategoryTranslation(c, catId, "en");
      await seedRoute(c, "da", "vis-cat-47-da", { categoryId: catId });
      await seedRoute(c, "en", "vis-cat-47-en", { categoryId: catId });

      await asRole(c, "anon", ANON_CLAIMS);

      const { rows: cats } = await c.query("SELECT id FROM public.categories WHERE id = $1", [catId]);
      expect(cats).toHaveLength(0);

      const { rows: trans } = await c.query(
        "SELECT category_id FROM public.category_translations WHERE category_id = $1", [catId],
      );
      expect(trans).toHaveLength(0);

      const { rows: routes } = await c.query(
        "SELECT slug FROM public.routes WHERE category_id = $1", [catId],
      );
      expect(routes).toHaveLength(0);
    });
  }, 12_000);

  it("AC-CAT-47: anon sees 0 categories when published category has only draft items", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c, { status: "published" });
      await seedItem(c, catId, "draft");
      await asRole(c, "anon", ANON_CLAIMS);
      const { rows } = await c.query("SELECT id FROM public.categories WHERE id = $1", [catId]);
      expect(rows).toHaveLength(0);
    });
  }, 12_000);

  // Non-admin authenticated users (all NON_ADMIN_FIXTURES) also see 0 rows for
  // a published category that has no published items (same RLS as anon).
  for (const fixture of NON_ADMIN_FIXTURES) {
    it(`AC-CAT-47: non-admin (${fixture.label}) sees 0 categories when published category has no published items`, async () => {
      await withTx(client, async (c) => {
        const catId = await seedCategory(c, { status: "published" });
        await seedCategoryTranslation(c, catId, "da");
        await seedRoute(c, "da", `vis-na47-${fixtureSlug(fixture.label)}`, { categoryId: catId });
        await fixture.seed(c);
        await asRole(c, "authenticated", fixture.claims);

        const { rows: cats } = await c.query("SELECT id FROM public.categories WHERE id = $1", [catId]);
        expect(cats).toHaveLength(0);

        const { rows: trans } = await c.query(
          "SELECT category_id FROM public.category_translations WHERE category_id = $1", [catId],
        );
        expect(trans).toHaveLength(0);

        const { rows: routes } = await c.query(
          "SELECT slug FROM public.routes WHERE category_id = $1", [catId],
        );
        expect(routes).toHaveLength(0);
      });
    }, 12_000);
  }

  // Non-admin sees 0 items for a draft item in a published category.
  for (const fixture of NON_ADMIN_FIXTURES) {
    it(`AC-CAT-51: non-admin (${fixture.label}) sees 0 media rows for a draft item`, async () => {
      await withTx(client, async (c) => {
        const catId = await seedCategory(c, { status: "published" });
        const draftItemId = await seedItem(c, catId, "draft");
        const mediaId = await seedMedia(c, draftItemId);
        await fixture.seed(c);
        await asRole(c, "authenticated", fixture.claims);

        const { rows } = await c.query("SELECT id FROM public.media WHERE id = $1", [mediaId]);
        expect(rows).toHaveLength(0);
      });
    }, 12_000);
  }

  // --------------------------------------------------------------------------
  // AC-CAT-48: published category + published item → all become visible
  // --------------------------------------------------------------------------

  it("AC-CAT-48: anon sees category, translations, routes, item, item_translations, media when item published", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catId = await seedCategory(c, { status: "published" });
      await seedCategoryTranslation(c, catId, "da");
      await seedCategoryTranslation(c, catId, "en");
      await seedRoute(c, "da", "vis-cat-48-da", { categoryId: catId });
      await seedRoute(c, "en", "vis-cat-48-en", { categoryId: catId });

      const itemId = await seedItem(c, catId, "draft");
      await seedItemTranslation(c, itemId, "da", "vis-item-48-da");
      await seedItemTranslation(c, itemId, "en", "vis-item-48-en");
      const mediaId = await seedMedia(c, itemId);

      // Publish the item via RPC so published_at is set and items_published_has_date is satisfied
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await c.query("SELECT public.admin_set_item_status($1, 'published'::public.content_status)", [itemId]);

      // Switch to anon
      await asRole(c, "anon", ANON_CLAIMS);

      const { rows: cats } = await c.query("SELECT id FROM public.categories WHERE id = $1", [catId]);
      expect(cats).toHaveLength(1);

      const { rows: catTrans } = await c.query(
        "SELECT category_id FROM public.category_translations WHERE category_id = $1", [catId],
      );
      expect(catTrans.length).toBeGreaterThan(0);

      const { rows: routes } = await c.query(
        "SELECT slug FROM public.routes WHERE category_id = $1", [catId],
      );
      expect(routes.length).toBeGreaterThan(0);

      const { rows: items } = await c.query("SELECT id FROM public.items WHERE id = $1", [itemId]);
      expect(items).toHaveLength(1);

      const { rows: itemTrans } = await c.query(
        "SELECT item_id FROM public.item_translations WHERE item_id = $1", [itemId],
      );
      expect(itemTrans.length).toBeGreaterThan(0);

      const { rows: medias } = await c.query("SELECT id FROM public.media WHERE id = $1", [mediaId]);
      expect(medias).toHaveLength(1);
    });
  }, 12_000);

  for (const fixture of NON_ADMIN_FIXTURES) {
    it(`AC-CAT-48: non-admin (${fixture.label}) sees category + item when item published via RPC`, async () => {
      await withTx(client, async (c) => {
        await seedAdmin(c);
        await fixture.seed(c);
        const slug = `vis-na48-${fixtureSlug(fixture.label)}`;
        const catId = await seedCategory(c, { status: "published" });
        await seedCategoryTranslation(c, catId, "da");
        await seedCategoryTranslation(c, catId, "en");
        await seedRoute(c, "da", `${slug}-da`, { categoryId: catId });
        await seedRoute(c, "en", `${slug}-en`, { categoryId: catId });
        const itemId = await seedItem(c, catId, "draft");
        await seedItemTranslation(c, itemId, "da", `${slug}-item-da`);
        await seedItemTranslation(c, itemId, "en", `${slug}-item-en`);

        // Publish via RPC (stamps published_at, as items_published_has_date requires)
        await asRole(c, "authenticated", ADMIN_CLAIMS);
        await c.query("SELECT public.admin_set_item_status($1, 'published'::public.content_status)", [itemId]);

        await asRole(c, "authenticated", fixture.claims);

        const { rows: cats } = await c.query("SELECT id FROM public.categories WHERE id = $1", [catId]);
        expect(cats).toHaveLength(1);
        const { rows: items } = await c.query("SELECT id FROM public.items WHERE id = $1", [itemId]);
        expect(items).toHaveLength(1);
      });
    }, 12_000);
  }

  // --------------------------------------------------------------------------
  // AC-CAT-49: unpublish the last item → category hides again
  // --------------------------------------------------------------------------

  it("AC-CAT-49: anon loses the category, translations, routes, item and its media when the only published item is unpublished", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catId = await seedCategory(c, { status: "published" });
      await seedCategoryTranslation(c, catId, "da");
      await seedCategoryTranslation(c, catId, "en");
      await seedRoute(c, "da", "vis-cat-49-da", { categoryId: catId });
      await seedRoute(c, "en", "vis-cat-49-en", { categoryId: catId });

      const itemId = await seedItem(c, catId, "draft");
      await seedItemTranslation(c, itemId, "da", "vis-item-49-da");
      await seedItemTranslation(c, itemId, "en", "vis-item-49-en");
      const mediaId = await seedMedia(c, itemId);
      const ids = { categoryId: catId, itemId, mediaId };

      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await c.query("SELECT public.admin_set_item_status($1, 'published'::public.content_status)", [itemId]);
      await asRole(c, "anon", ANON_CLAIMS);
      expect(await visibleCatalogRows(c, ids)).toEqual({
        categories: 1,
        category_translations: 2,
        routes: 2,
        items: 1,
        item_translations: 2,
        media: 1,
      });

      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await c.query("SELECT public.admin_set_item_status($1, 'draft'::public.content_status)", [itemId]);
      await asRole(c, "anon", ANON_CLAIMS);
      expect(await visibleCatalogRows(c, ids)).toEqual(NOTHING_VISIBLE);
    });
  }, 12_000);

  for (const fixture of NON_ADMIN_FIXTURES) {
    it(`AC-CAT-49: non-admin (${fixture.label}) sees no catalog rows after the last published item is unpublished`, async () => {
      await withTx(client, async (c) => {
        await seedAdmin(c);
        await fixture.seed(c);
        const slug = `vis-na49-${fixtureSlug(fixture.label)}`;
        const catId = await seedCategory(c, { status: "published" });
        await seedCategoryTranslation(c, catId, "da");
        await seedCategoryTranslation(c, catId, "en");
        await seedRoute(c, "da", `${slug}-da`, { categoryId: catId });
        await seedRoute(c, "en", `${slug}-en`, { categoryId: catId });
        const itemId = await seedItem(c, catId, "draft");
        await seedItemTranslation(c, itemId, "da", `${slug}-item-da`);
        await seedItemTranslation(c, itemId, "en", `${slug}-item-en`);
        const mediaId = await seedMedia(c, itemId);

        await asRole(c, "authenticated", ADMIN_CLAIMS);
        await c.query("SELECT public.admin_set_item_status($1, 'published'::public.content_status)", [itemId]);
        await c.query("SELECT public.admin_set_item_status($1, 'draft'::public.content_status)", [itemId]);

        await asRole(c, "authenticated", fixture.claims);
        expect(await visibleCatalogRows(c, { categoryId: catId, itemId, mediaId })).toEqual(NOTHING_VISIBLE);
      });
    }, 12_000);
  }

  // --------------------------------------------------------------------------
  // AC-CAT-50: draft category hides published items
  // --------------------------------------------------------------------------

  it("AC-CAT-50: anon sees no category, translation, route, item, item translation or media of a draft category with a published item", async () => {
    await withTx(client, async (c) => {
      // Seed item as published directly (bypass RLS)
      const catId = await seedCategory(c, { status: "draft" });
      await seedCategoryTranslation(c, catId, "da");
      await seedCategoryTranslation(c, catId, "en");
      await seedRoute(c, "da", "vis-cat-50-da", { categoryId: catId });
      await seedRoute(c, "en", "vis-cat-50-en", { categoryId: catId });
      const itemId = await seedItem(c, catId, "published");
      await seedItemTranslation(c, itemId, "da", "vis-item-50-da");
      await seedItemTranslation(c, itemId, "en", "vis-item-50-en");
      const mediaId = await seedMedia(c, itemId);

      await asRole(c, "anon", ANON_CLAIMS);
      expect(await visibleCatalogRows(c, { categoryId: catId, itemId, mediaId })).toEqual(NOTHING_VISIBLE);
    });
  }, 12_000);

  for (const fixture of NON_ADMIN_FIXTURES) {
    it(`AC-CAT-50: non-admin (${fixture.label}) sees nothing for a draft category with a published item`, async () => {
      await withTx(client, async (c) => {
        const slug = `vis-na50-${fixtureSlug(fixture.label)}`;
        const catId = await seedCategory(c, { status: "draft" });
        await seedCategoryTranslation(c, catId, "da");
        await seedRoute(c, "da", `${slug}-da`, { categoryId: catId });
        await seedRoute(c, "en", `${slug}-en`, { categoryId: catId });
        const itemId = await seedItem(c, catId, "published");
        await seedItemTranslation(c, itemId, "da", `${slug}-item-da`);
        const mediaId = await seedMedia(c, itemId);
        await fixture.seed(c);
        await asRole(c, "authenticated", fixture.claims);

        expect(await visibleCatalogRows(c, { categoryId: catId, itemId, mediaId })).toEqual(NOTHING_VISIBLE);
      });
    }, 12_000);
  }

  // --------------------------------------------------------------------------
  // AC-CAT-51: media of a draft item is invisible to anon
  // --------------------------------------------------------------------------

  it("AC-CAT-51: anon sees 0 media rows for a draft item (published category)", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c, { status: "published" });
      const draftItemId = await seedItem(c, catId, "draft");
      const mediaId = await seedMedia(c, draftItemId);

      await asRole(c, "anon", ANON_CLAIMS);

      const { rows } = await c.query("SELECT id FROM public.media WHERE id = $1", [mediaId]);
      expect(rows).toHaveLength(0);
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // AC-CAT-52: admin sees everything including drafts
  // --------------------------------------------------------------------------

  it("AC-CAT-52: admin sees a draft category's translations, routes, draft item, item translations and media", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);

      const draftCatId = await seedCategory(c, { status: "draft" });
      await seedCategoryTranslation(c, draftCatId, "da");
      await seedCategoryTranslation(c, draftCatId, "en");
      await seedRoute(c, "da", "admin-vis-cat-da", { categoryId: draftCatId });
      await seedRoute(c, "en", "admin-vis-cat-en", { categoryId: draftCatId });
      const draftItemId = await seedItem(c, draftCatId, "draft");
      await seedItemTranslation(c, draftItemId, "da", "admin-vis-da");
      const mediaId = await seedMedia(c, draftItemId);

      await asRole(c, "authenticated", ADMIN_CLAIMS);

      expect(await visibleCatalogRows(c, { categoryId: draftCatId, itemId: draftItemId, mediaId })).toEqual({
        categories: 1,
        category_translations: 2,
        routes: 2,
        items: 1,
        item_translations: 1,
        media: 1,
      });
    });
  }, 12_000);
});
