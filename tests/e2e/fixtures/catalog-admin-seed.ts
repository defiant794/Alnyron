/**
 * E2E seed helpers — catalog admin editors (F2.3 catalog-admin)
 *
 * Provides:
 *  - A non-allowlisted e2e user who can sign in but is refused /admin/* routes
 *    (requireAdmin() redirects them to /admin/no-access).
 *  - Category-translation snapshot/restore so AC-11 text edits are always undone.
 *  - Uploaded-object cleanup so bucket objects seeded by the MediaManager tests
 *    do not accumulate between runs.
 *
 * All e2e test items MUST use slugs prefixed with `e2e-cat-` (e.g. `e2e-cat-adm-…`)
 * so the existing `removeCatalogTestItems()` in db-state.ts sweeps them automatically
 * (it deletes rows whose DA slug matches `e2e-cat-%`).
 */

import { randomBytes } from "node:crypto";
import type pg from "pg";
import { E2E_EMAIL_DOMAIN } from "./admin-auth-seed";
import { getClient, endPool, DB_AVAILABLE } from "../../integration/rls/helpers/db";

export { getClient, endPool, DB_AVAILABLE };

// ── Non-admin test user ───────────────────────────────────────────────────────
//
// Signed-in but NOT in user_allowlist → requireAdmin() redirects to /admin/no-access.
// Storage RLS (`is_admin()`) also refuses any bucket mutation with their JWT.

export const E2E_CAT_NONADMIN_EMAIL = `e2e-cat-nonadmin@${E2E_EMAIL_DOMAIN}`;
/** Distinct UUID — never races with other seeds; lives only during catalog-admin e2e runs. */
export const E2E_CAT_NONADMIN_UUID = "00000000-0000-0000-e2e0-000000000007";

export function randomE2ePassword(): string {
  return `${randomBytes(24).toString("base64url")}aA1!`;
}

// ── Dedicated catalog-admin user (UUID …0008) ─────────────────────────────────
//
// Uses its own UUID so it never races E2E_ADMIN_UUID (…0001) used by
// admin-auth.spec under fullyParallel:true. sweepE2eTestUsers still removes
// it via the @alnyron-test.local domain.

export const E2E_CAT_ADMIN_EMAIL = `e2e-cat-admin@${E2E_EMAIL_DOMAIN}`;
export const E2E_CAT_ADMIN_UUID = "00000000-0000-0000-e2e0-000000000008";

