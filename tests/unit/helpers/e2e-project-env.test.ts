/**
 * Unit tests: e2e Supabase project isolation (tests/helpers/e2e-project-env.ts
 * with applyEnvPatch from tests/helpers/env-file.ts, as playwright.config.ts
 * applies them). With tests/.env.e2e-project present, that file alone decides
 * every Supabase key of the run: a production value inherited from the shell
 * never survives. Profile files live in a temp dir; every value is a fake.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WITHOUT_E2E_PROJECT, e2eProjectEnv } from "../../helpers/e2e-project-env";
import { applyEnvPatch } from "../../helpers/env-file";

const E2E_REF = "e2eprojectref0000000";

/** A complete tests/.env.e2e-project. */
const PROFILE = {
  SUPABASE_E2E_REF: E2E_REF,
  SUPABASE_E2E_DB_HOST: "aws-0-eu-north-1.pooler.supabase.com",
  SUPABASE_E2E_DB_USER: `postgres.${E2E_REF}`,
  SUPABASE_E2E_DB_PORT: "5432",
  SUPABASE_E2E_DB_PASSWORD: "e2e-db-password-fixture",
  SUPABASE_SECRET_KEY: "e2e-secret-key-fixture",
  NEXT_PUBLIC_SUPABASE_URL: `https://${E2E_REF}.supabase.co`,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "e2e-publishable-key-fixture",
};

/** Production settings a developer's shell may export. */
const PROD_SHELL = {
  SUPABASE_DB_PASSWORD: "prod-db-password-fixture",
  SUPABASE_SECRET_KEY: "prod-secret-key-fixture",
  NEXT_PUBLIC_SUPABASE_URL: "https://prodprojectref000000.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "prod-publishable-key-fixture",
};

/** Stale e2e settings left in a shell. */
const STALE_E2E_SHELL = {
  SUPABASE_E2E_REF: "staleprojectref00000",
  SUPABASE_E2E_DB_HOST: "aws-0-us-east-1.pooler.supabase.com",
  SUPABASE_E2E_DB_USER: "postgres.staleprojectref00000",
  SUPABASE_E2E_DB_PORT: "6543",
  SUPABASE_E2E_DB_PASSWORD: "stale-e2e-password-fixture",
};

const REQUIRED_KEYS = [
  "SUPABASE_E2E_REF",
  "SUPABASE_E2E_DB_HOST",
  "SUPABASE_E2E_DB_PASSWORD",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
] as const;

let rootDir: string;

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-profile-"));
  fs.mkdirSync(path.join(rootDir, "tests"));
});

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

