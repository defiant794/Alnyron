/**
 * Integration tests — admin_save_item move behaviour (catalog-section-fix)
 * Journey: catalog-section-fix
 * Acceptance IDs: AC-CATSEC-7, AC-CATSEC-10, AC-CATSEC-11, AC-CATSEC-12,
 *                 AC-CATSEC-13, AC-CATSEC-14
 *
 * Pins the item move of `admin_save_item` (migration
 * `20261105000100_catalog_item_move.sql`): when it receives `{ id, category_id }`
 * on update and `category_id` differs from the stored one, the item is moved to
 * the target section with sort_order = target max + 10.
 *
 * All transactions are ROLLED BACK — no data persists to the cloud DB.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_AVAILABLE, getClient, type PoolClient } from "../rls/helpers/db.js";
import {
  ADMIN_CLAIMS,
  NON_ADMIN_CLAIMS,
  asRole,
  expectPgError,
  seedAdmin,
  seedCategory,
  seedItem,
  seedItemTranslation,
  withTx,
} from "../rls/helpers/roles.js";

const BOGUS_UUID = "00000000-0000-0000-0000-999999999999";

/** A complete item translation (every column admin_save_item writes) under `slug`. */
function itemTranslation(slug: string, title = "Item") {
  return { slug, title, summary: "", body_md: "", seo_title: "", seo_description: "" };
}

/** Calls admin_save_item (as the current role) and returns the item id. */
async function saveItemRpc(c: PoolClient, payload: Record<string, unknown>): Promise<string> {
  const { rows } = await c.query<{ id: string }>("SELECT public.admin_save_item($1::jsonb) AS id", [
    JSON.stringify(payload),
  ]);
  return rows[0]!.id;
}

/** Reads category_id and sort_order for an item. */
async function storedLocation(c: PoolClient, itemId: string) {
  const { rows } = await c.query<{ category_id: string; sort_order: number }>(
    `SELECT category_id, sort_order FROM public.items WHERE id = $1`,
    [itemId],
  );
  return rows[0]!;
}

/** Max sort_order in a category, 0 when empty. */
async function maxSortOrder(c: PoolClient, categoryId: string): Promise<number> {
  const { rows } = await c.query<{ max: number | null }>(
    "SELECT MAX(sort_order) AS max FROM public.items WHERE category_id = $1",
    [categoryId],
  );
  return rows[0]?.max ?? 0;
}

