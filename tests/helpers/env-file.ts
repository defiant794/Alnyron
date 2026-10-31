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
