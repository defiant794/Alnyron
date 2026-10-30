/**
 * Integration tests — system pages are permanent (pages_system_guard trigger,
 * migration 20261101000400_hardening.sql).
 *
 * Covers F0.4 hardening:
 *   - system_key is immutable: an admin cannot clear it, change it, or assign one to a
 *     custom page (23514) — so pages_delete's `system_key is null` guard cannot be bypassed
 *   - a system page cannot be unpublished, not even in the same UPDATE that clears
 *     system_key (the CHECK constraint alone would allow that combination)
 *   - a system page cannot be deleted, even after an attempt to clear its system_key
 *   - the trigger is not RLS: it binds postgres (BYPASSRLS) too
 *   - admins can still edit a system page's translations, nav flag and nav order
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_AVAILABLE, getClient, type PoolClient } from "./helpers/db.js";
import {
  ADMIN_CLAIMS,
  asRole,
  expectPgError,
  seedAdmin,
  seedPublishedPage,
  systemPageId,
  withTx,
} from "./helpers/roles.js";

describe.skipIf(!DB_AVAILABLE)("System pages are permanent", () => {
  let client: PoolClient;

  beforeAll(async () => {
    client = await getClient();
  });

  afterAll(async () => {
    client.release();
  });

  async function systemPageState(
    c: PoolClient,
    id: string,
  ): Promise<{ system_key: string | null; status: string } | undefined> {
    const { rows } = await c.query<{ system_key: string | null; status: string }>(
      "SELECT system_key, status FROM public.pages WHERE id = $1",
      [id],
    );
    return rows[0];
  }

  it("admin: clearing system_key on a system page raises 23514", async () => {
    await withTx(client, async (c) => {
      const homeId = await systemPageId(c, "home");
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      await expectPgError(
        c,
        () => c.query("UPDATE public.pages SET system_key = NULL WHERE id = $1", [homeId]),
        "23514",
        "clear system_key",
      );
      expect(await systemPageState(c, homeId)).toEqual({ system_key: "home", status: "published" });
    });
  }, 12_000);

  it("admin: changing system_key to another key raises 23514", async () => {
    await withTx(client, async (c) => {
      const contactId = await systemPageId(c, "contact");
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      await expectPgError(
        c,
        () => c.query("UPDATE public.pages SET system_key = 'privacy' WHERE id = $1", [contactId]),
        "23514",
        "change system_key",
      );
      expect(await systemPageState(c, contactId)).toEqual({ system_key: "contact", status: "published" });
    });
  }, 12_000);

  it("admin: assigning a system_key to a custom page raises 23514 'system_key is immutable' (not the 23505 unique error)", async () => {
    await withTx(client, async (c) => {
      // Published on purpose: a draft page would trip the CHECK pages_system_always_published
      // (also 23514) even without the trigger. With status = 'published' the CHECK passes, so
      // without pages_system_guard the UPDATE would hit the system_key unique index (23505).
      const pageId = await seedPublishedPage(c);
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      await expectPgError(
        c,
        () => c.query("UPDATE public.pages SET system_key = 'home' WHERE id = $1", [pageId]),
        "23514",
        "assign system_key",
        { messageIncludes: "system_key is immutable" },
      );
      expect(await systemPageState(c, pageId)).toEqual({ system_key: null, status: "published" });
    });
  }, 12_000);

  it("admin: setting a system page to draft raises 23514", async () => {
    await withTx(client, async (c) => {
      const privacyId = await systemPageId(c, "privacy");
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      await expectPgError(
        c,
        () => c.query("UPDATE public.pages SET status = 'draft' WHERE id = $1", [privacyId]),
        "23514",
        "unpublish system page",
      );
      expect(await systemPageState(c, privacyId)).toEqual({ system_key: "privacy", status: "published" });
    });
  }, 12_000);

  it("admin: clearing system_key and unpublishing in one UPDATE raises 23514", async () => {
    await withTx(client, async (c) => {
      const homeId = await systemPageId(c, "home");
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      await expectPgError(
        c,
        () =>
          c.query("UPDATE public.pages SET system_key = NULL, status = 'draft' WHERE id = $1", [homeId]),
        "23514",
        "clear system_key + unpublish",
      );
      expect(await systemPageState(c, homeId)).toEqual({ system_key: "home", status: "published" });
    });
  }, 12_000);

  it("admin: a system page cannot be deleted, even after trying to clear its system_key", async () => {
    await withTx(client, async (c) => {
      const privacyId = await systemPageId(c, "privacy");
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      await expectPgError(
        c,
        () => c.query("UPDATE public.pages SET system_key = NULL WHERE id = $1", [privacyId]),
        "23514",
        "clear system_key before delete",
      );
      const result = await c.query("DELETE FROM public.pages WHERE id = $1", [privacyId]);
      expect(result.rowCount).toBe(0);
      expect(await systemPageState(c, privacyId)).toEqual({ system_key: "privacy", status: "published" });
    });
  }, 12_000);

  it("postgres (BYPASSRLS): clearing system_key still raises 23514 — the guard is a trigger, not RLS", async () => {
    await withTx(client, async (c) => {
      const homeId = await systemPageId(c, "home");
      await expectPgError(
        c,
        () => c.query("UPDATE public.pages SET system_key = NULL WHERE id = $1", [homeId]),
        "23514",
        "clear system_key as postgres",
      );
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // Admins keep editing rights on system page content
  // --------------------------------------------------------------------------

  it("admin: can edit a system page's translations directly and via admin_save_page", async () => {
    await withTx(client, async (c) => {
      const contactId = await systemPageId(c, "contact");
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      const direct = await c.query(
        "UPDATE public.page_translations SET title = 'Kontakt os i dag' WHERE page_id = $1 AND locale = 'da'",
        [contactId],
      );
      expect(direct.rowCount).toBe(1);

      await c.query("SELECT public.admin_save_page($1::jsonb)", [
        JSON.stringify({ id: contactId, translations: { en: { title: "Contact us" } } }),
      ]);

      const { rows } = await c.query<{ locale: string; title: string }>(
        "SELECT locale, title FROM public.page_translations WHERE page_id = $1 ORDER BY locale",
        [contactId],
      );
      expect(rows).toEqual([
        { locale: "da", title: "Kontakt os i dag" },
        { locale: "en", title: "Contact us" },
      ]);
      expect(await systemPageState(c, contactId)).toEqual({ system_key: "contact", status: "published" });
    });
  }, 12_000);

  it("admin: can change a system page's nav flag and order", async () => {
    await withTx(client, async (c) => {
      const homeId = await systemPageId(c, "home");
      const contactId = await systemPageId(c, "contact");
      await seedAdmin(c);
      await asRole(c, "authenticated", ADMIN_CLAIMS);

      const flag = await c.query("UPDATE public.pages SET show_in_nav = false WHERE id = $1", [contactId]);
      expect(flag.rowCount).toBe(1);

      await c.query("SELECT public.admin_reorder_nav($1::uuid[])", [`{${contactId},${homeId}}`]);

      const { rows } = await c.query<{ system_key: string; show_in_nav: boolean; nav_order: number }>(
        "SELECT system_key, show_in_nav, nav_order FROM public.pages WHERE id = ANY($1::uuid[]) ORDER BY nav_order",
        [[homeId, contactId]],
      );
      expect(rows).toEqual([
        { system_key: "contact", show_in_nav: false, nav_order: 10 },
        { system_key: "home", show_in_nav: true, nav_order: 20 },
      ]);
    });
  }, 12_000);
});