describe.skipIf(!DB_AVAILABLE)("catalog-section-fix — admin_save_item move behaviour", () => {
  let client: PoolClient;

  beforeAll(async () => {
    client = await getClient();
  });

  afterAll(() => {
    client.release();
  });

  // --------------------------------------------------------------------------
  // AC-CATSEC-7: update with different category_id moves item, sort_order = max+10
  // Requires migration 20261105000100_catalog_item_move.sql.
  // --------------------------------------------------------------------------

  it("AC-CATSEC-7: admin_save_item update with different category_id moves item and sets sort_order = target max + 10", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catA = await seedCategory(c);
      const catB = await seedCategory(c);

      // Seed an existing item in catB as postgres BEFORE asRole so max(sort_order) is known.
      const existingInB = await seedItem(c, catB);
      await c.query("UPDATE public.items SET sort_order = 50 WHERE id = $1", [existingInB]);

      await asRole(c, "authenticated", ADMIN_CLAIMS);

      // Insert an item in catA as admin
      const itemId = await saveItemRpc(c, {
        category_id: catA,
        price_type: null,
        price_amount: null,
        external_links: {},
        translations: { da: itemTranslation("move-item-da") },
      });

      const maxBefore = await maxSortOrder(c, catB);
      expect(maxBefore).toBe(50);

      // Move itemId from catA to catB
      await saveItemRpc(c, {
        id: itemId,
        category_id: catB,
        translations: { da: itemTranslation("move-item-da") },
      });

      const loc = await storedLocation(c, itemId);
      expect(loc.category_id, "item must be in catB after move").toBe(catB);
      expect(loc.sort_order, "sort_order must be max(catB) + 10").toBe(50 + 10);
    });
  }, 15_000);

  // --------------------------------------------------------------------------
  // AC-CATSEC-10: same category_id keeps sort_order unchanged
  // Pins that a save naming the item's own section is no move: nothing is
  // reordered.
  // --------------------------------------------------------------------------

  it("AC-CATSEC-10: admin_save_item update with same category_id keeps sort_order and category unchanged", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catA = await seedCategory(c);

      await asRole(c, "authenticated", ADMIN_CLAIMS);

      const itemId = await saveItemRpc(c, {
        category_id: catA,
        price_type: null,
        price_amount: null,
        external_links: {},
        translations: { da: itemTranslation("same-cat-keep") },
      });

      const locBefore = await storedLocation(c, itemId);

      // Update with same category_id — no move
      await saveItemRpc(c, {
        id: itemId,
        category_id: catA,
        translations: { da: itemTranslation("same-cat-keep", "Renamed") },
      });

      const locAfter = await storedLocation(c, itemId);
      expect(locAfter.category_id).toBe(catA);
      expect(locAfter.sort_order).toBe(locBefore.sort_order);
    });
  }, 15_000);

  // --------------------------------------------------------------------------
  // AC-CATSEC-10b: absent category_id also keeps sort_order unchanged
  // This covers the backward-compat case — no category_id key in payload.
  // --------------------------------------------------------------------------

  it("AC-CATSEC-10b: admin_save_item update without category_id keeps sort_order and category unchanged", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catA = await seedCategory(c);

      await asRole(c, "authenticated", ADMIN_CLAIMS);

      const itemId = await saveItemRpc(c, {
        category_id: catA,
        price_type: null,
        price_amount: null,
        external_links: {},
        translations: { da: itemTranslation("absent-cat-keep") },
      });

      const locBefore = await storedLocation(c, itemId);

      // Update without category_id key
      await saveItemRpc(c, {
        id: itemId,
        translations: { da: itemTranslation("absent-cat-keep", "Renamed") },
      });

      const locAfter = await storedLocation(c, itemId);
      expect(locAfter.category_id).toBe(catA);
      expect(locAfter.sort_order).toBe(locBefore.sort_order);
    });
  }, 15_000);

  // --------------------------------------------------------------------------
  // AC-CATSEC-11: unknown category_id raises 23503 (foreign key violation)
  // A move to a section that does not exist fails on the items FK.
  // --------------------------------------------------------------------------

  it("AC-CATSEC-11: admin_save_item update with unknown category_id raises 23503", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catA = await seedCategory(c);

      await asRole(c, "authenticated", ADMIN_CLAIMS);

      const itemId = await saveItemRpc(c, {
        category_id: catA,
        price_type: null,
        price_amount: null,
        external_links: {},
        translations: { da: itemTranslation("unknown-cat-item") },
      });

      // Move to an unknown category UUID — must raise foreign key violation
      await expectPgError(
        c,
        () =>
          c.query("SELECT public.admin_save_item($1::jsonb)", [
            JSON.stringify({
              id: itemId,
              category_id: BOGUS_UUID,
              translations: { da: itemTranslation("unknown-cat-item") },
            }),
          ]),
        "23503",
      );
    });
  }, 15_000);

  // --------------------------------------------------------------------------
  // AC-CATSEC-12: non-admin raises 42501
  // The RPC's admin check refuses a move like any other non-admin save.
  // --------------------------------------------------------------------------

  it("AC-CATSEC-12: admin_save_item update with category_id by a non-admin raises 42501", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catA = await seedCategory(c);
      const catB = await seedCategory(c);

      await asRole(c, "authenticated", ADMIN_CLAIMS);
      const itemId = await saveItemRpc(c, {
        category_id: catA,
        price_type: null,
        price_amount: null,
        external_links: {},
        translations: { da: itemTranslation("nonadmin-move") },
      });

      // Switch to non-admin
      await asRole(c, "authenticated", NON_ADMIN_CLAIMS);
      await expectPgError(
        c,
        () =>
          c.query("SELECT public.admin_save_item($1::jsonb)", [
            JSON.stringify({
              id: itemId,
              category_id: catB,
              translations: { da: itemTranslation("nonadmin-move") },
            }),
          ]),
        "42501",
      );
    });
  }, 15_000);

  // --------------------------------------------------------------------------
  // AC-CATSEC-13: draft item moved — status remains draft
  // A move changes only the section and the sort order.
  // --------------------------------------------------------------------------

  it("AC-CATSEC-13: draft item moved to another section — status remains draft", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catA = await seedCategory(c);
      const catB = await seedCategory(c);

      await asRole(c, "authenticated", ADMIN_CLAIMS);

      const itemId = await saveItemRpc(c, {
        category_id: catA,
        price_type: null,
        price_amount: null,
        external_links: {},
        translations: { da: itemTranslation("draft-move") },
      });

      // Verify initial status is draft
      const { rows: before } = await c.query<{ status: string }>(
        "SELECT status FROM public.items WHERE id = $1",
        [itemId],
      );
      expect(before[0]?.status).toBe("draft");

      // Move to catB
      await saveItemRpc(c, {
        id: itemId,
        category_id: catB,
        translations: { da: itemTranslation("draft-move") },
      });

      const { rows: after } = await c.query<{ status: string; category_id: string }>(
        "SELECT status, category_id FROM public.items WHERE id = $1",
        [itemId],
      );
      expect(after[0]?.status).toBe("draft");
      expect(after[0]?.category_id).toBe(catB);
    });
  }, 15_000);

  // --------------------------------------------------------------------------
  // AC-CATSEC-14: published item moved — status and published_at unchanged
  // A move changes only the section and the sort order.
  // --------------------------------------------------------------------------

  it("AC-CATSEC-14: published item moved to another section — status and published_at unchanged", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catA = await seedCategory(c);
      const catB = await seedCategory(c);

      // Seed a published item directly as postgres BEFORE asRole (bypasses RLS for published_at).
      const itemId = await seedItem(c, catA, "published");
      await seedItemTranslation(c, itemId, "da", "published-move-da");
      await seedItemTranslation(c, itemId, "en", "published-move-en");

      const { rows: before } = await c.query<{
        status: string;
        published_at: Date | null;
        category_id: string;
      }>(
        "SELECT status, published_at, category_id FROM public.items WHERE id = $1",
        [itemId],
      );
      expect(before[0]?.status).toBe("published");
      expect(before[0]?.published_at).not.toBeNull();
      const publishedAtBefore = before[0]!.published_at!;

      // Move to catB as admin
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await saveItemRpc(c, {
        id: itemId,
        category_id: catB,
        translations: { da: itemTranslation("published-move-da") },
      });

      const { rows: after } = await c.query<{
        status: string;
        published_at: Date | null;
        category_id: string;
      }>(
        "SELECT status, published_at, category_id FROM public.items WHERE id = $1",
        [itemId],
      );
      expect(after[0]?.status).toBe("published");
      expect(after[0]?.category_id).toBe(catB);
      expect(after[0]?.published_at?.getTime()).toBe(publishedAtBefore.getTime());
    });
  }, 15_000);
});
