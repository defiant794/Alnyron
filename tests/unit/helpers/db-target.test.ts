/**
 * Unit tests: which project the integration/e2e DB pool connects to
 * (dbTarget in tests/integration/rls/helpers/db.ts). Without SUPABASE_E2E_REF
 * it is the production project with SUPABASE_DB_PASSWORD, as the integration
 * tests always had it; with it, only the SUPABASE_E2E_* keys count, so the e2e
 * host is never paired with the production password. Every value is a fake.
 */
import { describe, expect, it } from "vitest";
import { dbTarget } from "../../integration/rls/helpers/db";

const PROD_POOLER_HOST = "aws-1-eu-west-3.pooler.supabase.com";
const PROD_USER = "postgres.xmgpixhxecamtryohgmk";
const PROD_PASSWORD = "prod-db-password-fixture";

const E2E_REF = "e2eprojectref0000000";
const E2E_HOST = "aws-0-eu-north-1.pooler.supabase.com";
const E2E_PASSWORD = "e2e-db-password-fixture";
const E2E_ENV = {
  SUPABASE_E2E_REF: E2E_REF,
  SUPABASE_E2E_DB_HOST: E2E_HOST,
  SUPABASE_E2E_DB_PASSWORD: E2E_PASSWORD,
};

function errorOf(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a throw");
}

describe("dbTarget without SUPABASE_E2E_REF: the production project (integration path unchanged)", () => {
  it("connects to the production pooler as its pooler user with SUPABASE_DB_PASSWORD", () => {
    expect(dbTarget({ SUPABASE_DB_PASSWORD: PROD_PASSWORD })).toEqual({
      host: PROD_POOLER_HOST,
      user: PROD_USER,
      sessionPort: 5432,
      password: PROD_PASSWORD,
      passwordKey: "SUPABASE_DB_PASSWORD",
    });
  });

  it("ignores SUPABASE_E2E_DB_* keys while SUPABASE_E2E_REF is unset", () => {
    const env = {
      SUPABASE_E2E_DB_HOST: E2E_HOST,
      SUPABASE_E2E_DB_PASSWORD: E2E_PASSWORD,
      SUPABASE_E2E_DB_PORT: "6543",
      SUPABASE_DB_PASSWORD: PROD_PASSWORD,
    };
    expect(dbTarget(env)).toMatchObject({
      host: PROD_POOLER_HOST,
      sessionPort: 5432,
      password: PROD_PASSWORD,
    });
  });

  it("throws without SUPABASE_DB_PASSWORD", () => {
    expect(() => dbTarget({})).toThrow(/No DB credentials: set SUPABASE_DB_PASSWORD/);
  });
});

describe("dbTarget with SUPABASE_E2E_REF: only the e2e project's own keys", () => {
  it("connects to the e2e host as postgres.<ref> on port 5432 with SUPABASE_E2E_DB_PASSWORD", () => {
    expect(dbTarget(E2E_ENV)).toEqual({
      host: E2E_ENV.SUPABASE_E2E_DB_HOST,
      user: `postgres.${E2E_REF}`,
      sessionPort: 5432,
      password: E2E_ENV.SUPABASE_E2E_DB_PASSWORD,
      passwordKey: "SUPABASE_E2E_DB_PASSWORD",
    });
  });

  it("uses SUPABASE_E2E_DB_USER and SUPABASE_E2E_DB_PORT when set", () => {
    expect(dbTarget({ ...E2E_ENV, SUPABASE_E2E_DB_USER: `postgres.${E2E_REF}`, SUPABASE_E2E_DB_PORT: "6543" })).toMatchObject({
      user: `postgres.${E2E_REF}`,
      sessionPort: 6543,
    });
  });

  it("never uses SUPABASE_DB_PASSWORD, even when the environment still holds it", () => {
    expect(dbTarget({ ...E2E_ENV, SUPABASE_DB_PASSWORD: PROD_PASSWORD }).password).toBe(E2E_ENV.SUPABASE_E2E_DB_PASSWORD);
  });

  it("a stale SUPABASE_E2E_REF with only the production password throws instead of pairing them", () => {
    const env = { SUPABASE_E2E_REF: E2E_REF, SUPABASE_E2E_DB_HOST: E2E_HOST, SUPABASE_DB_PASSWORD: PROD_PASSWORD };
    const { message } = errorOf(() => dbTarget(env));
    expect(message).toMatch(/SUPABASE_E2E_DB_PASSWORD is not/);
    expect(message).not.toContain(PROD_PASSWORD);
  });

  it("throws without SUPABASE_E2E_DB_HOST rather than falling back to the production pooler", () => {
    const env = { SUPABASE_E2E_REF: E2E_REF, SUPABASE_E2E_DB_PASSWORD: E2E_PASSWORD, SUPABASE_DB_PASSWORD: PROD_PASSWORD };
    expect(() => dbTarget(env)).toThrow(/SUPABASE_E2E_DB_HOST is not/);
  });

  it("throws when SUPABASE_E2E_DB_USER is not the pooler user of SUPABASE_E2E_REF", () => {
    expect(() => dbTarget({ ...E2E_ENV, SUPABASE_E2E_DB_USER: PROD_USER })).toThrow(/SUPABASE_E2E_DB_USER must be/);
  });

  it("throws when SUPABASE_E2E_DB_PORT is not a port number", () => {
    expect(() => dbTarget({ ...E2E_ENV, SUPABASE_E2E_DB_PORT: "pooler" })).toThrow(/SUPABASE_E2E_DB_PORT/);
  });

  it("throws when SUPABASE_E2E_REF names the production project", () => {
    expect(() =>
      dbTarget({ ...E2E_ENV, SUPABASE_E2E_REF: "xmgpixhxecamtryohgmk", SUPABASE_E2E_DB_HOST: PROD_POOLER_HOST }),
    ).toThrow(/production project/);
  });

  it("names keys in its errors, never values", () => {
    const { message } = errorOf(() =>
      dbTarget({ ...E2E_ENV, SUPABASE_E2E_DB_USER: "postgres.other-user-fixture" }),
    );
    for (const value of [...Object.values(E2E_ENV), "postgres.other-user-fixture"]) {
      expect(message).not.toContain(value);
    }
  });
});