/** Seed the dedicated catalog-admin user (in user_allowlist + auth.users). */
export async function seedCatalogAdmin(client: pg.PoolClient, password: string): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO public.user_allowlist (email, role)
       VALUES ($1, 'admin')
       ON CONFLICT (email) DO UPDATE SET role = 'admin'`,
      [E2E_CAT_ADMIN_EMAIL],
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
      [E2E_CAT_ADMIN_UUID, E2E_CAT_ADMIN_EMAIL, encrypted],
    );
    await client.query(
      `INSERT INTO auth.identities
         (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
       VALUES ($1::text, $2,
               jsonb_build_object('sub', $1::text, 'email', $3::text),
               'email', now(), now(), now())
       ON CONFLICT (provider, provider_id) DO NOTHING`,
      [E2E_CAT_ADMIN_UUID, E2E_CAT_ADMIN_UUID, E2E_CAT_ADMIN_EMAIL],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

/** Remove the catalog-admin user and allowlist entry. */
export async function cleanupCatalogAdmin(client: pg.PoolClient): Promise<void> {
  await client.query(`DELETE FROM auth.users WHERE id = $1`, [E2E_CAT_ADMIN_UUID]);
  await client.query(`DELETE FROM public.user_allowlist WHERE email = $1`, [E2E_CAT_ADMIN_EMAIL]);
}


/**
 * Seed the non-admin user in `auth.users` WITHOUT an `admin_allowlist` entry.
 * The user can sign in, but `requireAdmin()` will redirect them to `/admin/no-access`.
 */
export async function seedCatalogNonAdmin(client: pg.PoolClient, password: string): Promise<void> {
  await client.query("BEGIN");
  try {
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
      [E2E_CAT_NONADMIN_UUID, E2E_CAT_NONADMIN_EMAIL, encrypted],
    );

    await client.query(
      `INSERT INTO auth.identities
         (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
       VALUES ($1::text, $2,
               jsonb_build_object('sub', $1::text, 'email', $3::text),
               'email', now(), now(), now())
       ON CONFLICT (provider, provider_id) DO NOTHING`,
      [E2E_CAT_NONADMIN_UUID, E2E_CAT_NONADMIN_UUID, E2E_CAT_NONADMIN_EMAIL],
    );

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

/** Remove the non-admin e2e user (cascades to identities, sessions, profiles). */
export async function cleanupCatalogNonAdmin(client: pg.PoolClient): Promise<void> {
  await client.query(`DELETE FROM auth.users WHERE id = $1`, [E2E_CAT_NONADMIN_UUID]);
  // No allowlist row to remove (that's the point), but guard for safety:
  await client.query(`DELETE FROM public.user_allowlist WHERE email = $1`, [E2E_CAT_NONADMIN_EMAIL]);
}

// ── Category translation snapshot/restore ─────────────────────────────────────
//
// Used by AC-CATADM-11 so text edits to a real category are always undone in afterAll.

export interface CategoryTranslationSnapshot {
  category_id: string;
  locale: string;
  title: string;
  description: string;
  seo_title: string;
  seo_description: string;
}

/**
 * Read the current DA and EN translations of every category of `kind`.
 * Call in `beforeAll` before any editor test mutates a category_translations row.
 */
export async function snapshotCategoryTranslations(
  client: pg.PoolClient,
  kind: string,
): Promise<CategoryTranslationSnapshot[]> {
  const { rows } = await client.query<CategoryTranslationSnapshot>(
    `SELECT ct.category_id, ct.locale,
            coalesce(ct.title, '') AS title,
            coalesce(ct.description, '') AS description,
            coalesce(ct.seo_title, '') AS seo_title,
            coalesce(ct.seo_description, '') AS seo_description
     FROM public.category_translations ct
     JOIN public.categories c ON c.id = ct.category_id
     WHERE c.kind = $1::public.catalog_kind`,
    [kind],
  );
  return rows;
}

/**
 * Write the snapshotted translations back.
 * Uses UPSERT so rows deleted by a test are re-created cleanly.
 */
export async function restoreCategoryTranslations(
  client: pg.PoolClient,
  snapshots: CategoryTranslationSnapshot[],
): Promise<void> {
  for (const row of snapshots) {
    await client.query(
      `INSERT INTO public.category_translations
         (category_id, locale, title, description, seo_title, seo_description)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (category_id, locale)
       DO UPDATE SET
         title = EXCLUDED.title,
         description = EXCLUDED.description,
         seo_title = EXCLUDED.seo_title,
         seo_description = EXCLUDED.seo_description`,
      [row.category_id, row.locale, row.title, row.description, row.seo_title, row.seo_description],
    );
  }
}

// ── Storage object cleanup ─────────────────────────────────────────────────────
//
// Remove bucket objects that were uploaded during the test run.
// Uses the Supabase Storage Management API with the service-role key so the
// bucket SELECT policy is not a constraint (the management API uses the service role).

/**
 * Delete a list of media-bucket object paths via the Supabase Storage API.
 * Requires SUPABASE_SECRET_KEY (the service-role key).
 * No-ops silently when SUPABASE_SECRET_KEY is absent.
 */
export async function removeStorageObjects(paths: readonly string[]): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key || paths.length === 0) return;

  const res = await fetch(`${url}/storage/v1/object/media`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      apikey: key,
    },
    body: JSON.stringify({ prefixes: paths }),
  });

  if (!res.ok) {
    // Log but do not throw — test already passed; stale objects are low-risk.
    const text = await res.text().catch(() => res.statusText);
    console.warn(`[catalog-admin-seed] removeStorageObjects ${res.status}: ${text}`);
  }
}

/**
 * Query `public.media` for storage paths belonging to test items (DA slug
 * LIKE 'e2e-cat-%'). Call this in afterAll BEFORE `removeCatalogTestItems()`
 * so the item rows still exist for the JOIN. Pass the result to
 * `removeStorageObjects` to clean the bucket.
 */
export async function getUploadedMediaPaths(client: pg.PoolClient): Promise<string[]> {
  const { rows } = await client.query<{ storage_path: string }>(
    `SELECT m.storage_path
     FROM public.media m
     JOIN public.item_translations t ON t.item_id = m.item_id
     WHERE t.locale = 'da' AND t.slug LIKE 'e2e-cat-%'`,
  );
  return rows.map((r) => r.storage_path);
}

/**
 * Delete a single test item by id (cascade removes translations).
 * Use instead of `removeCatalogTestItems()` for mid-suite targeted cleanup
 * so items created by later tests in the same serial run are not wiped.
 */
export async function deleteTestItem(client: pg.PoolClient, itemId: string): Promise<void> {
  await client.query(`DELETE FROM public.items WHERE id = $1`, [itemId]);
}
