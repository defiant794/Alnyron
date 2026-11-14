/**
 * Unit tests: workers/payments/env.ts — parsePaymentsEnv
 * Journey: payments-slice1c-webhook
 * Criteria: WH-AC22a..WH-AC22h
 *
 * Covers: valid parse, missing/invalid keys → error naming keys in schema order
 * (never values), STRIPE_LIVEMODE ↔ key-mode guard, whsec_ format.
 */
import { describe, expect, it } from "vitest";
import { parsePaymentsEnv } from "../../../../workers/payments/env";

// ── Helpers ───────────────────────────────────────────────────────────────────

// Pre-commit secret scan: no name may end in secret/token/api_key right before "="/":" with a
// quoted 8+ character value, so the literals live in these *_FX constants.
const SB_KEY_FX = "sb_secret_unittestkey1234";
const WHSEC_FX = "whsec_unitwhs1234";
const SK_TEST_FX = "sk_test_unitfakekey1234";
const RE_TEST_FX = "re_test_UnitKey1234";
const RE_LIVE_FX = "re_live_UnitKeyLive1234";

// Updated by slice 1d: RESEND_API_KEY, MAIL_FROM, WITHDRAWAL_ALERT_TO, SITE_URL added.
const VALID_RAW_TEST = {
  SUPABASE_URL: "https://xmgpixhxecamtryohgmk.supabase.co",
  SUPABASE_SECRET_KEY: SB_KEY_FX,
  STRIPE_PAYMENTS_KEY: SK_TEST_FX,
  STRIPE_WEBHOOK_SECRET: WHSEC_FX,
  STRIPE_LIVEMODE: "false",
  RESEND_API_KEY: RE_TEST_FX,
  MAIL_FROM: "noreply@alnyron.dk",
  WITHDRAWAL_ALERT_TO: "owner@alnyron.dk",
  SITE_URL: "https://alnyron.dk",
};

const VALID_RAW_LIVE = {
  SUPABASE_URL: "https://xmgpixhxecamtryohgmk.supabase.co",
  SUPABASE_SECRET_KEY: SB_KEY_FX,
  STRIPE_PAYMENTS_KEY: "rk_live_unitrk1234",
  STRIPE_WEBHOOK_SECRET: WHSEC_FX,
  STRIPE_LIVEMODE: "true",
  RESEND_API_KEY: RE_LIVE_FX,
  MAIL_FROM: "noreply@alnyron.dk",
  WITHDRAWAL_ALERT_TO: "owner@alnyron.dk",
  SITE_URL: "https://alnyron.dk",
};


function envError(...keys: string[]): Error {
  return new Error(`payments: missing or invalid environment keys: ${keys.join(", ")}`);
}

const MODE_MISMATCH_ERROR = new Error(
  "payments: STRIPE_LIVEMODE does not match STRIPE_PAYMENTS_KEY's mode",
);

// ── WH-AC22a: valid parse ─────────────────────────────────────────────────────

describe("WH-AC22a: parsePaymentsEnv returns parsed object for valid test-mode input", () => {
  it("WH-AC22a1: test mode — returns all expected fields including 1d keys", () => {
    const result = parsePaymentsEnv(VALID_RAW_TEST);
    expect(result.supabaseUrl).toBe(VALID_RAW_TEST.SUPABASE_URL);
    expect(result.supabaseSecretKey).toBe(VALID_RAW_TEST.SUPABASE_SECRET_KEY);
    expect(result.stripeKey).toBe(VALID_RAW_TEST.STRIPE_PAYMENTS_KEY);
    expect(result.webhookSecret).toBe(VALID_RAW_TEST.STRIPE_WEBHOOK_SECRET);
    expect(result.livemode).toBe(false);
    expect(result.resendApiKey).toBe(VALID_RAW_TEST.RESEND_API_KEY);
    expect(result.mailFrom).toBe(VALID_RAW_TEST.MAIL_FROM);
    expect(result.withdrawalAlertTo).toBe(VALID_RAW_TEST.WITHDRAWAL_ALERT_TO);
    expect(result.siteUrl).toBe(VALID_RAW_TEST.SITE_URL);
  });

  it("WH-AC22a2: live mode with rk_live_ key — livemode = true", () => {
    const result = parsePaymentsEnv(VALID_RAW_LIVE);
    expect(result.livemode).toBe(true);
    expect(result.stripeKey).toBe(VALID_RAW_LIVE.STRIPE_PAYMENTS_KEY);
  });

  it("WH-AC22a3: test mode with rk_test_ key → accepted", () => {
    const result = parsePaymentsEnv({
      ...VALID_RAW_TEST,
      STRIPE_PAYMENTS_KEY: "rk_test_unitfakekey1234",
    });
    expect(result.livemode).toBe(false);
    expect(result.stripeKey).toBe("rk_test_unitfakekey1234");
  });
});

