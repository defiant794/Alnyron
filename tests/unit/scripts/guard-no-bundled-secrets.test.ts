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
  "STRIPE_CHECKOUT_KEY",
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

// ── PAY1B-AC47: STRIPE_CHECKOUT_KEY is guarded ────────────────────────────────

/**
 * Key-shaped fixtures are joined at run time: no Stripe-key-shaped literal sits in this
 * source, where the commit secret scan would (rightly) stop it.
 */
const STRIPE_TEST_KEY = ["sk", "test", "fakekeyABCDEF1234567890"].join("_");

describe("PAY1B-AC47: guard-no-bundled-secrets detects STRIPE_CHECKOUT_KEY by value", () => {
  it("PAY1B-AC47a: exits 1 and reports STRIPE_CHECKOUT_KEY when a sk_test_ value is present in the build output", () => {
    // Write a fake OpenNext env file that leaks STRIPE_CHECKOUT_KEY by value.
    // The guard must detect it and exit non-zero.
    const run = runGuard(
      outputDir({
        "app/cloudflare/next-env.mjs": `export const production = ${JSON.stringify({ STRIPE_CHECKOUT_KEY: STRIPE_TEST_KEY })};\n`,
      }),
    );
    expect(run.status).toBe(1);
    expect(run.leaks.some((l) => l.startsWith("STRIPE_CHECKOUT_KEY "))).toBe(true);
  });

  it("PAY1B-AC47b: guard output never prints the secret value itself", () => {
    const run = runGuard(
      outputDir({
        "app/cloudflare/next-env.mjs": `export const production = ${JSON.stringify({ STRIPE_CHECKOUT_KEY: STRIPE_TEST_KEY })};\n`,
      }),
    );
    expect(run.output).not.toContain(STRIPE_TEST_KEY);
  });

  it("PAY1B-AC47c: a process.env.STRIPE_CHECKOUT_KEY read (not a value) passes the guard", () => {
    const run = runGuard(
      outputDir({
        "app/route.js": `const k = process.env.STRIPE_CHECKOUT_KEY; if (!k) return null;`,
      }),
    );
    // A reference in JS source (not a literal value in an env file) must not fail
    expect(run.status).toBe(0);
    expect(run.leaks).toEqual([]);
  });

  // Reading the key as a property of a parsed env object, or destructuring it, leaves its name
  // in the bundle in a shape the guard cannot tell from a value: the build fails.
  it.each([
    ["a member read", "member.js", "(0,s.createCheckoutSession)(e.STRIPE_CHECKOUT_KEY,(0,c.buildParams)(t))"],
    ["a destructuring", "destructure.js", "const{STRIPE_CHECKOUT_KEY:e,STRIPE_TAX_RATE_ID:t}=(0,n.getStripeEnv)();"],
  ])("PAY1B-AC47d: %s of STRIPE_CHECKOUT_KEY fails the guard (exit 1)", (_label, file, content) => {
    const run = runGuard(outputDir({ [file]: content }));
    expect(run.status).toBe(1);
    expect(run.leaks).toEqual([`STRIPE_CHECKOUT_KEY ${file}`]);
  });

  it("PAY1B-AC47e: the shapes the server-only src/config/stripe-env.ts compiles to (from a real cf:build) pass the guard (exit 0)", () => {
    // Only the server function holds them: no client chunk or middleware loads stripe-env.ts (B10).
    // webpack inlines it into the billing page's chunk (getStripeEnv inlined into the action's
    // stripeEnvOrNull): the schema key, then the literal process.env read and the B14 mode check;
    // OpenNext's esbuild bundle of the server function (handler.mjs) carries the same code with
    // renamed locals. Copied from the 2026-11-12 cf:build after B12/B14.
    const schema =
      "let j=/^(?:(?:sk|rk)_test|rk_live)_[A-Za-z0-9]+$/,k=/^[a-z]+_live_/," +
      "l=f.Ikc({STRIPE_CHECKOUT_KEY:f.YjP().regex(j)," +
      "STRIPE_TAX_RATE_ID:f.YjP().regex(/^txr_[A-Za-z0-9]+$/)," +
      "STRIPE_PORTAL_CONFIGURATION_ID:f.YjP().regex(/^bpc_[A-Za-z0-9]+$/)," +
      'STRIPE_LIVEMODE:f.k5n(["true","false"])});';
    const getStripeEnv = (a: string, b: string, c: string, livemode: string) =>
      `function C(){try{let ${a}=(0,g.Ku)(l,process.env,"Stripe"),` +
      `${b}=f.YjP().regex(j).parse(process.env.STRIPE_CHECKOUT_KEY),${c}=${livemode};` +
      `if(k.test(${b})!==${c})throw Error("Invalid Stripe environment variables: STRIPE_LIVEMODE does not match the API key's mode");` +
      `return{checkoutKey:${b},taxRateId:${a}.STRIPE_TAX_RATE_ID,portalConfigurationId:${a}.STRIPE_PORTAL_CONFIGURATION_ID,livemode:${c}}}` +
      "catch{return null}}";
    const run = runGuard(
      outputDir({
        "server-functions/default/.next/server/app/monitor/(panel)/billing/page.js":
          schema + getStripeEnv("a", "b", "c", '"true"===a.STRIPE_LIVEMODE'),
        "server-functions/default/handler.mjs": schema + getStripeEnv("a3", "b3", "c3", 'a3.STRIPE_LIVEMODE==="true"'),
      }),
    );
    expect(run.status).toBe(0);
    expect(run.leaks).toEqual([]);
    expect(run.output).not.toContain("a live Stripe key");
  });
});

