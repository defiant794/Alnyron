/**
 * E2E seed helpers — admin auth (F1.1)
 *
 * Approach: cloud-only (no local Supabase / Docker).
 *   - Login/logout tests: seed a real password-enabled admin user via pg
 *     (bcrypt via pgcrypto's crypt() + an auth.identities row), then clean up.
 *   - Reset / invite flows: call the Supabase admin REST endpoint
 *     POST /auth/v1/admin/generate_link with SUPABASE_SECRET_KEY to obtain the
 *     action_link directly — no email / Mailpit required.
 *
 * SUPABASE_SECRET_KEY is the project's service-role key (from the Supabase
 * dashboard → Project Settings → API).  It lives in the git-ignored
 * `tests/.env.e2e` (never `.env.local`, which OpenNext compiles into the
 * Worker) and is used ONLY here, never in app code.
 *
 * The users are real admin logins on the production Supabase project while a
 * run lasts, so every password is random per run (`randomE2ePassword`) and
 * every user is deleted before and after its block; the Playwright global
 * setup/teardown (`sweepE2eTestUsers`) also removes any leftover
 * `@alnyron-test.local` account from an aborted run.
 *
 * DB_AVAILABLE guards pg-dependent tests; SECRET_KEY_AVAILABLE additionally
 * guards the generate_link calls.  Tests skip gracefully when either is absent.
 */

import { randomBytes } from "node:crypto";
import type pg from "pg";
import { DB_AVAILABLE, getClient, endPool } from "../../integration/rls/helpers/db";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Reserved domain of every e2e account; `sweepE2eTestUsers` deletes them all. */
export const E2E_EMAIL_DOMAIN = "alnyron-test.local";

export const E2E_ADMIN_EMAIL = `e2e-admin@${E2E_EMAIL_DOMAIN}`;
/** Stable UUID — only used inside cleaned-up e2e runs. */
export const E2E_ADMIN_UUID = "00000000-0000-0000-e2e0-000000000001";

/** Separate user for the Reset describe so it never races Login on E2E_ADMIN_UUID. */
export const E2E_RESET_ADMIN_EMAIL = `e2e-reset-admin@${E2E_EMAIL_DOMAIN}`;
export const E2E_RESET_ADMIN_UUID = "00000000-0000-0000-e2e0-000000000002";

export const E2E_INVITE_EMAIL = `e2e-invite@${E2E_EMAIL_DOMAIN}`;

// SECRET_KEY_AVAILABLE requires SUPABASE_SECRET_KEY in tests/.env.e2e (loaded
// by playwright.config.ts via e2eEnv).  Add the service-role key from the
// Supabase dashboard → Project Settings → API.  NEVER ship it to the Worker.
export const SECRET_KEY_AVAILABLE =
  DB_AVAILABLE &&
  !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
  !!process.env.SUPABASE_SECRET_KEY;

/**
 * A fresh password for one e2e user, never committed: the e2e accounts are
 * admin logins on the production project while they exist. 24 random bytes
 * (32 base64url characters) plus a fixed tail covering every Supabase
 * `password_requirements` class; 36 characters clears the 12-character minimum
 * and stays far below bcrypt's 72-byte limit.
 */
export function randomE2ePassword(): string {
  return `${randomBytes(24).toString("base64url")}aA1!`;
}

// ── User seeding via pg ───────────────────────────────────────────────────────

/**
 * Seed a password-enabled admin user on the cloud DB inside one transaction.
 * BEGIN/COMMIT ensures all three steps land atomically — no partial state if
 * the identities INSERT fails mid-run.
 *
 * Steps:
 *  1. Upsert allowlist → trigger assigns role 'admin' on profiles.
 *  2. Insert auth.users with a bcrypt-hashed password (pgcrypto crypt()).
 *     instance_id must be the nil UUID: GoTrue filters users by instance_id.
 *     Token columns must be '': GoTrue errors on NULL values.
 *     The on_auth_user_created trigger creates the profiles row.
 *  3. Insert auth.identities so GoTrue can authenticate via email+password.
 *     $3::text: explicit cast so Postgres resolves the type inside jsonb_build_object.
 */
