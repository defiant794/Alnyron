/**
 * E2E seed helpers — monitor web area
 *
 * Approach: cloud-only (no local Docker / Mailpit).
 *   - Login/logout: seed a real password-enabled monitor_user via pg.
 *   - Email verification / invite: generate_link(type=signup) token then
 *     /auth/confirm — no inbox required.
 *   - Access-control bleed tests: reuse seeded admin and owner from admin-auth-seed.
 *
 * Emails are under E2E_EMAIL_DOMAIN so the global sweep removes them.
 * DB_AVAILABLE guards pg-dependent tests; SECRET_KEY_AVAILABLE guards
 * generate_link tests.
 */
import type pg from "pg";
import {
  E2E_EMAIL_DOMAIN,
  SECRET_KEY_AVAILABLE,
  DB_AVAILABLE,
  endPool,
  randomE2ePassword,
  generateAuthLink,
  sweepE2eTestUsers,
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

export const E2E_MONITOR_EMAIL = `e2e-monitor@${E2E_EMAIL_DOMAIN}`;
export const E2E_MONITOR_UUID = "00000000-0000-0000-e2e0-000000000020";

export const E2E_MONITOR_RESET_EMAIL = `e2e-monitor-reset@${E2E_EMAIL_DOMAIN}`;
export const E2E_MONITOR_RESET_UUID = "00000000-0000-0000-e2e0-000000000021";

/** Used for the privilege-bleed tests: a non-owner admin. */
export const E2E_MONITOR_BLEED_ADMIN_EMAIL = `e2e-monitor-bleed-admin@${E2E_EMAIL_DOMAIN}`;
export const E2E_MONITOR_BLEED_ADMIN_UUID = "00000000-0000-0000-e2e0-000000000022";

/** Owner: may enter both monitor and admin/mylife panels. */
export const E2E_MONITOR_OWNER_EMAIL = `e2e-monitor-owner@${E2E_EMAIL_DOMAIN}`;
export const E2E_MONITOR_OWNER_UUID = "00000000-0000-0000-e2e0-000000000023";

/** mylife_user for privilege-bleed: must be blocked by /monitor panel. */
export const E2E_MONITOR_MYLIFE_EMAIL = `e2e-monitor-mylife@${E2E_EMAIL_DOMAIN}`;
export const E2E_MONITOR_MYLIFE_UUID = "00000000-0000-0000-e2e0-000000000024";

/** Email used for the public signup e2e test; created via generate_link(signup). */
export const E2E_MONITOR_SIGNUP_EMAIL = `e2e-monitor-signup@${E2E_EMAIL_DOMAIN}`;

/** A second monitor_user whose monitors the first must never reach (MON-AC39). */
export const E2E_MONITOR_OTHER_EMAIL = `e2e-monitor-other@${E2E_EMAIL_DOMAIN}`;
export const E2E_MONITOR_OTHER_UUID = "00000000-0000-0000-e2e0-000000000025";

/** monitor_user seeded WITHOUT an explicit monitor_limit — relies on the column
 *  default (2, set by migration 20261107000300). Used exclusively by MCH-E10. */
export const E2E_MONITOR_CAP2_EMAIL = `e2e-monitor-cap2@${E2E_EMAIL_DOMAIN}`;
export const E2E_MONITOR_CAP2_UUID = "00000000-0000-0000-e2e0-000000000026";

/** monitor_user of the monitor-ship-routing spec (Monitor-host 404s, recovery on the Monitor host). */
export const E2E_MONITOR_SHIP_EMAIL = `e2e-monitor-ship@${E2E_EMAIL_DOMAIN}`;
export const E2E_MONITOR_SHIP_UUID = "00000000-0000-0000-e2e0-000000000027";

// ── Shared insert helper ───────────────────────────────────────────────────────

/**
 * Insert a password-enabled, confirmed user into auth.users + auth.identities
 * (allowlist row first for admin/owner/mylife_user; monitor_user gets its
 * profile from handle_new_user, then an explicit monitor_limit of 5).
 */
export async function insertUser(
  client: pg.PoolClient,
  id: string,
  email: string,
  role: "admin" | "mylife_user" | "owner" | "monitor_user",
  password: string,
  /** When false, skip the explicit monitor_limit upsert so the trigger-created
   *  profile retains the column default. Only meaningful for monitor_user. */
  explicitLimit = true,
  /** auth.users.created_at (ISO timestamp); now() when omitted. */
  createdAt?: string,
): Promise<void> {
  await client.query("BEGIN");
  try {
    if (role === "monitor_user") {
      // No allowlist row for monitor_user (public signup path).
      // handle_new_user (migration 0400) fires an AFTER INSERT trigger on
      // auth.users and inserts the profile row with role='monitor_user' and
      // no explicit monitor_limit — the column default applies.
      // When explicitLimit=true (the default) the upsert below overrides the
      // default to 5; when false the trigger-created row is left untouched.
    } else {
      await client.query(
        `INSERT INTO public.user_allowlist (email, role)
         VALUES ($1, $2)
         ON CONFLICT (email) DO UPDATE SET role = $2`,
        [email, role],
      );
    }

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
               coalesce($4::timestamptz, now()), now(), '{}', '{}', false, '', '', '', '', '')
       ON CONFLICT (id) DO NOTHING`,
      [id, email, encrypted, createdAt ?? null],
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

    // For monitor_user: upsert profile with explicit monitor_limit = 5 (the
    // seeded cap used by most e2e tests). Pass explicitLimit=false to let the
    // trigger-created profile keep the column default instead (MCH-E10).
    if (role === "monitor_user" && explicitLimit) {
      await client.query(
        `INSERT INTO public.profiles (user_id, email, role, monitor_limit)
         VALUES ($1, $2, 'monitor_user', 5)
         ON CONFLICT (user_id) DO UPDATE SET monitor_limit = 5`,
        [id, email],
      );
    }

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

/** Delete the auth user (profile and monitors cascade) and its allowlist row. */
export async function deleteUser(client: pg.PoolClient, id: string, email: string): Promise<void> {
  await client.query(`DELETE FROM auth.users WHERE id = $1`, [id]);
  await client.query(`DELETE FROM public.user_allowlist WHERE email = $1`, [email]);
}

// ── monitor_user ──────────────────────────────────────────────────────────────

export async function seedE2eMonitorUser(client: pg.PoolClient, password: string): Promise<void> {
  await insertUser(client, E2E_MONITOR_UUID, E2E_MONITOR_EMAIL, "monitor_user", password);
}

export async function cleanupE2eMonitorUser(client: pg.PoolClient): Promise<void> {
  await deleteUser(client, E2E_MONITOR_UUID, E2E_MONITOR_EMAIL);
}

// ── monitor_user with column-default cap (MCH-E10) ───────────────────────────

/** Seed a monitor_user without an explicit monitor_limit so handle_new_user's
 *  trigger-created profile keeps the column default (2, set by migration
 *  20261107000300). If the trigger did not fire the test will fail fast — no
 *  fallback insert, by design. */
export async function seedE2eMonitorCap2User(
  client: pg.PoolClient,
  password: string,
): Promise<void> {
  await insertUser(client, E2E_MONITOR_CAP2_UUID, E2E_MONITOR_CAP2_EMAIL, "monitor_user", password, false);
}

export async function cleanupE2eMonitorCap2User(client: pg.PoolClient): Promise<void> {
  await deleteUser(client, E2E_MONITOR_CAP2_UUID, E2E_MONITOR_CAP2_EMAIL);
}

// ── monitor_user for reset flow ───────────────────────────────────────────────

export async function seedE2eMonitorResetUser(client: pg.PoolClient, password: string): Promise<void> {
  await insertUser(client, E2E_MONITOR_RESET_UUID, E2E_MONITOR_RESET_EMAIL, "monitor_user", password);
}

export async function cleanupE2eMonitorResetUser(client: pg.PoolClient): Promise<void> {
  await deleteUser(client, E2E_MONITOR_RESET_UUID, E2E_MONITOR_RESET_EMAIL);
}

// ── monitor_user for the monitor-ship-routing spec ────────────────────────────

export async function seedE2eMonitorShipUser(client: pg.PoolClient, password: string): Promise<void> {
  await insertUser(client, E2E_MONITOR_SHIP_UUID, E2E_MONITOR_SHIP_EMAIL, "monitor_user", password);
}

export async function cleanupE2eMonitorShipUser(client: pg.PoolClient): Promise<void> {
  await deleteUser(client, E2E_MONITOR_SHIP_UUID, E2E_MONITOR_SHIP_EMAIL);
}

// ── second monitor_user (another account's monitors) ──────────────────────────

export async function seedE2eMonitorOtherUser(client: pg.PoolClient, password: string): Promise<void> {
  await insertUser(client, E2E_MONITOR_OTHER_UUID, E2E_MONITOR_OTHER_EMAIL, "monitor_user", password);
}

export async function cleanupE2eMonitorOtherUser(client: pg.PoolClient): Promise<void> {
  await deleteUser(client, E2E_MONITOR_OTHER_UUID, E2E_MONITOR_OTHER_EMAIL);
}

// ── Bleed-admin ───────────────────────────────────────────────────────────────

export async function seedE2eMonitorBleedAdmin(client: pg.PoolClient, password: string): Promise<void> {
  await insertUser(client, E2E_MONITOR_BLEED_ADMIN_UUID, E2E_MONITOR_BLEED_ADMIN_EMAIL, "admin", password);
}

export async function cleanupE2eMonitorBleedAdmin(client: pg.PoolClient): Promise<void> {
  await deleteUser(client, E2E_MONITOR_BLEED_ADMIN_UUID, E2E_MONITOR_BLEED_ADMIN_EMAIL);
}

// ── Owner ─────────────────────────────────────────────────────────────────────

export async function seedE2eMonitorOwner(client: pg.PoolClient, password: string): Promise<void> {
  await insertUser(client, E2E_MONITOR_OWNER_UUID, E2E_MONITOR_OWNER_EMAIL, "owner", password);
}

export async function cleanupE2eMonitorOwner(client: pg.PoolClient): Promise<void> {
  await deleteUser(client, E2E_MONITOR_OWNER_UUID, E2E_MONITOR_OWNER_EMAIL);
}

// ── MyLife user for bleed test ────────────────────────────────────────────────

export async function seedE2eMonitorMyLifeUser(client: pg.PoolClient, password: string): Promise<void> {
  await insertUser(client, E2E_MONITOR_MYLIFE_UUID, E2E_MONITOR_MYLIFE_EMAIL, "mylife_user", password);
}

export async function cleanupE2eMonitorMyLifeUser(client: pg.PoolClient): Promise<void> {
  await deleteUser(client, E2E_MONITOR_MYLIFE_UUID, E2E_MONITOR_MYLIFE_EMAIL);
}

/** Remove the e2e signup test user (monitor_user created via generate_link). */
export async function cleanupE2eMonitorSignupUser(client: pg.PoolClient): Promise<void> {
  await client.query(`DELETE FROM auth.users WHERE email = $1`, [E2E_MONITOR_SIGNUP_EMAIL]);
}

// ── Monitor row helpers ───────────────────────────────────────────────────────

/** Seed N monitors for the given userId (as postgres, bypassing RLS). Returns their ids. */
export async function seedMonitors(
  client: pg.PoolClient,
  userId: string,
  count: number,
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO public.monitors (user_id, url, label, interval_minutes)
       VALUES ($1, $2, $3, 1440) RETURNING id`,
      [userId, `https://example-${i}.com/`, `Monitor ${i + 1}`],
    );
    ids.push(rows[0]!.id);
  }
  return ids;
}

/** Delete all monitors for a userId (as postgres). */
export async function cleanupMonitors(client: pg.PoolClient, userId: string): Promise<void> {
  await client.query(`DELETE FROM public.monitors WHERE user_id = $1`, [userId]);
}

/** Seed a monitor event (as postgres, bypassing RLS — cron writes these). */
export async function seedMonitorEvent(
  client: pg.PoolClient,
  monitorId: string,
  userId: string,
  detectedAt: string,
  summary: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO public.monitor_events (monitor_id, user_id, old_hash, new_hash, summary, detected_at)
     VALUES ($1, $2, 'oldhash', 'newhash', $3, $4::timestamptz) RETURNING id`,
    [monitorId, userId, summary, detectedAt],
  );
  return rows[0]!.id;
}
