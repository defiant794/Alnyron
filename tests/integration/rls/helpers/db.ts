/**
 * Integration-test (and e2e DB fixture) connection helper.
 *
 * Target project:
 *   - Default: the linked production project (verified via Supabase Management API 2026-10-30):
 *       Pooler host : aws-1-eu-west-3.pooler.supabase.com   ← aws-1, not aws-0
 *       User        : postgres.xmgpixhxecamtryohgmk
 *     The RLS integration tests always run here (vitest.config.ts loads only SUPABASE_DB_*)
 *     and roll every transaction back.
 *   - The isolated e2e project, when SUPABASE_E2E_REF is set: playwright.config.ts loads it
 *     from the git-ignored tests/.env.e2e-project (tests/helpers/e2e-project-env.ts) with
 *     SUPABASE_E2E_DB_HOST, SUPABASE_E2E_DB_USER (default postgres.<ref>, must be),
 *     SUPABASE_E2E_DB_PORT (default 5432) and SUPABASE_E2E_DB_PASSWORD, and removes the
 *     production SUPABASE_DB_PASSWORD. This target reads only those e2e keys, never
 *     SUPABASE_DB_PASSWORD, so a stale SUPABASE_E2E_REF can never pair the e2e host with
 *     the production password, and the e2e fixtures' COMMITTED rows never reach the
 *     production project.
 *   Session mode: port 5432  (SET LOCAL survives within a transaction)
 *   Txn mode    : port 6543  (fallback; SET LOCAL also works within BEGIN/ROLLBACK)
 *   DB          : postgres
 *   TLS         : verify-full. The pooler's chain ends at "Supabase Root 2021 CA", which
 *                 Node's default trust store does not hold (SELF_SIGNED_CERT_IN_CHAIN), so
 *                 that root is pinned via `ca` and the certificate must match the pooler host.
 *                 Certificate verification is never disabled: this connection is the
 *                 project superuser.
 *
 * Environment (a value already in process.env wins for the production target; vitest.config.ts
 * and playwright.config.ts load the SUPABASE_DB_* keys from the git-ignored tests/.env.e2e,
 * never .env.local):
 *   SUPABASE_DB_PASSWORD  the production project's DB password (required for that target)
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

const PROD_REF = "xmgpixhxecamtryohgmk";
// Verified 2026-10-30: Management API returns aws-1 for this project's region
const PROD_POOLER_HOST = "aws-1-eu-west-3.pooler.supabase.com";
const SESSION_PORT = 5432;
const TRANSACTION_PORT = 6543;
// cwd-relative, not import.meta.url: Playwright (the e2e DB fixture) loads this file as CommonJS.
const DEFAULT_CA_PATH = path.resolve("supabase/prod-ca-2021.crt");

/**
 * True when the run has DB credentials: the e2e profile (SUPABASE_E2E_REF, whose own settings
 * `dbTarget` then requires) or the production SUPABASE_DB_PASSWORD.
 * Integration suites call `describe.skipIf(!DB_AVAILABLE)` for the no-credentials case.
 * If credentials ARE present but incomplete or the connection fails at runtime, the suite
 * fails loudly.
 */
export const DB_AVAILABLE = !!process.env.SUPABASE_E2E_REF || !!process.env.SUPABASE_DB_PASSWORD;

/** Where the pool connects: pooler host, user (postgres.<project ref>), session-mode port and password. */
export interface DbTarget {
  host: string;
  user: string;
  sessionPort: number;
  password: string;
  /** The variable `password` came from, for error messages (never the value). */
  passwordKey: "SUPABASE_DB_PASSWORD" | "SUPABASE_E2E_DB_PASSWORD";
}

/**
 * The isolated e2e project when `env` has SUPABASE_E2E_REF, from the SUPABASE_E2E_* keys
 * only; else the production project with SUPABASE_DB_PASSWORD. Missing credentials, or an
 * incomplete or inconsistent e2e setting, throw (names only, never values) rather than
 * falling back to another project.
 */
