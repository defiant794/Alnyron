/**
 * RLS + constraint integration tests — catalog hardening (F2.1 security review
 * f21-security-1, migrations 20261103000300_catalog_hardening.sql and
 * 20261103000400_catalog_updated_by_cascade.sql; code review 5,
 * 20261103000500_catalog_attach_dedupe.sql)
 *
 * Covers:
 *   AC-CAT-S01 — L1: an admin's direct media INSERT with a path outside items/{item}/{uuid}.{ext}
 *                → 23514 media_storage_path_valid; the four new media CHECKs are validated
 *   AC-CAT-S02 — L1: a path in another item's folder (INSERT, or an UPDATE re-pointing the row)
 *                → 23514 media_storage_path_valid
 *   AC-CAT-S03 — L1: mime_type other than the extension's type → 23514 media_mime_matches_path
 *   AC-CAT-S04 — L1: the 9th direct media INSERT (one by one or in one multi-row INSERT), or a
 *                move into a full item → P0001 too_many_media (media_limit_per_item trigger);
 *                a non-admin is still refused by RLS (42501)
 *   AC-CAT-S05 — L1: items/categories.updated_by is the writer's auth.uid() whatever the
 *                INSERT/UPDATE says (null without a user JWT); deleting an auth user still
 *                nulls it (the FK's set-null action is not re-stamped), whatever JWT the tx has;
 *                the catalog admin RPCs, which no longer write the column (R5-2), leave the
 *                caller's uid through the trigger
 *   AC-CAT-S06 — L2: admin_check_media_slot: 42501 anon / non-admin, P0002 item_not_found,
 *                P0001 too_many_media at 8, passes below
 *   AC-CAT-S07 — L2: admin_list_orphan_media: 42501 anon / non-admin; only old, unreferenced,
 *                valid-path objects, oldest first, at most 1000
 *   AC-CAT-S08 — L3: alt_da / alt_en over 300 → 23514 media_alt_da_length / media_alt_en_length
 *                (direct DML and both RPCs); 300 accepted
 *   AC-CAT-S09 — L3: admin_reorder_items over 1000 ids → 22023 too_many_items;
 *                admin_save_item over 8 media entries → P0001 too_many_media
 *   AC-CAT-S17 — R5-1: admin_attach_media of a path a row already holds → 23505
 *                media_storage_path_key before the 8-image trigger (P0001) or a CHECK (23514)
 *                can refuse it (full item, double-submitted 8th image); row and object stay
 *
 * Every case runs in withTx (rolled back). Seeds run as postgres before asRole.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ITEMS_REORDER_MAX, MEDIA_ALT_MAX, MEDIA_MAX_PER_ITEM } from "@/config/catalog";
import { DB_AVAILABLE, getClient, type PoolClient } from "./helpers/db.js";
import {
  ADMIN_CLAIMS,
  ADMIN_UUID,
  ANON_CLAIMS,
  NON_ADMIN_FIXTURES,
  NULL_ROLE_EMAIL,
  NULL_ROLE_UUID,
  asRole,
  expectPgError,
  seedAdmin,
  seedAuthUser,
  seedCategory,
  seedItem,
  seedMedia,
  seedStorageObject,
  withTx,
} from "./helpers/roles.js";

const BOGUS_UUID = "00000000-0000-0000-0000-999999999997";

/** A fresh object name in the item's folder (the only names media_storage_path_valid accepts). */
function pathIn(itemId: string, ext = "png"): string {
  return `items/${itemId}/${randomUUID()}.${ext}`;
}

