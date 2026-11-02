/**
 * RLS integration tests — admin RPCs.
 *
 * Covers F0.4 acceptance:
 *   - non-admin call to any admin_* RPC raises 42501 — for a caller with no profile, a
 *     profile with role = NULL and a 'mylife_user' profile
 *   - admin_save_page creates the page, its translations and its route slugs
 *   - admin_save_page with a slug for a system page raises 23514 and writes nothing
 *   - admin_save_page with a slug already used by a category (same locale) raises 23505
 *   - admin_set_page_status publishes a custom page with two route slugs and stamps
 *     published_at; raises P0001 when fewer than 2 locale routes exist
 *   - admin_reorder_nav sets nav_order from the array position (1000+10, 1000+20, …)
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_AVAILABLE, getClient, type PoolClient } from "./helpers/db.js";
import {
  ADMIN_CLAIMS,
  ADMIN_UUID,
  NON_ADMIN_FIXTURES,
  asRole,
  expectPgError,
  seedAdmin,
  seedCategory,
  seedDraftPage,
  seedPublishedPage,
  seedRoute,
  systemPageId,
  withTx,
} from "./helpers/roles.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe.skipIf(!DB_AVAILABLE)("RLS — admin RPCs", () => {
  let client: PoolClient;

  beforeAll(async () => {
    client = await getClient();
  });

  afterAll(async () => {
    client.release();
  });

  // --------------------------------------------------------------------------
  // Non-admin is rejected from every admin RPC (42501)
  // --------------------------------------------------------------------------

  for (const fixture of NON_ADMIN_FIXTURES) {
    describe(`non-admin (${fixture.label})`, () => {
      it("admin_save_page raises 42501", async () => {
        await withTx(client, async (c) => {
          await fixture.seed(c);
          await asRole(c, "authenticated", fixture.claims);
          await expectPgError(
            c,
            () =>
              c.query("SELECT public.admin_save_page($1::jsonb)", [
                JSON.stringify({ translations: { da: { title: "Test" } } }),
              ]),
            "42501",
            `admin_save_page ${fixture.label}`,
          );
        });
      }, 12_000);

      it("admin_set_page_status raises 42501", async () => {
        await withTx(client, async (c) => {
          const pageId = await seedPublishedPage(c);
          await fixture.seed(c);
          await asRole(c, "authenticated", fixture.claims);
          await expectPgError(
            c,
            () =>
              c.query(
                "SELECT public.admin_set_page_status($1, 'draft'::public.content_status)",
                [pageId],
              ),
            "42501",
            `admin_set_page_status ${fixture.label}`,
          );
        });
      }, 12_000);

      it("admin_reorder_nav raises 42501", async () => {
        await withTx(client, async (c) => {
          const pageId = await seedPublishedPage(c);
          await fixture.seed(c);
          await asRole(c, "authenticated", fixture.claims);
          await expectPgError(
            c,
            () => c.query("SELECT public.admin_reorder_nav($1::uuid[])", [`{${pageId}}`]),
            "42501",
            `admin_reorder_nav ${fixture.label}`,
          );
        });
      }, 12_000);
    });
  }

  // --------------------------------------------------------------------------
  // admin_save_page
  // --------------------------------------------------------------------------

  it("admin: admin_save_page creates the page, its translations and its route slugs", async () => {
    await withTx(client, async (c) => {
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      const payload = {
        show_in_nav: true,
        nav_order: 42,
        translations: {
          da: { title: "Testside", lead: "Kort intro", body_md: "Brødtekst", slug: "test-rpc-side" },
          en: { title: "Test page", slug: "test-rpc-page" },
        },
      };
      const { rows } = await c.query<{ admin_save_page: string }>(
        "SELECT public.admin_save_page($1::jsonb)",
        [JSON.stringify(payload)],
      );
      const pageId = rows[0]?.admin_save_page;
      expect(pageId).toMatch(UUID_RE);

      const page = await c.query<{
        status: string;
        show_in_nav: boolean;
        nav_order: number;
        updated_by: string;
        system_key: string | null;
      }>(
        "SELECT status, show_in_nav, nav_order, updated_by, system_key FROM public.pages WHERE id = $1",
        [pageId],
      );
      expect(page.rows).toEqual([
        { status: "draft", show_in_nav: true, nav_order: 42, updated_by: ADMIN_UUID, system_key: null },
      ]);

      const translations = await c.query<{ locale: string; title: string; lead: string; body_md: string }>(
        "SELECT locale, title, lead, body_md FROM public.page_translations WHERE page_id = $1 ORDER BY locale",
        [pageId],
      );
      expect(translations.rows).toEqual([
        { locale: "da", title: "Testside", lead: "Kort intro", body_md: "Brødtekst" },
        { locale: "en", title: "Test page", lead: "", body_md: "" },
      ]);

      const routes = await c.query<{ locale: string; slug: string }>(
        "SELECT locale, slug FROM public.routes WHERE page_id = $1 ORDER BY locale",
        [pageId],
      );
      expect(routes.rows).toEqual([
        { locale: "da", slug: "test-rpc-side" },
        { locale: "en", slug: "test-rpc-page" },
      ]);
    });
  }, 12_000);

  it("admin: admin_save_page with a slug for a system page raises 23514 and writes nothing", async () => {
    await withTx(client, async (c) => {
      const homeId = await systemPageId(c, "home");
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      const before = await c.query<{ title: string }>(
        "SELECT title FROM public.page_translations WHERE page_id = $1 AND locale = 'da'",
        [homeId],
      );
      const originalTitle = before.rows[0]?.title;
      expect(originalTitle).toBeTruthy();

      await expectPgError(
        c,
        () =>
          c.query("SELECT public.admin_save_page($1::jsonb)", [
            JSON.stringify({
              id: homeId,
              translations: { da: { title: "Overskrevet forside", slug: "forside" } },
            }),
          ]),
        "23514",
        "admin_save_page system page slug",
      );

      // The translation upsert ran before routes_guard fired; the RPC is all-or-nothing.
      const after = await c.query<{ title: string }>(
        "SELECT title FROM public.page_translations WHERE page_id = $1 AND locale = 'da'",
        [homeId],
      );
      expect(after.rows[0]?.title).toBe(originalTitle);
      const routes = await c.query("SELECT slug FROM public.routes WHERE page_id = $1", [homeId]);
      expect(routes.rows).toHaveLength(0);
    });
  }, 12_000);

  it("admin: admin_save_page with a slug already used by a category (same locale) raises 23505", async () => {
    await withTx(client, async (c) => {
      const catId = await seedCategory(c);
      await seedRoute(c, "da", "rls-dublet", { categoryId: catId });
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      await expectPgError(
        c,
        () =>
          c.query("SELECT public.admin_save_page($1::jsonb)", [
            JSON.stringify({ translations: { da: { title: "RLS dublet-side", slug: "rls-dublet" } } }),
          ]),
        "23505",
        "admin_save_page duplicate slug",
      );

      const route = await c.query<{ page_id: string | null; category_id: string | null }>(
        "SELECT page_id, category_id FROM public.routes WHERE locale = 'da' AND slug = 'rls-dublet'",
      );
      expect(route.rows).toEqual([{ page_id: null, category_id: catId }]);
      const orphan = await c.query(
        "SELECT page_id FROM public.page_translations WHERE title = 'RLS dublet-side'",
      );
      expect(orphan.rows).toHaveLength(0);
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // admin_set_page_status
  // --------------------------------------------------------------------------

  it("admin: admin_set_page_status publishes a custom page that has two route slugs and stamps published_at", async () => {
    await withTx(client, async (c) => {
      const pageId = await seedDraftPage(c);
      await seedRoute(c, "da", "test-publish-da", { pageId });
      await seedRoute(c, "en", "test-publish-en", { pageId });
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      await c.query(
        "SELECT public.admin_set_page_status($1, 'published'::public.content_status)",
        [pageId],
      );

      const { rows } = await c.query<{ status: string; published_at: Date | null; updated_by: string }>(
        "SELECT status, published_at, updated_by FROM public.pages WHERE id = $1",
        [pageId],
      );
      expect(rows[0]?.status).toBe("published");
      expect(rows[0]?.published_at).toBeInstanceOf(Date);
      expect(rows[0]?.updated_by).toBe(ADMIN_UUID);
    });
  }, 12_000);

  it("admin: admin_set_page_status raises P0001 when fewer than 2 routes exist", async () => {
    await withTx(client, async (c) => {
      const pageId = await seedDraftPage(c);
      await seedRoute(c, "da", "test-missing-en", { pageId });
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      await expectPgError(
        c,
        () =>
          c.query(
            "SELECT public.admin_set_page_status($1, 'published'::public.content_status)",
            [pageId],
          ),
        "P0001",
        "admin_set_page_status missing_slugs",
      );

      const { rows } = await c.query<{ status: string }>(
        "SELECT status FROM public.pages WHERE id = $1",
        [pageId],
      );
      expect(rows[0]?.status).toBe("draft");
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // admin_reorder_nav
  // --------------------------------------------------------------------------

  it("admin: admin_reorder_nav sets nav_order from the array position", async () => {
    await withTx(client, async (c) => {
      const first = await seedPublishedPage(c);
      const second = await seedPublishedPage(c);
      const third = await seedPublishedPage(c);
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      await c.query("SELECT public.admin_reorder_nav($1::uuid[])", [`{${third},${first},${second}}`]);

      const { rows } = await c.query<{ id: string; nav_order: number }>(
        "SELECT id, nav_order FROM public.pages WHERE id = ANY($1::uuid[])",
        [[first, second, third]],
      );
      const order = Object.fromEntries(rows.map((r) => [r.id, r.nav_order]));
      expect(order).toEqual({ [third]: 1010, [first]: 1020, [second]: 1030 });
    });
  }, 12_000);
});
