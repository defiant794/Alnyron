/**
 * RLS + constraint integration tests — catalog (F2.1 catalog-model)
 *
 * Covers:
 *   AC-CAT-33 — 23505: duplicate slug in routes for a category
 *   AC-CAT-34 — 23505: duplicate slug in item_translations
 *   AC-CAT-35 — 23514: items_price_consistent (fixed+null amount, contact+amount)
 *   AC-CAT-36 — 23514: items_external_links_valid (http, javascript:, data:, unknown key, non-string)
 *   AC-CAT-37 — external_links: valid https for all 5 keys and {} both accepted
 *   AC-CAT-38 — 23514: item_translations_da_title (blank DA title)
 *   AC-CAT-39 — 23514: category_translations_da_title (blank DA title)
 *   AC-CAT-40 — 23514: item_translations_slug_check (bad slug format)
 *   AC-CAT-41 — 23514: routes_slug_format (bad slug)
 *   AC-CAT-42 — 23514: routes_slug_reserved (mylife + existing reserved)
 *   AC-CAT-43 — seeded routes survive routes_slug_reserved re-creation with mylife
 *   AC-CAT-44 — 23514: media_alt_da_check (blank alt_da)
 *   AC-CAT-45 — 23503: unknown category_id on items INSERT; deleting a category that still has items
 *               (items.category_id on delete restrict)
 *
 * All INSERT/UPDATE tests run as postgres (superuser, bypasses RLS) inside
 * withTx (rolled back). Constraint checks are SQL-layer, not RLS-layer.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RESERVED_ROUTE_SLUGS } from "@/config/catalog";
import { DB_AVAILABLE, getClient, type PoolClient } from "./helpers/db.js";
import {
  expectPgError,
  seedCategory,
  seedItem,
  seedItemTranslation,
  seedMedia,
  seedRoute,
  withTx,
} from "./helpers/roles.js";

const BOGUS_UUID = "00000000-0000-0000-0000-999999999998";

describe.skipIf(!DB_AVAILABLE)("Constraints — catalog", () => {
  let client: PoolClient;

  beforeAll(async () => {
    client = await getClient();
  });

  afterAll(async () => {
    client.release();
  });

  // --------------------------------------------------------------------------
  // AC-CAT-33: 23505 duplicate slug in routes (category)
  // --------------------------------------------------------------------------

  it("AC-CAT-33: 23505 when inserting a duplicate slug+locale route for a category", async () => {
    await withTx(client, async (c) => {
      const catA = await seedCategory(c);
      const catB = await seedCategory(c);
      await seedRoute(c, "da", "dup-cat-route-slug", { categoryId: catA });

      await expectPgError(
        c,
        () => seedRoute(c, "da", "dup-cat-route-slug", { categoryId: catB }),
        "23505",
        "routes duplicate slug",
      );
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // AC-CAT-34: 23505 duplicate slug in item_translations
  // --------------------------------------------------------------------------

  it("AC-CAT-34: 23505 when inserting a duplicate slug+locale item_translation", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      const itemA = await seedItem(c, catId);
      const itemB = await seedItem(c, catId);
      await seedItemTranslation(c, itemA, "da", "dup-item-slug");

      await expectPgError(
        c,
        () => seedItemTranslation(c, itemB, "da", "dup-item-slug"),
        "23505",
        "item_translations duplicate slug",
      );
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // AC-CAT-35: 23514 items_price_consistent
  // --------------------------------------------------------------------------

  it("AC-CAT-35: 23514 items_price_consistent when price_type=fixed but price_amount is null", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      await expectPgError(
        c,
        () => c.query(
          `INSERT INTO public.items (category_id, price_type, price_amount, status)
           VALUES ($1, 'fixed', NULL, 'draft')`,
          [catId],
        ),
        "23514",
        "price_consistent fixed+null",
        { messageIncludes: "items_price_consistent" },
      );
    });
  }, 12_000);

  it("AC-CAT-35: 23514 items_price_consistent when price_type=from but price_amount is null", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      await expectPgError(
        c,
        () => c.query(
          `INSERT INTO public.items (category_id, price_type, price_amount, status)
           VALUES ($1, 'from', NULL, 'draft')`,
          [catId],
        ),
        "23514",
        "price_consistent from+null",
        { messageIncludes: "items_price_consistent" },
      );
    });
  }, 12_000);

  it("AC-CAT-35: 23514 items_price_consistent when price_type=contact but price_amount is set", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      await expectPgError(
        c,
        () => c.query(
          `INSERT INTO public.items (category_id, price_type, price_amount, status)
           VALUES ($1, 'contact', 500, 'draft')`,
          [catId],
        ),
        "23514",
        "price_consistent contact+amount",
        { messageIncludes: "items_price_consistent" },
      );
    });
  }, 12_000);

  it("AC-CAT-35: accepts price_type=null with price_amount=null", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      // Should not throw
      await c.query(
        `INSERT INTO public.items (category_id, price_type, price_amount, status)
         VALUES ($1, NULL, NULL, 'draft')`,
        [catId],
      );
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // AC-CAT-36: 23514 items_external_links_valid
  // --------------------------------------------------------------------------

  it("AC-CAT-36: 23514 items_external_links_valid rejects http:// URL", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      const itemId = await seedItem(c, catId);
      await expectPgError(
        c,
        () => c.query(
          `UPDATE public.items SET external_links = $1 WHERE id = $2`,
          [JSON.stringify({ website: "http://example.com" }), itemId],
        ),
        "23514",
        "external_links http://",
        { messageIncludes: "items_external_links_valid" },
      );
    });
  }, 12_000);

  it("AC-CAT-36: 23514 items_external_links_valid rejects javascript: URL", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      const itemId = await seedItem(c, catId);
      await expectPgError(
        c,
        () => c.query(
          `UPDATE public.items SET external_links = $1 WHERE id = $2`,
          [JSON.stringify({ website: "javascript:alert(1)" }), itemId],
        ),
        "23514",
        "external_links javascript:",
        { messageIncludes: "items_external_links_valid" },
      );
    });
  }, 12_000);

  it("AC-CAT-36: 23514 items_external_links_valid rejects data: URL", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      const itemId = await seedItem(c, catId);
      await expectPgError(
        c,
        () => c.query(
          `UPDATE public.items SET external_links = $1 WHERE id = $2`,
          [JSON.stringify({ website: "data:text/html,<h1>hi</h1>" }), itemId],
        ),
        "23514",
        "external_links data:",
        { messageIncludes: "items_external_links_valid" },
      );
    });
  }, 12_000);

  it("AC-CAT-36: 23514 items_external_links_valid rejects unknown key", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      const itemId = await seedItem(c, catId);
      await expectPgError(
        c,
        () => c.query(
          `UPDATE public.items SET external_links = $1 WHERE id = $2`,
          [JSON.stringify({ unknown_key: "https://example.com" }), itemId],
        ),
        "23514",
        "external_links unknown_key",
        { messageIncludes: "items_external_links_valid" },
      );
    });
  }, 12_000);

  it("AC-CAT-36: 23514 items_external_links_valid rejects non-string value", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      const itemId = await seedItem(c, catId);
      await expectPgError(
        c,
        () => c.query(
          `UPDATE public.items SET external_links = $1 WHERE id = $2`,
          [JSON.stringify({ website: 123 }), itemId],
        ),
        "23514",
        "external_links non-string",
        { messageIncludes: "items_external_links_valid" },
      );
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // AC-CAT-37: valid external_links accepted
  // --------------------------------------------------------------------------

  it("AC-CAT-37: accepts external_links = {} (empty object)", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      const itemId = await seedItem(c, catId);
      // Should not throw
      await c.query(
        `UPDATE public.items SET external_links = $1 WHERE id = $2`,
        [JSON.stringify({}), itemId],
      );
    });
  }, 12_000);

  it("AC-CAT-37: accepts external_links with all 5 valid https keys", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      const itemId = await seedItem(c, catId);
      await c.query(
        `UPDATE public.items SET external_links = $1 WHERE id = $2`,
        [JSON.stringify({
          website: "https://example.com",
          demo: "https://demo.example.com",
          app_store: "https://apps.apple.com/app/id123",
          google_play: "https://play.google.com/store/apps/details?id=com.example",
          download: "https://example.com/download/app.zip",
        }), itemId],
      );
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // AC-CAT-38: 23514 item_translations_da_title
  // --------------------------------------------------------------------------

  it("AC-CAT-38: 23514 item_translations_da_title when DA title is empty", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      const itemId = await seedItem(c, catId);
      await expectPgError(
        c,
        () => c.query(
          `INSERT INTO public.item_translations (item_id, locale, slug, title)
           VALUES ($1, 'da', 'blank-da-title', '')`,
          [itemId],
        ),
        "23514",
        "item_translations_da_title blank",
        { messageIncludes: "item_translations_da_title" },
      );
    });
  }, 12_000);

  it("AC-CAT-38: accepts EN item_translation with empty title", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      const itemId = await seedItem(c, catId);
      // EN title may be blank
      await c.query(
        `INSERT INTO public.item_translations (item_id, locale, slug, title)
         VALUES ($1, 'en', 'en-blank-title', '')`,
        [itemId],
      );
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // AC-CAT-39: 23514 category_translations_da_title
  // --------------------------------------------------------------------------

  it("AC-CAT-39: 23514 category_translations_da_title when DA title is empty", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      await expectPgError(
        c,
        () => c.query(
          `INSERT INTO public.category_translations (category_id, locale, title)
           VALUES ($1, 'da', '')`,
          [catId],
        ),
        "23514",
        "category_translations_da_title blank",
        { messageIncludes: "category_translations_da_title" },
      );
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // AC-CAT-40: 23514 item_translations_slug_check
  // --------------------------------------------------------------------------

  it("AC-CAT-40: 23514 item_translations_slug_check when slug has uppercase", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      const itemId = await seedItem(c, catId);
      await expectPgError(
        c,
        () => c.query(
          `INSERT INTO public.item_translations (item_id, locale, slug, title)
           VALUES ($1, 'da', 'Invalid-Slug', 'Test')`,
          [itemId],
        ),
        "23514",
        "item_translations_slug_check uppercase",
        { messageIncludes: "item_translations_slug_check" },
      );
    });
  }, 12_000);

  it("AC-CAT-40: 23514 item_translations_slug_check when slug has trailing dash", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      const itemId = await seedItem(c, catId);
      await expectPgError(
        c,
        () => c.query(
          `INSERT INTO public.item_translations (item_id, locale, slug, title)
           VALUES ($1, 'da', 'trailing-dash-', 'Test')`,
          [itemId],
        ),
        "23514",
        "item_translations_slug_check trailing dash",
        { messageIncludes: "item_translations_slug_check" },
      );
    });
  }, 12_000);

  it("AC-CAT-40: 23514 item_translations_slug_check when slug has spaces", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      const itemId = await seedItem(c, catId);
      await expectPgError(
        c,
        () => c.query(
          `INSERT INTO public.item_translations (item_id, locale, slug, title)
           VALUES ($1, 'da', 'slug with spaces', 'Test')`,
          [itemId],
        ),
        "23514",
        "item_translations_slug_check spaces",
        { messageIncludes: "item_translations_slug_check" },
      );
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // AC-CAT-41: 23514 routes_slug_format
  // --------------------------------------------------------------------------

  it("AC-CAT-41: 23514 routes_slug_format when slug has uppercase", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      await expectPgError(
        c,
        () => c.query(
          `INSERT INTO public.routes (locale, slug, category_id) VALUES ('da', 'Invalid-Slug-41', $1)`,
          [catId],
        ),
        "23514",
        "routes_slug_format uppercase",
        { messageIncludes: "routes_slug_format" },
      );
    });
  }, 12_000);

  it("AC-CAT-41: 23514 routes_slug_format when slug has consecutive dashes", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      await expectPgError(
        c,
        () => c.query(
          `INSERT INTO public.routes (locale, slug, category_id) VALUES ('da', 'bad--slug-41', $1)`,
          [catId],
        ),
        "23514",
        "routes_slug_format consecutive dashes",
        { messageIncludes: "routes_slug_format" },
      );
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // AC-CAT-42: 23514 routes_slug_reserved (mylife + existing reserved)
  // --------------------------------------------------------------------------

  it("AC-CAT-42: 23514 routes_slug_reserved for slug 'mylife'", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      await expectPgError(
        c,
        () => c.query(
          `INSERT INTO public.routes (locale, slug, category_id) VALUES ('da', 'mylife', $1)`,
          [catId],
        ),
        "23514",
        "routes_slug_reserved mylife",
        { messageIncludes: "routes_slug_reserved" },
      );
    });
  }, 12_000);

  it("AC-CAT-42: 23514 routes_slug_reserved for slug 'admin'", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      await expectPgError(
        c,
        () => c.query(
          `INSERT INTO public.routes (locale, slug, category_id) VALUES ('da', 'admin', $1)`,
          [catId],
        ),
        "23514",
        "routes_slug_reserved admin",
        { messageIncludes: "routes_slug_reserved" },
      );
    });
  }, 12_000);

  it("AC-CAT-42: 23514 routes_slug_reserved for slug 'api'", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      await expectPgError(
        c,
        () => c.query(
          `INSERT INTO public.routes (locale, slug, category_id) VALUES ('da', 'api', $1)`,
          [catId],
        ),
        "23514",
        "routes_slug_reserved api",
        { messageIncludes: "routes_slug_reserved" },
      );
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // AC-CAT-43: seeded category routes survive routes_slug_reserved re-creation
  //
  // System pages have NO rows in the routes table — routes_guard blocks that
  // ("system pages have fixed routes"). The seeded rows come from
  // 20261101000300_seed_system_content.sql:97-100: 4 kinds × 2 locales = 8
  // category routes. `convalidated` proves every row present when the F2.1
  // migration re-added the constraint passed it (ADD CONSTRAINT checks them all).
  // --------------------------------------------------------------------------

  it("AC-CAT-43: routes_slug_reserved is validated and lists every reserved slug, including mylife", async () => {
    await withTx(client, async (c) => {
      const { rows } = await c.query<{ def: string; convalidated: boolean }>(
        `SELECT pg_get_constraintdef(oid) AS def, convalidated
           FROM pg_constraint
          WHERE conrelid = 'public.routes'::regclass AND conname = 'routes_slug_reserved'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.convalidated).toBe(true);
      // ARRAY['admin'::text, ...]: the DB list and the app's RESERVED_ROUTE_SLUGS match exactly.
      const listed = [...(rows[0]?.def ?? "").matchAll(/'([^']*)'::text/g)].map((match) => match[1]);
      expect(listed).toEqual([...RESERVED_ROUTE_SLUGS]);
      expect(listed).toContain("mylife");
    });
  }, 12_000);

  it("AC-CAT-43: the 8 seeded category routes still exist, each on its kind's category", async () => {
    await withTx(client, async (c) => {
      const { rows } = await c.query<{ kind: string; locale: string; slug: string }>(
        `SELECT cat.kind, r.locale, r.slug
           FROM public.routes r
           JOIN public.categories cat ON cat.id = r.category_id
          WHERE (r.locale, r.slug) IN (('da', 'apps'), ('da', 'hjemmesider'), ('da', 'ydelser'), ('da', '3d-modeller'),
                                       ('en', 'apps'), ('en', 'websites'), ('en', 'services'), ('en', '3d-models'))
          ORDER BY r.locale, r.slug`,
      );
      expect(rows).toEqual([
        { kind: "models3d", locale: "da", slug: "3d-modeller" },
        { kind: "apps", locale: "da", slug: "apps" },
        { kind: "websites", locale: "da", slug: "hjemmesider" },
        { kind: "services", locale: "da", slug: "ydelser" },
        { kind: "models3d", locale: "en", slug: "3d-models" },
        { kind: "apps", locale: "en", slug: "apps" },
        { kind: "services", locale: "en", slug: "services" },
        { kind: "websites", locale: "en", slug: "websites" },
      ]);
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // AC-CAT-44: 23514 media_alt_da_check
  // --------------------------------------------------------------------------

  it("AC-CAT-44: 23514 media_alt_da_check when alt_da is empty", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      const itemId = await seedItem(c, catId);
      await expectPgError(
        c,
        () => c.query(
          `INSERT INTO public.media (item_id, storage_path, alt_da, width, height, mime_type)
           VALUES ($1, $2, '', 100, 100, 'image/webp')`,
          [itemId, `items/${itemId}/b1a2c3d4-0000-4000-8000-000000000044.webp`],
        ),
        "23514",
        "media_alt_da_check blank",
        { messageIncludes: "media_alt_da_check" },
      );
    });
  }, 12_000);

  it("AC-CAT-44: 23514 media_alt_da_check on UPDATE setting alt_da to blank", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      const itemId = await seedItem(c, catId);
      const mediaId = await seedMedia(c, itemId);
      await expectPgError(
        c,
        () => c.query(`UPDATE public.media SET alt_da = '' WHERE id = $1`, [mediaId]),
        "23514",
        "media_alt_da_check UPDATE blank",
        { messageIncludes: "media_alt_da_check" },
      );
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // AC-CAT-45: 23503 unknown category_id on items INSERT
  // --------------------------------------------------------------------------

  it("AC-CAT-45: 23503 when inserting an item with a non-existent category_id", async () => {
    await withTx(client, async (c) => {
      await expectPgError(
        c,
        () => c.query(
          `INSERT INTO public.items (category_id, status) VALUES ($1, 'draft')`,
          [BOGUS_UUID],
        ),
        "23503",
        "items unknown category_id",
      );
    });
  }, 12_000);

  it("AC-CAT-45: 23503 when deleting a category that still has items (on delete restrict)", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      const itemId = await seedItem(c, catId);
      await expectPgError(
        c,
        () => c.query("DELETE FROM public.categories WHERE id = $1", [catId]),
        "23503",
        "categories delete with items",
        { messageIncludes: "items_category_id_fkey" },
      );

      // The category and its item are both still there; without items the delete goes through.
      const { rows } = await c.query("SELECT id FROM public.items WHERE id = $1", [itemId]);
      expect(rows).toHaveLength(1);
      await c.query("DELETE FROM public.items WHERE id = $1", [itemId]);
      const deleted = await c.query("DELETE FROM public.categories WHERE id = $1", [catId]);
      expect(deleted.rowCount).toBe(1);
    });
  }, 12_000);
});
