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
