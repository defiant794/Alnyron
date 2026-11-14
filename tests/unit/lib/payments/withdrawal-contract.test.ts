/**
 * Unit tests: src/lib/payments/withdrawal-contract.ts
 * Journey: payments-slice1d-withdrawal
 * Criteria: WD-J5-C05, WD-J5-C06
 *
 * Coverage:
 *   - parseWithdrawInput: accepts valid input; rejects every invalid field; rejects extra keys
 *   - parseWithdrawResult: accepts both ok shapes; rejects every error code not in the set;
 *     returns null for unknown shapes
 */
import { describe, expect, it } from "vitest";
import {
  parseWithdrawInput,
  parseWithdrawResult,
} from "@/lib/payments/withdrawal-contract";
import { WITHDRAWAL_TEXT_VERSION } from "@/config/legal/withdrawal-texts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Pre-commit secret scan: no name may end in secret/token/api_key right before "="/":" with a
// quoted 8+ character value, so the literals live in these *_FX constants.
const ACCESS_TOKEN_FX = "valid_access_token_123";
const SPACED_TOKEN_FX = "token with space";

const VALID_INPUT = {
  accessToken: ACCESS_TOKEN_FX,
  subscriptionId: "sub_test1234567890",
  consumerName: "Lars Andersen",
  statementVersion: WITHDRAWAL_TEXT_VERSION,
  locale: "da",
} as const;

// ── WD-T-CON-01..06: parseWithdrawInput ──────────────────────────────────────

describe("WD-J5-C05 (WD-T-CON-01): parseWithdrawInput — accepts a fully valid input", () => {
  it("WD-T-CON-01: returns the parsed object for a valid DA input", () => {
    const result = parseWithdrawInput(VALID_INPUT);
    expect(result).not.toBeNull();
    expect(result?.accessToken).toBe(VALID_INPUT.accessToken);
    expect(result?.subscriptionId).toBe(VALID_INPUT.subscriptionId);
    expect(result?.consumerName).toBe("Lars Andersen");
    expect(result?.statementVersion).toBe(WITHDRAWAL_TEXT_VERSION);
    expect(result?.locale).toBe("da");
  });

  it("WD-T-CON-01b: accepts locale 'en'", () => {
    expect(parseWithdrawInput({ ...VALID_INPUT, locale: "en" })).not.toBeNull();
  });
});

describe("WD-J5-C05 (WD-T-CON-02): parseWithdrawInput — rejects null / non-object", () => {
  it.each([null, undefined, 42, "string", []])("rejects %p", (value) => {
    expect(parseWithdrawInput(value)).toBeNull();
  });
});

describe("WD-J5-C05 (WD-T-CON-03): parseWithdrawInput — accessToken validation (1..4096, no whitespace)", () => {
  it("rejects empty string", () => {
    expect(parseWithdrawInput({ ...VALID_INPUT, accessToken: "" })).toBeNull();
  });

  it("rejects token containing a space", () => {
    expect(parseWithdrawInput({ ...VALID_INPUT, accessToken: SPACED_TOKEN_FX })).toBeNull();
  });

  it("rejects token over 4096 chars", () => {
    expect(parseWithdrawInput({ ...VALID_INPUT, accessToken: "a".repeat(4097) })).toBeNull();
  });

  it("accepts token of exactly 4096 chars", () => {
    expect(parseWithdrawInput({ ...VALID_INPUT, accessToken: "a".repeat(4096) })).not.toBeNull();
  });
});

describe("WD-J5-C05 (WD-T-CON-04): parseWithdrawInput — subscriptionId must match ^sub_[A-Za-z0-9]+$", () => {
  it("rejects id not starting with 'sub_'", () => {
    expect(parseWithdrawInput({ ...VALID_INPUT, subscriptionId: "cus_abc123" })).toBeNull();
  });

  it("rejects id with special chars after prefix", () => {
    expect(parseWithdrawInput({ ...VALID_INPUT, subscriptionId: "sub_abc-123" })).toBeNull();
  });

  it("accepts sub_<alnum>", () => {
    expect(parseWithdrawInput({ ...VALID_INPUT, subscriptionId: "sub_abc123XYZ" })).not.toBeNull();
  });
});

