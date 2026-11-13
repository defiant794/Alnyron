/**
 * Unit tests: src/lib/payments/money.ts — formatKroner.
 * Journey: payments-slice1b-billing  PAY1B-AC12
 *
 * Contract: amount > 0 is validated in services before formatKroner is called;
 * this test only exercises the values listed in the spec + a large amount.
 * Contract: "whole kroner when divisible by 100 ('95'), else 2 decimals with
 * the locale's separator ('10,50' da / '10.50' en)".
 * Large amounts use Intl grouping — pinned: "1.234,56" da / "1,234.56" en.
 */
import { describe, it, expect } from "vitest";
import { formatKroner } from "@/lib/payments/money";

// ── Whole-kroner values (divisible by 100) ────────────────────────────────────

describe("PAY1B-AC12: formatKroner — whole kroner (amount divisible by 100)", () => {
  it("PAY1B-AC12a: 9500 øre → '95' (da)", () => {
    expect(formatKroner(9500, "da")).toBe("95");
  });

  it("PAY1B-AC12b: 9500 øre → '95' (en)", () => {
    expect(formatKroner(9500, "en")).toBe("95");
  });

  it("PAY1B-AC12c: 1000 øre → '10' (da)", () => {
    expect(formatKroner(1000, "da")).toBe("10");
  });

  it("PAY1B-AC12d: 1000 øre → '10' (en)", () => {
    expect(formatKroner(1000, "en")).toBe("10");
  });
});

// ── Fractional-kroner values (not divisible by 100) ───────────────────────────

describe("PAY1B-AC12: formatKroner — 2 decimals for fractional øre amounts", () => {
  it("PAY1B-AC12e: 1050 øre → '10,50' with da locale (comma decimal)", () => {
    expect(formatKroner(1050, "da")).toBe("10,50");
  });

  it("PAY1B-AC12f: 1050 øre → '10.50' with en locale (dot decimal)", () => {
    expect(formatKroner(1050, "en")).toBe("10.50");
  });
});

// ── Large amounts with grouping ───────────────────────────────────────────────

describe("PAY1B-AC12: formatKroner — large amounts with Intl grouping (pinned)", () => {
  it("PAY1B-AC12g: 123456 øre → '1.234,56' with da locale (dot thousands, comma decimal)", () => {
    // Pinned: Danish Intl.NumberFormat uses '.' as thousands separator and ',' as decimal.
    expect(formatKroner(123456, "da")).toBe("1.234,56");
  });

  it("PAY1B-AC12h: 123456 øre → '1,234.56' with en locale (comma thousands, dot decimal)", () => {
    // Pinned: en-GB Intl.NumberFormat uses ',' as thousands separator and '.' as decimal.
    expect(formatKroner(123456, "en")).toBe("1,234.56");
  });
});
