/**
 * Integration tests — a taken item slug names its language (F2.3 catalog-admin, code review 2)
 * Journey: catalog-admin  AC-CATADM-24
 *
 * admin_save_item is SECURITY INVOKER, so it runs as `authenticated` on the RLS-enabled
 * item_translations table, and Postgres then leaves the unique violation's
 * "Key (locale, slug)=(...)" DETAIL out. Migration 20261103000600 re-raises a clash on
 * item_translations_locale_slug_key as 23505 `slug_taken` with the locale as HINT. These tests
 * call the real RPC as an authenticated admin (every transaction rolled back) and feed its real
 * error, in PostgREST's shape, through `saveItem`, which must name the clashing locale so the
 * item editor marks that language's URL-slug.
 *
 * Mocks: @/lib/supabase/server (createServerClient → an `rpc` that runs the RPC over the test's
 * pg connection inside a savepoint, the way PostgREST runs each call in its own transaction).
 */

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DB_AVAILABLE, getClient, type PoolClient } from "../rls/helpers/db.js";
import {
  ADMIN_CLAIMS,
  asRole,
  seedAdmin,
  seedCategory,
  seedItem,
  seedItemTranslation,
  withTx,
} from "../rls/helpers/roles.js";

// ── Mocks ──────────────────────────────────────────────────────────────────────

const db = vi.hoisted(() => ({ client: undefined as PoolClient | undefined }));

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: async () => ({
    rpc: async (fn: string, args: { payload: unknown }) => {
      const c = db.client;
      if (!c || fn !== "admin_save_item") throw new Error(`unexpected rpc ${fn}`);
      await c.query("SAVEPOINT rpc_call");
      try {
        const { rows } = await c.query<{ id: string }>("SELECT public.admin_save_item($1::jsonb) AS id", [
          JSON.stringify(args.payload),
        ]);
        await c.query("RELEASE SAVEPOINT rpc_call");
        return { data: rows[0]!.id, error: null };
      } catch (error) {
        await c.query("ROLLBACK TO SAVEPOINT rpc_call");
        await c.query("RELEASE SAVEPOINT rpc_call");
        if (!(error instanceof pg.DatabaseError)) throw error;
        // PostgREST passes the Postgres error fields through, null when absent.
        return {
          data: null,
          error: { code: error.code ?? "", message: error.message, details: error.detail ?? null, hint: error.hint ?? null },
        };
      }
    },
  }),
}));

// ── Module under test ─────────────────────────────────────────────────────────

import { saveItem } from "@/services/admin/catalog";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const OWNER_DA = "slug-hint-owner";
const OWNER_EN = "slug-hint-owner-en";

/** A complete item translation (every column admin_save_item writes) under `slug`. */
function translation(slug: string, title = "Element") {
  return { slug, title, summary: "", body_md: "", seo_title: "", seo_description: "" };
}

/** A new-item save in `categoryId` with the given DA and EN slugs (the item editor's payload shape). */
function newItem(categoryId: string, daSlug: string, enSlug: string) {
  return {
    category_id: categoryId,
    price_type: null,
    price_amount: null,
    external_links: {},
    translations: { da: translation(daSlug), en: translation(enSlug, "Item") },
  };
}

/**
 * As postgres: the admin, a category and an item that owns OWNER_DA / OWNER_EN (plus
 * `extraItem` slugs when given); then acts as the authenticated admin.
 */
async function arrange(c: PoolClient, extraItem?: { da: string; en: string }) {
  await seedAdmin(c);
  const categoryId = await seedCategory(c);
  const ownerId = await seedItem(c, categoryId);
  await seedItemTranslation(c, ownerId, "da", OWNER_DA);
  await seedItemTranslation(c, ownerId, "en", OWNER_EN);
  let extraId: string | undefined;
  if (extraItem) {
    extraId = await seedItem(c, categoryId);
    await seedItemTranslation(c, extraId, "da", extraItem.da);
    await seedItemTranslation(c, extraId, "en", extraItem.en);
  }
  await asRole(c, "authenticated", ADMIN_CLAIMS);
  return { categoryId, extraId };
}

/** Calls admin_save_item expecting it to fail; returns the error (the transaction stays usable). */
async function saveItemError(c: PoolClient, payload: Record<string, unknown>): Promise<pg.DatabaseError> {
  await c.query("SAVEPOINT expect_error");
  try {
    await c.query("SELECT public.admin_save_item($1::jsonb)", [JSON.stringify(payload)]);
  } catch (error) {
    await c.query("ROLLBACK TO SAVEPOINT expect_error");
    if (error instanceof pg.DatabaseError) return error;
    throw error;
  }
  throw new Error("admin_save_item saved, expected a slug clash");
}

describe.skipIf(!DB_AVAILABLE)("AC-CATADM-24: a taken item slug names its language", () => {
  let client: PoolClient;

  beforeAll(async () => {
    client = await getClient();
  });

  afterAll(() => {
    db.client = undefined;
    client.release();
  });

  it("AC-CATADM-24: an EN clash raises 23505 slug_taken with HINT en (RLS leaves the key DETAIL out)", async () => {
    await withTx(client, async (c) => {
      const { categoryId } = await arrange(c);

      const error = await saveItemError(c, newItem(categoryId, "slug-hint-new", OWNER_EN));

      expect(error.code).toBe("23505");
      expect(error.message).toBe("slug_taken");
      expect(error.constraint).toBe("item_translations_locale_slug_key");
      expect(error.hint).toBe("en");
      // The reason for the HINT: the caller is subject to RLS, so Postgres sends no key detail.
      expect(error.detail).toBeUndefined();
    });
  }, 12_000);

  it("AC-CATADM-24: a DA clash raises 23505 slug_taken with HINT da", async () => {
    await withTx(client, async (c) => {
      const { categoryId } = await arrange(c);

      const error = await saveItemError(c, newItem(categoryId, OWNER_DA, "slug-hint-new-en"));

      expect(error.code).toBe("23505");
      expect(error.message).toBe("slug_taken");
      expect(error.hint).toBe("da");
    });
  }, 12_000);

  it("AC-CATADM-24: renaming a saved item's EN slug to a taken one (the upsert's update path) names en", async () => {
    await withTx(client, async (c) => {
      const { extraId } = await arrange(c, { da: "slug-hint-other", en: "slug-hint-other-en" });

      const error = await saveItemError(c, {
        id: extraId,
        translations: { da: translation("slug-hint-other"), en: translation(OWNER_EN, "Item") },
      });

      expect(error.code).toBe("23505");
      expect(error.message).toBe("slug_taken");
      expect(error.hint).toBe("en");
    });
  }, 12_000);

  it("AC-CATADM-24: saveItem maps the real EN clash to the EN URL-slug (slug-taken, locale en)", async () => {
    await withTx(client, async (c) => {
      const { categoryId } = await arrange(c);
      db.client = c;

      expect(await saveItem(newItem(categoryId, "slug-hint-new", OWNER_EN))).toStrictEqual({
        ok: false,
        error: "slug-taken",
        locale: "en",
      });
      expect(await saveItem(newItem(categoryId, OWNER_DA, "slug-hint-new-en"))).toStrictEqual({
        ok: false,
        error: "slug-taken",
        locale: "da",
      });
      // The clash rolled back only that save: free slugs still save in the same transaction.
      expect(await saveItem(newItem(categoryId, "slug-hint-new", "slug-hint-new-en"))).toStrictEqual({
        ok: true,
        id: expect.any(String),
      });
    });
  }, 12_000);
});
