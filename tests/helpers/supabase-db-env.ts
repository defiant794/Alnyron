import path from "node:path";
import { TEST_ENV_FILE, pickEnv, readEnvFile } from "./env-file";

/**
 * SUPABASE_DB_* settings for DB test tooling (tests/integration/rls/helpers/db.ts,
 * also used by the e2e DB fixtures): a value already in process.env wins, else
 * the git-ignored `tests/.env.e2e` under `rootDir` (never `.env.local`, which
 * OpenNext bundles into the Worker). Only the DB keys are returned.
 */
export function supabaseDbEnv(rootDir: string): Record<string, string> {
  return pickEnv(readEnvFile(path.join(rootDir, TEST_ENV_FILE)), (key) =>
    key.startsWith("SUPABASE_DB_"),
  );
}
