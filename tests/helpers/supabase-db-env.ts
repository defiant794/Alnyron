import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

/**
 * SUPABASE_DB_* settings for DB test tooling (tests/integration/rls/helpers/db.ts,
 * also used by the e2e DB fixture): a value already in process.env wins, else
 * the git-ignored `.env.local` in `rootDir`. Only the DB keys are returned, not
 * the rest of the file.
 */
export function supabaseDbEnv(rootDir: string): Record<string, string> {
  let fromFile: NodeJS.Dict<string> = {};
  try {
    fromFile = parseEnv(fs.readFileSync(path.join(rootDir, ".env.local"), "utf-8"));
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
