/**
 * Unit tests: workers/payments/env.ts — new keys for slice 1d
 * Journey: payments-slice1d-withdrawal
 * Criteria: WD-J7-C01 (env required for sweep)
 *
 * Coverage:
 *   - RESEND_API_KEY: required, pattern ^re_[A-Za-z0-9_]+$
 *   - MAIL_FROM: required, non-empty
 *   - WITHDRAWAL_ALERT_TO: required, contains @
 *   - SITE_URL: required, starts with https://
 *   - All existing keys still parse correctly
 *   - Missing new key → error names the key (never the value)
 */
import { describe, expect, it } from "vitest";
import { parsePaymentsEnv } from "../../../../workers/payments/env";

// ── Shared fixtures ───────────────────────────────────────────────────────────

// Pre-commit secret scan: no name may end in secret/token/api_key right before "="/":" with a
// quoted 8+ character value, so the literals live in these *_FX constants.
const SB_KEY_FX = "sb_secret_unittestkey1234";
const SK_TEST_FX = "sk_test_unitfakekey1234";
const WHSEC_FX = "whsec_unittest1234";
const RE_TEST_FX = "re_test_UnitTestKey1234";
const RE_LIVE_FX = "re_live_UnitKeyLive1234";
const NOT_RE_FX = "sk_test_notresend";

const VALID_1D = {
  SUPABASE_URL: "https://xmgpixhxecamtryohgmk.supabase.co",
  SUPABASE_SECRET_KEY: SB_KEY_FX,
  STRIPE_PAYMENTS_KEY: SK_TEST_FX,
  STRIPE_WEBHOOK_SECRET: WHSEC_FX,
  STRIPE_LIVEMODE: "false",
  // new 1d keys
  RESEND_API_KEY: RE_TEST_FX,
  MAIL_FROM: "noreply@alnyron.dk",
  WITHDRAWAL_ALERT_TO: "owner@alnyron.dk",
  SITE_URL: "https://alnyron.dk",
} as const;

function without<K extends keyof typeof VALID_1D>(key: K): Omit<typeof VALID_1D, K> {
  const { [key]: _omit, ...rest } = VALID_1D;
  void _omit;
  return rest;
}

// ── Valid parse includes new fields ──────────────────────────────────────────

describe("WD-J7-C01: parsePaymentsEnv — includes new 1d keys in valid parse", () => {
  it("returns resendApiKey, mailFrom, withdrawalAlertTo, siteUrl for valid input", () => {
    const env = parsePaymentsEnv(VALID_1D);
    expect(env.resendApiKey).toBe(VALID_1D.RESEND_API_KEY);
    expect(env.mailFrom).toBe(VALID_1D.MAIL_FROM);
    expect(env.withdrawalAlertTo).toBe(VALID_1D.WITHDRAWAL_ALERT_TO);
    expect(env.siteUrl).toBe(VALID_1D.SITE_URL);
  });
});

// ── RESEND_API_KEY validation ─────────────────────────────────────────────────

describe("WD-J7-C01: parsePaymentsEnv — RESEND_API_KEY pattern ^re_[A-Za-z0-9_]+$", () => {
  it("missing RESEND_API_KEY → error names RESEND_API_KEY", () => {
    expect(() => parsePaymentsEnv(without("RESEND_API_KEY"))).toThrow(/RESEND_API_KEY/);
  });

  it("invalid RESEND_API_KEY (no re_ prefix) → error names RESEND_API_KEY", () => {
    expect(() => parsePaymentsEnv({ ...VALID_1D, RESEND_API_KEY: NOT_RE_FX })).toThrow(/RESEND_API_KEY/);
  });

  it("valid re_live_... key accepted", () => {
    expect(() => parsePaymentsEnv({ ...VALID_1D, RESEND_API_KEY: RE_LIVE_FX })).not.toThrow();
  });
});

// ── MAIL_FROM validation ──────────────────────────────────────────────────────

describe("WD-J7-C01: parsePaymentsEnv — MAIL_FROM required non-empty", () => {
  it("missing MAIL_FROM → error names MAIL_FROM", () => {
    expect(() => parsePaymentsEnv(without("MAIL_FROM"))).toThrow(/MAIL_FROM/);
  });

  it("empty MAIL_FROM → error names MAIL_FROM", () => {
    expect(() => parsePaymentsEnv({ ...VALID_1D, MAIL_FROM: "" })).toThrow(/MAIL_FROM/);
  });
});

// ── WITHDRAWAL_ALERT_TO validation ───────────────────────────────────────────

describe("WD-J7-C01: parsePaymentsEnv — WITHDRAWAL_ALERT_TO required, must contain @", () => {
  it("missing WITHDRAWAL_ALERT_TO → error names WITHDRAWAL_ALERT_TO", () => {
    expect(() => parsePaymentsEnv(without("WITHDRAWAL_ALERT_TO"))).toThrow(/WITHDRAWAL_ALERT_TO/);
  });

  it("WITHDRAWAL_ALERT_TO without @ → error names WITHDRAWAL_ALERT_TO", () => {
    expect(() => parsePaymentsEnv({ ...VALID_1D, WITHDRAWAL_ALERT_TO: "notanemail" })).toThrow(/WITHDRAWAL_ALERT_TO/);
  });
});

// ── SITE_URL validation ───────────────────────────────────────────────────────

describe("WD-J7-C01: parsePaymentsEnv — SITE_URL required, must start with https://", () => {
  it("missing SITE_URL → error names SITE_URL", () => {
    expect(() => parsePaymentsEnv(without("SITE_URL"))).toThrow(/SITE_URL/);
  });

  it("SITE_URL with http:// (not https) → error names SITE_URL", () => {
    expect(() => parsePaymentsEnv({ ...VALID_1D, SITE_URL: "http://alnyron.dk" })).toThrow(/SITE_URL/);
  });
});

// ── Error messages never include values ──────────────────────────────────────

describe("WD-J7-C01: parsePaymentsEnv — error messages name keys but never expose values", () => {
  it("missing RESEND_API_KEY error does not contain the SUPABASE_SECRET_KEY value", () => {
    try {
      parsePaymentsEnv(without("RESEND_API_KEY"));
    } catch (err) {
      expect(String(err)).not.toContain(VALID_1D.SUPABASE_SECRET_KEY);
    }
  });
});