// ── PAY1B-AC47f/g (B15, B16): a live Stripe key's value, under any name or none ───

/** Live-shaped fake keys (24 letters and digits after the prefix), joined at run time like STRIPE_TEST_KEY. */
const LIVE_BODY = "F1xtureOnlyNotAKey012345";
const SK_LIVE = ["sk", "live", LIVE_BODY].join("_");
const RK_LIVE = ["rk", "live", LIVE_BODY].join("_");
/** The shortest live key B15 matches: exactly 20 characters after the prefix. */
const LIVE_BODY_20 = LIVE_BODY.slice(0, 20);
const RK_LIVE_20 = ["rk", "live", LIVE_BODY_20].join("_");
/**
 * next-env.mjs as OpenNext writes a multi-line .env value: JSON.stringify escapes the newline,
 * so the `n` of `\n` sits right before the prefix (B16: no `\b` before it).
 */
const ESCAPED_NEWLINE_ENV = `export const production = ${JSON.stringify({ PAYMENTS_NOTE: `x\n${SK_LIVE}` })};\n`;

describe("PAY1B-AC47 (B15, B16): guard-no-bundled-secrets fails on a live Stripe key's value", () => {
  let run: GuardRun;

  beforeAll(() => {
    run = runGuard(
      outputDir({
        // Hardcoded in a server chunk: no variable name at all.
        "server-functions/default/hardcoded.js": `const s=${JSON.stringify(SK_LIVE)};fetch(u,{headers:{a:"Bearer "+s}});`,
        // An env-file entry under a name the name scan does not know.
        "cloudflare/renamed.mjs": `export const production = ${JSON.stringify({ PAYMENTS_TOKEN: RK_LIVE })};\n`,
        // Under the guarded name: reported both ways.
        "cloudflare/next-env.mjs": `export const production = ${JSON.stringify({ STRIPE_CHECKOUT_KEY: RK_LIVE })};\n`,
        // Exactly 20 characters after the prefix: the `{20,}` boundary, on the failing side.
        "server-functions/default/boundary.js": `const s=${JSON.stringify(RK_LIVE_20)};`,
        // Right after a word character (B16).
        "server-functions/default/prefixed.js": `const s=${JSON.stringify(`x${RK_LIVE}`)};`,
        // After an escaped newline in a JSON string, under a name the name scan does not know (B16).
        "cloudflare/multiline/next-env.mjs": ESCAPED_NEWLINE_ENV,
      }),
    );
  });

  it("PAY1B-AC47f: exits 1 and reports every file holding one, by path only", () => {
    expect(run.status).toBe(1);
    const lines = run.output.split(/\r?\n/);
    expect(lines.filter((line) => line.startsWith("  a live Stripe key in "))).toEqual([
      "  a live Stripe key in cloudflare/multiline/next-env.mjs",
      "  a live Stripe key in cloudflare/next-env.mjs",
      "  a live Stripe key in cloudflare/renamed.mjs",
      "  a live Stripe key in server-functions/default/boundary.js",
      "  a live Stripe key in server-functions/default/hardcoded.js",
      "  a live Stripe key in server-functions/default/prefixed.js",
    ]);
    expect(run.leaks).toEqual(["STRIPE_CHECKOUT_KEY cloudflare/next-env.mjs"]);
    expect(lines).toContain(
      "A live Stripe key belongs only in `wrangler secret put STRIPE_CHECKOUT_KEY` (a restricted rk_live_ key).",
    );
  });

  it("PAY1B-AC47f: never prints a key, nor any part of one past its prefix", () => {
    for (const value of [SK_LIVE, RK_LIVE, LIVE_BODY, RK_LIVE_20, LIVE_BODY_20]) {
      expect(run.output).not.toContain(value);
    }
  });

  it(
    "PAY1B-AC47f (B16): a live key right after a word character, glued to a name or after an " +
      "escaped newline in a JSON string, is a live key (exit 1, file reported)",
    () => {
      expect(ESCAPED_NEWLINE_ENV).toContain(`"x\\n${SK_LIVE}"`);
      expect(run.status).toBe(1);
      const lines = run.output.split(/\r?\n/);
      expect(lines).toContain("  a live Stripe key in cloudflare/multiline/next-env.mjs");
      expect(lines).toContain("  a live Stripe key in server-functions/default/prefixed.js");
    },
  );

  it(
    "PAY1B-AC47g: test keys, a live prefix with fewer than 20 characters after it, and the key " +
      "patterns src/config/stripe-env.ts compiles to are not live keys (exit 0)",
    () => {
      const clean = runGuard(
        outputDir({
          "test-keys.mjs": `export const k = ${JSON.stringify([
            ["sk", "test", LIVE_BODY].join("_"),
            ["rk", "test", LIVE_BODY].join("_"),
          ])};\n`,
          "short.js": `const s=${JSON.stringify(["rk", "live", LIVE_BODY.slice(0, 19)].join("_"))};`,
          "patterns.js": "let j=/^(?:(?:sk|rk)_test|rk_live)_[A-Za-z0-9]+$/,l=/^[a-z]+_live_/;",
        }),
      );
      expect(clean.status).toBe(0);
      expect(clean.output).not.toContain("a live Stripe key");
      expect(clean.output).toContain("and no live Stripe key");
    },
  );
});
