/**
 * Role-simulation helpers for Supabase RLS integration tests.
 *
 * Pattern per test:
 *   await withTx(client, async (c) => {
 *     await seedAuthUser(c, ADMIN_UUID, 'admin@test.local', 'admin');
 *     await asRole(c, 'authenticated', ADMIN_CLAIMS);
 *     await expectPgError(c, () => ..., '42501');
 *   });
 *
 * Key rules:
 * - seedAuthUser inserts user_allowlist (optional) + auth.users; the on_auth_user_created
 *   trigger creates the profiles row. Never insert profiles directly — that would
 *   collide with the trigger-created row on the same PK. Without an allowlist role the
 *   new profile is a monitor_user (20261106000400); seedRolelessUser gives role = NULL.
 * - Non-admin authenticated tests iterate NON_ADMIN_FIXTURES: a `sub` with no profiles
 *   row, a profile with role = NULL, and a profile with role = 'mylife_user'. The last
 *   two catch an is_admin() regression to "has a profile" / "role is not null".
 * - expectPgError wraps fn() in a SAVEPOINT so the transaction stays alive after the
 *   expected error (an unguarded error leaves the txn in 25P02 aborted state).
 * - withTx always issues ROLLBACK — no data persists to the cloud DB.
 */

import { randomUUID } from "node:crypto";
import type pg from "pg";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RlsRole = "anon" | "authenticated";
export type AppRole = "owner" | "admin" | "mylife_user";

export interface JwtClaims {
  /** Absent for anon: anon/publishable-key JWTs carry no `sub` claim. */
  sub?: string;
  role: "authenticated" | "anon";
  email?: string;
  /** Supabase puts these in every user JWT; the app must never read a role from them. */
  app_metadata?: Record<string, unknown>;
  user_metadata?: Record<string, unknown>;
}

// Stable UUIDs reused across test files — only ever inside rolled-back transactions.
export const ADMIN_UUID = "00000000-0000-0000-0000-000000000001";
export const NON_ADMIN_UUID = "00000000-0000-0000-0000-000000000002";
export const OWNER_UUID = "00000000-0000-0000-0000-000000000003";
export const NULL_ROLE_UUID = "00000000-0000-0000-0000-000000000004";
export const MYLIFE_UUID = "00000000-0000-0000-0000-000000000005";

export const ADMIN_EMAIL = "admin@test.local";
export const OWNER_EMAIL = "owner@test.local";
export const NULL_ROLE_EMAIL = "norole@test.local";
export const MYLIFE_EMAIL = "mylife@test.local";

// Matches a real anon request: no `sub` claim. An empty-string `sub` is not a valid
// JWT shape and makes Supabase's auth.uid() raise 22P02 (invalid uuid "").
export const ANON_CLAIMS: JwtClaims = { role: "anon" };
export const ADMIN_CLAIMS: JwtClaims = {
  sub: ADMIN_UUID,
  role: "authenticated",
  email: ADMIN_EMAIL,
};
export const NON_ADMIN_CLAIMS: JwtClaims = {
  sub: NON_ADMIN_UUID,
  role: "authenticated",
  email: "nonadmin@test.local",
};
export const OWNER_CLAIMS: JwtClaims = {
  sub: OWNER_UUID,
  role: "authenticated",
  email: OWNER_EMAIL,
};
export const NULL_ROLE_CLAIMS: JwtClaims = {
  sub: NULL_ROLE_UUID,
  role: "authenticated",
  email: NULL_ROLE_EMAIL,
};
export const MYLIFE_CLAIMS: JwtClaims = {
  sub: MYLIFE_UUID,
  role: "authenticated",
  email: MYLIFE_EMAIL,
};

/** An authenticated caller that must never pass private.is_admin(). */
export interface NonAdminFixture {
  label: string;
  claims: JwtClaims;
  /** Seeds the caller's auth.users/profiles rows (as postgres, before asRole). */
  seed: (client: pg.PoolClient) => Promise<void>;
}

export const NON_ADMIN_FIXTURES: readonly NonAdminFixture[] = [
  { label: "no profile row", claims: NON_ADMIN_CLAIMS, seed: async () => {} },
  {
    label: "profile role=null",
    claims: NULL_ROLE_CLAIMS,
    seed: (c) => seedRolelessUser(c, NULL_ROLE_UUID, NULL_ROLE_EMAIL),
  },
  {
    label: "profile role=mylife_user",
    claims: MYLIFE_CLAIMS,
    seed: (c) => seedAuthUser(c, MYLIFE_UUID, MYLIFE_EMAIL, "mylife_user"),
  },
];

