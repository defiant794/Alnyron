/**
 * RLS integration tests — pages, page_translations, routes visibility.
 *
 * Covers F0.4 acceptance:
 *   - anon cannot read draft page / its translations / its routes
 *   - anon can read a published page
 *   - admin reads everything (draft + published); non-admin authenticated callers (no
 *     profile, role = NULL, 'mylife_user') see no draft page, translation or route
 *   - page_translations DA row cannot be deleted (locale <> 'da' guard)
 *   - page_translations EN row can be deleted by admin
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_AVAILABLE, getClient, type PoolClient } from "./helpers/db.js";
import {
  ADMIN_CLAIMS,
  ADMIN_UUID,
  ANON_CLAIMS,
  NON_ADMIN_FIXTURES,
  asRole,
  seedAuthUser,
  seedDraftPage,
  seedPageTranslation,
  seedPublishedPage,
  seedRoute,
  withTx,
} from "./helpers/roles.js";

describe.skipIf(!DB_AVAILABLE)("RLS — pages visibility", () => {
  let client: PoolClient;

  beforeAll(async () => {
    client = await getClient();
  });

  afterAll(async () => {
    client.release();
  });

  // --------------------------------------------------------------------------
  // Anon: draft page is invisible
  // --------------------------------------------------------------------------

  it("anon: draft page is not returned from public.pages", async () => {
    await withTx(client, async (c) => {
      const pageId = await seedDraftPage(c);
      await asRole(c, "anon", ANON_CLAIMS);

      const { rows } = await c.query<{ id: string }>(
        "SELECT id FROM public.pages WHERE id = $1",
        [pageId],
      );
      expect(rows).toHaveLength(0);
    });
  }, 12_000);

  it("anon: page_translations for a draft page are not returned", async () => {
    await withTx(client, async (c) => {
      const pageId = await seedDraftPage(c);
      await seedPageTranslation(c, pageId, "da");
      await asRole(c, "anon", ANON_CLAIMS);

      const { rows } = await c.query(
        "SELECT page_id FROM public.page_translations WHERE page_id = $1",
        [pageId],
      );
      expect(rows).toHaveLength(0);
    });
  }, 12_000);

  it("anon: routes for a draft page are not returned", async () => {
    await withTx(client, async (c) => {
      const pageId = await seedDraftPage(c);
      await c.query(
        `INSERT INTO public.routes (locale, slug, page_id) VALUES ('da', 'testside-draft', $1)`,
        [pageId],
      );
      await asRole(c, "anon", ANON_CLAIMS);

      const { rows } = await c.query(
        "SELECT slug FROM public.routes WHERE page_id = $1",
        [pageId],
      );
      expect(rows).toHaveLength(0);
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // Anon: published page is visible
  // --------------------------------------------------------------------------

  it("anon: published page is returned from public.pages", async () => {
    await withTx(client, async (c) => {
      const pageId = await seedPublishedPage(c);
      await asRole(c, "anon", ANON_CLAIMS);

      const { rows } = await c.query<{ id: string }>(
        "SELECT id FROM public.pages WHERE id = $1",
        [pageId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(pageId);
    });
  }, 12_000);

  it("anon: page_translations for a published page are returned", async () => {
    await withTx(client, async (c) => {
      const pageId = await seedPublishedPage(c);
      await seedPageTranslation(c, pageId, "da");
      await asRole(c, "anon", ANON_CLAIMS);

      const { rows } = await c.query(
        "SELECT locale FROM public.page_translations WHERE page_id = $1",
        [pageId],
      );
      expect(rows).toHaveLength(1);
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // Admin: reads both draft and published
  // --------------------------------------------------------------------------

  it("admin: draft page is returned", async () => {
    await withTx(client, async (c) => {
      const pageId = await seedDraftPage(c);
      await seedAuthUser(c, ADMIN_UUID, "admin@test.local", "admin");
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      const { rows } = await c.query<{ id: string }>(
        "SELECT id FROM public.pages WHERE id = $1",
        [pageId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(pageId);
    });
  }, 12_000);

  it("admin: page_translations for a draft page are returned", async () => {
    await withTx(client, async (c) => {
      const pageId = await seedDraftPage(c);
      await seedPageTranslation(c, pageId, "da");
      await seedAuthUser(c, ADMIN_UUID, "admin@test.local", "admin");
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      const { rows } = await c.query(
        "SELECT locale FROM public.page_translations WHERE page_id = $1",
        [pageId],
      );
      expect(rows).toHaveLength(1);
    });
  }, 12_000);

  for (const fixture of NON_ADMIN_FIXTURES) {
    it(`non-admin authenticated (${fixture.label}): draft page, translations and routes are not returned`, async () => {
      await withTx(client, async (c) => {
        const pageId = await seedDraftPage(c);
        await seedPageTranslation(c, pageId, "da");
        await seedRoute(c, "da", "testside-draft", { pageId });
        await fixture.seed(c);
        await asRole(c, "authenticated", fixture.claims);

        const pages = await c.query("SELECT id FROM public.pages WHERE id = $1", [pageId]);
        expect(pages.rows).toHaveLength(0);
        const translations = await c.query(
          "SELECT locale FROM public.page_translations WHERE page_id = $1",
          [pageId],
        );
        expect(translations.rows).toHaveLength(0);
        const routes = await c.query("SELECT slug FROM public.routes WHERE page_id = $1", [pageId]);
        expect(routes.rows).toHaveLength(0);
      });
    }, 12_000);
  }

  // --------------------------------------------------------------------------
  // DA translation delete guard
  // --------------------------------------------------------------------------

  it("admin: DELETE page_translation with locale='da' deletes 0 rows", async () => {
    await withTx(client, async (c) => {
      const pageId = await seedPublishedPage(c);
      await seedPageTranslation(c, pageId, "da");
      await seedAuthUser(c, ADMIN_UUID, "admin@test.local", "admin");
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      const result = await c.query(
        "DELETE FROM public.page_translations WHERE page_id = $1 AND locale = 'da'",
        [pageId],
      );
      // RLS policy: locale <> 'da' guard — admin cannot delete the DA row
      expect(result.rowCount).toBe(0);
    });
  }, 12_000);

  it("admin: DELETE page_translation with locale='en' succeeds", async () => {
    await withTx(client, async (c) => {
      const pageId = await seedPublishedPage(c);
      await seedPageTranslation(c, pageId, "da");
      await seedPageTranslation(c, pageId, "en", "");
      await seedAuthUser(c, ADMIN_UUID, "admin@test.local", "admin");
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      const result = await c.query(
        "DELETE FROM public.page_translations WHERE page_id = $1 AND locale = 'en'",
        [pageId],
      );
      expect(result.rowCount).toBe(1);
    });
  }, 12_000);
});
