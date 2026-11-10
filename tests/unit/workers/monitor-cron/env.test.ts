/**
 * Unit tests: workers/monitor-cron/env.ts — parseMonitorCronEnv
 * Journey: monitor-engine  ENG-AC6; monitor-cron-runtime-fix  CRF-AC12–CRF-AC17
 *
 * Covers: valid parse with string coercion, missing/invalid keys → the exact
 *   error naming keys (never values), all schema bounds (the subrequest floor is
 *   2 fixed calls + one worst-case check = 17), the SUPABASE_SECRET_KEY format
 *   (only `^sb_secret_[A-Za-z0-9_-]+$`: no legacy JWT, publishable key, bare prefix,
 *   quotes, whitespace, line break or BOM), and an assertion that
 *   src/config/env.ts never mentions SUPABASE_SECRET_KEY.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseMonitorCronEnv,
  type MonitorCronEnv,
} from "../../../../workers/monitor-cron/env";

// ── Assertion: SUPABASE_SECRET_KEY isolation from app env ────────────────────

describe("ENG-AC6: src/config/env.ts must never mention SUPABASE_SECRET_KEY", () => {
  it("ENG-AC6env0: src/config/env.ts does not contain the string SUPABASE_SECRET_KEY", () => {
    const src = readFileSync(resolve("src/config/env.ts"), "utf-8");
    expect(src).not.toContain("SUPABASE_SECRET_KEY");
  });
});

// ── Valid parse ───────────────────────────────────────────────────────────────

const VALID_RAW = {
  SUPABASE_URL: "https://giokcppmmzrrknmllfjc.supabase.co",
  SUPABASE_SECRET_KEY: "sb_secret_unitTestKey123-valid",
  RESEND_API_KEY: "re_test_abc123",
  MAIL_FROM: "Alnyron <noreply@send.alnyron.dk>",
  MONITOR_SITE_URL: "https://alnyron.dk",
  MONITOR_BATCH_SIZE: "2",
  MONITOR_SUBREQUEST_LIMIT: "50",
};

/** The error parseMonitorCronEnv throws for the given keys: names only, never a value. */
function envError(...keys: string[]): Error {
  return new Error(`monitor-cron: missing or invalid environment keys: ${keys.join(", ")}`);
}

describe("parseMonitorCronEnv — ENG-AC6: valid parse", () => {
  it("ENG-AC6env1: parses a valid raw env object, coercing the two numbers", () => {
    expect(parseMonitorCronEnv(VALID_RAW)).toEqual({
      ...VALID_RAW,
      MONITOR_BATCH_SIZE: 2,
      MONITOR_SUBREQUEST_LIMIT: 50,
    });
  });

  it("ENG-AC6env2: MONITOR_BATCH_SIZE is coerced from string '2' to number 2", () => {
    const env: MonitorCronEnv = parseMonitorCronEnv(VALID_RAW);
    expect(env.MONITOR_BATCH_SIZE).toBe(2);
  });

  it("ENG-AC6env3: MONITOR_SUBREQUEST_LIMIT is coerced from string '50' to number 50", () => {
    const env: MonitorCronEnv = parseMonitorCronEnv(VALID_RAW);
    expect(env.MONITOR_SUBREQUEST_LIMIT).toBe(50);
  });

  it("ENG-AC6env4: SUPABASE_URL is preserved as a string", () => {
    const env = parseMonitorCronEnv(VALID_RAW);
    expect(env.SUPABASE_URL).toBe(VALID_RAW.SUPABASE_URL);
  });

  it("ENG-AC6env5: MONITOR_BATCH_SIZE accepts the lower bound 1", () => {
    expect(parseMonitorCronEnv({ ...VALID_RAW, MONITOR_BATCH_SIZE: "1" }).MONITOR_BATCH_SIZE).toBe(1);
  });

  it("ENG-AC6env6: MONITOR_BATCH_SIZE accepts the upper bound 500", () => {
    expect(parseMonitorCronEnv({ ...VALID_RAW, MONITOR_BATCH_SIZE: "500" }).MONITOR_BATCH_SIZE).toBe(500);
  });

  it("ENG-AC6env7: MONITOR_SUBREQUEST_LIMIT accepts the lower bound 17 (2 fixed calls + one 15-subrequest check)", () => {
    expect(parseMonitorCronEnv({ ...VALID_RAW, MONITOR_SUBREQUEST_LIMIT: "17" }).MONITOR_SUBREQUEST_LIMIT).toBe(17);
  });

  it("ENG-AC6env8: MONITOR_SUBREQUEST_LIMIT accepts the upper bound 10000", () => {
    expect(parseMonitorCronEnv({ ...VALID_RAW, MONITOR_SUBREQUEST_LIMIT: "10000" }).MONITOR_SUBREQUEST_LIMIT).toBe(10_000);
  });
});