/** Seed the admin user (allowlisted as 'admin') whose claims are ADMIN_CLAIMS. */
export async function seedAdmin(client: pg.PoolClient): Promise<void> {
  await seedAuthUser(client, ADMIN_UUID, ADMIN_EMAIL, "admin");
}

// ---------------------------------------------------------------------------
// Transaction wrapper — always rolls back
// ---------------------------------------------------------------------------

export async function withTx(
  client: pg.PoolClient,
  fn: (client: pg.PoolClient) => Promise<void>,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await fn(client);
  } finally {
    await client.query("ROLLBACK");
  }
}

// ---------------------------------------------------------------------------
// Role switching (call AFTER seeding, INSIDE withTx)
// ---------------------------------------------------------------------------

/**
 * SET LOCAL role + request.jwt.claims.
 * Must be called AFTER all postgres-level seeding in the same withTx block.
 * Subsequent queries run as the given Postgres role with the given JWT claims.
 */
export async function asRole(
  client: pg.PoolClient,
  role: RlsRole,
  claims: JwtClaims,
): Promise<void> {
  await client.query(`SET LOCAL role = ${role}`);
  await client.query(
    `SET LOCAL "request.jwt.claims" = '${JSON.stringify(claims)}'`,
  );
}

// ---------------------------------------------------------------------------
// Seeding helpers (run as postgres superuser, before asRole)
// ---------------------------------------------------------------------------

/**
 * Seed an authenticated user by inserting into auth.users.
 * The on_auth_user_created trigger fires and inserts into public.profiles with the role
 * drawn from user_allowlist. If appRole is given, a user_allowlist row is created first
 * so the trigger assigns that role. Without appRole there is no allowlist row, and since
 * 20261106000400 the trigger gives the new profile role = 'monitor_user' (a public
 * monitor sign-up), NOT role = NULL. A role = NULL profile needs the explicit clear in
 * seedRolelessUser.
 *
 * Never insert into profiles directly — that would collide on the PK when the trigger
 * also inserts.
 *
 * NOTE: The auth.users column set below covers what Supabase cloud requires as of
 * 2026-10-30. If the INSERT fails due to a missing NOT NULL column, web-developer should
 * inspect the actual schema (`\d auth.users` on the DB connection) and extend the INSERT.
 */
export async function seedAuthUser(
  client: pg.PoolClient,
  userId: string,
  email: string,
  appRole?: AppRole,
): Promise<void> {
  if (appRole) {
    await client.query(
      `INSERT INTO public.user_allowlist (email, role)
       VALUES ($1, $2)
       ON CONFLICT (email) DO NOTHING`,
      [email, appRole],
    );
  }
  // Trigger on_auth_user_created (private.handle_new_user): INSERT INTO public.profiles
  // (user_id, email, role) VALUES (new.id, lower(btrim(new.email)),
  // coalesce((SELECT role FROM user_allowlist WHERE email = lower(btrim(new.email))), 'monitor_user'))
  await client.query(
    `INSERT INTO auth.users
       (id, aud, role, email, email_confirmed_at, created_at, updated_at,
        raw_app_meta_data, raw_user_meta_data, is_super_admin, encrypted_password)
     VALUES ($1, 'authenticated', 'authenticated', $2, now(), now(), now(),
             '{}'::jsonb, '{}'::jsonb, false, '')`,
    [userId, email],
  );
}

/**
 * Seed an account whose profiles row has role = NULL: a staff account whose allowlist row
 * was deleted (the allowlist sync clears its role). seedAuthUser without an allowlist role
 * yields a monitor_user since 20261106000400, which is no stand-in for it — allowlist
 * writes for a monitor_user's email raise P0001 instead of granting (rls-monitor-signup)
 * and its login email changes keep the role — so the role is cleared right after creation.
 * Throws unless exactly one profiles row was cleared, so the fixture cannot drift silently.
 */
export async function seedRolelessUser(client: pg.PoolClient, userId: string, email: string): Promise<void> {
  await seedAuthUser(client, userId, email);
  const cleared = await client.query("UPDATE public.profiles SET role = NULL WHERE user_id = $1", [userId]);
  if (cleared.rowCount !== 1) throw new Error(`role=null setup: no profiles row to clear for ${userId}`);
}

