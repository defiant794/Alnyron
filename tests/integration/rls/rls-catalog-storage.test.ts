/**
 * RLS integration tests — storage.objects bucket 'media' (F2.1 catalog-model)
 *
 * Covers:
 *   AC-CAT-53 — admin SELECT on storage.objects sees seeded rows
 *   AC-CAT-54 — anon and non-admin get 0 rows from storage.objects (bucket media)
 *   AC-CAT-55 — admin INSERT: valid items/{uuid}/{uuid}.ext path succeeds
 *   AC-CAT-56 — admin INSERT: invalid path (other/…, traversal, bad ext) → 42501
 *   AC-CAT-57 — non-admin INSERT → 42501
 *   AC-CAT-58 — admin DELETE removes row; non-admin DELETE affects 0 rows
 *   AC-CAT-59 — admin UPDATE: cannot rename name out of items/ → 42501
 *
 * Tests that insert storage.objects rows directly must supply `set local
 * storage.allow_delete_query = 'true'` before DELETE inside a tx to work around
 * the Supabase storage trigger that guards direct SQL deletes. RLS assertions
 * remain unchanged by this escape.
 *
 * Direct INSERT into storage.objects requires minimal columns. The minimal
 * set is (bucket_id, name); owner_id may be omitted.
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
  seedStorageObject,
  withTx,
} from "./helpers/roles.js";

const VALID_ITEM_UUID = "aaaabbbb-cccc-dddd-eeee-000000000010";
const VALID_FILE_UUID = "ffffffff-eeee-dddd-cccc-000000000010";
const VALID_PATH = `items/${VALID_ITEM_UUID}/${VALID_FILE_UUID}.webp`;

describe.skipIf(!DB_AVAILABLE)("RLS — storage.objects bucket 'media'", () => {
  let client: PoolClient;

  beforeAll(async () => {
    client = await getClient();
  });

  afterAll(async () => {
    client.release();
  });

  // --------------------------------------------------------------------------
  // AC-CAT-53: admin SELECT sees seeded rows
  // --------------------------------------------------------------------------

  it("AC-CAT-53: admin can SELECT storage.objects rows in bucket media", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const path = `items/${VALID_ITEM_UUID}/select-test-${Date.now()}.webp`;
      await seedStorageObject(c, path);

      await asRole(c, "authenticated", ADMIN_CLAIMS);

      const { rows } = await c.query<{ name: string }>(
        "SELECT name FROM storage.objects WHERE bucket_id = 'media' AND name = $1",
        [path],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.name).toBe(path);
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // AC-CAT-54: anon gets 0 rows
  // --------------------------------------------------------------------------

  it("AC-CAT-54: anon gets 0 rows from storage.objects for bucket media", async () => {
    await withTx(client, async (c) => {
      const path = `items/${VALID_ITEM_UUID}/anon-select-test-${Date.now()}.webp`;
      await seedStorageObject(c, path);

      await asRole(c, "anon", ANON_CLAIMS);

      const { rows } = await c.query(
        "SELECT name FROM storage.objects WHERE bucket_id = 'media' AND name = $1",
        [path],
      );
      expect(rows).toHaveLength(0);
    });
  }, 12_000);

  for (const fixture of NON_ADMIN_FIXTURES) {
    it(`AC-CAT-54: non-admin (${fixture.label}) gets 0 rows from storage.objects`, async () => {
      await withTx(client, async (c) => {
        const path = `items/${VALID_ITEM_UUID}/non-admin-select-${fixture.label.replace(/\s/g, "-")}-${Date.now()}.webp`;
        await seedStorageObject(c, path);
        await fixture.seed(c);
        await asRole(c, "authenticated", fixture.claims);

        const { rows } = await c.query(
          "SELECT name FROM storage.objects WHERE bucket_id = 'media' AND name = $1",
          [path],
        );
        expect(rows).toHaveLength(0);
      });
    }, 12_000);
  }

  // --------------------------------------------------------------------------
  // AC-CAT-55: admin INSERT with valid path succeeds
  // The insert policy allows the row, and RETURNING also needs the admin SELECT
  // policy (`media_objects_select`, F2.1 migration) on the returned row: without
  // it INSERT … RETURNING raises "new row violates row-level security policy".
  // --------------------------------------------------------------------------

  it("AC-CAT-55: admin can INSERT a storage.objects row with a valid items/{uuid}/{uuid}.webp path", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      const path = `items/${VALID_ITEM_UUID}/${VALID_FILE_UUID}.webp`;
      const { rows } = await c.query<{ name: string }>(
        "INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES ('media', $1, $2) RETURNING name",
        [path, ADMIN_UUID],
      );
      expect(rows[0]?.name).toBe(path);
    });
  }, 12_000);

  it("AC-CAT-55: admin can INSERT with .png extension", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      const fileId = "22222222-3333-4444-5555-666666666666";
      const path = `items/${VALID_ITEM_UUID}/${fileId}.png`;
      const { rows } = await c.query<{ name: string }>(
        "INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES ('media', $1, $2) RETURNING name",
        [path, ADMIN_UUID],
      );
      expect(rows[0]?.name).toBe(path);
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // AC-CAT-56: admin INSERT with invalid path → 42501
  // --------------------------------------------------------------------------

  it("AC-CAT-56: admin INSERT with path 'other/…' raises 42501 (RLS check)", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await expectPgError(
        c,
        () => c.query(
          "INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES ('media', $1, $2)",
          ["other/some/file.webp", ADMIN_UUID],
        ),
        "42501",
        "admin INSERT bad path other/",
      );
    });
  }, 12_000);

  it("AC-CAT-56: admin INSERT with path containing '..' raises 42501", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await expectPgError(
        c,
        () => c.query(
          "INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES ('media', $1, $2)",
          ["items/../secret.webp", ADMIN_UUID],
        ),
        "42501",
        "admin INSERT path traversal",
      );
    });
  }, 12_000);

  it("AC-CAT-56: admin INSERT with unsupported extension (.gif) raises 42501", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);
      const path = `items/${VALID_ITEM_UUID}/${VALID_FILE_UUID}.gif`;
      await expectPgError(
        c,
        () => c.query(
          "INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES ('media', $1, $2)",
          [path, ADMIN_UUID],
        ),
        "42501",
        "admin INSERT bad extension gif",
      );
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // AC-CAT-57: non-admin INSERT → 42501
  // --------------------------------------------------------------------------

  for (const fixture of NON_ADMIN_FIXTURES) {
    it(`AC-CAT-57: non-admin (${fixture.label}) INSERT into storage.objects raises 42501`, async () => {
      await withTx(client, async (c) => {
        await fixture.seed(c);
        await asRole(c, "authenticated", fixture.claims);
        const path = `items/${VALID_ITEM_UUID}/${VALID_FILE_UUID}.webp`;
        await expectPgError(
          c,
          () => c.query(
            "INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES ('media', $1, NULL)",
            [path],
          ),
          "42501",
          `non-admin INSERT storage ${fixture.label}`,
        );
      });
    }, 12_000);
  }

  // --------------------------------------------------------------------------
  // AC-CAT-58: admin DELETE removes row; non-admin DELETE affects 0 rows
  // --------------------------------------------------------------------------

  it("AC-CAT-58: admin DELETE removes exactly 1 storage.objects row", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const path = `items/${VALID_ITEM_UUID}/delete-admin-${Date.now()}.webp`;
      await seedStorageObject(c, path);

      await asRole(c, "authenticated", ADMIN_CLAIMS);
      // Allow direct SQL delete (Supabase storage trigger workaround)
      await c.query("SET LOCAL storage.allow_delete_query = 'true'");

      const { rowCount } = await c.query(
        "DELETE FROM storage.objects WHERE bucket_id = 'media' AND name = $1",
        [path],
      );
      expect(rowCount).toBe(1);
    });
  }, 12_000);

  for (const fixture of NON_ADMIN_FIXTURES) {
    it(`AC-CAT-58: non-admin (${fixture.label}) DELETE affects 0 rows in storage.objects`, async () => {
      await withTx(client, async (c) => {
        const path = `items/${VALID_ITEM_UUID}/delete-non-admin-${fixture.label.replace(/\s/g, "-")}-${Date.now()}.webp`;
        await seedStorageObject(c, path);
        await fixture.seed(c);
        await asRole(c, "authenticated", fixture.claims);
        await c.query("SET LOCAL storage.allow_delete_query = 'true'");

        const { rowCount } = await c.query(
          "DELETE FROM storage.objects WHERE bucket_id = 'media' AND name = $1",
          [path],
        );
        expect(rowCount).toBe(0);
      });
    }, 12_000);
  }

  // --------------------------------------------------------------------------
  // AC-CAT-59: admin UPDATE cannot rename name out of items/
  // --------------------------------------------------------------------------

  it("AC-CAT-59: admin UPDATE raises 42501 when renaming name outside items/ path", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      const path = `items/${VALID_ITEM_UUID}/rename-test-${Date.now()}.webp`;
      await seedStorageObject(c, path);

      await asRole(c, "authenticated", ADMIN_CLAIMS);
      await expectPgError(
        c,
        () => c.query(
          "UPDATE storage.objects SET name = 'public/renamed.webp' WHERE bucket_id = 'media' AND name = $1",
          [path],
        ),
        "42501",
        "admin UPDATE rename out of items/",
      );
    });
  }, 12_000);

  it("AC-CAT-59: admin UPDATE can modify metadata without renaming (no 42501)", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      // A valid media path: the update policy's WITH CHECK requires the (unchanged) name to
      // satisfy private.media_path_valid, so only a well-formed object can be updated.
      const path = VALID_PATH;
      await seedStorageObject(c, path);

      await asRole(c, "authenticated", ADMIN_CLAIMS);
      // Updating metadata (not name) succeeds and reaches the row (admin SELECT policy)
      const { rowCount } = await c.query(
        "UPDATE storage.objects SET metadata = '{\"size\": 2048}'::jsonb WHERE bucket_id = 'media' AND name = $1",
        [path],
      );
      expect(rowCount).toBe(1);
    });
  }, 12_000);
});
