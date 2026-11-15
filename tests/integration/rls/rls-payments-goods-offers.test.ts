/**
 * Integration tests: slice S2 DB — item_offers RLS/CHECKs, admin_save_item offers, reserved slug
 * Journey: payments-s2-3d-purchase
 * Criteria: S2-OFFER-1..11 (S2-T-RLS-OFFER-01..11)
 *
 * Coverage:
 *   - item_offers: anon sees only active+public offers; inactive/non-public → 0 rows
 *   - digital active → 23514 (item_offers_digital_not_live CHECK)
 *   - non-admin writes → 42501
 *   - admin_save_item with offers key: replace full set, offers:[] clears
 *   - admin_save_item error codes: offers_not_allowed, item_has_offers, offers_invalid
 *   - Existing admin_save_item behaviour on items without offers key unchanged (regression)
 *   - Reserved slug 'order' raises constraint violation
 *
 * Notes:
 *   - admin_save_item runs SECURITY INVOKER as the admin's authenticated session.
 *     Use asRole(c, 'authenticated', ADMIN_CLAIMS), never asServiceRole.
 *   - admin_save_item returns the item UUID directly (a string), not a JSON object.
 *   - node-postgres returns bigint columns as strings; compare price_ore as a string or cast.
 *   - UUID namespace for this file: 0520 (valid hex; "s2-offers").
 *   - Full item payloads are required for insert; for updates the minimum is {id, translations.da}.
 *
 * Run: npm run test:integration:e2e-project -- tests/integration/rls/rls-payments-goods-offers.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getClient, type PoolClient } from "./helpers/db.js";
import {
  asRole,
  expectPgError,
  seedAdmin,
  seedCategory,
  seedItem,
  seedRoute,
  withTx,
  ANON_CLAIMS,
  ADMIN_CLAIMS,
  NON_ADMIN_FIXTURES,
} from "./helpers/roles.js";

const SKIP = !process.env.SUPABASE_E2E_REF;

let client: PoolClient;
beforeAll(async () => { if (!SKIP) client = await getClient(); });
afterAll(() => client?.release());

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Seed a models3d category, returning its id. */
async function seedModels3dCategory(c: PoolClient): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO public.categories (kind, status) VALUES ('models3d', 'published') RETURNING id`,
  );
  return rows[0]!.id;
}

/**
 * Build the minimum full insert payload for admin_save_item on a models3d category.
 * All required keys present so the function doesn't raise 22023/23502 before the offers check.
 */
function insertPayload(categoryId: string, slugSuffix: string, offersKey?: unknown): Record<string, unknown> {
  const base: Record<string, unknown> = {
    category_id: categoryId,
    price_type: null,
    price_amount: null,
    external_links: {},
    translations: {
      da: {
        slug: `s2-rls-offer-${slugSuffix}`,
        title: `S2 Testfigur ${slugSuffix}`,
        summary: "",
        body_md: "",
        seo_title: "",
        seo_description: "",
      },
    },
  };
  if (offersKey !== undefined) base.offers = offersKey;
  return base;
}

/**
 * Build a minimum update payload: id + translations.da (required by the function).
 * Spread extra keys for the update case.
 */
function updatePayload(
  itemId: string,
  slugSuffix: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: itemId,
    translations: {
      da: {
        slug: `s2-rls-offer-${slugSuffix}`,
        title: `S2 Testfigur ${slugSuffix}`,
        summary: "",
        body_md: "",
        seo_title: "",
        seo_description: "",
      },
    },
    ...extra,
  };
}

/** Call admin_save_item as an authenticated admin. Returns the new/updated item UUID. */
async function saveItem(c: PoolClient, payload: Record<string, unknown>): Promise<string> {
  const { rows } = await c.query<{ admin_save_item: string }>(
    "SELECT public.admin_save_item($1::jsonb)",
    [JSON.stringify(payload)],
  );
  return rows[0]!.admin_save_item;
}

/** Insert an item_offer directly as postgres (bypasses RLS; use in fixtures). */
async function seedItemOffer(
  c: PoolClient,
  itemId: string,
  kind: "physical" | "digital",
  priceOre: number,
  active: boolean,
): Promise<void> {
  await c.query(
    `INSERT INTO public.item_offers (item_id, kind, price_ore, active) VALUES ($1, $2, $3, $4)`,
    [itemId, kind, priceOre, active],
  );
}

// ── S2-T-RLS-OFFER-01: admin_save_item — replace offer set ───────────────────

describe("S2-OFFER-1 (S2-T-RLS-OFFER-01): admin_save_item with offers on models3d item", () => {
  it.skipIf(SKIP)("inserts offer and returns item id without error", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const categoryId = await seedModels3dCategory(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      const itemId = await saveItem(c, insertPayload(categoryId, "off01", [
        { kind: "physical", price_ore: 24995, active: true },
      ]));
      expect(typeof itemId).toBe("string");

      // Verify the offer row (cast bigint to int for assertion)
      await c.query("RESET ROLE"); // read as postgres
      const { rows } = await c.query<{ kind: string; price_ore: string; active: boolean }>(
        `SELECT kind, price_ore::int AS price_ore, active FROM public.item_offers WHERE item_id = $1`,
        [itemId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ kind: "physical", price_ore: 24995, active: true });
    });
  });
});

// ── S2-T-RLS-OFFER-02: offers_not_allowed ────────────────────────────────────

describe("S2-OFFER-2 (S2-T-RLS-OFFER-02): admin_save_item — offers on non-models3d item → P0001 offers_not_allowed", () => {
  it.skipIf(SKIP)("raises P0001 offers_not_allowed when category.kind != models3d", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const categoryId = await seedCategory(c, { status: "published" }); // 'apps' kind
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      await expectPgError(
        c,
        () => saveItem(c, insertPayload(categoryId, "off02", [
          { kind: "physical", price_ore: 24995, active: true },
        ])),
        "P0001",
        "offers_not_allowed",
        { messageIncludes: "offers_not_allowed" },
      );
    });
  });
});

// ── S2-T-RLS-OFFER-03: item_has_offers ───────────────────────────────────────

describe("S2-OFFER-3 (S2-T-RLS-OFFER-03): admin_save_item — category change while offers exist → P0001 item_has_offers", () => {
  it.skipIf(SKIP)("raises P0001 item_has_offers when category changed away from models3d without clearing", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const models3dId = await seedModels3dCategory(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      // Insert item with a physical offer
      const itemId = await saveItem(c, insertPayload(models3dId, "off03", [
        { kind: "physical", price_ore: 24995, active: false },
      ]));

      // Insert a non-models3d category for the change
      await c.query("RESET ROLE");
      const appsId = await seedCategory(c, { status: "published" });
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      // Update category_id to apps — has offers, no offers:[] clear
      await expectPgError(
        c,
        () => saveItem(c, updatePayload(itemId, "off03", { category_id: appsId })),
        "P0001",
        "item_has_offers",
        { messageIncludes: "item_has_offers" },
      );
    });
  });
});

// ── S2-T-RLS-OFFER-04: offers_invalid ────────────────────────────────────────

describe("S2-OFFER-4 (S2-T-RLS-OFFER-04): admin_save_item — malformed offers → 22023 offers_invalid", () => {
  const cases = [
    { label: "not an array",           offers: { kind: "physical", price_ore: 24995, active: false } },
    { label: "duplicate kind",         offers: [{ kind: "physical", price_ore: 24995, active: false }, { kind: "physical", price_ore: 1000, active: false }] },
    { label: "unknown kind",           offers: [{ kind: "virtual", price_ore: 24995, active: false }] },
    { label: "price below min (249)",  offers: [{ kind: "physical", price_ore: 249, active: false }] },
    { label: "price above max",        offers: [{ kind: "physical", price_ore: 5000001, active: false }] },
    { label: "digital active in payload", offers: [{ kind: "digital", price_ore: 24995, active: true }] },
  ] as const;

  it.skipIf(SKIP).each(cases)("$label → 22023 offers_invalid", async ({ offers }) => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const categoryId = await seedModels3dCategory(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      await expectPgError(
        c,
        () => saveItem(c, insertPayload(categoryId, "off04", offers)),
        "22023",
        "offers_invalid",
        { messageIncludes: "offers_invalid" },
      );
    });
  });
});

// ── S2-T-RLS-OFFER-05: digital active → DB CHECK 23514 ──────────────────────

describe("S2-OFFER-5 (S2-T-RLS-OFFER-05): item_offers_digital_not_live CHECK — digital + active → 23514", () => {
  it.skipIf(SKIP)("raises 23514 on direct INSERT of digital offer with active=true", async () => {
    await withTx(client, async (c) => {
      const categoryId = await seedModels3dCategory(c);
      const itemId = await seedItem(c, categoryId, "published");

      await expectPgError(
        c,
        () => seedItemOffer(c, itemId, "digital", 24995, true),
        "23514",
        "item_offers_digital_not_live",
      );
    });
  });
});

// ── S2-T-RLS-OFFER-06, 07: RLS anon/authenticated visibility ─────────────────

describe("S2-OFFER-6 (S2-T-RLS-OFFER-06): item_offers RLS — anon visibility", () => {
  it.skipIf(SKIP)("active offer on a public models3d item is visible to anon", async () => {
    await withTx(client, async (c) => {
      const categoryId = await seedModels3dCategory(c);
      await c.query(
        `INSERT INTO public.category_translations (category_id, locale, title)
         VALUES ($1, 'da', '3D-figurer') ON CONFLICT DO NOTHING`,
        [categoryId],
      );
      await seedRoute(c, "da", "s2viscat", { categoryId });
      const itemId = await seedItem(c, categoryId, "published");
      await c.query(
        `INSERT INTO public.item_translations (item_id, locale, slug, title)
         VALUES ($1, 'da', 's2-vis-item', 'S2 Visibel') ON CONFLICT DO NOTHING`,
        [itemId],
      );
      await seedItemOffer(c, itemId, "physical", 24995, true);

      await asRole(c, "anon", ANON_CLAIMS);
      const { rows } = await c.query<{ price_ore: string }>(
        `SELECT price_ore::int AS price_ore FROM public.item_offers WHERE item_id = $1`,
        [itemId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.price_ore).toBe(24995);
    });
  });

  it.skipIf(SKIP)("inactive offer on a public item returns 0 rows to anon", async () => {
    await withTx(client, async (c) => {
      const categoryId = await seedModels3dCategory(c);
      const itemId = await seedItem(c, categoryId, "published");
      await c.query(
        `INSERT INTO public.item_translations (item_id, locale, slug, title)
         VALUES ($1, 'da', 's2-vis-inactive', 'S2 Inaktiv') ON CONFLICT DO NOTHING`,
        [itemId],
      );
      await seedItemOffer(c, itemId, "physical", 24995, false);

      await asRole(c, "anon", ANON_CLAIMS);
      const { rows } = await c.query(`SELECT price_ore FROM public.item_offers WHERE item_id = $1`, [itemId]);
      expect(rows).toHaveLength(0);
    });
  });

  it.skipIf(SKIP)("active offer on a draft (non-public) item returns 0 rows to anon", async () => {
    await withTx(client, async (c) => {
      const categoryId = await seedModels3dCategory(c);
      const itemId = await seedItem(c, categoryId, "draft"); // not published
      await seedItemOffer(c, itemId, "physical", 24995, true);

      await asRole(c, "anon", ANON_CLAIMS);
      const { rows } = await c.query(`SELECT price_ore FROM public.item_offers WHERE item_id = $1`, [itemId]);
      expect(rows).toHaveLength(0);
    });
  });
});

describe("S2-OFFER-6 (S2-T-RLS-OFFER-07): item_offers RLS — a non-admin authenticated user sees what anon sees", () => {
  it.skipIf(SKIP).each(NON_ADMIN_FIXTURES)(
    "non-admin ($label): the active offer of a public item only, not an inactive one or a draft item's",
    async ({ claims, seed }) => {
      await withTx(client, async (c) => {
        const categoryId = await seedModels3dCategory(c);
        await c.query(
          `INSERT INTO public.category_translations (category_id, locale, title)
           VALUES ($1, 'da', '3D-figurer') ON CONFLICT DO NOTHING`,
          [categoryId],
        );
        await seedRoute(c, "da", "s2vis7cat", { categoryId });
        const publicItem = await seedItem(c, categoryId, "published");
        const inactiveItem = await seedItem(c, categoryId, "published");
        const draftItem = await seedItem(c, categoryId, "draft");
        for (const [itemId, slug] of [
          [publicItem, "s2-vis7-public"],
          [inactiveItem, "s2-vis7-inactive"],
          [draftItem, "s2-vis7-draft"],
        ] as const) {
          await c.query(
            `INSERT INTO public.item_translations (item_id, locale, slug, title)
             VALUES ($1, 'da', $2, 'S2 Synlighed') ON CONFLICT DO NOTHING`,
            [itemId, slug],
          );
        }
        await seedItemOffer(c, publicItem, "physical", 24995, true);
        await seedItemOffer(c, inactiveItem, "physical", 24995, false);
        await seedItemOffer(c, draftItem, "physical", 24995, true);
        await seed(c);

        await asRole(c, "authenticated", claims);
        const { rows } = await c.query<{ item_id: string; price_ore: number }>(
          `SELECT item_id, price_ore::int AS price_ore FROM public.item_offers WHERE item_id = ANY($1::uuid[])`,
          [[publicItem, inactiveItem, draftItem]],
        );
        expect(rows).toEqual([{ item_id: publicItem, price_ore: 24995 }]);
      });
    },
  );
});

// ── S2-T-RLS-OFFER-08: anon/authenticated writes → 42501 ────────────────────

describe("S2-OFFER-7 (S2-T-RLS-OFFER-08): item_offers writes — non-admin → 42501", () => {
  it.skipIf(SKIP)("anon INSERT → 42501", async () => {
    await withTx(client, async (c) => {
      const categoryId = await seedModels3dCategory(c);
      const itemId = await seedItem(c, categoryId, "published");

      await asRole(c, "anon", ANON_CLAIMS);
      await expectPgError(
        c,
        () => c.query(
          `INSERT INTO public.item_offers (item_id, kind, price_ore, active) VALUES ($1, 'physical', 24995, false)`,
          [itemId],
        ),
        "42501",
        "anon INSERT item_offers",
      );
    });
  });

  it.skipIf(SKIP).each(NON_ADMIN_FIXTURES)("non-admin ($label) INSERT → 42501", async ({ claims, seed }) => {
    await withTx(client, async (c) => {
      const categoryId = await seedModels3dCategory(c);
      const itemId = await seedItem(c, categoryId, "published");
      await seed(c);

      await asRole(c, "authenticated", claims);
      await expectPgError(
        c,
        () => c.query(
          `INSERT INTO public.item_offers (item_id, kind, price_ore, active) VALUES ($1, 'physical', 24995, false)`,
          [itemId],
        ),
        "42501",
        `non-admin INSERT item_offers`,
      );
    });
  });
});

// ── S2-T-RLS-OFFER-09: existing admin_save_item behaviour unchanged (regression) ─

describe("S2-OFFER-8 (S2-T-RLS-OFFER-09): admin_save_item without offers key — existing behaviour unchanged", () => {
  it.skipIf(SKIP)("saving an apps-category item without offers key succeeds and no offers row appears", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const categoryId = await seedCategory(c, { status: "published" });
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      // No offers key in payload — must succeed using the full insert shape
      const itemId = await saveItem(c, {
        category_id: categoryId,
        price_type: null,
        price_amount: null,
        external_links: {},
        translations: {
          da: { slug: "s2-rls-offer-off09", title: "Regression Item", summary: "", body_md: "", seo_title: "", seo_description: "" },
        },
      });
      expect(typeof itemId).toBe("string");

      await c.query("RESET ROLE");
      const { rows } = await c.query(`SELECT kind FROM public.item_offers WHERE item_id = $1`, [itemId]);
      expect(rows).toHaveLength(0);
    });
  });
});

// ── S2-T-RLS-OFFER-10: offers:[] clears all offers ──────────────────────────

describe("S2-OFFER-9 (S2-T-RLS-OFFER-10): admin_save_item with offers:[] — clears existing offers", () => {
  it.skipIf(SKIP)("existing physical offer is deleted when offers:[] is passed", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const categoryId = await seedModels3dCategory(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      // Insert item with one offer
      const itemId = await saveItem(c, insertPayload(categoryId, "off10", [
        { kind: "physical", price_ore: 24995, active: false },
      ]));

      // Clear with offers:[]
      await saveItem(c, updatePayload(itemId, "off10", { offers: [] }));

      await c.query("RESET ROLE");
      const { rows } = await c.query(`SELECT kind FROM public.item_offers WHERE item_id = $1`, [itemId]);
      expect(rows).toHaveLength(0);
    });
  });
});

// ── S2-T-RLS-OFFER-11: reserved slug 'order' ────────────────────────────────

describe("S2-OFFER-10 (S2-T-RLS-OFFER-11): reserved slug 'order' — routes_slug_reserved prevents it", () => {
  it.skipIf(SKIP)("inserting a route with slug 'order' raises 23514 constraint error", async () => {
    await withTx(client, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO public.pages (status) VALUES ('draft') RETURNING id`,
      );
      const pageId = rows[0]!.id;

      await expectPgError(
        c,
        () => c.query(
          `INSERT INTO public.routes (locale, slug, page_id) VALUES ('da', 'order', $1)`,
          [pageId],
        ),
        "23514",
        "reserved slug 'order'",
      );
    });
  });
});
