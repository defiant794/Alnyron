/**
 * E2E seed helpers — admin Monitor-brugere page (admin-monitor-users-cleanup)
 *
 * Uses DEDICATED UUIDs so this spec never races admin-auth.spec.ts
 * (E2E_ADMIN_UUID) or pages-editor.spec.ts (E2E_PAGES_ADMIN_UUID).
 * Users are inserted and removed with the shared monitor-seed helpers
 * (`insertUser` / `deleteUser`).
 *
 * Emails are under E2E_EMAIL_DOMAIN (@alnyron-test.local) so the global
 * sweep (sweepE2eTestUsers) removes any leftovers from aborted runs.
 *
 * Three status fixtures for the cleanup spec (AMC-18/19/20):
 *   - E2E_AMU_MONITOR       — confirmed → "Tilmeldt" (registered)
 *   - E2E_AMU_FRESH         — unconfirmed, created_at = now → "Afventer bekræftelse" (pending)
 *   - E2E_AMU_EXPIRED       — unconfirmed, created_at 1 h ago → "Udløbet" (expired)
 */

import type pg from "pg";
import { getClient, endPool } from "../../integration/rls/helpers/db";
import {
  DB_AVAILABLE,
  E2E_EMAIL_DOMAIN,
  randomE2ePassword,
} from "./admin-auth-seed";
import { deleteUser, insertUser, seedMonitors } from "./monitor-seed";

export { getClient, endPool, DB_AVAILABLE, E2E_EMAIL_DOMAIN, randomE2ePassword };

// ── Dedicated admin for this spec (never races E2E_ADMIN_UUID) ───────────────

export const E2E_AMU_ADMIN_EMAIL = `e2e-amu-admin@${E2E_EMAIL_DOMAIN}`;
/** Distinct from E2E_ADMIN_UUID/E2E_PAGES_ADMIN_UUID — no cross-spec races. */
export const E2E_AMU_ADMIN_UUID = "00000000-0000-0000-0a31-000000000010";

export async function seedE2eAmuAdmin(client: pg.PoolClient, password: string): Promise<void> {
  await insertUser(client, E2E_AMU_ADMIN_UUID, E2E_AMU_ADMIN_EMAIL, "admin", password);
}

export async function cleanupE2eAmuAdmin(client: pg.PoolClient): Promise<void> {
  await deleteUser(client, E2E_AMU_ADMIN_UUID, E2E_AMU_ADMIN_EMAIL);
}

// ── Confirmed monitor_user (status: "Tilmeldt") ───────────────────────────────

export const E2E_AMU_MONITOR_EMAIL = `e2e-amu-mon@${E2E_EMAIL_DOMAIN}`;
export const E2E_AMU_MONITOR_UUID  = "00000000-0000-0000-0a31-000000000020";

/** Fixed signup time used in the Oprettet cell assertion. */
export const E2E_AMU_MONITOR_CREATED_AT = "2026-10-20T10:00:00.000Z";

/** Confirmed monitor_user (monitor_limit 5) signed up at E2E_AMU_MONITOR_CREATED_AT, with 2 monitors. */
export async function seedE2eAmuMonitorUser(client: pg.PoolClient, password: string): Promise<void> {
  await insertUser(
    client,
    E2E_AMU_MONITOR_UUID,
    E2E_AMU_MONITOR_EMAIL,
    "monitor_user",
    password,
    true,
    E2E_AMU_MONITOR_CREATED_AT,
  );
  await seedMonitors(client, E2E_AMU_MONITOR_UUID, 2);
}

export async function cleanupE2eAmuMonitorUser(client: pg.PoolClient): Promise<void> {
  await deleteUser(client, E2E_AMU_MONITOR_UUID, E2E_AMU_MONITOR_EMAIL);
}

// ── Fresh unconfirmed monitor_user (status: "Afventer bekræftelse") ────────────

export const E2E_AMU_FRESH_EMAIL = `e2e-amu-fresh@${E2E_EMAIL_DOMAIN}`;
export const E2E_AMU_FRESH_UUID  = "00000000-0000-0000-0a31-000000000040";

/**
 * Unconfirmed monitor_user seeded with created_at = now() — always within the
 * 10-minute window so the status renders as "Afventer bekræftelse" (pending).
 * No `email_confirmed_at` row; insertUser always confirms, so we unset it
 * right after insertion via a direct UPDATE.
 */
export async function seedE2eAmuFreshUser(client: pg.PoolClient, password: string): Promise<void> {
  await insertUser(
    client,
    E2E_AMU_FRESH_UUID,
    E2E_AMU_FRESH_EMAIL,
    "monitor_user",
    password,
  );
  // Unset confirmation so it shows as pending
  await client.query(
    `UPDATE auth.users SET email_confirmed_at = NULL WHERE id = $1`,
    [E2E_AMU_FRESH_UUID],
  );
}

export async function cleanupE2eAmuFreshUser(client: pg.PoolClient): Promise<void> {
  await deleteUser(client, E2E_AMU_FRESH_UUID, E2E_AMU_FRESH_EMAIL);
}