// ── Missing keys → error naming keys, never values ───────────────────────────

describe("parseMonitorCronEnv — ENG-AC6: missing required key → error names the key, not values", () => {
  for (const key of [
    "SUPABASE_URL",
    "SUPABASE_SECRET_KEY",
    "RESEND_API_KEY",
    "MAIL_FROM",
    "MONITOR_SITE_URL",
    "MONITOR_BATCH_SIZE",
    "MONITOR_SUBREQUEST_LIMIT",
  ] as const) {
    it(`ENG-AC6env9-${key}: missing ${key} → throws the error naming exactly '${key}'`, () => {
      expect(() => parseMonitorCronEnv({ ...VALID_RAW, [key]: undefined })).toThrow(envError(key));
    });
  }
});

// ── Invalid values → error names keys, never values ──────────────────────────

describe("parseMonitorCronEnv — ENG-AC6: invalid values → error names keys, never exposes values", () => {
  it("ENG-AC6env10: non-https SUPABASE_URL → throws naming SUPABASE_URL only", () => {
    expect(() => parseMonitorCronEnv({ ...VALID_RAW, SUPABASE_URL: "http://not-https.example.com" })).toThrow(
      envError("SUPABASE_URL"),
    );
  });

  it("ENG-AC6env11: MONITOR_BATCH_SIZE 0 (below 1) → throws naming MONITOR_BATCH_SIZE", () => {
    expect(() => parseMonitorCronEnv({ ...VALID_RAW, MONITOR_BATCH_SIZE: "0" })).toThrow(envError("MONITOR_BATCH_SIZE"));
  });

  it("ENG-AC6env12: MONITOR_BATCH_SIZE 501 (above 500) → throws naming MONITOR_BATCH_SIZE", () => {
    expect(() => parseMonitorCronEnv({ ...VALID_RAW, MONITOR_BATCH_SIZE: "501" })).toThrow(envError("MONITOR_BATCH_SIZE"));
  });

  it("ENG-AC6env13: MONITOR_SUBREQUEST_LIMIT 16 (below 17: no room for a check after the claim) → throws naming MONITOR_SUBREQUEST_LIMIT", () => {
    expect(() => parseMonitorCronEnv({ ...VALID_RAW, MONITOR_SUBREQUEST_LIMIT: "16" })).toThrow(
      envError("MONITOR_SUBREQUEST_LIMIT"),
    );
  });

  it("ENG-AC6env14: MONITOR_SUBREQUEST_LIMIT 10001 (above 10000) → throws naming MONITOR_SUBREQUEST_LIMIT", () => {
    expect(() => parseMonitorCronEnv({ ...VALID_RAW, MONITOR_SUBREQUEST_LIMIT: "10001" })).toThrow(
      envError("MONITOR_SUBREQUEST_LIMIT"),
    );
  });

  it("ENG-AC6env15: empty SUPABASE_SECRET_KEY → throws naming SUPABASE_SECRET_KEY", () => {
    expect(() => parseMonitorCronEnv({ ...VALID_RAW, SUPABASE_SECRET_KEY: "" })).toThrow(envError("SUPABASE_SECRET_KEY"));
  });

  it("ENG-AC6env16: several invalid keys → one error naming each key once, never a value", () => {
    // A schema that put a value into its message would fail the exact match.
    expect(() =>
      parseMonitorCronEnv({
        ...VALID_RAW,
        SUPABASE_URL: "not-https-secret-xyz://leaked-value",
        RESEND_API_KEY: "",
        MONITOR_BATCH_SIZE: "1.5",
      }),
    ).toThrow(envError("SUPABASE_URL", "RESEND_API_KEY", "MONITOR_BATCH_SIZE"));
  });
});

// ── CRF-AC12–17: SUPABASE_SECRET_KEY format validation ───────────────────────

