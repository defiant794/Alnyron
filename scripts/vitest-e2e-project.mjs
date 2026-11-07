/**
 * Runs `vitest run --project integration` against the isolated e2e Supabase
 * project, so migration-0400-dependent integration tests can be verified
 * before the migration reaches production.
 *
 * Loads SUPABASE_E2E_* keys and the secret key from tests/.env.e2e-project
 * into process.env, then spawns the vitest CLI. Values are NEVER printed.
 * Exit code passes through from vitest.
 *
 *   npm run test:integration:e2e-project
 *   npm run test:integration:e2e-project -- tests/integration/rls/rls-auth-hook.test.ts
 *
 * Mirrors tests/helpers/e2e-project-env.ts: same key strategy, same guards.
 * The DB pool in tests/integration/rls/helpers/db.ts switches to the e2e
 * project when SUPABASE_E2E_REF is set in the environment.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseEnv } from "node:util";
import { spawnSync } from "node:child_process";

const ENV_FILE = "tests/.env.e2e-project";
const PROD_REF = "xmgpixhxecamtryohgmk";

/**
 * Keys injected into process.env from tests/.env.e2e-project.
 * Every E2E_PROFILE_KEY that is absent from the file is DELETED from the
 * environment, so a production value in the shell never survives.
 */
const E2E_PROFILE_KEYS = [
  "SUPABASE_E2E_REF",
  "SUPABASE_E2E_DB_HOST",
  "SUPABASE_E2E_DB_USER",
  "SUPABASE_E2E_DB_PORT",
  "SUPABASE_E2E_DB_PASSWORD",
  "SUPABASE_SECRET_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
];

const REQUIRED_KEYS = [
  "SUPABASE_E2E_REF",
  "SUPABASE_E2E_DB_HOST",
  "SUPABASE_E2E_DB_PASSWORD",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
];

let settings;
try {
  settings = parseEnv(readFileSync(ENV_FILE, "utf-8"));
} catch (error) {
  console.error(`Cannot read ${ENV_FILE} (${error.code ?? error.message}); run from the repo root.`);
  process.exit(1);
}

const missing = REQUIRED_KEYS.filter((key) => !settings[key]);
if (missing.length > 0) {
  // Log key names only — never values
  console.error(`${ENV_FILE} is missing required keys: ${missing.join(", ")}`);
  process.exit(1);
}

// Validate URL matches SUPABASE_E2E_REF (mirrors e2e-project-env.ts:66)
const url = settings["NEXT_PUBLIC_SUPABASE_URL"] ?? "";
const ref = settings["SUPABASE_E2E_REF"] ?? "";
if (!URL.canParse(url) || new URL(url).hostname !== `${ref}.supabase.co`) {
  console.error(`${ENV_FILE}: NEXT_PUBLIC_SUPABASE_URL is not the project SUPABASE_E2E_REF names`);
  process.exit(1);
}

// Refuse to run against the production project
if (ref === PROD_REF) {
  console.error(`${ENV_FILE}: SUPABASE_E2E_REF must not be the production project (SUPABASE_E2E_REF)`);
  process.exit(1);
}

// Apply only declared E2E keys; delete every declared key the file lacks so
// shell-inherited production values (SUPABASE_SECRET_KEY, NEXT_PUBLIC_SUPABASE_URL,
// etc.) never survive into the integration run.
for (const key of E2E_PROFILE_KEYS) {
  if (settings[key]) {
    process.env[key] = settings[key];
  } else {
    delete process.env[key];
  }
}
// Always scrub the production DB password
delete process.env["SUPABASE_DB_PASSWORD"];

const extraArgs = process.argv.slice(2);
// Log the ref only (never host/password)
console.log(`vitest run --project integration against e2e project ${ref}${extraArgs.length ? " " + extraArgs.join(" ") : ""}`);

// Spawn vitest CLI — passes exit code through so a Red run shows as failure
const require = createRequire(import.meta.url);
const vitestDir = path.dirname(require.resolve("vitest/package.json"));
const vitestBin = path.join(vitestDir, "vitest.mjs");

const result = spawnSync(
  process.execPath,
  [vitestBin, "run", "--project", "integration", ...extraArgs],
  { stdio: "inherit", env: process.env },
);
process.exit(result.status ?? 1);
