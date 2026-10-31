/**
 * Build guard: fails `npm run cf:build` when the test-only E2E_REVALIDATE_SECRET
 * has been compiled into the Cloudflare Worker output (.open-next).
 *
 * @opennextjs/cloudflare compiles every root .env* file into the Worker
 * (.open-next/cloudflare/next-env.mjs), so a secret put in .env.local by
 * mistake would ship with the deployed app and arm the test-only
 * POST /api/test/revalidate in production.
 *
 * Every file under .open-next is scanned for the variable name. The one
 * expected occurrence is the route reading it at runtime,
 * `process.env.E2E_REVALIDATE_SECRET`, which names the variable without
 * holding a value; any other occurrence (an env-file entry such as
 * `"E2E_REVALIDATE_SECRET":"…"` or `E2E_REVALIDATE_SECRET=…`) fails the build.
 * Exits 0 when .open-next does not exist.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const NAME = "E2E_REVALIDATE_SECRET";
const ROOT = fileURLToPath(new URL("../.open-next", import.meta.url));
const PROJECT = fileURLToPath(new URL("..", import.meta.url));

const needle = Buffer.from(NAME);
const runtimeRead = Buffer.from("process.env.");

/** Yields every regular file below `dir`. */
function* filesUnder(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* filesUnder(path);
    else if (entry.isFile()) yield path;
  }
}

/** True when `content` names the variable anywhere other than a `process.env.` read. */
function holdsSecret(content) {
  for (let at = content.indexOf(needle); at !== -1; at = content.indexOf(needle, at + needle.length)) {
    const start = at - runtimeRead.length;
    if (start < 0 || !content.subarray(start, at).equals(runtimeRead)) return true;
  }
  return false;
}

if (!existsSync(ROOT)) {
  console.log(`guard-no-e2e-secret: no ${relative(PROJECT, ROOT)} output, nothing to check`);
} else {
  const leaks = [];
  for (const file of filesUnder(ROOT)) {
    if (holdsSecret(readFileSync(file))) leaks.push(relative(PROJECT, file));
  }

  if (leaks.length > 0) {
    console.error(
      [
        `guard-no-e2e-secret: ${NAME} is compiled into the Worker bundle:`,
        ...leaks.map((file) => `  ${file}`),
        `It is a test-only secret for a local production build. Remove it from every root .env* file`,
        `(OpenNext compiles them into the Worker), keep it in the shell environment only, and rebuild.`,
      ].join("\n"),
    );
    process.exitCode = 1;
  } else {
    console.log(`guard-no-e2e-secret: ${NAME} is not in ${relative(PROJECT, ROOT)}`);
  }
}
