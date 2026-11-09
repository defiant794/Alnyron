import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { supabaseDbEnv } from "./tests/helpers/supabase-db-env";

// Path aliases (@/*) via vite-tsconfig-paths; React/JSX transform via plugin-react.
// With `projects` defined, root plugins do not propagate, so each project repeats them.
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [react(), tsconfigPaths()],
        // css.postcss inline object: passing an object bypasses the
        // postcss.config.mjs file lookup entirely (Vite only skips it when an
        // inline object is given).  Empty plugins[] = no PostCSS transforms,
        // so Tailwind v4's @import "tailwindcss" does not crash unit tests.
        css: { postcss: { plugins: [] } },
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/unit/**/*.test.{ts,tsx}"],
          // next-intl's ESM imports `next/navigation` without an extension,
          // which native Node cannot resolve (next has no exports map). Run it
          // through Vite instead; this also lets vi.mock("next/navigation")
          // reach next-intl's own router hooks. use-intl likewise, so that
          // vi.mock("react") reaches its `react` import (the cron Worker's
          // react-shim test, tests/unit/workers/monitor-cron/react-shim.test.ts).
          server: { deps: { inline: ["next-intl", "use-intl"] } },
        },
      },
      {
        plugins: [react(), tsconfigPaths()],
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.{ts,tsx}"],
          // fileParallelism: false — integration tests share a single cloud Postgres
          // connection pool. Parallel files would race on the same ADMIN_UUID /
          // email in auth.users and user_allowlist, risking 40P01 deadlocks once
          // the schema is applied. Sequential file execution prevents this.
          fileParallelism: false,
          // SUPABASE_DB_* from the environment or the git-ignored tests/.env.e2e
          // (never .env.local: OpenNext compiles it into the Worker bundle).
          env: supabaseDbEnv(fileURLToPath(new URL(".", import.meta.url))),
        },
      },
    ],
  },
});
