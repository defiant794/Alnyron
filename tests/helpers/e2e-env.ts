import path from "node:path";
import { TEST_ENV_FILE, pickEnv, readEnvFile } from "./env-file";

/** The app's public settings the admin-auth fixtures reuse, from the app's `.env.local`. */
const APP_PUBLIC_KEYS: Record<string, true> = {
  NEXT_PUBLIC_SUPABASE_URL: true,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: true,
  NEXT_PUBLIC_SITE_URL: true,
};

/**
 * Env for the Playwright admin-auth fixtures, on top of `supabaseDbEnv`
 * (a value already in process.env wins over both files):
 *   - the app's public Supabase/site values, from `.env.local`;
 *   - SUPABASE_SECRET_KEY (generate_link for the invite and reset flows), from
 *     the git-ignored `tests/.env.e2e` only. The app has no secret key: it must
 *     never be in `.env.local`, which OpenNext compiles into the Worker.
 */
export function e2eEnv(rootDir: string): Record<string, string> {
  return {
    ...pickEnv(readEnvFile(path.join(rootDir, ".env.local")), (key) => APP_PUBLIC_KEYS[key] === true),
    ...pickEnv(
      readEnvFile(path.join(rootDir, TEST_ENV_FILE)),
      (key) => key === "SUPABASE_SECRET_KEY",
    ),
  };
}
