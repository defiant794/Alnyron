import path from "node:path";
import { E2E_PROJECT_ENV_FILE, readEnvFile, type EnvPatch } from "./env-file";

/**
 * Every key the e2e profile decides; all of them describe the e2e project. In
 * e2e mode each one takes its value from tests/.env.e2e-project or is
 * removed, so a value inherited from the shell (a production
 * SUPABASE_SECRET_KEY or NEXT_PUBLIC_SUPABASE_URL) never survives.
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
] as const;

/** Keys without which the e2e project cannot be reached (the user and port have defaults, the secret key is optional). */
const REQUIRED_KEYS = [
  "SUPABASE_E2E_REF",
  "SUPABASE_E2E_DB_HOST",
  "SUPABASE_E2E_DB_PASSWORD",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
] as const;

/** The production DB password: removed in e2e mode, so nothing in the run can send it to any project. */
const PRODUCTION_ONLY_KEYS = ["SUPABASE_DB_PASSWORD"] as const;

/**
 * Without the e2e profile: removes every `SUPABASE_E2E_*` key, so a stale
 * value in the shell cannot switch tests/integration/rls/helpers/db.ts to an
 * e2e host. The run then targets only the linked project.
 */
export const WITHOUT_E2E_PROJECT: Readonly<EnvPatch> = Object.fromEntries(
  E2E_PROFILE_KEYS.filter((key) => key.startsWith("SUPABASE_E2E_")).map((key) => [key, undefined]),
);

/**
 * The environment of an e2e run against the isolated e2e Supabase project,
 * from the git-ignored `tests/.env.e2e-project` under `rootDir`, or `null`
 * when that file is absent (the run then keeps the linked project:
 * tests/.env.e2e and .env.local, plus {@link WITHOUT_E2E_PROJECT}).
 *
 * The file fully determines the Supabase settings: every profile key is set
 * from it or removed when the file has none, and the production
 * SUPABASE_DB_PASSWORD is removed, whatever the shell held. With it applied
 * (`applyEnvPatch`), tests/integration/rls/helpers/db.ts connects the DB
 * fixtures to the e2e host with SUPABASE_E2E_DB_PASSWORD, and the admin-auth
 * seeds use the e2e URL and secret key. The app must read the same project:
 * start it with `npm run dev:e2e` (scripts/next-e2e-project.mjs).
 *
 * @throws when a required key is missing, or NEXT_PUBLIC_SUPABASE_URL is not
 *   the project SUPABASE_E2E_REF names. Messages name keys, never values.
 */
export function e2eProjectEnv(rootDir: string): EnvPatch | null {
  const file = readEnvFile(path.join(rootDir, E2E_PROJECT_ENV_FILE));
  if (Object.keys(file).length === 0) return null;

  const missing = REQUIRED_KEYS.filter((key) => !file[key]);
  if (missing.length > 0) throw new Error(`${E2E_PROJECT_ENV_FILE} is missing: ${missing.join(", ")}`);
  const { NEXT_PUBLIC_SUPABASE_URL: url = "", SUPABASE_E2E_REF: ref } = file;
  if (!URL.canParse(url) || new URL(url).hostname !== `${ref}.supabase.co`) {
    throw new Error(`${E2E_PROJECT_ENV_FILE}: NEXT_PUBLIC_SUPABASE_URL is not the project SUPABASE_E2E_REF names`);
  }

  return Object.fromEntries([
    ...E2E_PROFILE_KEYS.map((key) => [key, file[key] || undefined] as const),
    ...PRODUCTION_ONLY_KEYS.map((key) => [key, undefined] as const),
  ]);
}
