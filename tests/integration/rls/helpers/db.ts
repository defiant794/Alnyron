/**
 * Integration-test DB connection helper.
 *
 * Endpoint (verified via Supabase Management API 2026-10-30):
 *   Pooler host : aws-1-eu-west-3.pooler.supabase.com   ← aws-1, not aws-0
 *   Session mode: port 5432  (SET LOCAL survives within a transaction)
 *   Txn mode    : port 6543  (fallback; SET LOCAL also works within BEGIN/ROLLBACK)
 *   User        : postgres.xmgpixhxecamtryohgmk
 *   DB          : postgres
 *   TLS         : verify-full. The pooler's chain ends at "Supabase Root 2021 CA", which
 *                 Node's default trust store does not hold (SELF_SIGNED_CERT_IN_CHAIN), so
 *                 that root is pinned via `ca` and the certificate must match POOLER_HOST.
 *                 Certificate verification is never disabled: this connection is the
 *                 project superuser on the production database.
 *
 * Environment (a value already in process.env wins; vitest.config.ts and playwright.config.ts
 * also load the SUPABASE_DB_* keys from the git-ignored tests/.env.e2e, never .env.local):
 *   SUPABASE_DB_PASSWORD  project DB password (required)
 *   SUPABASE_DB_CA_CERT   path to the CA certificate; default supabase/prod-ca-2021.crt, resolved
 *                         from the repo root (the runners' cwd) —
 *                         Supabase's prod-ca-2021.crt (Dashboard → Database Settings → SSL
 *                         Configuration; https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt),
 *                         SHA-256 80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA,
 *                         identical to the root the pooler presents (checked 2026-10-30)
 *
 * Tests skip when DB_AVAILABLE is false (no credentials).
 * A runtime connection error is LOUD — it fails the suite, never silently skips.
 */

import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const { Pool } = pg;
export type { PoolClient } from "pg";

const SUPABASE_REF = "xmgpixhxecamtryohgmk";
// Verified 2026-10-30: Management API returns aws-1 for this project's region
const POOLER_HOST = "aws-1-eu-west-3.pooler.supabase.com";
const POOLER_USER = `postgres.${SUPABASE_REF}`;
// cwd-relative, not import.meta.url: Playwright (the e2e DB fixture) loads this file as CommonJS.
const DEFAULT_CA_PATH = path.resolve("supabase/prod-ca-2021.crt");

export const DB_PASSWORD = process.env.SUPABASE_DB_PASSWORD || undefined;

/**
 * True when DB credentials are present.
 * Integration suites call `describe.skipIf(!DB_AVAILABLE)` for the no-credentials case.
 * If credentials ARE present but the connection fails at runtime, the suite fails loudly.
 */
export const DB_AVAILABLE = !!DB_PASSWORD;

// ---------------------------------------------------------------------------
// Pool — session mode (port 5432) so SET LOCAL persists within a transaction
// ---------------------------------------------------------------------------

let _pool: pg.Pool | undefined;

/** Port 5432 = session mode (SET LOCAL kept for the connection), 6543 = transaction mode. */
function buildPool(port: 5432 | 6543): pg.Pool {
  if (!DB_PASSWORD) throw new Error("No DB credentials — set SUPABASE_DB_PASSWORD (environment or tests/.env.e2e)");
  return new Pool({
    host: POOLER_HOST,
    port,
    user: POOLER_USER,
    database: "postgres",
    password: DB_PASSWORD,
    // pg sets servername = host, so Node checks the certificate against POOLER_HOST.
    ssl: { ca: fs.readFileSync(process.env.SUPABASE_DB_CA_CERT || DEFAULT_CA_PATH, "utf-8"), rejectUnauthorized: true },
    connectionTimeoutMillis: 10_000,
    max: 4,
  });
}

/**
 * Acquire a pooled client.
 * The caller MUST call client.release() in a finally block.
 *
 * Two uses, with different persistence:
 *   - RLS integration tests wrap their work in BEGIN / ROLLBACK, so nothing they do persists.
 *   - The e2e DB fixture (tests/e2e/fixtures/db-state.ts) COMMITS marked `e2e-home-*` rows,
 *     because the dev server reads them through its own connection; it removes them again
 *     before and after each block (the cleanup before also covers an aborted run).
 */
export async function getClient(): Promise<pg.PoolClient> {
  if (!_pool) _pool = buildPool(5432);
  return _pool.connect();
}

/** Closes the shared pool (long-lived runners, e.g. Playwright workers, must not leave it open). */
export async function endPool(): Promise<void> {
  const pool = _pool;
  _pool = undefined;
  await pool?.end();
}

/**
 * Try session-mode pooler (port 5432) then transaction-mode (port 6543).
 * Returns { client, host } so beforeAll hooks can log which endpoint connected.
 * Throws loudly if both fail — never silently skips.
 *
 * Usage in beforeAll:
 *   const { client, host } = await connectWithFallback();
 *   console.log(`Connected: ${host}`);
 */
export async function connectWithFallback(): Promise<{ client: pg.PoolClient; host: string }> {
  if (!DB_PASSWORD) throw new Error("No DB credentials");

  // Session mode first
  try {
    const pool = buildPool(5432);
    const client = await pool.connect();
    _pool = pool;
    return { client, host: `${POOLER_HOST}:5432 (session mode)` };
  } catch (e1) {
    // Transaction mode fallback
    try {
      const pool = buildPool(6543);
      const client = await pool.connect();
      _pool = pool;
      return { client, host: `${POOLER_HOST}:6543 (transaction mode)` };
    } catch (e2) {
      throw new Error(
        [
          "Both Supabase pooler endpoints failed.",
          `  Session mode  (${POOLER_HOST}:5432): ${(e1 as Error).message}`,
          `  Txn mode      (${POOLER_HOST}:6543): ${(e2 as Error).message}`,
          "Verify SUPABASE_DB_PASSWORD matches the project's DB password.",
        ].join("\n"),
      );
    }
  }
}