function writeProfile(values: Readonly<Record<string, string>>): void {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}\n`);
  fs.writeFileSync(path.join(rootDir, "tests", ".env.e2e-project"), lines.join(""));
}

function without(values: Readonly<Record<string, string>>, ...keys: string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter(([key]) => !keys.includes(key)));
}

/** The environment after playwright.config.ts applied the profile to `shell`. */
function e2eRun(shell: Readonly<Record<string, string>>): NodeJS.Dict<string> {
  const patch = e2eProjectEnv(rootDir);
  if (!patch) throw new Error("expected tests/.env.e2e-project to be read");
  const env: NodeJS.Dict<string> = { ...shell };
  applyEnvPatch(env, patch);
  return env;
}

function errorOf(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a throw");
}

describe("e2eProjectEnv: tests/.env.e2e-project fully determines the Supabase settings", () => {
  it("sets every Supabase key of the run from the profile", () => {
    writeProfile(PROFILE);
    expect(e2eRun({ ...PROD_SHELL, ...STALE_E2E_SHELL })).toMatchObject(PROFILE);
  });

  it("leaves no production value anywhere in the environment", () => {
    writeProfile(PROFILE);
    const values = Object.values(e2eRun(PROD_SHELL));
    for (const prodValue of Object.values(PROD_SHELL)) expect(values).not.toContain(prodValue);
  });

  it("removes the production SUPABASE_DB_PASSWORD", () => {
    writeProfile(PROFILE);
    expect(e2eRun(PROD_SHELL)).not.toHaveProperty("SUPABASE_DB_PASSWORD");
  });

  it("removes a shell SUPABASE_SECRET_KEY when the profile has none, instead of keeping production's", () => {
    writeProfile(without(PROFILE, "SUPABASE_SECRET_KEY"));
    expect(e2eRun(PROD_SHELL)).not.toHaveProperty("SUPABASE_SECRET_KEY");
  });

  it("removes stale SUPABASE_E2E_DB_USER and SUPABASE_E2E_DB_PORT when the profile leaves them to their defaults", () => {
    writeProfile(without(PROFILE, "SUPABASE_E2E_DB_USER", "SUPABASE_E2E_DB_PORT"));
    const env = e2eRun(STALE_E2E_SHELL);
    expect(env).not.toHaveProperty("SUPABASE_E2E_DB_USER");
    expect(env).not.toHaveProperty("SUPABASE_E2E_DB_PORT");
  });

  it("never takes a SUPABASE_DB_PASSWORD from the profile: the e2e DB password is SUPABASE_E2E_DB_PASSWORD", () => {
    writeProfile({ ...PROFILE, SUPABASE_DB_PASSWORD: "legacy-password-fixture" });
    const env = e2eRun(PROD_SHELL);
    expect(env).not.toHaveProperty("SUPABASE_DB_PASSWORD");
    expect(env.SUPABASE_E2E_DB_PASSWORD).toBe(PROFILE.SUPABASE_E2E_DB_PASSWORD);
  });

  it("keeps keys outside the Supabase profile", () => {
    writeProfile(PROFILE);
    expect(e2eRun({ PLAYWRIGHT_BASE_URL: "http://localhost:3000" }).PLAYWRIGHT_BASE_URL).toBe("http://localhost:3000");
  });
});

describe("e2eProjectEnv: e2e mode requires the e2e-specific keys", () => {
  it.each(REQUIRED_KEYS)("throws naming %s when the profile lacks it", (key) => {
    writeProfile(without(PROFILE, key));
    expect(() => e2eProjectEnv(rootDir)).toThrow(new RegExp(`is missing: ${key}$`));
  });

  it("rejects a profile with only the production-named SUPABASE_DB_PASSWORD", () => {
    writeProfile({ ...without(PROFILE, "SUPABASE_E2E_DB_PASSWORD"), SUPABASE_DB_PASSWORD: "legacy-password-fixture" });
    expect(() => e2eProjectEnv(rootDir)).toThrow(/is missing: SUPABASE_E2E_DB_PASSWORD/);
  });

  it("throws when NEXT_PUBLIC_SUPABASE_URL is another project than SUPABASE_E2E_REF", () => {
    writeProfile({ ...PROFILE, NEXT_PUBLIC_SUPABASE_URL: PROD_SHELL.NEXT_PUBLIC_SUPABASE_URL });
    expect(() => e2eProjectEnv(rootDir)).toThrow(/NEXT_PUBLIC_SUPABASE_URL is not the project SUPABASE_E2E_REF names/);
  });

  it("throws when NEXT_PUBLIC_SUPABASE_URL is not a URL", () => {
    writeProfile({ ...PROFILE, NEXT_PUBLIC_SUPABASE_URL: "not a url" });
    expect(() => e2eProjectEnv(rootDir)).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });

  it("names keys in its errors, never values", () => {
    writeProfile({ ...without(PROFILE, "SUPABASE_E2E_DB_HOST"), NEXT_PUBLIC_SUPABASE_URL: PROD_SHELL.NEXT_PUBLIC_SUPABASE_URL });
    const { message } = errorOf(() => e2eProjectEnv(rootDir));
    for (const value of [...Object.values(PROFILE), PROD_SHELL.NEXT_PUBLIC_SUPABASE_URL]) {
      if (value !== E2E_REF) expect(message).not.toContain(value);
    }
  });
});

describe("without tests/.env.e2e-project: the linked project, unchanged", () => {
  it("returns null, so playwright.config.ts keeps tests/.env.e2e and .env.local", () => {
    expect(e2eProjectEnv(rootDir)).toBeNull();
  });

  it("WITHOUT_E2E_PROJECT removes every stale SUPABASE_E2E_* key, so the DB target stays the linked project", () => {
    const env: NodeJS.Dict<string> = { ...STALE_E2E_SHELL };
    applyEnvPatch(env, WITHOUT_E2E_PROJECT);
    expect(env).toEqual({});
  });

  it("WITHOUT_E2E_PROJECT leaves the linked project's keys as they are", () => {
    const env: NodeJS.Dict<string> = { ...PROD_SHELL, ...STALE_E2E_SHELL };
    applyEnvPatch(env, WITHOUT_E2E_PROJECT);
    expect(env).toEqual(PROD_SHELL);
  });
});

describe("applyEnvPatch", () => {
  it("sets string values and deletes keys patched to undefined (never the string 'undefined')", () => {
    const env: NodeJS.Dict<string> = { KEEP: "1", DROP: "2", REPLACE: "3" };
    applyEnvPatch(env, { DROP: undefined, REPLACE: "4", ADD: "5" });
    expect(env).toEqual({ KEEP: "1", REPLACE: "4", ADD: "5" });
    expect(Object.keys(env)).not.toContain("DROP");
  });
});
