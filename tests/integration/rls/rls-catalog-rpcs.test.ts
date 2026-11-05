/**
 * RLS integration tests — catalog admin RPCs (F2.1 catalog-model)
 *
 * Covers:
 *   AC-CAT-01  — anon + NON_ADMIN_FIXTURES → 42501 on all 8 RPCs
 *   AC-CAT-01b — has_function_privilege: anon has no EXECUTE on catalog RPCs
 *   AC-CAT-02  — admin_save_category insert: draft, nav_order=100, returns UUID
 *   AC-CAT-03  — admin_save_category: category_translations upserted
 *   AC-CAT-04  — admin_save_category: routes row upserted when slug key present
 *   AC-CAT-05  — admin_save_category: P0002 category_not_found for unknown id
 *   AC-CAT-06  — admin_save_category: 23505 on slug clash
 *   AC-CAT-07  — admin_save_category: 23514 category_translations_da_title for blank DA title
 *   AC-CAT-08  — admin_save_category: 22023 kind_required on insert without kind
 *   AC-CAT-09  — admin_set_category_status: P0001 missing_slugs with <2 routes; publish/unpublish with DA+EN routes
 *   AC-CAT-10  — admin_set_category_status: P0002 category_not_found
 *   AC-CAT-11  — admin_save_item insert: draft, sort_order = max+10
 *   AC-CAT-12  — admin_save_item update: price/currency/links replaced when present (JSON null → null/'DKK'/'{}'),
 *                kept when absent; featured coalesced; category_id MOVES the item (sort_order = target max+10) when it
 *                differs (migration 20261105000100_catalog_item_move.sql). admin_save_category update: kind fixed,
 *                featured/nav_order coalesced
 *   AC-CAT-13  — admin_save_item: item_translations upserted
 *   AC-CAT-14  — admin_save_item media: alt/sort_order updated for item's own media
 *   AC-CAT-15  — admin_save_item media: P0002 media_not_found for media from another item
 *   AC-CAT-16  — admin_save_item insert: 23503 for non-existent category_id; 22023 category_required without one
 *   AC-CAT-17  — admin_save_item: 23505 on duplicate item translation slug
 *   AC-CAT-18  — admin_set_item_status: P0001 missing_translations
 *   AC-CAT-19  — admin_set_item_status: published_at stamped once, kept on re-publish
 *   AC-CAT-20  — admin_set_item_status: P0002 item_not_found
 *   AC-CAT-21  — admin_reorder_items: sort_order = ord*10; ids of another category in the array untouched
 *   AC-CAT-22  — admin_reorder_items: P0002 category_not_found
 *   AC-CAT-23  — admin_delete_item: returns paths; empty when no media; cascades
 *   AC-CAT-24  — admin_delete_item: P0002 item_not_found
 *   AC-CAT-25  — admin_attach_media: 22023 invalid_media_path (bad format)
 *   AC-CAT-26  — admin_attach_media: 22023 invalid_media_path (wrong item segment)
 *   AC-CAT-27  — admin_attach_media: P0002 media_not_stored (missing storage object)
 *   AC-CAT-28  — admin_attach_media: P0001 too_many_media on 9th media
 *   AC-CAT-29  — admin_attach_media: returns UUID, sort_order=max+10, mime from extension; 22023
 *                media_type_mismatch when the object's recorded mimetype differs from the extension
 *   AC-CAT-30  — admin_attach_media: P0002 item_not_found
 *   AC-CAT-31  — admin_detach_media: deletes row, returns storage_path
 *   AC-CAT-32  — admin_detach_media: P0002 media_not_found
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
  seedCategory,
  seedCategoryTranslation,
  seedItem,
  seedItemTranslation,
  seedMedia,
  seedRoute,
  seedStorageObject,
  withTx,
} from "./helpers/roles.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BOGUS_UUID = "00000000-0000-0000-0000-999999999999";

const ATTACH_MEDIA = "SELECT public.admin_attach_media($1, $2, $3, $4, $5, $6)";

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

/** The items columns admin_save_item writes from a payload (numeric price_amount comes back as text). */
async function storedItem(c: PoolClient, itemId: string) {
  const { rows } = await c.query<{
    category_id: string;
    featured: boolean;
    price_type: string | null;
    price_amount: string | null;
    price_currency: string;
    external_links: Record<string, string>;
  }>(
    `SELECT category_id, featured, price_type, price_amount, price_currency, external_links
       FROM public.items WHERE id = $1`,
    [itemId],
  );
  return rows;
}