/**
 * Insert a published page as postgres (bypasses RLS). Returns the generated UUID.
 */
export async function seedPublishedPage(client: pg.PoolClient): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO public.pages (status, published_at)
     VALUES ('published', now())
     RETURNING id`,
  );
  return rows[0]!.id;
}

/**
 * Insert a draft page as postgres. Returns the generated UUID.
 */
export async function seedDraftPage(client: pg.PoolClient): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO public.pages (status)
     VALUES ('draft')
     RETURNING id`,
  );
  return rows[0]!.id;
}

/**
 * Insert a page_translation as postgres. DA title must be non-empty.
 */
export async function seedPageTranslation(
  client: pg.PoolClient,
  pageId: string,
  locale: "da" | "en",
  title: string = locale === "da" ? "Testside" : "",
): Promise<void> {
  await client.query(
    `INSERT INTO public.page_translations (page_id, locale, title)
     VALUES ($1, $2, $3)
     ON CONFLICT (page_id, locale) DO NOTHING`,
    [pageId, locale, title],
  );
}

/**
 * Insert a category as postgres and return its UUID.
 * status='published' means the category may be visible once it has a published item.
 */
export async function seedCategory(
  client: pg.PoolClient,
  opts: { status?: "draft" | "published" } = {},
): Promise<string> {
  const { status = "published" } = opts;
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO public.categories (kind, status) VALUES ('apps', $1) RETURNING id`,
    [status],
  );
  return rows[0]!.id;
}

/**
 * Insert a category_translation as postgres. DA title must be non-empty.
 */
export async function seedCategoryTranslation(
  client: pg.PoolClient,
  categoryId: string,
  locale: "da" | "en",
): Promise<void> {
  const title = locale === "da" ? "Testkategori" : "";
  await client.query(
    `INSERT INTO public.category_translations (category_id, locale, title)
     VALUES ($1, $2, $3)
     ON CONFLICT (category_id, locale) DO NOTHING`,
    [categoryId, locale, title],
  );
}

/**
 * Insert an item belonging to a category as postgres. Returns the item UUID.
 */
export async function seedItem(
  client: pg.PoolClient,
  categoryId: string,
  status: "draft" | "published" = "draft",
): Promise<string> {
  // Pass new Date() for published_at so pg serialises a real timestamptz value.
  // Never pass the string 'now()' as a $N parameter — that raises 22007.
  const publishedAt = status === "published" ? new Date() : null;
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO public.items (category_id, status, published_at)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [categoryId, status, publishedAt],
  );
  return rows[0]!.id;
}

/**
 * Insert an item_translation as postgres. Slug must be unique per locale.
 */
export async function seedItemTranslation(
  client: pg.PoolClient,
  itemId: string,
  locale: "da" | "en",
  slug: string,
): Promise<void> {
  const title = locale === "da" ? "Testprodukt" : "";
  await client.query(
    `INSERT INTO public.item_translations (item_id, locale, slug, title)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (item_id, locale) DO NOTHING`,
    [itemId, locale, slug, title],
  );
}

/**
 * Insert the site_settings singleton as postgres if it does not yet exist.
 */
export async function seedSiteSettings(client: pg.PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO public.site_settings (company_name, contact_email)
     VALUES ('TestCo', 'test@example.com')
     ON CONFLICT (id) DO NOTHING`,
  );
}

/**
 * Insert a routes row as postgres pointing at exactly one page or category.
 * Slugs must avoid the reserved list and be unique per locale.
 */
export async function seedRoute(
  client: pg.PoolClient,
  locale: "da" | "en",
  slug: string,
  target: { pageId: string } | { categoryId: string },
): Promise<void> {
  const pageId = "pageId" in target ? target.pageId : null;
  const categoryId = "categoryId" in target ? target.categoryId : null;
  await client.query(
    "INSERT INTO public.routes (locale, slug, page_id, category_id) VALUES ($1, $2, $3, $4)",
    [locale, slug, pageId, categoryId],
  );
}

/**
 * Insert a media row for an item as postgres. Returns the media UUID.
 * The path is a fresh `items/{itemId}/{uuid}.webp` (the `media_storage_path_valid`
 * CHECK), so repeated calls for one item never collide on `media_storage_path_key`.
 */
