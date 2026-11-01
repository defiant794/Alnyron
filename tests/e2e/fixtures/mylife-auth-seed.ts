/**
 * E2E seed helpers — mylife auth
 * Journey: mylife-login  ML-AC2..ML-AC15
 *
 * Mirrors tests/e2e/fixtures/admin-auth-seed.ts for the mylife_user role.
 * Adds:
 *   - bleed-admin: a plain admin user for privilege-bleed test (admin → mylife/no-access)
 *   - owner: an owner for privilege-bleed test (owner → mylife accessible)
 *   - invite: a fresh @alnyron-test.local account for invite flow (ML-AC14)
 *
 * All e2e accounts use @alnyron-test.local domain and are swept by sweepE2eTestUsers.
 */
import type pg from "pg";
import { DB_AVAILABLE, endPool } from "../../integration/rls/helpers/db";
import {
  E2E_EMAIL_DOMAIN,
  SECRET_KEY_AVAILABLE,
  sweepE2eTestUsers,
  randomE2ePassword,
  generateAuthLink,
} from "./admin-auth-seed";

export {
  DB_AVAILABLE,
  endPool,
  sweepE2eTestUsers,
  randomE2ePassword,
  generateAuthLink,
  E2E_EMAIL_DOMAIN,
  SECRET_KEY_AVAILABLE,
};

// ── Constants ─────────────────────────────────────────────────────────────────

export const E2E_MYLIFE_EMAIL = `e2e-mylife@${E2E_EMAIL_DOMAIN}`;
export const E2E_MYLIFE_UUID = "00000000-0000-0000-e2e0-000000000010";

export const E2E_MYLIFE_RESET_EMAIL = `e2e-mylife-reset@${E2E_EMAIL_DOMAIN}`;
export const E2E_MYLIFE_RESET_UUID = "00000000-0000-0000-e2e0-000000000011";

/** Separate admin for bleed test so it never races login/reset describe blocks. */
export const E2E_BLEED_ADMIN_EMAIL = `e2e-bleed-admin@${E2E_EMAIL_DOMAIN}`;
export const E2E_BLEED_ADMIN_UUID = "00000000-0000-0000-e2e0-000000000012";

/** Owner for bleed test — verifies owner can access the MyLife panel. */
export const E2E_OWNER_EMAIL = `e2e-owner@${E2E_EMAIL_DOMAIN}`;
export const E2E_OWNER_UUID = "00000000-0000-0000-e2e0-000000000013";

/** Fresh email for invite-flow test (ML-AC14). Cleaned up after each block. */
export const E2E_MYLIFE_INVITE_EMAIL = `e2e-mylife-invite@${E2E_EMAIL_DOMAIN}`;

// ── Shared insert helper ──────────────────────────────────────────────────────

async function insertUser(
  client: pg.PoolClient,
  id: string,
  email: string,
  role: "admin" | "mylife_user" | "owner",
  password: string,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO public.user_allowlist (email, role)
       VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET role = $2`,
      [email, role],
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
      [id, email, encrypted],
    );
    await client.query(
      `INSERT INTO auth.identities
         (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
       VALUES ($1::text, $2,
               jsonb_build_object('sub', $1::text, 'email', $3::text),
               'email', now(), now(), now())
       ON CONFLICT (provider, provider_id) DO NOTHING`,
      [id, id, email],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

async function deleteUser(client: pg.PoolClient, id: string, email: string): Promise<void> {
  await client.query(`DELETE FROM auth.users WHERE id = $1`, [id]);
  await client.query(`DELETE FROM public.user_allowlist WHERE email = $1`, [email]);
}

// ── mylife_user ───────────────────────────────────────────────────────────────

export async function seedE2eMyLifeUser(client: pg.PoolClient, password: string): Promise<void> {
  await insertUser(client, E2E_MYLIFE_UUID, E2E_MYLIFE_EMAIL, "mylife_user", password);
}

export async function cleanupE2eMyLifeUser(client: pg.PoolClient): Promise<void> {
  await deleteUser(client, E2E_MYLIFE_UUID, E2E_MYLIFE_EMAIL);
}

// ── mylife_user for reset flow ────────────────────────────────────────────────

export async function seedE2eMyLifeResetUser(client: pg.PoolClient, password: string): Promise<void> {
  await insertUser(client, E2E_MYLIFE_RESET_UUID, E2E_MYLIFE_RESET_EMAIL, "mylife_user", password);
}

export async function cleanupE2eMyLifeResetUser(client: pg.PoolClient): Promise<void> {
  await deleteUser(client, E2E_MYLIFE_RESET_UUID, E2E_MYLIFE_RESET_EMAIL);
}

// ── Bleed-admin (plain admin for privilege-bleed test) ────────────────────────

export async function seedE2eBleedAdmin(client: pg.PoolClient, password: string): Promise<void> {
  await insertUser(client, E2E_BLEED_ADMIN_UUID, E2E_BLEED_ADMIN_EMAIL, "admin", password);
}

export async function cleanupE2eBleedAdmin(client: pg.PoolClient): Promise<void> {
  await deleteUser(client, E2E_BLEED_ADMIN_UUID, E2E_BLEED_ADMIN_EMAIL);
}

// ── Owner (for privilege-bleed test: owner can access MyLife) ─────────────────

export async function seedE2eOwner(client: pg.PoolClient, password: string): Promise<void> {
  await insertUser(client, E2E_OWNER_UUID, E2E_OWNER_EMAIL, "owner", password);
}

export async function cleanupE2eOwner(client: pg.PoolClient): Promise<void> {
  await deleteUser(client, E2E_OWNER_UUID, E2E_OWNER_EMAIL);
}

// ── Invite: mylife_user (ML-AC14 role-aware confirm) ─────────────────────────

/** Remove the mylife invite user — call before and after the invite describe block. */
export async function cleanupE2eMyLifeInviteUser(client: pg.PoolClient): Promise<void> {
  await client.query(`DELETE FROM auth.users WHERE email = $1`, [E2E_MYLIFE_INVITE_EMAIL]);
  await client.query(`DELETE FROM public.user_allowlist WHERE email = $1`, [E2E_MYLIFE_INVITE_EMAIL]);
}
