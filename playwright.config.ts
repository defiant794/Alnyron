import { defineConfig, devices } from "@playwright/test";
import { supabaseDbEnv } from "./tests/helpers/supabase-db-env";

// The e2e DB fixture (tests/e2e/fixtures/db-state.ts) connects like the
// integration tests: SUPABASE_DB_* only, from the environment or .env.local.
// The config is evaluated in the runner and in every worker.
Object.assign(process.env, supabaseDbEnv(__dirname));

// E2E specs live in tests/e2e (kept separate from Vitest unit tests).
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