export function dbTarget(env: Readonly<NodeJS.Dict<string>> = process.env): DbTarget {
  const ref = env.SUPABASE_E2E_REF;
  if (!ref) {
    const password = env.SUPABASE_DB_PASSWORD;
    if (!password) throw new Error("No DB credentials: set SUPABASE_DB_PASSWORD (environment or tests/.env.e2e)");
    return {
      host: PROD_POOLER_HOST,
      user: `postgres.${PROD_REF}`,
      sessionPort: SESSION_PORT,
      password,
      passwordKey: "SUPABASE_DB_PASSWORD",
    };
  }

  if (ref === PROD_REF) throw new Error("SUPABASE_E2E_REF names the production project");
  const host = env.SUPABASE_E2E_DB_HOST;
  if (!host) throw new Error("SUPABASE_E2E_REF is set but SUPABASE_E2E_DB_HOST is not (tests/.env.e2e-project)");
  const password = env.SUPABASE_E2E_DB_PASSWORD;
  if (!password) throw new Error("SUPABASE_E2E_REF is set but SUPABASE_E2E_DB_PASSWORD is not (tests/.env.e2e-project)");
  const user = env.SUPABASE_E2E_DB_USER || `postgres.${ref}`;
  if (user !== `postgres.${ref}`) {
    throw new Error("SUPABASE_E2E_DB_USER must be the pooler user of SUPABASE_E2E_REF (postgres.<ref>)");
  }
  const sessionPort = Number(env.SUPABASE_E2E_DB_PORT || SESSION_PORT);
  if (!Number.isInteger(sessionPort) || sessionPort <= 0) throw new Error("SUPABASE_E2E_DB_PORT is not a port number");
  return { host, user, sessionPort, password, passwordKey: "SUPABASE_E2E_DB_PASSWORD" };
}

// ---------------------------------------------------------------------------
// Pool — session mode (port 5432) so SET LOCAL persists within a transaction
// ---------------------------------------------------------------------------

let _pool: pg.Pool | undefined;

/** Session-mode port (SET LOCAL kept for the connection) or 6543 = transaction mode. */
function buildPool(target: DbTarget, port: number): pg.Pool {
  return new Pool({
    host: target.host,
    port,
    user: target.user,
    database: "postgres",
    password: target.password,
    // pg sets servername = host, so Node checks the certificate against the pooler host.
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
 *   - The e2e DB fixtures (tests/e2e/fixtures) COMMIT marked `e2e-*` rows, because the app
 *     reads them through its own connection; they remove them again before and after each
 *     block (the cleanup before also covers an aborted run). With tests/.env.e2e-project
 *     present they write to the isolated e2e project (see the module doc).
 */
export async function getClient(): Promise<pg.PoolClient> {
  if (!_pool) {
    const target = dbTarget();
    _pool = buildPool(target, target.sessionPort);
  }
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
  const target = dbTarget();

  // Session mode first
  try {
    const pool = buildPool(target, target.sessionPort);
    const client = await pool.connect();
    _pool = pool;
    return { client, host: `${target.host}:${target.sessionPort} (session mode)` };
  } catch (e1) {
    // Transaction mode fallback
    try {
      const pool = buildPool(target, TRANSACTION_PORT);
      const client = await pool.connect();
      _pool = pool;
      return { client, host: `${target.host}:${TRANSACTION_PORT} (transaction mode)` };
    } catch (e2) {
      throw new Error(
        [
          "Both Supabase pooler endpoints failed.",
          `  Session mode  (${target.host}:${target.sessionPort}): ${(e1 as Error).message}`,
          `  Txn mode      (${target.host}:${TRANSACTION_PORT}): ${(e2 as Error).message}`,
          `Verify ${target.passwordKey} matches the project's DB password.`,
        ].join("\n"),
      );
    }
  }
}