export async function seedMedia(client: pg.PoolClient, itemId: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO public.media (item_id, storage_path, alt_da, width, height, mime_type)
     VALUES ($1, $2, 'Testbillede', 100, 100, 'image/webp')
     RETURNING id`,
    [itemId, `items/${itemId}/${randomUUID()}.webp`],
  );
  return rows[0]!.id;
}

/**
 * Insert a row into storage.objects for the 'media' bucket as postgres
 * (bypasses RLS). Returns the object name (path). Used by catalog RLS tests
 * that need a storage object to exist before calling admin_attach_media.
 *
 * Minimal columns only; Supabase storage won't need file content for RLS tests.
 * `metadata` is what the Storage API would record (e.g. `{ mimetype: 'image/png' }`
 * for the upload's declared type); the default records no type.
 */
export async function seedStorageObject(
  client: pg.PoolClient,
  path: string,
  metadata: Record<string, unknown> | null = { size: 1024 },
): Promise<string> {
  await client.query(
    `INSERT INTO storage.objects (bucket_id, name, owner_id, metadata)
     VALUES ('media', $1, NULL, $2::jsonb)`,
    [path, metadata === null ? null : JSON.stringify(metadata)],
  );
  return path;
}

/**
 * Look up a seeded system page (migration 20261101000300) by system_key.
 * Run as postgres or admin; anon/non-admin see it too since system pages are published.
 */
export async function systemPageId(
  client: pg.PoolClient,
  key: "home" | "contact" | "privacy",
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    "SELECT id FROM public.pages WHERE system_key = $1",
    [key],
  );
  if (rows.length !== 1) throw new Error(`system page '${key}' not found (seed migration missing?)`);
  return rows[0]!.id;
}

// ---------------------------------------------------------------------------
// Error assertion helper with SAVEPOINT isolation
// ---------------------------------------------------------------------------

/**
 * Assert that fn() throws a pg error with the given SQLSTATE code and, when
 * `opts.messageIncludes` is set, a message containing that text. Use the message
 * check when several constraints raise the same SQLSTATE and the test must prove
 * which one fired (e.g. a trigger vs a CHECK constraint, both 23514).
 *
 * Wraps fn() in SAVEPOINT / ROLLBACK TO SAVEPOINT so the transaction is restored
 * to a usable state after the expected error. Without this, any query after an
 * unhandled error would fail with 25P02 (in_failed_sql_transaction).
 *
 * ROLLBACK TO SAVEPOINT is allowed inside an aborted transaction — it clears the
 * aborted state and restores the transaction to the pre-savepoint snapshot.
 */
export async function expectPgError(
  client: pg.PoolClient,
  fn: () => Promise<unknown>,
  code: string,
  label?: string,
  opts: { messageIncludes?: string } = {},
): Promise<void> {
  // Use a random suffix so nested/sequential calls in one transaction don't collide.
  const sp = `sp_${Math.random().toString(36).slice(2, 10)}`;
  await client.query(`SAVEPOINT ${sp}`);

  let thrown: unknown;
  try {
    await fn();
    // fn() succeeded without error — release the savepoint normally.
    await client.query(`RELEASE SAVEPOINT ${sp}`);
  } catch (e) {
    thrown = e;
    // Transaction is now in aborted state (25P02).
    // ROLLBACK TO restores the snapshot AND clears the aborted state.
    await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    await client.query(`RELEASE SAVEPOINT ${sp}`);
  }

  const prefix = label ? `[${label}] ` : "";
  if (!thrown) throw new Error(`${prefix}Expected SQLSTATE ${code} but no error was thrown`);

  let actualCode: string | undefined;
  let message = "unknown error";
  if (thrown && typeof thrown === "object") {
    if ("code" in thrown && typeof thrown.code === "string") actualCode = thrown.code;
    if ("message" in thrown && typeof thrown.message === "string") message = thrown.message;
  }

  if (actualCode !== code) {
    throw new Error(`${prefix}Expected SQLSTATE ${code} but got ${actualCode}: ${message}`);
  }
  if (opts.messageIncludes !== undefined && !message.includes(opts.messageIncludes)) {
    throw new Error(
      `${prefix}Expected SQLSTATE ${code} with message containing "${opts.messageIncludes}" but got: ${message}`,
    );
  }
}
