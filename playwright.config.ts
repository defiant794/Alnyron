import { defineConfig, devices } from "@playwright/test";
import { e2eEnv } from "./tests/helpers/e2e-env";
import { WITHOUT_E2E_PROJECT, e2eProjectEnv } from "./tests/helpers/e2e-project-env";
import { applyEnvPatch } from "./tests/helpers/env-file";
import { supabaseDbEnv } from "./tests/helpers/supabase-db-env";

// The config is evaluated in the runner and in every worker.
//
// With the git-ignored tests/.env.e2e-project present, the whole run targets
// the isolated e2e Supabase project, and only it: the DB fixtures
// (tests/e2e/fixtures, via tests/integration/rls/helpers/db.ts, with
// SUPABASE_E2E_DB_PASSWORD), the admin-auth seeds (URL + secret key) and the
// catalog spec's project guard. The file decides every Supabase key: a value
// of them already in the environment is replaced or removed, and the
// production SUPABASE_DB_PASSWORD is removed. Start the app against the same
// project (`npm run dev:e2e`).
//
// Without it, the linked project as before: the DB fixtures connect like the
// integration tests (SUPABASE_DB_* from the environment or tests/.env.e2e), and
// the admin-auth seed fixtures also need NEXT_PUBLIC_SUPABASE_URL (.env.local)
// and SUPABASE_SECRET_KEY (tests/.env.e2e only: OpenNext bundles .env.local).
// Stale SUPABASE_E2E_* values in the environment are removed.
applyEnvPatch(
  process.env,
  e2eProjectEnv(__dirname) ?? { ...WITHOUT_E2E_PROJECT, ...supabaseDbEnv(__dirname), ...e2eEnv(__dirname) },
);

// E2E specs live in tests/e2e (kept separate from Vitest unit tests).
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  // Before and after the whole run (not per worker, so no parallel block loses
  // its seeded user): delete every leftover @alnyron-test.local auth user.
  globalSetup: "./tests/e2e/sweep-test-users.ts",
  globalTeardown: "./tests/e2e/sweep-test-users.ts",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
