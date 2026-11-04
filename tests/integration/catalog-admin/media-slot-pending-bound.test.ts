/**
 * Integration tests — unattached uploads per item are bounded (F2.3 catalog-admin, security
 * review Low F23-SEC-L1: orphan media could accumulate unbounded in the public media bucket)
 * Journey: catalog-admin
 *
 * admin_check_media_slot runs before a signed upload URL is issued. It used to count
 * public.media rows only, so uploads that were never attached piled up in the item's bucket
 * folder without limit. Migration 20261103000700 makes it raise P0001 too_many_media while the
 * folder holds PENDING_CEILING or more objects that no media row references. Attached objects
 * (bounded by the 8-image limit) and other items' folders do not count.
 *
 * Every case runs in withTx (rolled back). Seeds run as postgres before asRole.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, it } from "vitest";
import { MEDIA_MAX_PER_ITEM } from "@/config/catalog";
import { DB_AVAILABLE, getClient, type PoolClient } from "../rls/helpers/db.js";
import {
  ADMIN_CLAIMS,
  asRole,
  expectPgError,
  seedAdmin,
  seedCategory,
  seedItem,
  withTx,
} from "../rls/helpers/roles.js";

/** Unattached objects an item's folder may hold before the pre-check refuses (migration 20261103000700). */
const PENDING_CEILING = 16;

const CHECK_SLOT = "SELECT public.admin_check_media_slot($1)";

/** As postgres: `n` media-bucket objects in the item's folder that no media row references; returns their names. */
async function seedUnattached(c: PoolClient, itemId: string, n: number): Promise<string[]> {
  const { rows } = await c.query<{ name: string }>(
    `INSERT INTO storage.objects (bucket_id, name, metadata)
     SELECT 'media', 'items/' || $1::text || '/' || gen_random_uuid() || '.png', '{"size": 1024}'::jsonb
       FROM generate_series(1, $2::int)
     RETURNING name`,
    [itemId, n],
  );
  return rows.map((r) => r.name);
}

/** As postgres: `n` stored objects in the item's folder, each attached by a media row. */
async function seedAttached(c: PoolClient, itemId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const path = `items/${itemId}/${randomUUID()}.webp`;
    await c.query(`INSERT INTO storage.objects (bucket_id, name, metadata) VALUES ('media', $1, '{"size": 1024}'::jsonb)`, [
      path,
    ]);
    await c.query(
      `INSERT INTO public.media (item_id, storage_path, alt_da, width, height, mime_type)
       VALUES ($1, $2, 'Alt', 100, 100, 'image/webp')`,
      [itemId, path],
    );
  }
}

/** Asserts the pre-check refuses the item with P0001 too_many_media. */
async function expectSlotRefused(c: PoolClient, itemId: string, label: string): Promise<void> {
  await expectPgError(c, () => c.query(CHECK_SLOT, [itemId]), "P0001", label, { messageIncludes: "too_many_media" });
}

describe.skipIf(!DB_AVAILABLE)("F23-SEC-L1: admin_check_media_slot bounds unattached uploads per item", () => {
  let client: PoolClient;

  beforeAll(async () => {
    client = await getClient();
  });

  afterAll(() => {
    client.release();
  });

  it("F23-SEC-L1: admin_check_media_slot passes with 15 unattached objects in the item's folder and raises P0001 too_many_media at 16", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const categoryId = await seedCategory(c);
      const belowCeiling = await seedItem(c, categoryId);
      const atCeiling = await seedItem(c, categoryId);
      await seedUnattached(c, belowCeiling, PENDING_CEILING - 1);
      await seedUnattached(c, atCeiling, PENDING_CEILING);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      await c.query(CHECK_SLOT, [belowCeiling]); // 15 pending, no images: room for one more upload
      await expectSlotRefused(c, atCeiling, "16 unattached objects, no media rows");
    });
  }, 20_000);

  it("F23-SEC-L1: attached objects and other items' folders do not count against the unattached-object ceiling", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const categoryId = await seedCategory(c);
      const mixed = await seedItem(c, categoryId);
      const emptyFolder = await seedItem(c, categoryId);
      const full = await seedItem(c, categoryId);
      // 7 attached + 15 unattached objects: 22 in the folder, under both limits.
      await seedAttached(c, mixed, MEDIA_MAX_PER_ITEM - 1);
      await seedUnattached(c, mixed, PENDING_CEILING - 1);
      await seedUnattached(c, full, PENDING_CEILING);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      await c.query(CHECK_SLOT, [mixed]);
      await c.query(CHECK_SLOT, [emptyFolder]); // another item's full folder is not this item's
      await expectSlotRefused(c, full, "16 unattached objects");
    });
  }, 20_000);

  it("F23-SEC-L1: attaching one of 16 unattached objects brings the item back under the ceiling", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const itemId = await seedItem(c, await seedCategory(c));
      const [first] = await seedUnattached(c, itemId, PENDING_CEILING);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      await expectSlotRefused(c, itemId, "16 unattached objects before the attach");
      await c.query("SELECT public.admin_attach_media($1, $2, $3, $4, $5, $6)", [itemId, first, "Alt", "", 100, 100]);
      await c.query(CHECK_SLOT, [itemId]); // 15 unattached + 1 image
    });
  }, 20_000);
});
