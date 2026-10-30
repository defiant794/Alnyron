import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * SUPABASE_DB_* settings for the integration project (tests/integration/rls/helpers/db.ts):
 * a value already in process.env wins, else the git-ignored .env.local. Only the DB keys
 * reach the test process, not the rest of the file.
 */
function supabaseDbEnv(): Record<string, string> {
  let fromFile: NodeJS.Dict<string> = {};
  try {
    fromFile = parseEnv(fs.readFileSync(fileURLToPath(new URL(".env.local", import.meta.url)), "utf-8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const merged: NodeJS.Dict<string> = { ...fromFile, ...process.env };
  return Object.fromEntries(
    Object.entries(merged).filter(
      (entry): entry is [string, string] => entry[0].startsWith("SUPABASE_DB_") && !!entry[1],
    ),
  );
}

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
          // reach next-intl's own router hooks.
          server: { deps: { inline: ["next-intl"] } },
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
          env: supabaseDbEnv(),
        },
      },
    ],
  },
});
