/**
 * E2E seed helpers — monitor-nav (Slice B)
 *
 * Provides a dedicated admin user (distinct UUID from all other e2e specs) and
 * helpers to snapshot/restore ALL pages rows so that the Flyt op/ned scenario
 * (which calls admin_reorder_nav and renumbers every non-pinned page's nav_order)
 * does not permanently drift the shared e2e project's state and corrupt other
 * specs' snapshots (e.g. pages-editor.spec.ts).
 *
 * Uses `randomE2ePassword` from pages-editor-seed to avoid duplicating the
 * implementation.
 */

import type pg from "pg";
import { getClient, endPool } from "../../integration/rls/helpers/db";
import { randomE2ePassword } from "./pages-editor-seed";
import { revalidateSite } from "./revalidate";

export { getClient, endPool, randomE2ePassword };

// ── Constants ─────────────────────────────────────────────────────────────────

export const E2E_MONNAV_ADMIN_EMAIL = "e2e-monitor-nav-admin@alnyron-test.local";
/** Distinct from every other e2e UUID to prevent races. */
export const E2E_MONNAV_ADMIN_UUID = "00000000-0000-0000-e2e0-000000000030";

// ── Seed / cleanup admin user ─────────────────────────────────────────────────

export async function seedMonitorNavAdmin(
  client: pg.PoolClient,
  password: string,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO public.user_allowlist (email, role)
       VALUES ($1, 'admin')
       ON CONFLICT (email) DO UPDATE SET role = 'admin'`,
      [E2E_MONNAV_ADMIN_EMAIL],
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
      [E2E_MONNAV_ADMIN_UUID, E2E_MONNAV_ADMIN_EMAIL, encrypted],
    );

    await client.query(
      `INSERT INTO auth.identities
         (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
       VALUES ($1::text, $2,
               jsonb_build_object('sub', $1::text, 'email', $3::text),
               'email', now(), now(), now())
       ON CONFLICT (provider, provider_id) DO NOTHING`,
      [E2E_MONNAV_ADMIN_UUID, E2E_MONNAV_ADMIN_UUID, E2E_MONNAV_ADMIN_EMAIL],
    );

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

export async function cleanupMonitorNavAdmin(client: pg.PoolClient): Promise<void> {
  await client.query(`DELETE FROM auth.users WHERE id = $1`, [E2E_MONNAV_ADMIN_UUID]);
  await client.query(`DELETE FROM public.user_allowlist WHERE email = $1`, [
    E2E_MONNAV_ADMIN_EMAIL,
  ]);
}

// ── Full pages snapshot / restore ─────────────────────────────────────────────
//
// The Sider list sends every non-pinned page id to admin_reorder_nav (contact,
// privacy and monitor; the pinned home page keeps its nav_order), which renumbers
// them all, so restoring only the monitor row would leave the other pages with
// drifted nav_order values, corrupting pages-editor.spec's snapshot baseline on
// the shared e2e project.

export interface PageNavSnapshot {
  id: string;
  show_in_nav: boolean;
  nav_order: number;
}

/**
 * Snapshot id, show_in_nav and nav_order for every row in public.pages.
 * Call this in beforeAll before any test mutates the DB.
 */
export async function snapshotAllPages(client: pg.PoolClient): Promise<PageNavSnapshot[]> {
  const { rows } = await client.query<PageNavSnapshot>(
    `SELECT id, show_in_nav, nav_order FROM public.pages ORDER BY id`,
  );
  return rows;
}

/**
 * Restore every page to its snapshotted show_in_nav + nav_order in one
 * transaction, then revalidate the ISR cache so the public site reflects the
 * restored state. Call this in afterAll.
 */
export async function restoreAllPages(
  client: pg.PoolClient,
  snapshot: PageNavSnapshot[],
): Promise<void> {
  await client.query("BEGIN");
  try {
    for (const p of snapshot) {
      await client.query(
        `UPDATE public.pages SET show_in_nav = $1, nav_order = $2 WHERE id = $3`,
        [p.show_in_nav, p.nav_order, p.id],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
  await revalidateSite();
}

/**
 * Look up the monitor page id from the pages table (seeded by the migration).
 * Returns null when the row does not exist (migration not yet applied).
 */
export async function monitorPageId(client: pg.PoolClient): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM public.pages WHERE system_key = 'monitor' LIMIT 1`,
  );
  return rows[0]?.id ?? null;
}

/**
 * Hides the monitor page and gives it the highest nav_order of all system
 * pages (at least its seeded 1100, in the pages band after the categories),
 * so it is the last row of the Sider list: "Flyt op" enabled, "Flyt ned"
 * disabled. Call this after {@link snapshotAllPages}.
 */
export async function hideMonitorAtEnd(client: pg.PoolClient, monitorId: string): Promise<void> {
  await client.query(
    `UPDATE public.pages
        SET show_in_nav = false,
            nav_order = greatest(1100, (SELECT max(nav_order) + 10 FROM public.pages WHERE system_key IS NOT NULL))
      WHERE id = $1`,
    [monitorId],
  );
}

/** Shows (`show = true`) or hides the monitor page in the public nav. */
export async function setMonitorShown(client: pg.PoolClient, monitorId: string, show: boolean): Promise<void> {
  await client.query(`UPDATE public.pages SET show_in_nav = $1 WHERE id = $2`, [show, monitorId]);
}

/**
 * Header hrefs of every catalog category on the Danish site: the category's
 * English route slug without a locale prefix (`/apps`), as getPublicCategories
 * builds them. Which of them the header shows depends on the category being
 * public; this set only tells category links apart from page links.
 */
export async function categoryNavHrefs(client: pg.PoolClient): Promise<Set<string>> {
  const { rows } = await client.query<{ href: string }>(
    `SELECT '/' || slug AS href FROM public.routes WHERE category_id IS NOT NULL AND locale = 'en'`,
  );
  return new Set(rows.map((row) => row.href));
}
