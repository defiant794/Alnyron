/**
 * E2E seed helpers — admin Monitor-brugere page (admin-monitor-users)
 *
 * Uses DEDICATED UUIDs so this spec never races admin-auth.spec.ts
 * (E2E_ADMIN_UUID) or pages-editor.spec.ts (E2E_PAGES_ADMIN_UUID).
 * Users are inserted and removed with the shared monitor-seed helpers
 * (`insertUser` / `deleteUser`).
 *
 * Emails are under E2E_EMAIL_DOMAIN (@alnyron-test.local) so the global
 * sweep (sweepE2eTestUsers) removes any leftovers from aborted runs.
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

// ── monitor_user fixture — confirmed, 2 monitors, fixed created_at ────────────

export const E2E_AMU_MONITOR_EMAIL = `e2e-amu-mon@${E2E_EMAIL_DOMAIN}`;
export const E2E_AMU_MONITOR_UUID  = "00000000-0000-0000-0a31-000000000020";

/** Fixed signup time used in the Tilmeldt cell assertion. */
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

// ── non-admin user (monitor_user role) for redirect test ─────────────────────

export const E2E_AMU_NONADMIN_EMAIL = `e2e-amu-nonadmin@${E2E_EMAIL_DOMAIN}`;
export const E2E_AMU_NONADMIN_UUID  = "00000000-0000-0000-0a31-000000000030";

export async function seedE2eAmuNonAdminUser(client: pg.PoolClient, password: string): Promise<void> {
  await insertUser(client, E2E_AMU_NONADMIN_UUID, E2E_AMU_NONADMIN_EMAIL, "monitor_user", password);
}

export async function cleanupE2eAmuNonAdminUser(client: pg.PoolClient): Promise<void> {
  await deleteUser(client, E2E_AMU_NONADMIN_UUID, E2E_AMU_NONADMIN_EMAIL);
}