describe("parseMonitorCronEnv — CRF-AC12–17: SUPABASE_SECRET_KEY must match /^sb_secret_[A-Za-z0-9_-]+$/", () => {
  // CRF-AC12: valid new-format key accepted
  it.for([
    { id: "CRF-AC12env1", label: "alphanumeric suffix", key: "sb_secret_abc123" },
    { id: "CRF-AC12env2", label: "underscore suffix", key: "sb_secret_abc_def" },
    { id: "CRF-AC12env3", label: "hyphen suffix", key: "sb_secret_abc-def" },
    { id: "CRF-AC12env4", label: "long realistic key", key: "sb_secret_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-xyzXYZ" },
  ])("$id: valid key ($label) → accepted", ({ key }) => {
    expect(() => parseMonitorCronEnv({ ...VALID_RAW, SUPABASE_SECRET_KEY: key })).not.toThrow();
  });

  // CRF-AC13: legacy JWT rejected
  it("CRF-AC13env1: legacy JWT (eyJ…) → throws naming SUPABASE_SECRET_KEY, never the value", () => {
    // The legacy Supabase key format (a JWT, eyJ…), not a secret API key.
    expect(() =>
      parseMonitorCronEnv({ ...VALID_RAW, SUPABASE_SECRET_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test" }),
    ).toThrow(envError("SUPABASE_SECRET_KEY"));
  });

  // CRF-AC14: publishable key rejected
  it("CRF-AC14env1: publishable key (sb_publishable_…) → throws naming SUPABASE_SECRET_KEY", () => {
    expect(() =>
      parseMonitorCronEnv({ ...VALID_RAW, SUPABASE_SECRET_KEY: "sb_publishable_abcdefXYZ123" }),
    ).toThrow(envError("SUPABASE_SECRET_KEY"));
  });

  // CRF-AC15: prefix alone (no suffix characters) rejected
  it("CRF-AC15env1: 'sb_secret_' alone (no suffix) → throws naming SUPABASE_SECRET_KEY", () => {
    expect(() =>
      parseMonitorCronEnv({ ...VALID_RAW, SUPABASE_SECRET_KEY: "sb_secret_" }),
    ).toThrow(envError("SUPABASE_SECRET_KEY"));
  });

  // CRF-AC16: key wrapped in literal quotes (a common paste mangling) rejected
  it("CRF-AC16env1: key wrapped in literal double-quote characters → throws naming SUPABASE_SECRET_KEY", () => {
    // A common paste mangling: the secret value includes the surrounding quotes. The exact form
    // of the production incident's value is not known.
    expect(() =>
      parseMonitorCronEnv({ ...VALID_RAW, SUPABASE_SECRET_KEY: '"sb_secret_realkey123"' }),
    ).toThrow(envError("SUPABASE_SECRET_KEY"));
  });

  it("CRF-AC16env2: key wrapped in literal single-quote characters → throws naming SUPABASE_SECRET_KEY", () => {
    expect(() =>
      parseMonitorCronEnv({ ...VALID_RAW, SUPABASE_SECRET_KEY: "'sb_secret_realkey123'" }),
    ).toThrow(envError("SUPABASE_SECRET_KEY"));
  });

  // CRF-AC17: whitespace, newline or BOM rejected
  it.for([
    { id: "CRF-AC17env1", label: "leading space",    key: " sb_secret_abc" },
    { id: "CRF-AC17env2", label: "trailing space",   key: "sb_secret_abc " },
    { id: "CRF-AC17env3", label: "internal space",   key: "sb_secret_ab cd" },
    { id: "CRF-AC17env4", label: "trailing newline", key: "sb_secret_abc\n" },
    { id: "CRF-AC17env5", label: "CRLF suffix",      key: "sb_secret_abc\r\n" },
    { id: "CRF-AC17env6", label: "BOM prefix",       key: "\uFEFFsb_secret_abc" },
  ])("$id: $label → throws naming SUPABASE_SECRET_KEY, never exposes the value", ({ key }) => {
    // toThrow checks the message string; envError returns the exact expected message.
    // The key must not appear in the error message (it may contain sensitive material).
    expect(() =>
      parseMonitorCronEnv({ ...VALID_RAW, SUPABASE_SECRET_KEY: key }),
    ).toThrow(envError("SUPABASE_SECRET_KEY"));
  });

  it("CRF-AC17env7: error message names SUPABASE_SECRET_KEY and never echoes the value", () => {
    const marker = "sb_secret_MARKER_MUST_NOT_LEAK_xyz987\n";
    expect(() => parseMonitorCronEnv({ ...VALID_RAW, SUPABASE_SECRET_KEY: marker })).toThrow(
      envError("SUPABASE_SECRET_KEY"),
    );
  });
});