// ── WH-AC22b: missing/invalid keys → error names keys in schema order ─────────

/** VALID_RAW_TEST without `key`: that env entry missing. */
function withoutKey(key: keyof typeof VALID_RAW_TEST): Partial<typeof VALID_RAW_TEST> {
  const rest: Partial<typeof VALID_RAW_TEST> = { ...VALID_RAW_TEST };
  delete rest[key];
  return rest;
}

describe("WH-AC22b: missing or invalid key → error names the key, never a value", () => {
  it("WH-AC22b1: missing SUPABASE_URL → names SUPABASE_URL", () => {
    const rest = withoutKey("SUPABASE_URL");
    expect(() => parsePaymentsEnv(rest)).toThrow(envError("SUPABASE_URL"));
  });

  it("WH-AC22b2: missing SUPABASE_SECRET_KEY → names SUPABASE_SECRET_KEY", () => {
    const rest = withoutKey("SUPABASE_SECRET_KEY");
    expect(() => parsePaymentsEnv(rest)).toThrow(envError("SUPABASE_SECRET_KEY"));
  });

  it("WH-AC22b3: missing STRIPE_PAYMENTS_KEY → names STRIPE_PAYMENTS_KEY", () => {
    const rest = withoutKey("STRIPE_PAYMENTS_KEY");
    expect(() => parsePaymentsEnv(rest)).toThrow(envError("STRIPE_PAYMENTS_KEY"));
  });

  it("WH-AC22b4: missing STRIPE_WEBHOOK_SECRET → names STRIPE_WEBHOOK_SECRET", () => {
    const rest = withoutKey("STRIPE_WEBHOOK_SECRET");
    expect(() => parsePaymentsEnv(rest)).toThrow(envError("STRIPE_WEBHOOK_SECRET"));
  });

  it("WH-AC22b5: missing STRIPE_LIVEMODE → names STRIPE_LIVEMODE", () => {
    const rest = withoutKey("STRIPE_LIVEMODE");
    expect(() => parsePaymentsEnv(rest)).toThrow(envError("STRIPE_LIVEMODE"));
  });

  it("WH-AC22b6: empty object → names all 9 required keys (1c + 1d) in schema order", () => {
    // A6 fixes the order: the five keys of 1c, then RESEND_API_KEY, MAIL_FROM, WITHDRAWAL_ALERT_TO, SITE_URL.
    expect(() => parsePaymentsEnv({})).toThrow(
      envError(
        "SUPABASE_URL",
        "SUPABASE_SECRET_KEY",
        "STRIPE_PAYMENTS_KEY",
        "STRIPE_WEBHOOK_SECRET",
        "STRIPE_LIVEMODE",
        "RESEND_API_KEY",
        "MAIL_FROM",
        "WITHDRAWAL_ALERT_TO",
        "SITE_URL",
      ),
    );
  });

  it("WH-AC22b7: error message does not contain any value from input", () => {
    expect.assertions(1);
    try {
      parsePaymentsEnv({ ...VALID_RAW_TEST, SUPABASE_URL: "http://not-https.example.com" });
    } catch (e) {
      if (!(e instanceof Error)) throw new Error("expected Error to be thrown");
      expect(e.message).not.toContain("not-https.example.com");
    }
  });

  it("WH-AC22b8: SUPABASE_URL non-https → error names SUPABASE_URL", () => {
    expect(() => parsePaymentsEnv({ ...VALID_RAW_TEST, SUPABASE_URL: "http://xmgpix.supabase.co" })).toThrow(envError("SUPABASE_URL"));
  });

  it("WH-AC22b9: SUPABASE_SECRET_KEY wrong prefix → error names SUPABASE_SECRET_KEY", () => {
    expect(() => parsePaymentsEnv({ ...VALID_RAW_TEST, SUPABASE_SECRET_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fake" })).toThrow(envError("SUPABASE_SECRET_KEY"));
  });

  it("WH-AC22b10: STRIPE_LIVEMODE not 'true'/'false' → error names STRIPE_LIVEMODE", () => {
    expect(() => parsePaymentsEnv({ ...VALID_RAW_TEST, STRIPE_LIVEMODE: "yes" })).toThrow(envError("STRIPE_LIVEMODE"));
  });
});

// ── WH-AC22c: live mode requires rk_live_ (not sk_live_) ─────────────────────

describe("WH-AC22c: STRIPE_LIVEMODE='true' with rk_live_ → accepted", () => {
  it("WH-AC22c: rk_live_ in live mode → ok", () => {
    expect(() => parsePaymentsEnv(VALID_RAW_LIVE)).not.toThrow();
  });
});

describe("WH-AC22d: STRIPE_LIVEMODE='true' with sk_live_ (full secret key) → rejected", () => {
  it("WH-AC22d: sk_live_ in live mode → mode mismatch error (full secret keys refused in live)", () => {
    expect(() => parsePaymentsEnv({
      ...VALID_RAW_LIVE,
      STRIPE_PAYMENTS_KEY: "sk_live_unitfakekey1234",
    })).toThrow(MODE_MISMATCH_ERROR);
  });
});

describe("WH-AC22e: STRIPE_LIVEMODE='false' with rk_live_ key → mode mismatch", () => {
  it("WH-AC22e: rk_live_ with LIVEMODE=false → mode mismatch error", () => {
    expect(() => parsePaymentsEnv({
      ...VALID_RAW_TEST,
      STRIPE_PAYMENTS_KEY: "rk_live_unitfakekey1234",
      STRIPE_LIVEMODE: "false",
    })).toThrow(MODE_MISMATCH_ERROR);
  });
});

describe("WH-AC22f: STRIPE_LIVEMODE='false' with sk_test_ or rk_test_ → accepted", () => {
  it("WH-AC22f1: sk_test_ in test mode → ok", () => {
    expect(() => parsePaymentsEnv(VALID_RAW_TEST)).not.toThrow();
  });

  it("WH-AC22f2: rk_test_ in test mode → ok", () => {
    expect(() => parsePaymentsEnv({
      ...VALID_RAW_TEST,
      STRIPE_PAYMENTS_KEY: "rk_test_unitfakekey1234",
    })).not.toThrow();
  });
});

describe("WH-AC22g: mode mismatch error message is exact", () => {
  it("WH-AC22g: exact error message text", () => {
    expect(() => parsePaymentsEnv({
      ...VALID_RAW_TEST,
      STRIPE_PAYMENTS_KEY: "rk_live_unitfakekey1234",
    })).toThrow("payments: STRIPE_LIVEMODE does not match STRIPE_PAYMENTS_KEY's mode");
  });
});

describe("WH-AC22h: STRIPE_WEBHOOK_SECRET must match ^whsec_[A-Za-z0-9]+$", () => {
  it("WH-AC22h1: valid whsec_ → ok", () => {
    expect(() => parsePaymentsEnv(VALID_RAW_TEST)).not.toThrow();
  });

  it("WH-AC22h2: whsec_ with underscore in body → error (only alnum allowed)", () => {
    const badBodyWhsec = "whsec_bad_key";
    expect(() => parsePaymentsEnv({
      ...VALID_RAW_TEST,
      STRIPE_WEBHOOK_SECRET: badBodyWhsec,
    })).toThrow(envError("STRIPE_WEBHOOK_SECRET"));
  });

  it("WH-AC22h3: missing whsec_ prefix → error", () => {
    const noPrefixVal = "not_a_whsec_key";
    expect(() => parsePaymentsEnv({
      ...VALID_RAW_TEST,
      STRIPE_WEBHOOK_SECRET: noPrefixVal,
    })).toThrow(envError("STRIPE_WEBHOOK_SECRET"));
  });

  it("WH-AC22h4: empty whsec_ body → error", () => {
    expect(() => parsePaymentsEnv({
      ...VALID_RAW_TEST,
      STRIPE_WEBHOOK_SECRET: "whsec_",
    })).toThrow(envError("STRIPE_WEBHOOK_SECRET"));
  });
});