/** A direct INSERT INTO public.media as the current role; returns the row id. */
async function insertMedia(
  c: PoolClient,
  row: { itemId: string; path: string; mime?: string; altDa?: string; altEn?: string },
): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO public.media (item_id, storage_path, alt_da, alt_en, width, height, mime_type)
     VALUES ($1, $2, $3, $4, 100, 100, $5)
     RETURNING id`,
    [row.itemId, row.path, row.altDa ?? "Alt", row.altEn ?? "", row.mime ?? "image/png"],
  );
  return rows[0]!.id;
}

/** Media rows of an item (as the current role). */
async function mediaCount(c: PoolClient, itemId: string): Promise<number> {
  const { rows } = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM public.media WHERE item_id = $1", [
    itemId,
  ]);
  return rows[0]!.n;
}

/** Seeds a media-bucket object as postgres, created `age` ago (an interval literal). */
async function seedAgedObject(c: PoolClient, path: string, age: string): Promise<string> {
  await c.query(
    `INSERT INTO storage.objects (bucket_id, name, metadata, created_at)
     VALUES ('media', $1, '{"size": 1024}'::jsonb, now() - $2::interval)`,
    [path, age],
  );
  return path;
}

const LIST_ORPHANS = "SELECT public.admin_list_orphan_media() AS paths";
const CHECK_SLOT = "SELECT public.admin_check_media_slot($1)";
const ATTACH_MEDIA = "SELECT public.admin_attach_media($1, $2, $3, $4, $5, $6) AS id";

/** How many media rows and media-bucket objects name `path` (as the current role). */
async function pathHolders(c: PoolClient, path: string): Promise<{ media: number; objects: number }> {
  const { rows } = await c.query<{ media: number; objects: number }>(
    `SELECT (SELECT count(*)::int FROM public.media WHERE storage_path = $1) AS media,
            (SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'media' AND name = $1) AS objects`,
    [path],
  );
  return rows[0]!;
}

describe.skipIf(!DB_AVAILABLE)("Catalog hardening — media rules, updated_by, slot/orphan RPCs, input bounds", () => {
  let client: PoolClient;

  beforeAll(async () => {
    client = await getClient();
  });

  afterAll(async () => {
    client.release();
  });

  // --------------------------------------------------------------------------
  // AC-CAT-S01 … AC-CAT-S03: media path and type CHECKs (L1)
  // --------------------------------------------------------------------------

  it("AC-CAT-S01: the media path / type / alt-length CHECKs exist and are validated", async () => {
    await withTx(client, async (c) => {
      const { rows } = await c.query<{ conname: string; convalidated: boolean; def: string }>(
        `SELECT conname, convalidated, pg_get_constraintdef(oid) AS def
           FROM pg_constraint
          WHERE conrelid = 'public.media'::regclass
            AND conname IN ('media_storage_path_valid', 'media_mime_matches_path', 'media_alt_da_length', 'media_alt_en_length')
          ORDER BY conname`,
      );
      expect(rows.map((r) => [r.conname, r.convalidated])).toEqual([
        ["media_alt_da_length", true],
        ["media_alt_en_length", true],
        ["media_mime_matches_path", true],
        ["media_storage_path_valid", true],
      ]);
      const defs = Object.fromEntries(rows.map((r) => [r.conname, r.def]));
      expect(defs.media_alt_da_length).toContain(`char_length(alt_da) <= ${MEDIA_ALT_MAX}`);
      expect(defs.media_alt_en_length).toContain(`char_length(alt_en) <= ${MEDIA_ALT_MAX}`);
      expect(defs.media_storage_path_valid).toContain("private.media_path_valid(storage_path)");
      expect(defs.media_storage_path_valid).toContain("split_part(storage_path, '/'::text, 2) = (item_id)::text");
      expect(defs.media_mime_matches_path).toContain("private.media_mime_type(storage_path)");
    });
  }, 12_000);

  it("AC-CAT-S01: an admin's direct media INSERT with a path outside items/{item}/{uuid}.{ext} raises 23514 media_storage_path_valid", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const itemId = await seedItem(c, await seedCategory(c));
      const file = randomUUID();
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      for (const path of [
        "../x.png",
        "https://evil.example/x.png",
        `other/${itemId}/${file}.png`,
        `items/${itemId}/../${file}.png`,
        `items/${itemId}/x.png`,
        `items/${itemId}/${file}.png?.png`,
        `/items/${itemId}/${file}.png`,
      ]) {
        await expectPgError(c, () => insertMedia(c, { itemId, path }), "23514", `path ${path}`, {
          messageIncludes: "media_storage_path_valid",
        });
      }
      expect(await mediaCount(c, itemId)).toBe(0);

      // The one accepted shape: a uuid file in the item's own folder.
      await insertMedia(c, { itemId, path: pathIn(itemId) });
      expect(await mediaCount(c, itemId)).toBe(1);
    });
  }, 12_000);

  it("AC-CAT-S02: a path in another item's folder raises 23514 media_storage_path_valid (INSERT and re-pointing UPDATE)", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catId = await seedCategory(c);
      const itemA = await seedItem(c, catId);
      const itemB = await seedItem(c, catId);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      await expectPgError(c, () => insertMedia(c, { itemId: itemA, path: pathIn(itemB) }), "23514", "insert into B's folder", {
        messageIncludes: "media_storage_path_valid",
      });

      const mediaId = await insertMedia(c, { itemId: itemA, path: pathIn(itemA) });
      await expectPgError(
        c,
        () => c.query("UPDATE public.media SET item_id = $2 WHERE id = $1", [mediaId, itemB]),
        "23514",
        "re-point row to B",
        { messageIncludes: "media_storage_path_valid" },
      );
      await expectPgError(
        c,
        () => c.query("UPDATE public.media SET storage_path = $2 WHERE id = $1", [mediaId, pathIn(itemB)]),
        "23514",
        "re-point path to B's folder",
        { messageIncludes: "media_storage_path_valid" },
      );
      const { rows } = await c.query<{ item_id: string }>("SELECT item_id FROM public.media WHERE id = $1", [mediaId]);
      expect(rows).toEqual([{ item_id: itemA }]);
    });
  }, 12_000);

  it("AC-CAT-S03: a mime_type other than the extension's type raises 23514 media_mime_matches_path; matching types insert", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const itemId = await seedItem(c, await seedCategory(c));
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      for (const [ext, mime] of [
        ["png", "image/webp"],
        ["webp", "image/png"],
        ["jpg", "image/png"],
        ["avif", "image/jpeg"],
      ] as const) {
        await expectPgError(c, () => insertMedia(c, { itemId, path: pathIn(itemId, ext), mime }), "23514", `${ext} as ${mime}`, {
          messageIncludes: "media_mime_matches_path",
        });
      }

      const ids: string[] = [];
      for (const [ext, mime] of [
        ["png", "image/png"],
        ["jpg", "image/jpeg"],
        ["jpeg", "image/jpeg"],
        ["webp", "image/webp"],
        ["avif", "image/avif"],
      ] as const) {
        ids.push(await insertMedia(c, { itemId, path: pathIn(itemId, ext), mime }));
      }
      expect(await mediaCount(c, itemId)).toBe(5);

      // An UPDATE cannot change the type away from the extension either (ids[0] is the .png row).
      await expectPgError(
        c,
        () => c.query("UPDATE public.media SET mime_type = 'image/avif' WHERE id = $1", [ids[0]]),
        "23514",
        "update mime_type",
        { messageIncludes: "media_mime_matches_path" },
      );
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // AC-CAT-S04: 8-image limit on every insert (L1)
  // --------------------------------------------------------------------------

  it("AC-CAT-S04: an admin's 9th direct media INSERT raises P0001 too_many_media", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const itemId = await seedItem(c, await seedCategory(c));
      for (let i = 0; i < MEDIA_MAX_PER_ITEM - 1; i++) await seedMedia(c, itemId);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      await insertMedia(c, { itemId, path: pathIn(itemId) }); // the 8th
      await expectPgError(c, () => insertMedia(c, { itemId, path: pathIn(itemId) }), "P0001", "9th direct insert", {
        messageIncludes: "too_many_media",
      });
      expect(await mediaCount(c, itemId)).toBe(MEDIA_MAX_PER_ITEM);

      // Editing a row of the full item (no move) is not an insert and passes.
      await c.query("UPDATE public.media SET alt_da = 'Ny alt' WHERE item_id = $1", [itemId]);
    });
  }, 12_000);

  it("AC-CAT-S04: one multi-row INSERT of 9 media rows for an item raises P0001 too_many_media (bulk insert)", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const itemId = await seedItem(c, await seedCategory(c));
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      // The PostgREST array-body form: each row's BEFORE trigger sees the rows inserted before it.
      const nineRows = `INSERT INTO public.media (item_id, storage_path, alt_da, width, height, mime_type)
         SELECT $1::uuid, 'items/' || $1::uuid || '/' || gen_random_uuid() || '.png', 'Alt', 100, 100, 'image/png'
           FROM generate_series(1, $2::int)`;
      await expectPgError(c, () => c.query(nineRows, [itemId, MEDIA_MAX_PER_ITEM + 1]), "P0001", "9-row insert", {
        messageIncludes: "too_many_media",
      });
      expect(await mediaCount(c, itemId)).toBe(0);

      await c.query(nineRows, [itemId, MEDIA_MAX_PER_ITEM]);
      expect(await mediaCount(c, itemId)).toBe(MEDIA_MAX_PER_ITEM);
    });
  }, 12_000);

  it("AC-CAT-S04: moving a media row into a full item raises P0001 too_many_media; into a free item it moves", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catId = await seedCategory(c);
      const full = await seedItem(c, catId);
      const free = await seedItem(c, catId);
      const source = await seedItem(c, catId);
      for (let i = 0; i < MEDIA_MAX_PER_ITEM; i++) await seedMedia(c, full);
      const mediaId = await seedMedia(c, source);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      await expectPgError(
        c,
        () => c.query("UPDATE public.media SET item_id = $2, storage_path = $3 WHERE id = $1", [mediaId, full, pathIn(full, "webp")]),
        "P0001",
        "move into full item",
        { messageIncludes: "too_many_media" },
      );
      expect(await mediaCount(c, full)).toBe(MEDIA_MAX_PER_ITEM);

      await c.query("UPDATE public.media SET item_id = $2, storage_path = $3 WHERE id = $1", [mediaId, free, pathIn(free, "webp")]);
      expect(await mediaCount(c, free)).toBe(1);
      expect(await mediaCount(c, source)).toBe(0);
    });
  }, 12_000);

  for (const fixture of NON_ADMIN_FIXTURES) {
    it(`AC-CAT-S04: a non-admin (${fixture.label}) INSERT into a full public item is refused by RLS (42501), not counted`, async () => {
      await withTx(client, async (c) => {
        const itemId = await seedItem(c, await seedCategory(c), "published");
        for (let i = 0; i < MEDIA_MAX_PER_ITEM; i++) await seedMedia(c, itemId);
        await fixture.seed(c);
        await asRole(c, "authenticated", fixture.claims);

        // The full item's 8 rows are public; the insert still fails on the media RLS policy.
        expect(await mediaCount(c, itemId)).toBe(MEDIA_MAX_PER_ITEM);
        await expectPgError(c, () => insertMedia(c, { itemId, path: pathIn(itemId) }), "42501", `non-admin ${fixture.label}`, {
          messageIncludes: "row-level security",
        });
      });
    }, 12_000);
  }

  // --------------------------------------------------------------------------
  // AC-CAT-S05: updated_by is stamped by trigger (L1)
  // --------------------------------------------------------------------------

  it("AC-CAT-S05: an admin's direct INSERT/UPDATE cannot spoof items/categories.updated_by", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      // Another real user, so a spoofed value would pass the foreign key if it were kept.
      await seedAuthUser(c, NULL_ROLE_UUID, NULL_ROLE_EMAIL);
      const seededCat = await seedCategory(c);
      const seededItem = await seedItem(c, seededCat);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      const insertedCat = await c.query<{ id: string; updated_by: string | null }>(
        "INSERT INTO public.categories (kind, status, updated_by) VALUES ('apps', 'draft', $1) RETURNING id, updated_by",
        [NULL_ROLE_UUID],
      );
      expect(insertedCat.rows[0]!.updated_by).toBe(ADMIN_UUID);

      const insertedItem = await c.query<{ updated_by: string | null }>(
        "INSERT INTO public.items (category_id, status, updated_by) VALUES ($1, 'draft', $2) RETURNING updated_by",
        [insertedCat.rows[0]!.id, NULL_ROLE_UUID],
      );
      expect(insertedItem.rows).toEqual([{ updated_by: ADMIN_UUID }]);

      for (const spoof of [NULL_ROLE_UUID, null]) {
        const item = await c.query<{ updated_by: string | null }>(
          "UPDATE public.items SET updated_by = $2 WHERE id = $1 RETURNING updated_by",
          [seededItem, spoof],
        );
        expect(item.rows).toEqual([{ updated_by: ADMIN_UUID }]);
        const category = await c.query<{ updated_by: string | null }>(
          "UPDATE public.categories SET updated_by = $2 WHERE id = $1 RETURNING updated_by",
          [seededCat, spoof],
        );
        expect(category.rows).toEqual([{ updated_by: ADMIN_UUID }]);
      }

      // Any other column change is stamped too.
      const featured = await c.query<{ updated_by: string | null }>(
        "UPDATE public.items SET featured = true WHERE id = $1 RETURNING updated_by",
        [seededItem],
      );
      expect(featured.rows).toEqual([{ updated_by: ADMIN_UUID }]);
    });
  }, 12_000);

  it("AC-CAT-S05: a writer without a user JWT (postgres) gets updated_by = null whatever it sends", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const { rows: cat } = await c.query<{ id: string; updated_by: string | null }>(
        "INSERT INTO public.categories (kind, status, updated_by) VALUES ('apps', 'draft', $1) RETURNING id, updated_by",
        [ADMIN_UUID],
      );
      expect(cat[0]!.updated_by).toBeNull();
      const { rows: item } = await c.query<{ updated_by: string | null }>(
        "INSERT INTO public.items (category_id, status, updated_by) VALUES ($1, 'draft', $2) RETURNING updated_by",
        [cat[0]!.id, ADMIN_UUID],
      );
      expect(item).toEqual([{ updated_by: null }]);
    });
  }, 12_000);

  it("AC-CAT-S05: deleting an auth user nulls its updated_by even in a transaction carrying a user JWT", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      await seedAuthUser(c, NULL_ROLE_UUID, NULL_ROLE_EMAIL);
      const byAdmin = await seedCategory(c);
      const itemByAdmin = await seedItem(c, byAdmin);
      const byOther = await seedCategory(c);
      const updatedBy = async (table: "categories" | "items", id: string) =>
        (await c.query<{ updated_by: string | null }>(`SELECT updated_by FROM public.${table} WHERE id = $1`, [id])).rows[0]!
          .updated_by;

      // JWT claims set while the role stays postgres (who may delete auth.users).
      await c.query(`SET LOCAL "request.jwt.claims" = '${JSON.stringify({ sub: ADMIN_UUID, role: "authenticated" })}'`);
      await c.query("UPDATE public.categories SET featured = true WHERE id = $1", [byAdmin]);
      await c.query("UPDATE public.items SET featured = true WHERE id = $1", [itemByAdmin]);
      await c.query(`SET LOCAL "request.jwt.claims" = '${JSON.stringify({ sub: NULL_ROLE_UUID, role: "authenticated" })}'`);
      await c.query("UPDATE public.categories SET featured = true WHERE id = $1", [byOther]);
      expect([await updatedBy("categories", byAdmin), await updatedBy("items", itemByAdmin)]).toEqual([ADMIN_UUID, ADMIN_UUID]);
      expect(await updatedBy("categories", byOther)).toBe(NULL_ROLE_UUID);

      // Another user's JWT: the set-null action keeps null instead of stamping that user.
      await c.query("DELETE FROM auth.users WHERE id = $1", [ADMIN_UUID]);
      expect([await updatedBy("categories", byAdmin), await updatedBy("items", itemByAdmin)]).toEqual([null, null]);

      // The deleted user's own JWT: the delete is not blocked by its own uid (23503).
      const deleted = await c.query("DELETE FROM auth.users WHERE id = $1", [NULL_ROLE_UUID]);
      expect(deleted.rowCount).toBe(1);
      expect(await updatedBy("categories", byOther)).toBeNull();
    });
  }, 12_000);

  it("AC-CAT-S05: the catalog admin RPCs leave updated_by = the caller's uid through the trigger alone", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      // Seeded as postgres (no user JWT), so every row starts with updated_by = null.
      const catId = await seedCategory(c);
      const statusCat = await seedCategory(c);
      const savedItem = await seedItem(c, catId);
      const statusItem = await seedItem(c, catId);
      const reordered = await seedItem(c, catId);
      const updatedBy = async (table: "categories" | "items", ids: string[]) =>
        (
          await c.query<{ updated_by: string | null }>(`SELECT updated_by FROM public.${table} WHERE id = ANY($1::uuid[])`, [
            ids,
          ])
        ).rows.map((r) => r.updated_by);
      expect(await updatedBy("categories", [catId, statusCat])).toEqual([null, null]);
      expect(await updatedBy("items", [savedItem, statusItem, reordered])).toEqual([null, null, null]);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      const saved = async (rpc: "admin_save_category" | "admin_save_item", payload: Record<string, unknown>) =>
        (await c.query<{ id: string }>(`SELECT public.${rpc}($1::jsonb) AS id`, [JSON.stringify(payload)])).rows[0]!.id;
      const newCat = await saved("admin_save_category", { kind: "apps" });
      await saved("admin_save_category", { id: catId, nav_order: 5 });
      const newItem = await saved("admin_save_item", { category_id: catId });
      await saved("admin_save_item", { id: savedItem, featured: true });
      await c.query("SELECT public.admin_set_category_status($1, 'draft'::public.content_status)", [statusCat]);
      await c.query("SELECT public.admin_set_item_status($1, 'draft'::public.content_status)", [statusItem]);
      await c.query("SELECT public.admin_reorder_items($1, $2::uuid[])", [catId, `{${reordered}}`]);

      expect(await updatedBy("categories", [newCat, catId, statusCat])).toEqual([ADMIN_UUID, ADMIN_UUID, ADMIN_UUID]);
      expect(await updatedBy("items", [newItem, savedItem, statusItem, reordered])).toEqual([
        ADMIN_UUID,
        ADMIN_UUID,
        ADMIN_UUID,
        ADMIN_UUID,
      ]);
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // AC-CAT-S06: admin_check_media_slot (L2)
  // --------------------------------------------------------------------------

  it("AC-CAT-S06: anon cannot call admin_check_media_slot (42501)", async () => {
    await withTx(client, async (c) => {
      await asRole(c, "anon", ANON_CLAIMS);
      // Refused by the missing EXECUTE grant, before the function body runs.
      await expectPgError(c, () => c.query(CHECK_SLOT, [BOGUS_UUID]), "42501", "admin_check_media_slot anon", {
        messageIncludes: "permission denied for function admin_check_media_slot",
      });
    });
  }, 12_000);

  for (const fixture of NON_ADMIN_FIXTURES) {
    it(`AC-CAT-S06: admin_check_media_slot raises 42501 forbidden for a non-admin (${fixture.label})`, async () => {
      await withTx(client, async (c) => {
        const itemId = await seedItem(c, await seedCategory(c), "published");
        await fixture.seed(c);
        await asRole(c, "authenticated", fixture.claims);
        await expectPgError(c, () => c.query(CHECK_SLOT, [itemId]), "42501", `admin_check_media_slot ${fixture.label}`, {
          messageIncludes: "forbidden",
        });
      });
    }, 12_000);
  }

  it("AC-CAT-S06: admin_check_media_slot raises P0002 item_not_found for an unknown item", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await expectPgError(c, () => c.query(CHECK_SLOT, [BOGUS_UUID]), "P0002", "admin_check_media_slot unknown", {
        messageIncludes: "item_not_found",
      });
    });
  }, 12_000);

  it("AC-CAT-S06: admin_check_media_slot passes below 8 images and raises P0001 too_many_media at 8", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const itemId = await seedItem(c, await seedCategory(c));
      for (let i = 0; i < MEDIA_MAX_PER_ITEM - 1; i++) await seedMedia(c, itemId);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      await c.query(CHECK_SLOT, [itemId]); // 7 images: room for one more
      await insertMedia(c, { itemId, path: pathIn(itemId) });
      await expectPgError(c, () => c.query(CHECK_SLOT, [itemId]), "P0001", "admin_check_media_slot full", {
        messageIncludes: "too_many_media",
      });
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // AC-CAT-S07: admin_list_orphan_media (L2)
  // --------------------------------------------------------------------------

  it("AC-CAT-S07: anon cannot call admin_list_orphan_media (42501)", async () => {
    await withTx(client, async (c) => {
      await asRole(c, "anon", ANON_CLAIMS);
      // Refused by the missing EXECUTE grant, before the function body runs.
      await expectPgError(c, () => c.query(LIST_ORPHANS), "42501", "admin_list_orphan_media anon", {
        messageIncludes: "permission denied for function admin_list_orphan_media",
      });
    });
  }, 12_000);

  for (const fixture of NON_ADMIN_FIXTURES) {
    it(`AC-CAT-S07: admin_list_orphan_media raises 42501 forbidden for a non-admin (${fixture.label})`, async () => {
      await withTx(client, async (c) => {
        await fixture.seed(c);
        await asRole(c, "authenticated", fixture.claims);
        await expectPgError(c, () => c.query(LIST_ORPHANS), "42501", `admin_list_orphan_media ${fixture.label}`, {
          messageIncludes: "forbidden",
        });
      });
    }, 12_000);
  }

  it("AC-CAT-S07: admin_list_orphan_media lists only old, unreferenced, valid-path objects, oldest first", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const itemId = await seedItem(c, await seedCategory(c));
      const olderOrphan = await seedAgedObject(c, pathIn(itemId, "webp"), "3 days");
      const oldOrphan = await seedAgedObject(c, pathIn(itemId, "jpg"), "2 days");
      const youngOrphan = await seedAgedObject(c, pathIn(itemId), "1 hour");
      const referenced = await seedAgedObject(c, pathIn(itemId), "4 days");
      await c.query(
        `INSERT INTO public.media (item_id, storage_path, alt_da, width, height, mime_type)
         VALUES ($1, $2, 'Alt', 100, 100, 'image/png')`,
        [itemId, referenced],
      );
      // Not an upload name (postgres bypasses the bucket's insert policy).
      const invalidName = await seedAgedObject(c, `other/${randomUUID()}.png`, "5 days");
      const ours = new Set([olderOrphan, oldOrphan, youngOrphan, referenced, invalidName]);

      await asRole(c, "authenticated", ADMIN_CLAIMS);
      const byDefault = await c.query<{ paths: string[] }>(LIST_ORPHANS);
      expect(byDefault.rows[0]!.paths.filter((p) => ours.has(p))).toEqual([olderOrphan, oldOrphan]);

      const withinAnHour = await c.query<{ paths: string[] }>(
        "SELECT public.admin_list_orphan_media($1::interval) AS paths",
        ["30 minutes"],
      );
      expect(withinAnHour.rows[0]!.paths.filter((p) => ours.has(p))).toEqual([olderOrphan, oldOrphan, youngOrphan]);
    });
  }, 12_000);

  it("AC-CAT-S07: admin_list_orphan_media returns at most 1000 names", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const itemId = await seedItem(c, await seedCategory(c));
      await c.query(
        `INSERT INTO storage.objects (bucket_id, name, metadata, created_at)
         SELECT 'media', 'items/' || $1::text || '/' || gen_random_uuid() || '.png', '{"size": 1}'::jsonb, now() - interval '2 days'
           FROM generate_series(1, 1001)`,
        [itemId],
      );
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      const { rows } = await c.query<{ n: number }>("SELECT cardinality(public.admin_list_orphan_media()) AS n");
      expect(rows[0]!.n).toBe(1000);
    });
  }, 20_000);

  // --------------------------------------------------------------------------
  // AC-CAT-S08: alt text length (L3)
  // --------------------------------------------------------------------------

  it("AC-CAT-S08: a direct media INSERT with alt_da / alt_en over 300 raises 23514 media_alt_*_length; 300 inserts", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const itemId = await seedItem(c, await seedCategory(c));
      const over = "a".repeat(MEDIA_ALT_MAX + 1);
      const atMax = "a".repeat(MEDIA_ALT_MAX);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      await expectPgError(c, () => insertMedia(c, { itemId, path: pathIn(itemId), altDa: over }), "23514", "alt_da 301", {
        messageIncludes: "media_alt_da_length",
      });
      await expectPgError(c, () => insertMedia(c, { itemId, path: pathIn(itemId), altEn: over }), "23514", "alt_en 301", {
        messageIncludes: "media_alt_en_length",
      });
      const mediaId = await insertMedia(c, { itemId, path: pathIn(itemId), altDa: atMax, altEn: atMax });
      await expectPgError(
        c,
        () => c.query("UPDATE public.media SET alt_en = $2 WHERE id = $1", [mediaId, over]),
        "23514",
        "update alt_en 301",
        { messageIncludes: "media_alt_en_length" },
      );
    });
  }, 12_000);

  it("AC-CAT-S08: admin_attach_media and admin_save_item with an alt text over 300 raise 23514 media_alt_*_length", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const itemId = await seedItem(c, await seedCategory(c));
      const path = await seedStorageObject(c, pathIn(itemId, "webp"));
      const mediaId = await seedMedia(c, itemId);
      const over = "a".repeat(MEDIA_ALT_MAX + 1);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      await expectPgError(
        c,
        () => c.query("SELECT public.admin_attach_media($1, $2, $3, $4, $5, $6)", [itemId, path, over, "", 100, 100]),
        "23514",
        "attach alt_da 301",
        { messageIncludes: "media_alt_da_length" },
      );
      await expectPgError(
        c,
        () =>
          c.query("SELECT public.admin_save_item($1::jsonb)", [
            JSON.stringify({ id: itemId, media: [{ id: mediaId, alt_da: "Alt", alt_en: over, sort_order: 10 }] }),
          ]),
        "23514",
        "save_item alt_en 301",
        { messageIncludes: "media_alt_en_length" },
      );
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // AC-CAT-S09: RPC array bounds (L3)
  // --------------------------------------------------------------------------

  it("AC-CAT-S09: admin_reorder_items raises 22023 too_many_items above 1000 ids; 1000 ids run", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const catId = await seedCategory(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      // $2 random ids: none is an item of the category, so a run that passes the bound updates nothing.
      const reorderRandomIds =
        "SELECT public.admin_reorder_items($1, ARRAY(SELECT gen_random_uuid() FROM generate_series(1, $2::int)))";
      await expectPgError(c, () => c.query(reorderRandomIds, [catId, ITEMS_REORDER_MAX + 1]), "22023", "reorder 1001", {
        messageIncludes: "too_many_items",
      });
      await c.query(reorderRandomIds, [catId, ITEMS_REORDER_MAX]);
    });
  }, 12_000);

  it("AC-CAT-S09: admin_save_item raises P0001 too_many_media for more than 8 media entries, before writing anything", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const itemId = await seedItem(c, await seedCategory(c));
      const mediaIds: string[] = [];
      for (let i = 0; i < MEDIA_MAX_PER_ITEM; i++) mediaIds.push(await seedMedia(c, itemId));
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      const entry = (id: string) => ({ id, alt_da: "Ny alt", alt_en: "", sort_order: 10 });
      // Nine entries, all naming the item's own rows (one twice): the bound alone refuses it.
      const nine = [...mediaIds, mediaIds[0]!].map(entry);
      await expectPgError(
        c,
        () => c.query("SELECT public.admin_save_item($1::jsonb)", [JSON.stringify({ id: itemId, featured: true, media: nine })]),
        "P0001",
        "save_item 9 media",
        { messageIncludes: "too_many_media" },
      );

      // Eight entries go through.
      await c.query("SELECT public.admin_save_item($1::jsonb)", [JSON.stringify({ id: itemId, media: mediaIds.map(entry) })]);
      const { rows } = await c.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM public.media WHERE item_id = $1 AND alt_da = 'Ny alt'",
        [itemId],
      );
      expect(rows[0]!.n).toBe(MEDIA_MAX_PER_ITEM);
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // AC-CAT-S17: an attached path is a duplicate before any refusal (R5-1)
  // --------------------------------------------------------------------------

  it("AC-CAT-S17: re-attaching one of a full item's own paths raises 23505 media_storage_path_key, not P0001; row and object stay", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const itemId = await seedItem(c, await seedCategory(c));
      const paths: string[] = [];
      for (let i = 0; i < MEDIA_MAX_PER_ITEM; i++) paths.push(await seedStorageObject(c, pathIn(itemId, "webp")));
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      const ids: string[] = [];
      for (const path of paths) ids.push((await c.query<{ id: string }>(ATTACH_MEDIA, [itemId, path, "Alt", "", 100, 100])).rows[0]!.id);
      const eighth = paths[MEDIA_MAX_PER_ITEM - 1]!;

      // The double-submitted 8th image: the item is full, yet the path is reported as attached.
      await expectPgError(c, () => c.query(ATTACH_MEDIA, [itemId, eighth, "Alt", "", 100, 100]), "23505", "re-attach 8th", {
        messageIncludes: "media_storage_path_key",
      });

      expect(await mediaCount(c, itemId)).toBe(MEDIA_MAX_PER_ITEM);
      const { rows } = await c.query<{ id: string }>("SELECT id FROM public.media WHERE storage_path = $1", [eighth]);
      expect(rows).toEqual([{ id: ids[MEDIA_MAX_PER_ITEM - 1] }]);
      expect(await pathHolders(c, eighth)).toEqual({ media: 1, objects: 1 });
    });
  }, 12_000);

  it("AC-CAT-S17: attaching one path twice to an item with 7 images raises 23505 media_storage_path_key the second time, not P0001 or 23514", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const itemId = await seedItem(c, await seedCategory(c));
      for (let i = 0; i < MEDIA_MAX_PER_ITEM - 1; i++) await seedMedia(c, itemId);
      const path = await seedStorageObject(c, pathIn(itemId, "webp"));
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      const first = (await c.query<{ id: string }>(ATTACH_MEDIA, [itemId, path, "Alt", "", 100, 100])).rows[0]!.id;
      expect(await mediaCount(c, itemId)).toBe(MEDIA_MAX_PER_ITEM);

      await expectPgError(c, () => c.query(ATTACH_MEDIA, [itemId, path, "Alt", "", 100, 100]), "23505", "second attach", {
        messageIncludes: "media_storage_path_key",
      });
      // An alt text a CHECK refuses (23514) does not hide the duplicate either.
      await expectPgError(
        c,
        () => c.query(ATTACH_MEDIA, [itemId, path, "a".repeat(MEDIA_ALT_MAX + 1), "", 100, 100]),
        "23505",
        "second attach, alt over the limit",
        { messageIncludes: "media_storage_path_key" },
      );

      const { rows } = await c.query<{ id: string }>("SELECT id FROM public.media WHERE storage_path = $1", [path]);
      expect(rows).toEqual([{ id: first }]);
      expect(await pathHolders(c, path)).toEqual({ media: 1, objects: 1 });
    });
  }, 12_000);
});
