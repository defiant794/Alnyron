/**
 * Unit tests: assertE2eTarget() — guard that rejects environments that do not target
 * a known non-production e2e Supabase project. Verifies the helper throws for every
 * unsafe env shape and passes for a valid one, without reading or setting real
 * environment variables.
 *
 * Tests/unit project: no DB credentials needed.
 */

import { describe, expect, it } from "vitest";
import { assertE2eTarget } from "../../helpers/assert-e2e-target.js";

const PROD_REF = "xmgpixhxecamtryohgmk";
const E2E_REF = "mytest0projectref0001";
const E2E_URL = `https://${E2E_REF}.supabase.co`;

function call(env: Record<string, string | undefined>): void {
  assertE2eTarget(env as NodeJS.Dict<string>);
}

function errorOf(fn: () => void): Error {
  try {
    fn();
  } catch (e) {
    if (e instanceof Error) return e;
    throw e;
  }
  throw new Error("Expected assertE2eTarget to throw, but it did not");
}

// ── Accepts the matching host ──────────────────────────────────────────────────

describe("assertE2eTarget: accepts a valid e2e target", () => {
  it("accepts when ref is set, not prod, and URL hostname matches", () => {
    expect(() =>
      call({
        SUPABASE_E2E_REF: E2E_REF,
        NEXT_PUBLIC_SUPABASE_URL: E2E_URL,
      }),
    ).not.toThrow();
  });

  it("accepts: hostname match ignores port in URL", () => {
    expect(() =>
      call({
        SUPABASE_E2E_REF: E2E_REF,
        NEXT_PUBLIC_SUPABASE_URL: `${E2E_URL}:5432`,
      }),
    ).not.toThrow();
  });
});

// ── Throws on missing ref ──────────────────────────────────────────────────────

describe("assertE2eTarget: throws when SUPABASE_E2E_REF is absent", () => {
  it("throws when SUPABASE_E2E_REF is missing", () => {
    const err = errorOf(() =>
      call({ NEXT_PUBLIC_SUPABASE_URL: E2E_URL }),
    );
    expect(err.message).toMatch(/SUPABASE_E2E_REF is not set/);
  });

  it("throws when SUPABASE_E2E_REF is empty string", () => {
    const err = errorOf(() =>
      call({ SUPABASE_E2E_REF: "", NEXT_PUBLIC_SUPABASE_URL: E2E_URL }),
    );
    expect(err.message).toMatch(/SUPABASE_E2E_REF is not set/);
  });
});

// ── Throws on production ref ───────────────────────────────────────────────────

describe("assertE2eTarget: throws when SUPABASE_E2E_REF is the production project", () => {
  it("throws when ref matches the prod ref", () => {
    const err = errorOf(() =>
      call({
        SUPABASE_E2E_REF: PROD_REF,
        NEXT_PUBLIC_SUPABASE_URL: `https://${PROD_REF}.supabase.co`,
      }),
    );
    expect(err.message).toMatch(/production project/);
  });
});

// ── Throws on mismatched host ──────────────────────────────────────────────────

describe("assertE2eTarget: throws when hostname does not match the ref", () => {
  it("throws when hostname belongs to a different ref", () => {
    const err = errorOf(() =>
      call({
        SUPABASE_E2E_REF: E2E_REF,
        NEXT_PUBLIC_SUPABASE_URL: "https://otherproject0000000.supabase.co",
      }),
    );
    expect(err.message).toMatch(/hostname/);
  });

  it("throws when hostname is not *.supabase.co", () => {
    const err = errorOf(() =>
      call({
        SUPABASE_E2E_REF: E2E_REF,
        NEXT_PUBLIC_SUPABASE_URL: `https://${E2E_REF}.example.com`,
      }),
    );
    expect(err.message).toMatch(/hostname/);
  });
});

// ── Errors name keys, never values ────────────────────────────────────────────

describe("assertE2eTarget: error messages name keys, never the env values", () => {
  it("mismatch error does not contain the hostname value", () => {
    const wrongHostname = "otherproject0000000.supabase.co";
    const err = errorOf(() =>
      call({
        SUPABASE_E2E_REF: E2E_REF,
        NEXT_PUBLIC_SUPABASE_URL: `https://${wrongHostname}`,
      }),
    );
    expect(err.message).not.toContain(wrongHostname);
    expect(err.message).not.toContain(E2E_REF);
  });

  it("wrong-domain error does not contain the ref or hostname value", () => {
    const wrongUrl = `https://${E2E_REF}.example.com`;
    const err = errorOf(() =>
      call({
        SUPABASE_E2E_REF: E2E_REF,
        NEXT_PUBLIC_SUPABASE_URL: wrongUrl,
      }),
    );
    expect(err.message).not.toContain(`${E2E_REF}.example.com`);
    expect(err.message).not.toContain(E2E_REF);
  });
});

// ── Throws on unparsable URL ───────────────────────────────────────────────────

describe("assertE2eTarget: throws when NEXT_PUBLIC_SUPABASE_URL is not a valid URL", () => {
  it("throws on a non-URL string", () => {
    const err = errorOf(() =>
      call({ SUPABASE_E2E_REF: E2E_REF, NEXT_PUBLIC_SUPABASE_URL: "not-a-url" }),
    );
    expect(err.message).toMatch(/parsable URL/);
  });

  it("throws when NEXT_PUBLIC_SUPABASE_URL is absent", () => {
    const err = errorOf(() =>
      call({ SUPABASE_E2E_REF: E2E_REF }),
    );
    expect(err.message).toMatch(/parsable URL/);
  });
});
