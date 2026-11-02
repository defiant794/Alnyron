/**
 * E2E seed helpers — pages editor (F1.2)
 *
 * Uses a DEDICATED admin user (E2E_PAGES_ADMIN_UUID / E2E_PAGES_ADMIN_EMAIL)
 * so the pages editor block never races admin-auth.spec.ts which uses
 * E2E_ADMIN_UUID.
 *
 * Snapshot/restore: the editor tests write real data to the production DB
 * (Contact title, show_in_nav flags).  `snapshotSystemPages` captures the
 * state of all system pages + their translations before the block runs;
 * `restoreSystemPages` writes them back afterward and calls `revalidateSite()`
 * so the ISR cache reflects the restored content.
 */

import type pg from "pg";
import { randomBytes } from "node:crypto";
import { DB_AVAILABLE, getClient, endPool } from "../../integration/rls/helpers/db";
import { revalidateSite } from "./revalidate";

export { getClient, endPool, DB_AVAILABLE };

// ── Dedicated pages-editor test user ─────────────────────────────────────────

export const E2E_PAGES_ADMIN_EMAIL = "e2e-pages-admin@alnyron-test.local";
/** Distinct from E2E_ADMIN_UUID — never races admin-auth's seed/cleanup. */
export const E2E_PAGES_ADMIN_UUID = "00000000-0000-0000-e2e0-000000000003";

export function randomE2ePassword(): string {
  return `${randomBytes(24).toString("base64url")}aA1!`;
}

export async function seedE2ePagesAdmin(client: pg.PoolClient, password: string): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO public.user_allowlist (email, role)
       VALUES ($1, 'admin')
       ON CONFLICT (email) DO UPDATE SET role = 'admin'`,
      [E2E_PAGES_ADMIN_EMAIL],
    );

    const { rows } = await client.query<{ pwd: string }>(
      `SELECT crypt($1, gen_salt('bf', 10)) AS pwd`,
      [password],
    );
    const encrypted = rows[0]!.pwd;

    await client.query(
      `INSERT INTO auth.users
         (instance_id, id, aud, role, email, email_confirmed_at, encrypted_password,
          created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_super_admin,
          confirmation_token, recovery_token,
          email_change, email_change_token_new, email_change_token_current)
       VALUES ('00000000-0000-0000-0000-000000000000'::uuid, $1,
               'authenticated', 'authenticated', $2, now(), $3,
               now(), now(), '{}', '{}', false, '', '', '', '', '')
       ON CONFLICT (id) DO NOTHING`,
      [E2E_PAGES_ADMIN_UUID, E2E_PAGES_ADMIN_EMAIL, encrypted],
    );

    await client.query(
      `INSERT INTO auth.identities
         (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
       VALUES ($1::text, $2,
               jsonb_build_object('sub', $1::text, 'email', $3::text),
               'email', now(), now(), now())
       ON CONFLICT (provider, provider_id) DO NOTHING`,
      [E2E_PAGES_ADMIN_UUID, E2E_PAGES_ADMIN_UUID, E2E_PAGES_ADMIN_EMAIL],
    );

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

export async function cleanupE2ePagesAdmin(client: pg.PoolClient): Promise<void> {
  await client.query(`DELETE FROM auth.users WHERE id = $1`, [E2E_PAGES_ADMIN_UUID]);
  await client.query(`DELETE FROM public.user_allowlist WHERE email = $1`, [E2E_PAGES_ADMIN_EMAIL]);
}

// ── System-page snapshot / restore ───────────────────────────────────────────

/** Captured state of a system `pages` row. */
export interface PageSnapshot {
  id: string;
  system_key: string;
  show_in_nav: boolean;
  nav_order: number;
}

/** Captured state of a `page_translations` row. */
export interface PageTranslationSnapshot {
  page_id: string;
  locale: string;
  title: string;
  lead: string;
  body_md: string;
  content: object;
  seo_title: string;
  seo_description: string;
}

export interface SystemPagesSnapshot {
  pages: PageSnapshot[];
  translations: PageTranslationSnapshot[];
}

/**
 * Read the current state of all three system pages (home/contact/privacy) and
 * their DA + EN translations.  Call this in `beforeAll` before any editor test
 * mutates the DB.
 */
export async function snapshotSystemPages(client: pg.PoolClient): Promise<SystemPagesSnapshot> {
  const { rows: pages } = await client.query<PageSnapshot>(
    `SELECT id, system_key, show_in_nav, nav_order
       FROM public.pages
      WHERE system_key IN ('home', 'contact', 'privacy')`,
  );

  const { rows: translations } = await client.query<PageTranslationSnapshot>(
    `SELECT pt.page_id, pt.locale, pt.title, pt.lead, pt.body_md,
            pt.content, pt.seo_title, pt.seo_description
       FROM public.page_translations pt
       JOIN public.pages p ON p.id = pt.page_id
      WHERE p.system_key IN ('home', 'contact', 'privacy')`,
  );

  return { pages, translations };
}

/**
 * Write the snapshotted state back to the DB, then revalidate the ISR cache so
 * restored content is immediately served on the public site.  Call this in
 * `afterAll`.
 */
export async function restoreSystemPages(
  client: pg.PoolClient,
  snapshot: SystemPagesSnapshot,
): Promise<void> {
  await client.query("BEGIN");
  try {
    for (const p of snapshot.pages) {
      await client.query(
        `UPDATE public.pages
            SET show_in_nav = $1, nav_order = $2
          WHERE id = $3`,
        [p.show_in_nav, p.nav_order, p.id],
      );
    }

    for (const tr of snapshot.translations) {
      await client.query(
        `UPDATE public.page_translations
            SET title = $1, lead = $2, body_md = $3, content = $4::jsonb,
                seo_title = $5, seo_description = $6
          WHERE page_id = $7 AND locale = $8`,
        [
          tr.title,
          tr.lead,
          tr.body_md,
          JSON.stringify(tr.content),
          tr.seo_title,
          tr.seo_description,
          tr.page_id,
          tr.locale,
        ],
      );
    }

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }

  await revalidateSite();
}