describe.skipIf(!DB_AVAILABLE)("RLS — catalog admin RPCs", () => {
  let client: PoolClient;

  beforeAll(async () => {
    client = await getClient();
  });

  afterAll(async () => {
    client.release();
  });

  // --------------------------------------------------------------------------
  // AC-CAT-01: Non-admin callers are rejected (42501) from all 8 RPCs
  // --------------------------------------------------------------------------

  for (const fixture of NON_ADMIN_FIXTURES) {
    describe(`non-admin (${fixture.label})`, () => {
      it("AC-CAT-01: admin_save_category raises 42501", async () => {
        await withTx(client, async (c) => {
          await fixture.seed(c);
          await asRole(c, "authenticated", fixture.claims);
          await expectPgError(
            c,
            () => c.query("SELECT public.admin_save_category($1::jsonb)", [JSON.stringify({ kind: "apps", translations: { da: { title: "X" } } })]),
            "42501",
            `admin_save_category ${fixture.label}`,
          );
        });
      }, 12_000);

      it("AC-CAT-01: admin_set_category_status raises 42501", async () => {
        await withTx(client, async (c) => {
          const catId = await seedCategory(c);
          await fixture.seed(c);
          await asRole(c, "authenticated", fixture.claims);
          await expectPgError(
            c,
            () => c.query("SELECT public.admin_set_category_status($1, 'draft'::public.content_status)", [catId]),
            "42501",
            `admin_set_category_status ${fixture.label}`,
          );
        });
      }, 12_000);

      it("AC-CAT-01: admin_save_item raises 42501", async () => {
        await withTx(client, async (c) => {
          const catId = await seedCategory(c);
          await fixture.seed(c);
          await asRole(c, "authenticated", fixture.claims);
          await expectPgError(
            c,
            () => c.query("SELECT public.admin_save_item($1::jsonb)", [JSON.stringify({ category_id: catId, translations: { da: { slug: "s", title: "T" } } })]),
            "42501",
            `admin_save_item ${fixture.label}`,
          );
        });
      }, 12_000);

      it("AC-CAT-01: admin_set_item_status raises 42501", async () => {
        await withTx(client, async (c) => {
          const catId = await seedCategory(c);
          const itemId = await seedItem(c, catId);
          await fixture.seed(c);
          await asRole(c, "authenticated", fixture.claims);
          await expectPgError(
            c,
            () => c.query("SELECT public.admin_set_item_status($1, 'draft'::public.content_status)", [itemId]),
            "42501",
            `admin_set_item_status ${fixture.label}`,
          );
        });
      }, 12_000);

      it("AC-CAT-01: admin_reorder_items raises 42501", async () => {
        await withTx(client, async (c) => {
          const catId = await seedCategory(c);
          await fixture.seed(c);
          await asRole(c, "authenticated", fixture.claims);
          await expectPgError(
            c,
            () => c.query("SELECT public.admin_reorder_items($1, $2::uuid[])", [catId, `{}`]),
            "42501",
            `admin_reorder_items ${fixture.label}`,
          );
        });
      }, 12_000);

      it("AC-CAT-01: admin_delete_item raises 42501", async () => {
        await withTx(client, async (c) => {
          const catId = await seedCategory(c);
          const itemId = await seedItem(c, catId);
          await fixture.seed(c);
          await asRole(c, "authenticated", fixture.claims);
          await expectPgError(
            c,
            () => c.query("SELECT public.admin_delete_item($1)", [itemId]),
            "42501",
            `admin_delete_item ${fixture.label}`,
          );
        });
      }, 12_000);

      it("AC-CAT-01: admin_attach_media raises 42501", async () => {
        await withTx(client, async (c) => {
          await fixture.seed(c);
          await asRole(c, "authenticated", fixture.claims);
          await expectPgError(
            c,
            () => c.query(
              "SELECT public.admin_attach_media($1, $2, $3, $4, $5, $6)",
              [BOGUS_UUID, `items/${BOGUS_UUID}/${BOGUS_UUID}.webp`, "Alt", "", 100, 100],
            ),
            "42501",
            `admin_attach_media ${fixture.label}`,
          );
        });
      }, 12_000);

      it("AC-CAT-01: admin_detach_media raises 42501", async () => {
        await withTx(client, async (c) => {
          await fixture.seed(c);
          await asRole(c, "authenticated", fixture.claims);
          await expectPgError(
            c,
            () => c.query("SELECT public.admin_detach_media($1)", [BOGUS_UUID]),
            "42501",
            `admin_detach_media ${fixture.label}`,
          );
        });
      }, 12_000);
    });
  }

  // Anon is rejected (42501) by every one of the 8 catalog admin RPCs.
  it("AC-CAT-01: anon call to admin_save_category raises 42501", async () => {
    await withTx(client, async (c) => {
      await asRole(c, "anon", ANON_CLAIMS);
      await expectPgError(c, () => c.query("SELECT public.admin_save_category($1::jsonb)", [JSON.stringify({ kind: "apps", translations: { da: { title: "X" } } })]), "42501", "admin_save_category anon");
    });
  }, 12_000);

  it("AC-CAT-01: anon call to admin_set_category_status raises 42501", async () => {
    await withTx(client, async (c) => {
      await asRole(c, "anon", ANON_CLAIMS);
      await expectPgError(c, () => c.query("SELECT public.admin_set_category_status($1, 'draft'::public.content_status)", [BOGUS_UUID]), "42501", "admin_set_category_status anon");
    });
  }, 12_000);

  it("AC-CAT-01: anon call to admin_save_item raises 42501", async () => {
    await withTx(client, async (c) => {
      await asRole(c, "anon", ANON_CLAIMS);
      await expectPgError(c, () => c.query("SELECT public.admin_save_item($1::jsonb)", [JSON.stringify({ category_id: BOGUS_UUID, translations: { da: { slug: "x", title: "X" } } })]), "42501", "admin_save_item anon");
    });
  }, 12_000);

  it("AC-CAT-01: anon call to admin_set_item_status raises 42501", async () => {
    await withTx(client, async (c) => {
      await asRole(c, "anon", ANON_CLAIMS);
      await expectPgError(c, () => c.query("SELECT public.admin_set_item_status($1, 'draft'::public.content_status)", [BOGUS_UUID]), "42501", "admin_set_item_status anon");
    });
  }, 12_000);

  it("AC-CAT-01: anon call to admin_reorder_items raises 42501", async () => {
    await withTx(client, async (c) => {
      await asRole(c, "anon", ANON_CLAIMS);
      await expectPgError(c, () => c.query("SELECT public.admin_reorder_items($1, $2::uuid[])", [BOGUS_UUID, "{}"]), "42501", "admin_reorder_items anon");
    });
  }, 12_000);

  it("AC-CAT-01: anon call to admin_delete_item raises 42501", async () => {
    await withTx(client, async (c) => {
      await asRole(c, "anon", ANON_CLAIMS);
      await expectPgError(c, () => c.query("SELECT public.admin_delete_item($1)", [BOGUS_UUID]), "42501", "admin_delete_item anon");
    });
  }, 12_000);

  it("AC-CAT-01: anon call to admin_attach_media raises 42501", async () => {
    await withTx(client, async (c) => {
      await asRole(c, "anon", ANON_CLAIMS);
      await expectPgError(c, () => c.query("SELECT public.admin_attach_media($1,$2,$3,$4,$5,$6)", [BOGUS_UUID, `items/${BOGUS_UUID}/${BOGUS_UUID}.webp`, "Alt", "", 100, 100]), "42501", "admin_attach_media anon");
    });
  }, 12_000);

  it("AC-CAT-01: anon call to admin_detach_media raises 42501", async () => {
    await withTx(client, async (c) => {
      await asRole(c, "anon", ANON_CLAIMS);
      await expectPgError(c, () => c.query("SELECT public.admin_detach_media($1)", [BOGUS_UUID]), "42501", "admin_detach_media anon");
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // AC-CAT-01b: has_function_privilege — anon has no EXECUTE on catalog RPCs
  // --------------------------------------------------------------------------

  it("AC-CAT-01b: anon has no EXECUTE privilege on any of the 8 catalog RPCs", async () => {
    const { rows } = await client.query<{ fn: string; anon_exec: boolean }>(`
      SELECT p.proname AS fn,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN (
          'admin_save_category','admin_set_category_status',
          'admin_save_item','admin_set_item_status',
          'admin_reorder_items','admin_delete_item',
          'admin_attach_media','admin_detach_media'
        )
    `);
    expect(rows).toHaveLength(8);
    for (const row of rows) {
      expect(row.anon_exec).toBe(false);
    }
  }, 12_000);

  // --------------------------------------------------------------------------
  // AC-CAT-02, AC-CAT-03, AC-CAT-04: admin_save_category — insert
  // --------------------------------------------------------------------------

  it("AC-CAT-02: admin_save_category insert creates draft category with nav_order=100", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      const payload = {
        kind: "apps",
        translations: {
          da: { title: "Test Kategori DA", description: "Beskrivelse", seo_title: "", seo_description: "" },
          en: { title: "Test Category EN", description: "", seo_title: "", seo_description: "" },
        },
      };
      const { rows } = await c.query<{ admin_save_category: string }>(
        "SELECT public.admin_save_category($1::jsonb)",
        [JSON.stringify(payload)],
      );
      const catId = rows[0]?.admin_save_category;
      expect(catId).toMatch(UUID_RE);

      const { rows: cats } = await c.query<{ status: string; nav_order: number; kind: string }>(
        "SELECT status, nav_order, kind FROM public.categories WHERE id = $1",
        [catId],
      );
      expect(cats[0]).toMatchObject({ status: "draft", nav_order: 100, kind: "apps" });
    });
  }, 12_000);

  it("AC-CAT-03: admin_save_category upserts category_translations for each locale", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      const payload = {
        kind: "websites",
        translations: {
          da: { title: "Hjemmesider DA", description: "", seo_title: "", seo_description: "" },
          en: { title: "Websites EN", description: "", seo_title: "", seo_description: "" },
        },
      };
      const { rows } = await c.query<{ admin_save_category: string }>(
        "SELECT public.admin_save_category($1::jsonb)",
        [JSON.stringify(payload)],
      );
      const catId = rows[0]?.admin_save_category;

      const { rows: translations } = await c.query<{ locale: string; title: string }>(
        "SELECT locale, title FROM public.category_translations WHERE category_id = $1 ORDER BY locale",
        [catId],
      );
      expect(translations).toEqual([
        { locale: "da", title: "Hjemmesider DA" },
        { locale: "en", title: "Websites EN" },
      ]);
    });
  }, 12_000);

  it("AC-CAT-04: admin_save_category upserts routes when slug key present in translation", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      const payload = {
        kind: "services",
        translations: {
          da: { title: "Ydelser", description: "", seo_title: "", seo_description: "", slug: "ydelser-rpc-test" },
          en: { title: "Services", description: "", seo_title: "", seo_description: "", slug: "services-rpc-test" },
        },
      };
      const { rows } = await c.query<{ admin_save_category: string }>(
        "SELECT public.admin_save_category($1::jsonb)",
        [JSON.stringify(payload)],
      );
      const catId = rows[0]?.admin_save_category;

      const { rows: routes } = await c.query<{ locale: string; slug: string }>(
        "SELECT locale, slug FROM public.routes WHERE category_id = $1 ORDER BY locale",
        [catId],
      );
      expect(routes).toEqual([
        { locale: "da", slug: "ydelser-rpc-test" },
        { locale: "en", slug: "services-rpc-test" },
      ]);
    });
  }, 12_000);

  it("AC-CAT-05: admin_save_category raises P0002 category_not_found for unknown id", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await expectPgError(
        c,
        () => c.query("SELECT public.admin_save_category($1::jsonb)", [
          JSON.stringify({ id: BOGUS_UUID, translations: { da: { title: "X", description: "", seo_title: "", seo_description: "" } } }),
        ]),
        "P0002",
        "admin_save_category unknown id",
        { messageIncludes: "category_not_found" },
      );
    });
  }, 12_000);

  it("AC-CAT-06: admin_save_category raises 23505 on duplicate slug", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      // First insert claims the slug
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await c.query("SELECT public.admin_save_category($1::jsonb)", [
        JSON.stringify({ kind: "apps", translations: { da: { title: "Cat A", description: "", seo_title: "", seo_description: "", slug: "slug-clash-rpc" } } }),
      ]);

      // Second insert tries the same slug
      await expectPgError(
        c,
        () => c.query("SELECT public.admin_save_category($1::jsonb)", [
          JSON.stringify({ kind: "apps", translations: { da: { title: "Cat B", description: "", seo_title: "", seo_description: "", slug: "slug-clash-rpc" } } }),
        ]),
        "23505",
        "admin_save_category duplicate slug",
      );
    });
  }, 12_000);

  it("AC-CAT-07: admin_save_category raises 23514 for blank DA title", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await expectPgError(
        c,
        () => c.query("SELECT public.admin_save_category($1::jsonb)", [
          JSON.stringify({ kind: "apps", translations: { da: { title: "", description: "", seo_title: "", seo_description: "" } } }),
        ]),
        "23514",
        "admin_save_category blank DA title",
        { messageIncludes: "category_translations_da_title" },
      );
    });
  }, 12_000);

  it("AC-CAT-08: admin_save_category raises 22023 kind_required when inserting without kind", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await expectPgError(
        c,
        () => c.query("SELECT public.admin_save_category($1::jsonb)", [
          JSON.stringify({ translations: { da: { title: "No Kind", description: "", seo_title: "", seo_description: "" } } }),
        ]),
        "22023",
        "admin_save_category no kind",
        { messageIncludes: "kind_required" },
      );
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // AC-CAT-09, AC-CAT-10: admin_set_category_status
  // --------------------------------------------------------------------------

  it("AC-CAT-09: admin_set_category_status raises P0001 missing_slugs with <2 routes", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catId = await seedCategory(c);
      await seedCategoryTranslation(c, catId, "da");
      await seedRoute(c, "da", "one-locale-only-rpc", { categoryId: catId });

      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await expectPgError(
        c,
        () => c.query("SELECT public.admin_set_category_status($1, 'published'::public.content_status)", [catId]),
        "P0001",
        "admin_set_category_status missing_slugs",
        { messageIncludes: "missing_slugs" },
      );
    });
  }, 12_000);

  it("AC-CAT-10: admin_set_category_status raises P0002 for unknown category", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await expectPgError(
        c,
        () => c.query("SELECT public.admin_set_category_status($1, 'published'::public.content_status)", [BOGUS_UUID]),
        "P0002",
        "admin_set_category_status unknown",
        { messageIncludes: "category_not_found" },
      );
    });
  }, 12_000);

  it("AC-CAT-09: admin_set_category_status publishes a category with a DA and an EN route, then unpublishes it", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catId = await seedCategory(c, { status: "draft" });
      await seedCategoryTranslation(c, catId, "da");
      await seedRoute(c, "da", "publish-ok-rpc-da", { categoryId: catId });
      await seedRoute(c, "en", "publish-ok-rpc-en", { categoryId: catId });

      await asRole(c, "authenticated", ADMIN_CLAIMS);
      const stored = async () =>
        (await c.query<{ status: string; updated_by: string | null }>(
          "SELECT status, updated_by FROM public.categories WHERE id = $1",
          [catId],
        )).rows;

      await c.query("SELECT public.admin_set_category_status($1, 'published'::public.content_status)", [catId]);
      expect(await stored()).toEqual([{ status: "published", updated_by: ADMIN_UUID }]);

      await c.query("SELECT public.admin_set_category_status($1, 'draft'::public.content_status)", [catId]);
      expect(await stored()).toEqual([{ status: "draft", updated_by: ADMIN_UUID }]);
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // AC-CAT-11: admin_save_item — insert
  // --------------------------------------------------------------------------

  it("AC-CAT-11: admin_save_item insert creates draft item with sort_order=max+10", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catId = await seedCategory(c);

      await asRole(c, "authenticated", ADMIN_CLAIMS);
      const payload = {
        category_id: catId,
        price_type: null,
        price_amount: null,
        external_links: {},
        translations: {
          da: { slug: "item-insert-rpc", title: "Test Item DA", summary: "", body_md: "", seo_title: "", seo_description: "" },
        },
      };
      const { rows } = await c.query<{ admin_save_item: string }>(
        "SELECT public.admin_save_item($1::jsonb)",
        [JSON.stringify(payload)],
      );
      const itemId = rows[0]?.admin_save_item;
      expect(itemId).toMatch(UUID_RE);

      const { rows: items } = await c.query<{ status: string; sort_order: number }>(
        "SELECT status, sort_order FROM public.items WHERE id = $1",
        [itemId],
      );
      expect(items[0]).toMatchObject({ status: "draft" });
      expect(items[0]!.sort_order).toBe(10); // 0+10 (no prior items in category)
    });
  }, 12_000);

  it("AC-CAT-11: admin_save_item sort_order increments by 10 from max", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catId = await seedCategory(c);

      await asRole(c, "authenticated", ADMIN_CLAIMS);

      // Insert first item
      const p1 = { category_id: catId, price_type: null, price_amount: null, external_links: {}, translations: { da: { slug: "item-order-1", title: "Item 1", summary: "", body_md: "", seo_title: "", seo_description: "" } } };
      await c.query("SELECT public.admin_save_item($1::jsonb)", [JSON.stringify(p1)]);

      // Insert second item — sort_order should be 20
      const p2 = { category_id: catId, price_type: null, price_amount: null, external_links: {}, translations: { da: { slug: "item-order-2", title: "Item 2", summary: "", body_md: "", seo_title: "", seo_description: "" } } };
      const { rows } = await c.query<{ admin_save_item: string }>("SELECT public.admin_save_item($1::jsonb)", [JSON.stringify(p2)]);
      const item2Id = rows[0]?.admin_save_item;

      const { rows: items } = await c.query<{ sort_order: number }>(
        "SELECT sort_order FROM public.items WHERE id = $1",
        [item2Id],
      );
      expect(items[0]!.sort_order).toBe(20);
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // AC-CAT-12: admin_save_item update — price_type replaced/kept
  // --------------------------------------------------------------------------

  it("AC-CAT-12: admin_save_item update replaces price_type when key is present in payload", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catId = await seedCategory(c);

      await asRole(c, "authenticated", ADMIN_CLAIMS);
      const insertPayload = {
        category_id: catId, price_type: "contact", price_amount: null, external_links: {},
        translations: { da: { slug: "item-update-price", title: "Item Update", summary: "", body_md: "", seo_title: "", seo_description: "" } },
      };
      const { rows: ins } = await c.query<{ admin_save_item: string }>(
        "SELECT public.admin_save_item($1::jsonb)", [JSON.stringify(insertPayload)],
      );
      const itemId = ins[0]?.admin_save_item;

      // Update: price_type key present → should replace
      const updatePayload = { id: itemId, price_type: "fixed", price_amount: 500, translations: { da: { slug: "item-update-price", title: "Item Update", summary: "", body_md: "", seo_title: "", seo_description: "" } } };
      await c.query("SELECT public.admin_save_item($1::jsonb)", [JSON.stringify(updatePayload)]);

      const { rows: updated } = await c.query<{ price_type: string; price_amount: string }>(
        "SELECT price_type, price_amount FROM public.items WHERE id = $1",
        [itemId],
      );
      expect(updated[0]?.price_type).toBe("fixed");
      expect(Number(updated[0]?.price_amount)).toBe(500);
    });
  }, 12_000);

  it("AC-CAT-12: admin_save_item update keeps price, currency, links and featured when their keys are absent", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catId = await seedCategory(c);

      await asRole(c, "authenticated", ADMIN_CLAIMS);
      const itemId = await saveItemRpc(c, {
        category_id: catId,
        featured: true,
        price_type: "from",
        price_amount: 1250.5,
        price_currency: "EUR",
        external_links: { website: "https://example.com" },
        translations: { da: itemTranslation("item-keep-absent") },
      });

      // Only the translation is sent: every item column must stay as it was.
      await saveItemRpc(c, { id: itemId, translations: { da: itemTranslation("item-keep-absent", "Renamed") } });

      expect(await storedItem(c, itemId)).toEqual([
        {
          category_id: catId,
          featured: true,
          price_type: "from",
          price_amount: "1250.50",
          price_currency: "EUR",
          external_links: { website: "https://example.com" },
        },
      ]);
      const { rows: translations } = await c.query<{ title: string }>(
        "SELECT title FROM public.item_translations WHERE item_id = $1 AND locale = 'da'",
        [itemId],
      );
      expect(translations).toEqual([{ title: "Renamed" }]);
    });
  }, 12_000);

  it("AC-CAT-12: admin_save_item update with JSON null price/currency/links stores no price, 'DKK' and '{}'", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catId = await seedCategory(c);

      await asRole(c, "authenticated", ADMIN_CLAIMS);
      const itemId = await saveItemRpc(c, {
        category_id: catId,
        price_type: "fixed",
        price_amount: 500,
        price_currency: "EUR",
        external_links: { demo: "https://demo.example.com" },
        translations: { da: itemTranslation("item-null-keys") },
      });

      await saveItemRpc(c, {
        id: itemId,
        price_type: null,
        price_amount: null,
        price_currency: null,
        external_links: null,
        translations: { da: itemTranslation("item-null-keys") },
      });

      expect(await storedItem(c, itemId)).toEqual([
        {
          category_id: catId,
          featured: false,
          price_type: null,
          price_amount: null,
          price_currency: "DKK",
          external_links: {},
        },
      ]);
    });
  }, 12_000);

  it("AC-CAT-12: admin_save_item update replaces present keys, sets featured, and MOVES item when category_id differs", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catA = await seedCategory(c);
      const catB = await seedCategory(c);

      await asRole(c, "authenticated", ADMIN_CLAIMS);
      const itemId = await saveItemRpc(c, {
        category_id: catA,
        price_type: "contact",
        price_amount: null,
        external_links: {},
        translations: { da: itemTranslation("item-replace-keys") },
      });

      await saveItemRpc(c, {
        id: itemId,
        category_id: catB,
        featured: true,
        price_type: "fixed",
        price_amount: 999.99,
        price_currency: "SEK",
        external_links: { download: "https://example.com/app.zip" },
        translations: { da: itemTranslation("item-replace-keys") },
      });

      // A differing category_id moves the item to catB (migration 20261105000100_catalog_item_move.sql).
      expect(await storedItem(c, itemId)).toEqual([
        {
          category_id: catB,
          featured: true,
          price_type: "fixed",
          price_amount: "999.99",
          price_currency: "SEK",
          external_links: { download: "https://example.com/app.zip" },
        },
      ]);
    });
  }, 12_000);

  it("AC-CAT-12: admin_save_category update keeps kind, replaces featured/nav_order when present, keeps them when absent", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      const daTranslation = (title: string) => ({ title, description: "", seo_title: "", seo_description: "" });
      const { rows: inserted } = await c.query<{ id: string }>("SELECT public.admin_save_category($1::jsonb) AS id", [
        JSON.stringify({ kind: "apps", featured: false, nav_order: 30, translations: { da: daTranslation("Apps test") } }),
      ]);
      const catId = inserted[0]!.id;
      const stored = async () =>
        (await c.query<{ kind: string; status: string; featured: boolean; nav_order: number }>(
          "SELECT kind, status, featured, nav_order FROM public.categories WHERE id = $1",
          [catId],
        )).rows;

      await c.query("SELECT public.admin_save_category($1::jsonb)", [
        JSON.stringify({ id: catId, kind: "services", featured: true, nav_order: 7, translations: { da: daTranslation("Apps test") } }),
      ]);
      expect(await stored()).toEqual([{ kind: "apps", status: "draft", featured: true, nav_order: 7 }]);

      await c.query("SELECT public.admin_save_category($1::jsonb)", [
        JSON.stringify({ id: catId, translations: { da: daTranslation("Apps omdøbt") } }),
      ]);
      expect(await stored()).toEqual([{ kind: "apps", status: "draft", featured: true, nav_order: 7 }]);
      const { rows: translations } = await c.query<{ title: string }>(
        "SELECT title FROM public.category_translations WHERE category_id = $1 AND locale = 'da'",
        [catId],
      );
      expect(translations).toEqual([{ title: "Apps omdøbt" }]);
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // AC-CAT-13: admin_save_item — translations upserted
  // --------------------------------------------------------------------------

  it("AC-CAT-13: admin_save_item upserts item_translations for each locale", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catId = await seedCategory(c);

      await asRole(c, "authenticated", ADMIN_CLAIMS);
      const payload = {
        category_id: catId, price_type: null, price_amount: null, external_links: {},
        translations: {
          da: { slug: "item-trans-da", title: "Item DA", summary: "Resumé", body_md: "", seo_title: "", seo_description: "" },
          en: { slug: "item-trans-en", title: "Item EN", summary: "Summary", body_md: "", seo_title: "", seo_description: "" },
        },
      };
      const { rows } = await c.query<{ admin_save_item: string }>(
        "SELECT public.admin_save_item($1::jsonb)", [JSON.stringify(payload)],
      );
      const itemId = rows[0]?.admin_save_item;

      const { rows: translations } = await c.query<{ locale: string; title: string }>(
        "SELECT locale, title FROM public.item_translations WHERE item_id = $1 ORDER BY locale",
        [itemId],
      );
      expect(translations).toEqual([
        { locale: "da", title: "Item DA" },
        { locale: "en", title: "Item EN" },
      ]);
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // AC-CAT-14, AC-CAT-15: admin_save_item media entries
  // --------------------------------------------------------------------------

  it("AC-CAT-14: admin_save_item updates alt/sort_order for media belonging to the item", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catId = await seedCategory(c);
      const itemId = await seedItem(c, catId);
      const mediaId = await seedMedia(c, itemId);

      await asRole(c, "authenticated", ADMIN_CLAIMS);
      const payload = {
        id: itemId,
        media: [{ id: mediaId, alt_da: "Opdateret alt DA", alt_en: "Updated alt EN", sort_order: 50 }],
        translations: { da: { slug: "item-media-update", title: "Item", summary: "", body_md: "", seo_title: "", seo_description: "" } },
      };
      await c.query("SELECT public.admin_save_item($1::jsonb)", [JSON.stringify(payload)]);

      const { rows } = await c.query<{ alt_da: string; alt_en: string; sort_order: number }>(
        "SELECT alt_da, alt_en, sort_order FROM public.media WHERE id = $1",
        [mediaId],
      );
      expect(rows[0]).toMatchObject({ alt_da: "Opdateret alt DA", alt_en: "Updated alt EN", sort_order: 50 });
    });
  }, 12_000);

  it("AC-CAT-15: admin_save_item raises P0002 for media belonging to another item", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catId = await seedCategory(c);
      const itemA = await seedItem(c, catId);
      const itemB = await seedItem(c, catId);
      const mediaOfB = await seedMedia(c, itemB);

      await asRole(c, "authenticated", ADMIN_CLAIMS);
      const payload = {
        id: itemA,
        media: [{ id: mediaOfB, alt_da: "Stolen media", alt_en: "", sort_order: 10 }],
        translations: { da: { slug: "item-media-wrong", title: "Item A", summary: "", body_md: "", seo_title: "", seo_description: "" } },
      };
      await expectPgError(
        c,
        () => c.query("SELECT public.admin_save_item($1::jsonb)", [JSON.stringify(payload)]),
        "P0002",
        "admin_save_item media of another item",
        { messageIncludes: "media_not_found" },
      );
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // AC-CAT-16, AC-CAT-17: admin_save_item constraint errors
  // --------------------------------------------------------------------------

  it("AC-CAT-16: admin_save_item raises 23503 for non-existent category_id", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await expectPgError(
        c,
        () => c.query("SELECT public.admin_save_item($1::jsonb)", [
          JSON.stringify({ category_id: BOGUS_UUID, price_type: null, price_amount: null, external_links: {}, translations: { da: { slug: "item-bad-cat", title: "X", summary: "", body_md: "", seo_title: "", seo_description: "" } } }),
        ]),
        "23503",
        "admin_save_item unknown category",
      );
    });
  }, 12_000);

  it("AC-CAT-16: admin_save_item raises 22023 category_required on insert without category_id", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await expectPgError(
        c,
        () => c.query("SELECT public.admin_save_item($1::jsonb)", [
          JSON.stringify({ price_type: null, price_amount: null, external_links: {}, translations: { da: itemTranslation("item-no-cat") } }),
        ]),
        "22023",
        "admin_save_item insert without category_id",
        { messageIncludes: "category_required" },
      );
    });
  }, 12_000);

  it("AC-CAT-17: admin_save_item raises 23505 on duplicate item translation slug", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catId = await seedCategory(c);

      await asRole(c, "authenticated", ADMIN_CLAIMS);
      const p1 = { category_id: catId, price_type: null, price_amount: null, external_links: {}, translations: { da: { slug: "dup-slug-rpc", title: "Item 1", summary: "", body_md: "", seo_title: "", seo_description: "" } } };
      await c.query("SELECT public.admin_save_item($1::jsonb)", [JSON.stringify(p1)]);

      const p2 = { category_id: catId, price_type: null, price_amount: null, external_links: {}, translations: { da: { slug: "dup-slug-rpc", title: "Item 2", summary: "", body_md: "", seo_title: "", seo_description: "" } } };
      await expectPgError(
        c,
        () => c.query("SELECT public.admin_save_item($1::jsonb)", [JSON.stringify(p2)]),
        "23505",
        "admin_save_item duplicate slug",
      );
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // AC-CAT-18, AC-CAT-19, AC-CAT-20: admin_set_item_status
  // --------------------------------------------------------------------------

  it("AC-CAT-18: admin_set_item_status raises P0001 missing_translations without DA+EN", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catId = await seedCategory(c);
      const itemId = await seedItem(c, catId);
      // Only DA translation
      await seedItemTranslation(c, itemId, "da", "item-da-only");

      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await expectPgError(
        c,
        () => c.query("SELECT public.admin_set_item_status($1, 'published'::public.content_status)", [itemId]),
        "P0001",
        "admin_set_item_status missing_translations",
        { messageIncludes: "missing_translations" },
      );
    });
  }, 12_000);

  it("AC-CAT-19: admin_set_item_status stamps published_at once and keeps it on re-publish", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catId = await seedCategory(c);
      const itemId = await seedItem(c, catId);
      await seedItemTranslation(c, itemId, "da", "pub-at-test-da");
      await seedItemTranslation(c, itemId, "en", "pub-at-test-en");

      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await c.query("SELECT public.admin_set_item_status($1, 'published'::public.content_status)", [itemId]);

      const { rows: first } = await c.query<{ published_at: Date | null }>(
        "SELECT published_at FROM public.items WHERE id = $1", [itemId],
      );
      const firstPublishedAt = first[0]?.published_at;
      expect(firstPublishedAt).not.toBeNull();

      // Unpublish then re-publish
      await c.query("SELECT public.admin_set_item_status($1, 'draft'::public.content_status)", [itemId]);
      await c.query("SELECT public.admin_set_item_status($1, 'published'::public.content_status)", [itemId]);

      const { rows: second } = await c.query<{ published_at: Date | null }>(
        "SELECT published_at FROM public.items WHERE id = $1", [itemId],
      );
      // published_at must not change on re-publish
      expect(second[0]?.published_at?.toISOString()).toBe(firstPublishedAt?.toISOString());
    });
  }, 12_000);

  it("AC-CAT-20: admin_set_item_status raises P0002 for unknown item", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await expectPgError(
        c,
        () => c.query("SELECT public.admin_set_item_status($1, 'published'::public.content_status)", [BOGUS_UUID]),
        "P0002",
        "admin_set_item_status unknown",
        { messageIncludes: "item_not_found" },
      );
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // AC-CAT-21, AC-CAT-22: admin_reorder_items
  // --------------------------------------------------------------------------

  it("AC-CAT-21: admin_reorder_items sets sort_order=ord*10; an id of another category in the array is untouched", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catA = await seedCategory(c);
      const catB = await seedCategory(c);
      const itemA1 = await seedItem(c, catA);
      const itemA2 = await seedItem(c, catA);
      const itemB1 = await seedItem(c, catB);

      await asRole(c, "authenticated", ADMIN_CLAIMS);
      // Reorder catA with catB's item in the middle: itemA2 (1st), itemB1 (2nd), itemA1 (3rd).
      await c.query("SELECT public.admin_reorder_items($1, $2::uuid[])", [catA, `{${itemA2},${itemB1},${itemA1}}`]);

      const { rows } = await c.query<{ id: string; sort_order: number }>(
        "SELECT id, sort_order FROM public.items WHERE id = ANY($1::uuid[])",
        [[itemA1, itemA2, itemB1]],
      );
      // catA's items take their positions (1 → 10, 3 → 30). The category_id filter skips
      // itemB1, which keeps the DB default sort_order (100, core.sql) seedItem left it with.
      expect(Object.fromEntries(rows.map((row) => [row.id, row.sort_order]))).toEqual({
        [itemA2]: 10,
        [itemA1]: 30,
        [itemB1]: 100,
      });
    });
  }, 12_000);

  it("AC-CAT-22: admin_reorder_items raises P0002 for unknown category", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await expectPgError(
        c,
        () => c.query("SELECT public.admin_reorder_items($1, $2::uuid[])", [BOGUS_UUID, `{}`]),
        "P0002",
        "admin_reorder_items unknown",
        { messageIncludes: "category_not_found" },
      );
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // AC-CAT-23, AC-CAT-24: admin_delete_item
  // --------------------------------------------------------------------------

  it("AC-CAT-23: admin_delete_item returns media paths and cascades translations/media", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catId = await seedCategory(c);
      const itemId = await seedItem(c, catId);
      await seedItemTranslation(c, itemId, "da", "delete-item-da");
      const mediaId = await seedMedia(c, itemId);

      await asRole(c, "authenticated", ADMIN_CLAIMS);
      const { rows } = await c.query<{ admin_delete_item: string[] }>(
        "SELECT public.admin_delete_item($1)", [itemId],
      );
      const paths = rows[0]?.admin_delete_item;
      expect(Array.isArray(paths)).toBe(true);
      expect(paths!.length).toBe(1);
      expect(paths![0]).toContain("items/");

      // Item should be gone
      const { rows: items } = await c.query("SELECT id FROM public.items WHERE id = $1", [itemId]);
      expect(items).toHaveLength(0);

      // Translations should be cascaded
      const { rows: trans } = await c.query("SELECT item_id FROM public.item_translations WHERE item_id = $1", [itemId]);
      expect(trans).toHaveLength(0);

      // Media should be cascaded
      const { rows: medias } = await c.query("SELECT id FROM public.media WHERE id = $1", [mediaId]);
      expect(medias).toHaveLength(0);
    });
  }, 12_000);

  it("AC-CAT-23: admin_delete_item returns empty array when item has no media", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catId = await seedCategory(c);
      const itemId = await seedItem(c, catId);

      await asRole(c, "authenticated", ADMIN_CLAIMS);
      const { rows } = await c.query<{ admin_delete_item: string[] }>(
        "SELECT public.admin_delete_item($1)", [itemId],
      );
      const paths = rows[0]?.admin_delete_item;
      expect(paths).toEqual([]);
    });
  }, 12_000);

  it("AC-CAT-24: admin_delete_item raises P0002 for unknown item", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await expectPgError(
        c,
        () => c.query("SELECT public.admin_delete_item($1)", [BOGUS_UUID]),
        "P0002",
        "admin_delete_item unknown",
        { messageIncludes: "item_not_found" },
      );
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // AC-CAT-25 … AC-CAT-32: admin_attach_media / admin_detach_media
  // --------------------------------------------------------------------------

  it("AC-CAT-25: admin_attach_media raises 22023 for bad path format", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catId = await seedCategory(c);
      const itemId = await seedItem(c, catId);
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await expectPgError(
        c,
        () => c.query("SELECT public.admin_attach_media($1, $2, $3, $4, $5, $6)", [
          itemId, "other/bad/path.webp", "Alt", "", 100, 100,
        ]),
        "22023",
        "admin_attach_media bad path",
        { messageIncludes: "invalid_media_path" },
      );
    });
  }, 12_000);

  it("AC-CAT-26: admin_attach_media raises 22023 when path item segment != p_item_id", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catId = await seedCategory(c);
      const itemId = await seedItem(c, catId);
      const wrongItemId = BOGUS_UUID;
      const fileUuid = "11111111-2222-3333-4444-555555555555";
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await expectPgError(
        c,
        () => c.query("SELECT public.admin_attach_media($1, $2, $3, $4, $5, $6)", [
          itemId, `items/${wrongItemId}/${fileUuid}.webp`, "Alt", "", 100, 100,
        ]),
        "22023",
        "admin_attach_media wrong item segment",
        { messageIncludes: "invalid_media_path" },
      );
    });
  }, 12_000);

  it("AC-CAT-27: admin_attach_media raises P0002 when storage object does not exist", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catId = await seedCategory(c);
      const itemId = await seedItem(c, catId);
      const fileUuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      const path = `items/${itemId}/${fileUuid}.webp`;
      // Do NOT seed the storage object
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await expectPgError(
        c,
        () => c.query("SELECT public.admin_attach_media($1, $2, $3, $4, $5, $6)", [
          itemId, path, "Alt", "", 100, 100,
        ]),
        "P0002",
        "admin_attach_media missing storage object",
        { messageIncludes: "media_not_stored" },
      );
    });
  }, 12_000);

  it("AC-CAT-28: admin_attach_media raises P0001 too_many_media on 9th attachment", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catId = await seedCategory(c);
      const itemId = await seedItem(c, catId);

      // Seed 8 media rows (each seedMedia call names a fresh valid path in the item's folder).
      for (let i = 0; i < 8; i++) await seedMedia(c, itemId);

      const fileUuid = "cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa";
      const path = `items/${itemId}/${fileUuid}.webp`;
      await seedStorageObject(c, path);

      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await expectPgError(
        c,
        () => c.query("SELECT public.admin_attach_media($1, $2, $3, $4, $5, $6)", [
          itemId, path, "Alt", "", 100, 100,
        ]),
        "P0001",
        "admin_attach_media 9th",
        { messageIncludes: "too_many_media" },
      );
    });
  }, 12_000);

  it("AC-CAT-29: admin_attach_media returns UUID, sort_order=max+10, mime from extension", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catId = await seedCategory(c);
      const itemId = await seedItem(c, catId);

      // Seed an existing media row with sort_order=30 so the next attachment must
      // compute max(30)+10=40, distinguishing the RPC's max+10 from a hardcoded 10.
      await c.query(
        `INSERT INTO public.media (item_id, storage_path, alt_da, width, height, mime_type, sort_order)
         VALUES ($1, $2, 'Existing', 100, 100, 'image/webp', 30)`,
        [itemId, `items/${itemId}/abcdabcd-0000-4000-8000-000000000030.webp`],
      );

      // Use .jpg to exercise the non-identity mime mapping (jpg/jpeg → image/jpeg).
      const fileUuid = "dddddddd-eeee-ffff-0000-111111111111";
      const path = `items/${itemId}/${fileUuid}.jpg`;
      await seedStorageObject(c, path);

      await asRole(c, "authenticated", ADMIN_CLAIMS);
      const { rows } = await c.query<{ admin_attach_media: string }>(
        "SELECT public.admin_attach_media($1, $2, $3, $4, $5, $6)",
        [itemId, path, "Alt DA", "Alt EN", 800, 600],
      );
      const newMediaId = rows[0]?.admin_attach_media;
      expect(newMediaId).toMatch(UUID_RE);

      const { rows: media } = await c.query<{ sort_order: number; mime_type: string; alt_da: string; alt_en: string }>(
        "SELECT sort_order, mime_type, alt_da, alt_en FROM public.media WHERE id = $1",
        [newMediaId],
      );
      // sort_order must be max(existing 30)+10=40, proving max+10 not a constant.
      // mime_type for .jpg/.jpeg must map to image/jpeg (the non-identity case).
      expect(media[0]).toMatchObject({ sort_order: 40, mime_type: "image/jpeg", alt_da: "Alt DA", alt_en: "Alt EN" });
    });
  }, 12_000);

  it("AC-CAT-29: admin_attach_media raises 22023 media_type_mismatch when the object's recorded mimetype differs from its extension", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catId = await seedCategory(c);
      const itemId = await seedItem(c, catId);
      // A PNG upload stored under a .webp name.
      const path = `items/${itemId}/abababab-cdcd-efef-0101-232323232323.webp`;
      await seedStorageObject(c, path, { size: 1024, mimetype: "image/png" });

      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await expectPgError(
        c,
        () => c.query(ATTACH_MEDIA, [itemId, path, "Alt", "", 100, 100]),
        "22023",
        "admin_attach_media mimetype mismatch",
        { messageIncludes: "media_type_mismatch" },
      );
      const { rows } = await c.query("SELECT id FROM public.media WHERE item_id = $1", [itemId]);
      expect(rows).toHaveLength(0);
    });
  }, 12_000);

  it("AC-CAT-29: admin_attach_media attaches when the recorded mimetype matches the extension (any case) or is absent", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catId = await seedCategory(c);
      const itemId = await seedItem(c, catId);
      const objects = [
        { path: `items/${itemId}/a1a1a1a1-b2b2-c3c3-d4d4-e5e5e5e5e5e1.jpeg`, metadata: { size: 1024, mimetype: "image/jpeg" }, mime: "image/jpeg" },
        { path: `items/${itemId}/a1a1a1a1-b2b2-c3c3-d4d4-e5e5e5e5e5e2.png`, metadata: { size: 2048, mimetype: "IMAGE/PNG" }, mime: "image/png" },
        { path: `items/${itemId}/a1a1a1a1-b2b2-c3c3-d4d4-e5e5e5e5e5e3.avif`, metadata: { size: 512 }, mime: "image/avif" },
        { path: `items/${itemId}/a1a1a1a1-b2b2-c3c3-d4d4-e5e5e5e5e5e4.webp`, metadata: null, mime: "image/webp" },
      ];
      for (const object of objects) await seedStorageObject(c, object.path, object.metadata);

      await asRole(c, "authenticated", ADMIN_CLAIMS);
      for (const object of objects) await c.query(ATTACH_MEDIA, [itemId, object.path, "Alt", "", 100, 100]);

      const { rows } = await c.query<{ storage_path: string; mime_type: string }>(
        "SELECT storage_path, mime_type FROM public.media WHERE item_id = $1 ORDER BY sort_order",
        [itemId],
      );
      expect(rows).toEqual(objects.map((object) => ({ storage_path: object.path, mime_type: object.mime })));
    });
  }, 12_000);

  it("AC-CAT-30: admin_attach_media raises P0002 for unknown item", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const fileUuid = "eeeeeeee-ffff-0000-1111-222222222222";
      const path = `items/${BOGUS_UUID}/${fileUuid}.webp`;
      await seedStorageObject(c, path);
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await expectPgError(
        c,
        () => c.query("SELECT public.admin_attach_media($1, $2, $3, $4, $5, $6)", [
          BOGUS_UUID, path, "Alt", "", 100, 100,
        ]),
        "P0002",
        "admin_attach_media unknown item",
        { messageIncludes: "item_not_found" },
      );
    });
  }, 12_000);

  it("AC-CAT-31: admin_detach_media deletes the row and returns its storage_path", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catId = await seedCategory(c);
      const itemId = await seedItem(c, catId);
      const mediaId = await seedMedia(c, itemId);

      // Fetch the storage_path of the seeded media
      const { rows: pre } = await c.query<{ storage_path: string }>(
        "SELECT storage_path FROM public.media WHERE id = $1", [mediaId],
      );
      const storagePath = pre[0]!.storage_path;

      await asRole(c, "authenticated", ADMIN_CLAIMS);
      const { rows } = await c.query<{ admin_detach_media: string }>(
        "SELECT public.admin_detach_media($1)", [mediaId],
      );
      expect(rows[0]?.admin_detach_media).toBe(storagePath);

      // Row should be gone
      const { rows: post } = await c.query("SELECT id FROM public.media WHERE id = $1", [mediaId]);
      expect(post).toHaveLength(0);
    });
  }, 12_000);

  it("AC-CAT-32: admin_detach_media raises P0002 for unknown media", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await expectPgError(
        c,
        () => c.query("SELECT public.admin_detach_media($1)", [BOGUS_UUID]),
        "P0002",
        "admin_detach_media unknown",
        { messageIncludes: "media_not_found" },
      );
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // Constraint propagation through RPCs (admin caller)
  //
  // Each test exercises a DB constraint via an admin RPC call, proving the RPC
  // surfaces the constraint's SQLSTATE and name (which the TS error map reads).
  // Complements the direct-INSERT constraint tests in rls-catalog-constraints.test.ts.
  // --------------------------------------------------------------------------

  // ── items_price_consistent ─────────────────────────────────────────────────

  it("AC-CAT-35 via RPC: admin_save_item raises 23514 items_price_consistent for fixed+null amount", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catId = await seedCategory(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await expectPgError(
        c,
        () => c.query("SELECT public.admin_save_item($1::jsonb)", [
          JSON.stringify({ category_id: catId, price_type: "fixed", price_amount: null, external_links: {}, translations: { da: { slug: "price-rpc-35a", title: "X", summary: "", body_md: "", seo_title: "", seo_description: "" } } }),
        ]),
        "23514",
        "admin_save_item price_consistent fixed+null",
        { messageIncludes: "items_price_consistent" },
      );
    });
  }, 12_000);

  it("AC-CAT-35 via RPC: admin_save_item raises 23514 items_price_consistent for contact+amount", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catId = await seedCategory(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await expectPgError(
        c,
        () => c.query("SELECT public.admin_save_item($1::jsonb)", [
          JSON.stringify({ category_id: catId, price_type: "contact", price_amount: 500, external_links: {}, translations: { da: { slug: "price-rpc-35b", title: "X", summary: "", body_md: "", seo_title: "", seo_description: "" } } }),
        ]),
        "23514",
        "admin_save_item price_consistent contact+amount",
        { messageIncludes: "items_price_consistent" },
      );
    });
  }, 12_000);

  // ── items_external_links_valid ─────────────────────────────────────────────

  it("AC-CAT-36 via RPC: admin_save_item raises 23514 items_external_links_valid for http:// value", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catId = await seedCategory(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await expectPgError(
        c,
        () => c.query("SELECT public.admin_save_item($1::jsonb)", [
          JSON.stringify({ category_id: catId, price_type: null, price_amount: null, external_links: { website: "http://example.com" }, translations: { da: { slug: "links-rpc-36a", title: "X", summary: "", body_md: "", seo_title: "", seo_description: "" } } }),
        ]),
        "23514",
        "admin_save_item external_links http://",
        { messageIncludes: "items_external_links_valid" },
      );
    });
  }, 12_000);

  it("AC-CAT-36 via RPC: admin_save_item raises 23514 items_external_links_valid for javascript: value", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catId = await seedCategory(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await expectPgError(
        c,
        () => c.query("SELECT public.admin_save_item($1::jsonb)", [
          JSON.stringify({ category_id: catId, price_type: null, price_amount: null, external_links: { website: "javascript:alert(1)" }, translations: { da: { slug: "links-rpc-36b", title: "X", summary: "", body_md: "", seo_title: "", seo_description: "" } } }),
        ]),
        "23514",
        "admin_save_item external_links javascript:",
        { messageIncludes: "items_external_links_valid" },
      );
    });
  }, 12_000);

  it("AC-CAT-36 via RPC: admin_save_item raises 23514 items_external_links_valid for data: value", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catId = await seedCategory(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await expectPgError(
        c,
        () => c.query("SELECT public.admin_save_item($1::jsonb)", [
          JSON.stringify({ category_id: catId, price_type: null, price_amount: null, external_links: { website: "data:text/html,x" }, translations: { da: { slug: "links-rpc-36c", title: "X", summary: "", body_md: "", seo_title: "", seo_description: "" } } }),
        ]),
        "23514",
        "admin_save_item external_links data:",
        { messageIncludes: "items_external_links_valid" },
      );
    });
  }, 12_000);

  it("AC-CAT-36 via RPC: admin_save_item raises 23514 items_external_links_valid for unknown key", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catId = await seedCategory(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await expectPgError(
        c,
        () => c.query("SELECT public.admin_save_item($1::jsonb)", [
          JSON.stringify({ category_id: catId, price_type: null, price_amount: null, external_links: { unknown_key: "https://example.com" }, translations: { da: { slug: "links-rpc-36d", title: "X", summary: "", body_md: "", seo_title: "", seo_description: "" } } }),
        ]),
        "23514",
        "admin_save_item external_links unknown_key",
        { messageIncludes: "items_external_links_valid" },
      );
    });
  }, 12_000);

  it("AC-CAT-36 via RPC: admin_save_item raises 23514 items_external_links_valid for non-string value", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catId = await seedCategory(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await expectPgError(
        c,
        () => c.query("SELECT public.admin_save_item($1::jsonb)", [
          JSON.stringify({ category_id: catId, price_type: null, price_amount: null, external_links: { website: 123 }, translations: { da: { slug: "links-rpc-36e", title: "X", summary: "", body_md: "", seo_title: "", seo_description: "" } } }),
        ]),
        "23514",
        "admin_save_item external_links non-string",
        { messageIncludes: "items_external_links_valid" },
      );
    });
  }, 12_000);

  // ── item_translations_da_title ─────────────────────────────────────────────

  it("AC-CAT-38 via RPC: admin_save_item raises 23514 item_translations_da_title for blank DA title", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catId = await seedCategory(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await expectPgError(
        c,
        () => c.query("SELECT public.admin_save_item($1::jsonb)", [
          JSON.stringify({ category_id: catId, price_type: null, price_amount: null, external_links: {}, translations: { da: { slug: "da-title-rpc-38", title: "", summary: "", body_md: "", seo_title: "", seo_description: "" } } }),
        ]),
        "23514",
        "admin_save_item item_translations_da_title blank",
        { messageIncludes: "item_translations_da_title" },
      );
    });
  }, 12_000);

  // ── item_translations_slug_check ───────────────────────────────────────────

  it("AC-CAT-40 via RPC: admin_save_item raises 23514 item_translations_slug_check for invalid slug", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catId = await seedCategory(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await expectPgError(
        c,
        () => c.query("SELECT public.admin_save_item($1::jsonb)", [
          JSON.stringify({ category_id: catId, price_type: null, price_amount: null, external_links: {}, translations: { da: { slug: "Invalid Slug!", title: "X", summary: "", body_md: "", seo_title: "", seo_description: "" } } }),
        ]),
        "23514",
        "admin_save_item item_translations_slug_check",
        { messageIncludes: "item_translations_slug_check" },
      );
    });
  }, 12_000);

  it("AC-CAT-40 via RPC: admin_save_item raises 23514 item_translations_slug_check for slug with trailing dash", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catId = await seedCategory(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await expectPgError(
        c,
        () => c.query("SELECT public.admin_save_item($1::jsonb)", [
          JSON.stringify({ category_id: catId, price_type: null, price_amount: null, external_links: {}, translations: { da: { slug: "trailing-dash-", title: "X", summary: "", body_md: "", seo_title: "", seo_description: "" } } }),
        ]),
        "23514",
        "admin_save_item item_translations_slug_check trailing-dash",
        { messageIncludes: "item_translations_slug_check" },
      );
    });
  }, 12_000);

  // ── routes_slug_format / routes_slug_reserved ──────────────────────────────

  it("AC-CAT-41 via RPC: admin_save_category raises 23514 routes_slug_format for invalid slug in translation", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await expectPgError(
        c,
        () => c.query("SELECT public.admin_save_category($1::jsonb)", [
          JSON.stringify({ kind: "apps", translations: { da: { title: "Cat", description: "", seo_title: "", seo_description: "", slug: "Invalid Slug Format!" } } }),
        ]),
        "23514",
        "admin_save_category routes_slug_format",
        { messageIncludes: "routes_slug_format" },
      );
    });
  }, 12_000);

  it("AC-CAT-42 via RPC: admin_save_category raises 23514 routes_slug_reserved for slug 'mylife'", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await expectPgError(
        c,
        () => c.query("SELECT public.admin_save_category($1::jsonb)", [
          JSON.stringify({ kind: "apps", translations: { da: { title: "Cat", description: "", seo_title: "", seo_description: "", slug: "mylife" } } }),
        ]),
        "23514",
        "admin_save_category routes_slug_reserved mylife",
        { messageIncludes: "routes_slug_reserved" },
      );
    });
  }, 12_000);

  it("AC-CAT-42 via RPC: admin_save_category raises 23514 routes_slug_reserved for slug 'admin'", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await expectPgError(
        c,
        () => c.query("SELECT public.admin_save_category($1::jsonb)", [
          JSON.stringify({ kind: "apps", translations: { da: { title: "Cat", description: "", seo_title: "", seo_description: "", slug: "admin" } } }),
        ]),
        "23514",
        "admin_save_category routes_slug_reserved admin",
        { messageIncludes: "routes_slug_reserved" },
      );
    });
  }, 12_000);

  // ── media_alt_da_check — via admin_attach_media ────────────────────────────

  it("AC-CAT-44 via RPC: admin_attach_media raises 23514 media_alt_da_check for blank p_alt_da", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catId = await seedCategory(c);
      const itemId = await seedItem(c, catId);
      const fileUuid = "44444444-4444-4444-4444-444444444444";
      const path = `items/${itemId}/${fileUuid}.webp`;
      await seedStorageObject(c, path);
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await expectPgError(
        c,
        () => c.query("SELECT public.admin_attach_media($1, $2, $3, $4, $5, $6)", [
          itemId, path, "", "", 100, 100,
        ]),
        "23514",
        "admin_attach_media media_alt_da_check blank",
        { messageIncludes: "media_alt_da_check" },
      );
    });
  }, 12_000);

  // ── media_alt_da_check — via admin_save_item media update ─────────────────

  it("AC-CAT-44 via RPC: admin_save_item raises 23514 media_alt_da_check for blank alt_da in media entry", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catId = await seedCategory(c);
      const itemId = await seedItem(c, catId);
      const mediaId = await seedMedia(c, itemId);
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await expectPgError(
        c,
        () => c.query("SELECT public.admin_save_item($1::jsonb)", [
          JSON.stringify({
            id: itemId,
            media: [{ id: mediaId, alt_da: "", alt_en: "", sort_order: 10 }],
            translations: { da: { slug: "alt-check-rpc-44", title: "X", summary: "", body_md: "", seo_title: "", seo_description: "" } },
          }),
        ]),
        "23514",
        "admin_save_item media_alt_da_check blank",
        { messageIncludes: "media_alt_da_check" },
      );
    });
  }, 12_000);
});
