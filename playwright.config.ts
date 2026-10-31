import { defineConfig, devices } from "@playwright/test";
import { supabaseDbEnv } from "./tests/helpers/supabase-db-env";
import { e2eEnv } from "./tests/helpers/e2e-env";

// The e2e DB fixtures (tests/e2e/fixtures) connect like the integration tests:
// SUPABASE_DB_* only, from the environment or the git-ignored tests/.env.e2e.
// The config is evaluated in the runner and in every worker.
Object.assign(process.env, supabaseDbEnv(__dirname));
// The admin-auth seed fixtures also need NEXT_PUBLIC_SUPABASE_URL (.env.local)
// and SUPABASE_SECRET_KEY (tests/.env.e2e only: OpenNext bundles .env.local).
Object.assign(process.env, e2eEnv(__dirname));

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