// ── Expired unconfirmed monitor_user (status: "Udløbet") ─────────────────────

export const E2E_AMU_EXPIRED_EMAIL = `e2e-amu-expired@${E2E_EMAIL_DOMAIN}`;
export const E2E_AMU_EXPIRED_UUID  = "00000000-0000-0000-0a31-000000000050";

/**
 * Unconfirmed monitor_user whose created_at is backdated an hour (database
 * clock) after insertion, so the status renders as "Udløbet" (expired). An
 * hour stays well past the 10-minute window even when the app server's clock
 * runs behind the database's, and well under the 24 h after which the
 * unconfirmed-account purge would delete the fixture.
 */
export async function seedE2eAmuExpiredUser(client: pg.PoolClient, password: string): Promise<void> {
  await insertUser(
    client,
    E2E_AMU_EXPIRED_UUID,
    E2E_AMU_EXPIRED_EMAIL,
    "monitor_user",
    password,
  );
  // Backdate created_at an hour and unset confirmation so it shows as expired
  await client.query(
    `UPDATE auth.users
        SET email_confirmed_at = NULL,
            created_at         = now() - INTERVAL '1 hour'
      WHERE id = $1`,
    [E2E_AMU_EXPIRED_UUID],
  );
}

export async function cleanupE2eAmuExpiredUser(client: pg.PoolClient): Promise<void> {
  await deleteUser(client, E2E_AMU_EXPIRED_UUID, E2E_AMU_EXPIRED_EMAIL);
}

// ── Non-admin user (monitor_user role) for redirect test ─────────────────────

export const E2E_AMU_NONADMIN_EMAIL = `e2e-amu-nonadmin@${E2E_EMAIL_DOMAIN}`;
export const E2E_AMU_NONADMIN_UUID  = "00000000-0000-0000-0a31-000000000030";

export async function seedE2eAmuNonAdminUser(client: pg.PoolClient, password: string): Promise<void> {
  await insertUser(client, E2E_AMU_NONADMIN_UUID, E2E_AMU_NONADMIN_EMAIL, "monitor_user", password);
}

export async function cleanupE2eAmuNonAdminUser(client: pg.PoolClient): Promise<void> {
  await deleteUser(client, E2E_AMU_NONADMIN_UUID, E2E_AMU_NONADMIN_EMAIL);
}

// ── monitor_user with 2 specific monitors for Overvåger column (admin-monitor-users-sites) ──

export const E2E_AMU_SITES_EMAIL = `e2e-amu-sites@${E2E_EMAIL_DOMAIN}`;
/** Distinct UUID in the 0a31 namespace — no cross-spec races. */
export const E2E_AMU_SITES_UUID  = "00000000-0000-0000-0a31-000000000060";

/**
 * Fixed URLs used by the Overvåger column tests.
 * The active monitor has a label (shown as a muted note after its link); the
 * paused one has label=NULL (link only).  Both links show displayUrl(url).
 * Explicit created_at keeps ORDER BY deterministic.
 */
export const E2E_AMU_SITES_URL_ACTIVE = "https://amu-sites-active.alnyron-e2e.example.com";
export const E2E_AMU_SITES_LABEL_ACTIVE = "Aktiv side";
export const E2E_AMU_SITES_URL_PAUSED  = "https://amu-sites-paused.alnyron-e2e.example.com";
/** displayUrl(E2E_AMU_SITES_URL_ACTIVE) — no scheme, no trailing slash. */
export const E2E_AMU_SITES_DISPLAY_ACTIVE = "amu-sites-active.alnyron-e2e.example.com";
/** displayUrl(E2E_AMU_SITES_URL_PAUSED) — no scheme, no trailing slash. */
export const E2E_AMU_SITES_DISPLAY_PAUSED = "amu-sites-paused.alnyron-e2e.example.com";

/**
 * Confirmed monitor_user with:
 *   - 1 active monitor (label = "Aktiv side"), seeded at :01
 *   - 1 paused monitor (label = NULL),         seeded at :02
 * Both explicit created_at values so ORDER BY created_at, id is stable.
 */
export async function seedE2eAmuSitesUser(client: pg.PoolClient, password: string): Promise<void> {
  await insertUser(client, E2E_AMU_SITES_UUID, E2E_AMU_SITES_EMAIL, "monitor_user", password);
  await client.query(
    `INSERT INTO public.monitors
       (user_id, url, label, status, consecutive_errors, interval_minutes, created_at)
     VALUES
       ($1, $2, $3, 'active', 0, 1440, '2026-11-11T10:01:00.000Z'::timestamptz),
       ($1, $4, NULL, 'paused', 0, 1440, '2026-11-11T10:02:00.000Z'::timestamptz)`,
    [E2E_AMU_SITES_UUID, E2E_AMU_SITES_URL_ACTIVE, E2E_AMU_SITES_LABEL_ACTIVE, E2E_AMU_SITES_URL_PAUSED],
  );
}

export async function cleanupE2eAmuSitesUser(client: pg.PoolClient): Promise<void> {
  await deleteUser(client, E2E_AMU_SITES_UUID, E2E_AMU_SITES_EMAIL);
}