export async function seedE2eAdmin(client: pg.PoolClient, password: string): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO public.user_allowlist (email, role)
       VALUES ($1, 'admin')
       ON CONFLICT (email) DO UPDATE SET role = 'admin'`,
      [E2E_ADMIN_EMAIL],
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
      [E2E_ADMIN_UUID, E2E_ADMIN_EMAIL, encrypted],
    );

    await client.query(
      `INSERT INTO auth.identities
         (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
       VALUES ($1::text, $2,
               jsonb_build_object('sub', $1::text, 'email', $3::text),
               'email', now(), now(), now())
       ON CONFLICT (provider, provider_id) DO NOTHING`,
      [E2E_ADMIN_UUID, E2E_ADMIN_UUID, E2E_ADMIN_EMAIL],
    );

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

/** Remove the e2e admin user and allowlist entry. Cascades to profiles. */
export async function cleanupE2eAdmin(client: pg.PoolClient): Promise<void> {
  await client.query(`DELETE FROM auth.users WHERE id = $1`, [E2E_ADMIN_UUID]);
  await client.query(`DELETE FROM public.user_allowlist WHERE email = $1`, [E2E_ADMIN_EMAIL]);
}

/** Seed a separate admin user for the Reset flow (distinct UUID/email from Login). */
export async function seedE2eResetAdmin(client: pg.PoolClient, password: string): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO public.user_allowlist (email, role)
       VALUES ($1, 'admin')
       ON CONFLICT (email) DO UPDATE SET role = 'admin'`,
      [E2E_RESET_ADMIN_EMAIL],
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
      [E2E_RESET_ADMIN_UUID, E2E_RESET_ADMIN_EMAIL, encrypted],
    );
    await client.query(
      `INSERT INTO auth.identities
         (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
       VALUES ($1::text, $2,
               jsonb_build_object('sub', $1::text, 'email', $3::text),
               'email', now(), now(), now())
       ON CONFLICT (provider, provider_id) DO NOTHING`,
      [E2E_RESET_ADMIN_UUID, E2E_RESET_ADMIN_UUID, E2E_RESET_ADMIN_EMAIL],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

/** Remove the reset-flow e2e admin user and allowlist entry. */
export async function cleanupE2eResetAdmin(client: pg.PoolClient): Promise<void> {
  await client.query(`DELETE FROM auth.users WHERE id = $1`, [E2E_RESET_ADMIN_UUID]);
  await client.query(`DELETE FROM public.user_allowlist WHERE email = $1`, [E2E_RESET_ADMIN_EMAIL]);
}

/** Remove the e2e invite user (auth.users + allowlist). Cascades to profiles. */
export async function cleanupE2eInviteUser(client: pg.PoolClient): Promise<void> {
  await client.query(`DELETE FROM auth.users WHERE email = $1`, [E2E_INVITE_EMAIL]);
  await client.query(`DELETE FROM public.user_allowlist WHERE email = $1`, [E2E_INVITE_EMAIL]);
}

/**
 * Delete every `@alnyron-test.local` account and allowlist entry, including
 * leftovers of an aborted run (auth.users cascades to identities, sessions and
 * profiles). Run only while no e2e block is active: the Playwright global
 * setup and teardown (tests/e2e/sweep-test-users.ts) call it.
 */
export async function sweepE2eTestUsers(client: pg.PoolClient): Promise<void> {
  const pattern = `%@${E2E_EMAIL_DOMAIN}`;
  await client.query(`DELETE FROM auth.users WHERE lower(email) LIKE $1`, [pattern]);
  await client.query(`DELETE FROM public.user_allowlist WHERE email LIKE $1`, [pattern]);
}

// ── generate_link via Supabase admin REST API ─────────────────────────────────

export type GenerateLinkType = "recovery" | "invite";

interface GenerateLinkResponse {
  action_link: string;
  hashed_token: string;
  verification_type: string;
}

/**
 * Call POST /auth/v1/admin/generate_link with the service-role key.
 * Returns the confirmation URL built the same way the DA email template does:
 *   {SiteURL}/auth/confirm?token_hash={hashed_token}&type={verification_type}
 * (not `action_link`, which points to GoTrue's own /auth/v1/verify and triggers
 * the implicit-flow fragment redirect — the browser would visit /auth/confirm
 * without token_hash/type and the route would reject it as link_invalid).
 *
 * @param confirmUrl  Base URL for the confirm link (e.g. `${baseUrl}/auth/confirm?next=...`).
 *   token_hash and type are appended from the generate_link response, matching the DA email
 *   template. NOT forwarded to GoTrue as `options.redirectTo`.
 *
 * For 'invite': seeds the allowlist first so hook_before_user_created passes.
 * For 'recovery': the user must already exist (call seedE2eAdmin first).
 */
export async function generateAuthLink(
  type: GenerateLinkType,
  email: string,
  confirmUrl: string,
  role: "admin" | "mylife_user" = "admin",
): Promise<string> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SECRET_KEY!;

  if (type === "invite") {
    // Seed allowlist before generating the invite so the before_user_created
    // hook allows the new account. The role determines which area the user
    // enters; callers default to 'admin' so existing usages are unchanged.
    const client = await getClient();
    try {
      await client.query(
        `INSERT INTO public.user_allowlist (email, role)
         VALUES ($1, $2)
         ON CONFLICT (email) DO UPDATE SET role = $2`,
        [email, role],
      );
    } finally {
      client.release();
    }
  }

  const response = await fetch(`${url}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      apikey: key,
    },
    body: JSON.stringify({ type, email }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`generate_link failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as GenerateLinkResponse;
  // Build the link the way the email template does:
  // {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=<type>&next=...
  const link = new URL(confirmUrl);
  link.searchParams.set("token_hash", data.hashed_token);
  link.searchParams.set("type", data.verification_type);
  return link.toString();
}

// ── Pool lifecycle and re-exports ────────────────────────────────────────────
// DB_AVAILABLE re-exported so the spec can guard login tests without an extra
// import from the db helper.
export { DB_AVAILABLE, endPool };
