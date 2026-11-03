/**
 * Runs the Next.js CLI against the isolated e2e Supabase project, the one
 * playwright.config.ts targets when tests/.env.e2e-project exists, so the app
 * reads the rows the e2e DB fixtures write:
 *
 *   npm run dev:e2e -- -p 3000                         next dev
 *   node scripts/next-e2e-project.mjs build            a production build, then
 *   node scripts/next-e2e-project.mjs start -p 3000    serve it
 *
 * NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY come from
 * the git-ignored tests/.env.e2e-project and win over .env.local (Next never
 * replaces a variable already in the environment). Only these two public keys
 * reach the app: the e2e project's DB password and secret key stay with the
 * Playwright fixtures. Values are never printed. Next runs in this process,
 * so stopping it stops everything this script started.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parseEnv } from "node:util";

const ENV_FILE = "tests/.env.e2e-project";
const PUBLIC_KEYS = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"];

let settings;
try {
  settings = parseEnv(readFileSync(ENV_FILE, "utf-8"));
} catch (error) {
  console.error(`Cannot read ${ENV_FILE} (${error.code ?? error.message}); run from the repo root.`);
  process.exit(1);
}
const missing = PUBLIC_KEYS.filter((key) => !settings[key]);
if (missing.length > 0) {
  console.error(`${ENV_FILE} is missing: ${missing.join(", ")}`);
  process.exit(1);
}
for (const key of PUBLIC_KEYS) process.env[key] = settings[key];

const projectRef = new URL(settings.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
const args = process.argv.slice(2);
console.log(`next ${args.join(" ")} against the e2e Supabase project ${projectRef}`);

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");
process.argv = [process.argv[0], nextBin, ...args];
require(nextBin);
