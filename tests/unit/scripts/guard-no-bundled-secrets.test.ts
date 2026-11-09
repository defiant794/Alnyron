import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// scripts/guard-no-bundled-secrets.mjs runs after `opennextjs-cloudflare build`
// (npm run cf:build) and fails the build when a server-only secret has been
// compiled into .open-next (OpenNext compiles every root .env* file into the
// Worker). Each suite writes a fake output directory and runs the real script
// on it: a `process.env.NAME` read or a schema key whose value is a call
// passes, anything else that names a secret fails, and no value is ever
// printed.

const SCRIPT = resolve(process.cwd(), "scripts/guard-no-bundled-secrets.mjs");
const SECRET_NAMES = [
  "E2E_REVALIDATE_SECRET",
  "RESEND_API_KEY",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_DB_PASSWORD",
] as const;
/** Stands in for a secret value: it must never appear in the guard's output. */
const FIXTURE_VALUE = "fixture-value-5d1c";
/** A fake JWT (`{"alg":"HS256"}`.`{}`.`fixture`): dotted, no `-` or `_`, so its first segment reads as a name. */
const JWT_VALUE = "eyJhbGciOiJIUzI1NiJ9.e30.Zml4dHVyZQ";
/** A fake dotted password: every segment reads as a name. */
const DOTTED_VALUE = "correct.horse.battery";

type GuardRun = { status: number | null; output: string; leaks: string[] };

const tempDirs: string[] = [];

/** Writes `files` (relative path → content) under a fresh temp dir and returns the dir. */
function outputDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "bundled-secrets-"));
  tempDirs.push(dir);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), content);
  }
  return dir;
}

