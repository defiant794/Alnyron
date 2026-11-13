/**
 * Build guard: fails `npm run cf:build` when a server-only secret has been
 * compiled into the Cloudflare Worker output (.open-next).
 *
 * @opennextjs/cloudflare compiles every root .env* file (.env, .env.<mode>,
 * .env.local, .env.<mode>.local) into the Worker
 * (.open-next/cloudflare/next-env.mjs), so a secret put in one of them ships
 * inside the deployed bundle: readable by anyone holding the bundle and, for
 * E2E_REVALIDATE_SECRET, arming the test-only POST /api/test/revalidate in
 * production. Server secrets belong in the shell environment, in
 * `wrangler secret put` for the deployed Worker or in the git-ignored
 * .dev.vars for a local Workers preview (read by wrangler only, never
 * compiled); test-only secrets in tests/.env.e2e. Never in a root .env* file.
 *
 * Every file under the output is scanned for each name in SECRETS. An
 * occurrence that only names the variable passes:
 *   - a runtime read, `process.env.NAME`;
 *   - a schema key whose value is a call, e.g. `RESEND_API_KEY: z.string()`
 *     in src/config/env.ts (minified `RESEND_API_KEY:d.YjP()`).
 * Any other occurrence fails the build: an env-file entry such as
 * `"NAME":"…"`, `NAME:"…"` or `NAME=…`, an unquoted `NAME: value` line (a
 * dotted value such as a JWT included), or a bare mention. Every leaking
 * (name, file) pair is reported.
 *
 * Every file is also scanned for a live Stripe key's VALUE (`sk_live_` or
 * `rk_live_`, then at least 20 letters or digits), under whatever name or
 * none: hardcoded in source, or inlined some other way the name scan cannot
 * see. The prefix may follow any character, a word character included (a
 * JSON-escaped newline `\nsk_live_…`, a name glued on as in `key_rk_live_…`):
 * a false positive fails the build, the safe direction. Each file holding one
 * is reported. Output names variables and files only, never a value.
 *
 * Usage: node scripts/guard-no-bundled-secrets.mjs [dir]   (default: .open-next)
 * Exits 0 when the directory does not exist, 1 on any leak.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Server-only secrets, each with where it belongs instead of a root .env* file. */
const SECRETS = new Map([
  [
    "E2E_REVALIDATE_SECRET",
    "test-only: the shell environment of a local `npm run start` and `npm run test:e2e`, never Cloudflare",
  ],
  [
    "RESEND_API_KEY",
    "`wrangler secret put` for the deployed Worker, .dev.vars for `npm run preview`, the shell environment for `next dev`/`next start`",
  ],
  [
    "SUPABASE_SECRET_KEY",
    "test tooling + cron Worker secret: tests/.env.e2e or the shell environment for tests, `wrangler secret put SUPABASE_SECRET_KEY --config workers/monitor-cron/wrangler.jsonc` for the cron Worker, never the app",
  ],
  ["SUPABASE_DB_PASSWORD", "test-only: tests/.env.e2e or the shell environment, never the app"],
  [
    "STRIPE_CHECKOUT_KEY",
    "`wrangler secret put STRIPE_CHECKOUT_KEY` for the deployed Worker, .dev.vars for `npm run preview`, the shell environment for `next dev`/`next start`",
  ],
]);

const PROJECT = fileURLToPath(new URL("..", import.meta.url));
const ROOT = resolve(process.argv[2] ?? join(PROJECT, ".open-next"));

const RUNTIME_READ = Buffer.from("process.env.");
/**
 * What follows a schema key: `:` then a call of a (possibly dotted) name,
 * directly or as an indirect call (`z.string()`, `d.YjP()`, `ki()`,
 * `(0,d.YjP)()`). A string, number or template literal does not match, nor
 * does a bare name or member access: an unquoted `NAME: value` line whose
 * value is dotted (a JWT, a dotted password) is a leak. Only the bytes after
 * the name are tested, so an expression longer than the window counts as a
 * leak (fail-safe).
 */
const CALLEE = String.raw`[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*`;
const CALL_VALUE = new RegExp(String.raw`^\s*:\s*(?:\(\s*0\s*,\s*${CALLEE}\s*\)|${CALLEE})\s*\(`);
const CALL_WINDOW = 64;

/**
 * A live Stripe secret or restricted key's value, wherever it starts: no `\b` before the
 * prefix, so a key right after a word character still matches. LIVE_MARK is a cheap
 * pre-check on the raw bytes.
 */
const LIVE_STRIPE_KEY = /(?:sk|rk)_live_[A-Za-z0-9]{20,}/;
const LIVE_MARK = Buffer.from("_live_");

/** Yields every regular file below `dir`. */
function* filesUnder(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* filesUnder(path);
    else if (entry.isFile()) yield path;
  }
}

/** True when `content` names `name` anywhere other than a runtime read or a call-valued schema key. */
function holdsValue(content, name) {
  const needle = Buffer.from(name);
  for (let at = content.indexOf(needle); at !== -1; at = content.indexOf(needle, at + needle.length)) {
    const start = at - RUNTIME_READ.length;
    if (start >= 0 && content.subarray(start, at).equals(RUNTIME_READ)) continue;
    const end = at + needle.length;
    if (CALL_VALUE.test(content.subarray(end, end + CALL_WINDOW).toString("latin1"))) continue;
    return true;
  }
  return false;
}

/** True when `content` holds a live Stripe key's value. */
function holdsLiveStripeKey(content) {
  return content.includes(LIVE_MARK) && LIVE_STRIPE_KEY.test(content.toString("latin1"));
}

/** `path` relative to the working directory, with `/` separators. */
function shown(path) {
  return relative(process.cwd(), path).split(sep).join("/") || ".";
}

if (!existsSync(ROOT)) {
  console.log(`guard-no-bundled-secrets: no ${shown(ROOT)} output, nothing to check`);
} else {
  const leaks = [];
  const liveKeyFiles = [];
  for (const file of filesUnder(ROOT)) {
    const content = readFileSync(file);
    for (const name of SECRETS.keys()) {
      if (holdsValue(content, name)) leaks.push({ name, file: shown(file) });
    }
    if (holdsLiveStripeKey(content)) liveKeyFiles.push(shown(file));
  }

  if (leaks.length > 0 || liveKeyFiles.length > 0) {
    leaks.sort((a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file));
    liveKeyFiles.sort((a, b) => a.localeCompare(b));
    const leaked = [...new Set(leaks.map(({ name }) => name))];
    const lines = [
      `guard-no-bundled-secrets: server-only secrets are compiled into the Worker bundle:`,
      ...leaks.map(({ name, file }) => `  ${name} in ${file}`),
      ...liveKeyFiles.map((file) => `  a live Stripe key in ${file}`),
    ];
    if (leaks.length > 0) {
      lines.push(
        `OpenNext compiles every root .env* file into the Worker. Remove these names from all of them,`,
        `keep each one where it belongs, and rebuild:`,
        ...leaked.map((name) => `  ${name}: ${SECRETS.get(name)}`),
      );
    }
    if (liveKeyFiles.length > 0) {
      lines.push(
        `A live Stripe key belongs only in \`wrangler secret put STRIPE_CHECKOUT_KEY\` (a restricted rk_live_ key).`,
        `Remove it from the source and from every root .env* file, roll it in the Stripe Dashboard if it`,
        `was ever committed or deployed, and rebuild.`,
      );
    }
    console.error(lines.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(
      `guard-no-bundled-secrets: no server-only secret in ${shown(ROOT)} (${[...SECRETS.keys()].join(", ")}) ` +
        `and no live Stripe key`,
    );
  }
}