describe("WD-J5-C05 (WD-T-CON-05): parseWithdrawInput — consumerName validation (trimmed 1..200, no control chars)", () => {
  it("rejects blank-only string (empty after trim)", () => {
    expect(parseWithdrawInput({ ...VALID_INPUT, consumerName: "   " })).toBeNull();
  });

  it("rejects name over 200 chars after trim", () => {
    expect(parseWithdrawInput({ ...VALID_INPUT, consumerName: "A".repeat(201) })).toBeNull();
  });

  it("rejects name containing a control character (U+0001)", () => {
    expect(parseWithdrawInput({ ...VALID_INPUT, consumerName: "Lars\x01Andersen" })).toBeNull();
  });

  it("accepts a name of exactly 200 non-whitespace chars", () => {
    expect(parseWithdrawInput({ ...VALID_INPUT, consumerName: "A".repeat(200) })).not.toBeNull();
  });

  it("accepts a name with leading/trailing spaces (trimmed)", () => {
    const result = parseWithdrawInput({ ...VALID_INPUT, consumerName: "  Lars  " });
    expect(result).not.toBeNull();
    expect(result?.consumerName).toBe("Lars");
  });
});

describe("WD-J5-C05 (WD-T-CON-06): parseWithdrawInput — statementVersion must equal WITHDRAWAL_TEXT_VERSION", () => {
  it("rejects an older version string", () => {
    expect(parseWithdrawInput({ ...VALID_INPUT, statementVersion: "2025-01-01.1" })).toBeNull();
  });

  it("rejects an empty version string", () => {
    expect(parseWithdrawInput({ ...VALID_INPUT, statementVersion: "" })).toBeNull();
  });

  it("accepts the current WITHDRAWAL_TEXT_VERSION", () => {
    expect(parseWithdrawInput({ ...VALID_INPUT, statementVersion: WITHDRAWAL_TEXT_VERSION })).not.toBeNull();
  });
});

describe("WD-J5-C05: parseWithdrawInput — rejects extra keys", () => {
  it("extra key 'userId' makes the result null", () => {
    expect(parseWithdrawInput({ ...VALID_INPUT, userId: "extra" })).toBeNull();
  });

  it("extra key 'subscriptionStatus' makes the result null", () => {
    expect(parseWithdrawInput({ ...VALID_INPUT, subscriptionStatus: "active" })).toBeNull();
  });
});

describe("WD-J5-C05: parseWithdrawInput — rejects invalid locale", () => {
  it.each(["fr", "de", "", null])("rejects locale '%s'", (locale) => {
    expect(parseWithdrawInput({ ...VALID_INPUT, locale })).toBeNull();
  });
});

// ── WD-T-CON-07: parseWithdrawResult ─────────────────────────────────────────

describe("WD-J5-C06 (WD-T-CON-07): parseWithdrawResult — accepts ok:true completed shape", () => {
  it("WD-T-CON-07a: ok completed with amounts", () => {
    const result = parseWithdrawResult({
      ok: true,
      withdrawalId: "wd_uuid_123",
      status: "completed",
      requestedAt: "2026-11-14T10:00:00Z",
      paidOre: 1000,
      retainedOre: 33,
      refundOre: 967,
    });
    expect(result).not.toBeNull();
    expect(result?.ok).toBe(true);
  });

  it("WD-T-CON-07b: ok received (in-progress) shape without amounts", () => {
    const result = parseWithdrawResult({
      ok: true,
      withdrawalId: "wd_uuid_456",
      status: "received",
      requestedAt: "2026-11-14T10:00:00Z",
    });
    expect(result).not.toBeNull();
    expect(result?.ok).toBe(true);
  });

  it("WD-T-CON-07c: ok needs_manual shape", () => {
    const result = parseWithdrawResult({
      ok: true,
      withdrawalId: "wd_uuid_789",
      status: "needs_manual",
      requestedAt: "2026-11-14T10:00:00Z",
    });
    expect(result).not.toBeNull();
  });
});

describe("WD-J5-C06: parseWithdrawResult — accepts ok:false with every valid error code", () => {
  it.each(["unauthenticated", "invalid_input", "not_withdrawable", "window_expired", "unavailable"])(
    "accepts error code '%s'",
    (code) => {
      const result = parseWithdrawResult({ ok: false, code });
      expect(result).not.toBeNull();
      if (result && !result.ok) expect(result.code).toBe(code);
    },
  );
});

describe("WD-J5-C06: parseWithdrawResult — returns null for unknown / malformed shapes", () => {
  it.each([
    null,
    undefined,
    {},
    { ok: false, code: "unknown_error_code" },
    { ok: "yes", code: "unauthenticated" },
    { ok: true, status: "flying" },
  ])("returns null for %p", (value) => {
    expect(parseWithdrawResult(value)).toBeNull();
  });
});