/** Runs the guard on `target` from inside `dir`, so reported paths are relative to `dir`. */
function runGuard(dir: string, target = "."): GuardRun {
  const result = spawnSync(process.execPath, [SCRIPT, target], { cwd: dir, encoding: "utf8" });
  const output = result.stdout + result.stderr;
  const leaks = [...output.matchAll(/^ {2}([A-Z0-9_]+) in (.+)$/gm)].map(
    ([, name, file]) => `${name} ${file}`,
  );
  return { status: result.status, output, leaks };
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("guard-no-bundled-secrets: each server-only secret", () => {
  let run: GuardRun;

  beforeAll(() => {
    const files: Record<string, string> = {};
    for (const name of SECRET_NAMES) {
      files[`${name}/route.js`] = `const s=process.env.${name};if(!s)return null;`;
      files[`${name}/cloudflare/next-env.mjs`] =
        `export const production = ${JSON.stringify({ [name]: FIXTURE_VALUE })};\n`;
      files[`${name}/.env.local`] = `${name}=${FIXTURE_VALUE}\n`;
    }
    run = runGuard(outputDir(files));
  });

  it.each(SECRET_NAMES)(
    "%s: a process.env read passes; its OpenNext env-file entry and a .env line fail",
    (name) => {
      expect(run.leaks.filter((leak) => leak.startsWith(`${name} `)).sort()).toEqual([
        `${name} ${name}/.env.local`,
        `${name} ${name}/cloudflare/next-env.mjs`,
      ]);
    },
  );

  it("exits 1 and reports names and files only, never a value", () => {
    expect(run.status).toBe(1);
    expect(run.leaks).toHaveLength(SECRET_NAMES.length * 2);
    expect(run.output).not.toContain(FIXTURE_VALUE);
  });

  it("says where each leaked secret belongs instead of a root .env* file", () => {
    expect(run.output).toContain("OpenNext compiles every root .env* file into the Worker");
    for (const name of SECRET_NAMES) {
      expect(run.output).toMatch(new RegExp(`^ {2}${name}: \\S`, "m"));
    }
    expect(run.output).toContain("wrangler secret put");
    expect(run.output).toContain(".dev.vars");
    expect(run.output).toContain("tests/.env.e2e");
  });
});

describe("guard-no-bundled-secrets: occurrences that only name a variable", () => {
  const ALLOWED: [label: string, file: string, content: string][] = [
    ["a runtime read of every secret", "reads.js", SECRET_NAMES.map((name) => `process.env.${name}`).join(";")],
    ["a minified zod schema key (webpack)", "webpack.js", "c({RESEND_API_KEY:d.YjP().min(1),MAIL_FROM:d.YjP().min(1)})"],
    ["an unminified zod schema key (esbuild)", "middleware.mjs", "var s = c({ RESEND_API_KEY: ki().min(1), MAIL_FROM: ki().min(1) });"],
    ["a schema key with an indirect call", "indirect.js", "c({RESEND_API_KEY:(0,d.YjP)().min(1)})"],
    [
      "public and non-secret env-file entries",
      "cloudflare/next-env.mjs",
      `export const production = ${JSON.stringify({
        NEXT_PUBLIC_SUPABASE_URL: FIXTURE_VALUE,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: FIXTURE_VALUE,
        NEXT_PUBLIC_SITE_URL: FIXTURE_VALUE,
        MAIL_FROM: FIXTURE_VALUE,
      })};\n`,
    ],
  ];
  let run: GuardRun;

  beforeAll(() => {
    run = runGuard(outputDir(Object.fromEntries(ALLOWED.map(([, file, content]) => [file, content]))));
  });

  it("exits 0 and reports no leak", () => {
    expect(run.status).toBe(0);
    expect(run.leaks).toEqual([]);
    expect(run.output).toContain("guard-no-bundled-secrets: no server-only secret in .");
  });

  it.each(ALLOWED)("passes %s", (_label, file) => {
    expect(run.leaks.some((leak) => leak.endsWith(` ${file}`))).toBe(false);
  });
});

describe("guard-no-bundled-secrets: occurrences that hold a value", () => {
  const LEAKS: [label: string, file: string, content: string, name: string][] = [
    ["an unquoted key with a string value", "string.js", `c({RESEND_API_KEY:${JSON.stringify(FIXTURE_VALUE)}})`, "RESEND_API_KEY"],
    ["an unquoted key with a template literal", "template.js", `c({RESEND_API_KEY:\`${FIXTURE_VALUE}\`})`, "RESEND_API_KEY"],
    ["an unquoted key with a number", "number.js", "c({SUPABASE_DB_PASSWORD:12345678})", "SUPABASE_DB_PASSWORD"],
    ["a dotenv `NAME: value` line", "copied.env", `SUPABASE_SECRET_KEY: ${FIXTURE_VALUE}\n`, "SUPABASE_SECRET_KEY"],
    ["a `NAME: value` line with a JWT-shaped value", "jwt.env", `SUPABASE_SECRET_KEY: ${JWT_VALUE}\n`, "SUPABASE_SECRET_KEY"],
    ["a `NAME: value` line with a dotted value", "dotted.env", `SUPABASE_DB_PASSWORD: ${DOTTED_VALUE}\n`, "SUPABASE_DB_PASSWORD"],
    [
      "a dotted value with an unpaired `)(`",
      "paren.env",
      `SUPABASE_DB_PASSWORD: ${DOTTED_VALUE})(1\n`,
      "SUPABASE_DB_PASSWORD",
    ],
    ["a bracket read", "bracket.js", 'process.env["SUPABASE_SECRET_KEY"]', "SUPABASE_SECRET_KEY"],
    ["a bare mention", "mention.js", "// arm the route with E2E_REVALIDATE_SECRET\n", "E2E_REVALIDATE_SECRET"],
    [
      "a value after an allowed read in the same file",
      "mixed.js",
      `const k=process.env.RESEND_API_KEY;const e=${JSON.stringify({ RESEND_API_KEY: FIXTURE_VALUE })};`,
      "RESEND_API_KEY",
    ],
  ];
  let run: GuardRun;

  beforeAll(() => {
    run = runGuard(outputDir(Object.fromEntries(LEAKS.map(([, file, content]) => [file, content]))));
  });

  it("exits 1, reports exactly one leak per file and never prints a value", () => {
    expect(run.status).toBe(1);
    expect(run.leaks).toHaveLength(LEAKS.length);
    for (const value of [FIXTURE_VALUE, JWT_VALUE, DOTTED_VALUE]) expect(run.output).not.toContain(value);
  });

  it.each(LEAKS)("fails on %s", (_label, file, _content, name) => {
    expect(run.leaks).toContain(`${name} ${file}`);
  });
});

describe("guard-no-bundled-secrets: no build output", () => {
  it("exits 0 when the output directory does not exist", () => {
    const run = runGuard(outputDir({}), "missing");
    expect(run.status).toBe(0);
    expect(run.output).toContain("guard-no-bundled-secrets: no missing output, nothing to check");
  });
});

describe("guard-no-bundled-secrets: ENG-AC6 SUPABASE_SECRET_KEY description updated for cron Worker", () => {
  let run: GuardRun;

  beforeAll(() => {
    // A file that leaks SUPABASE_SECRET_KEY by value — the guard must report it
    // and include the updated description mentioning the cron Worker.
    const files: Record<string, string> = {
      "cron/cloudflare/next-env.mjs":
        `export const p = ${JSON.stringify({ SUPABASE_SECRET_KEY: FIXTURE_VALUE })};\n`,
    };
    run = runGuard(outputDir(files));
  });

  it("ENG-AC6guard1: the SUPABASE_SECRET_KEY line names the tests and the cron Worker as its only homes", () => {
    // contract §5: description → "test tooling + cron Worker secret"
    expect(run.output.split(/\r?\n/)).toContain(
      "  SUPABASE_SECRET_KEY: test tooling + cron Worker secret: tests/.env.e2e or the shell environment for tests, " +
        "`wrangler secret put SUPABASE_SECRET_KEY --config workers/monitor-cron/wrangler.jsonc` for the cron Worker, never the app",
    );
  });

  it("ENG-AC6guard2: guard output still never prints the leaked value", () => {
    expect(run.output).not.toContain(FIXTURE_VALUE);
  });

  it("ENG-AC6guard3: guard exits 1 when SUPABASE_SECRET_KEY value is present", () => {
    expect(run.status).toBe(1);
  });
});
