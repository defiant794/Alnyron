import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

/**
 * Git-ignored file for the test-only secrets: SUPABASE_DB_* (integration tests,
 * the e2e DB fixtures) and SUPABASE_SECRET_KEY (e2e generate_link). It sits
 * under tests/ on purpose: Next.js and @opennextjs/cloudflare read every root
 * `.env*` file (`.env`, `.env.<mode>`, `.env.local`, `.env.<mode>.local`), and
 * OpenNext compiles them into the Worker bundle. Relative to the repo root.
 */
export const TEST_ENV_FILE = path.join("tests", ".env.e2e");

/**
 * Git-ignored settings of the isolated e2e Supabase project (`SUPABASE_E2E_*`
 * including its `SUPABASE_E2E_DB_PASSWORD`, `SUPABASE_SECRET_KEY` and public
 * URL/key). When present, the whole e2e run targets that project and only
 * that project (tests/helpers/e2e-project-env.ts). Relative to the repo root;
 * under tests/ for the same reason as {@link TEST_ENV_FILE}.
 */
export const E2E_PROJECT_ENV_FILE = path.join("tests", ".env.e2e-project");

/** Changes to an environment: a string sets the key, `undefined` removes it. */
export type EnvPatch = Record<string, string | undefined>;

/**
 * Applies `patch` to `env` (normally `process.env`). Keys patched to
 * `undefined` are deleted: assigning `undefined` to `process.env` would store
 * the string "undefined".
 */
export function applyEnvPatch(env: NodeJS.Dict<string>, patch: Readonly<EnvPatch>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}

/** Parses a dotenv file; a missing file yields no values (they may come from the environment). */
export function readEnvFile(file: string): NodeJS.Dict<string> {
  try {
    return parseEnv(fs.readFileSync(file, "utf-8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
}

/**
 * The non-empty values for the keys `keep` accepts, from `fromFile` overlaid
 * with process.env: a value already in the environment wins over the file.
 */
export function pickEnv(
  fromFile: NodeJS.Dict<string>,
  keep: (key: string) => boolean,
): Record<string, string> {
  const merged: NodeJS.Dict<string> = { ...fromFile, ...process.env };
  return Object.fromEntries(
    Object.entries(merged).filter(
      (entry): entry is [string, string] => keep(entry[0]) && !!entry[1],
    ),
  );
}
