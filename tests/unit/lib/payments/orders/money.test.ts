/**
 * Unit tests: src/lib/payments/orders/money.ts
 * Journey: payments-s2-3d-purchase
 * Criteria: S2-OFFER-11..13 (S2-T-MONEY-01..N)
 *
 * Coverage:
 *   - parseKronerToOre: valid inputs → correct integer øre; invalid inputs → null
 *   - formatOreAsKroner: øre → locale editor string ("249,95")
 *   - OFFER_PRICE_MIN_ORE and OFFER_PRICE_MAX_ORE constant pins
 */
import { describe, expect, it } from "vitest";
import { parseKronerToOre, formatOreAsKroner } from "@/lib/payments/orders/money";
import { OFFER_PRICE_MIN_ORE, OFFER_PRICE_MAX_ORE } from "@/config/payments";

// ── S2-T-MONEY-01..08: parseKronerToOre — valid inputs ───────────────────────

describe("S2-OFFER-11 (S2-T-MONEY-01..08): parseKronerToOre — valid inputs → integer øre", () => {
  it.each([
    { input: "249",    expected: 24900 },
    { input: "249,9",  expected: 24990 },
    { input: "249,95", expected: 24995 },
    { input: "249.95", expected: 24995 },
    { input: "1",      expected: 100 },
    { input: "50000",  expected: 5000000 },
    { input: "0,25",   expected: 25 },
    { input: "0.25",   expected: 25 },
  ])("S2-T-MONEY-$# '$input' → $expected", ({ input, expected }) => {
    expect(parseKronerToOre(input)).toBe(expected);
  });
});

// ── S2-T-MONEY-09..17: parseKronerToOre — invalid inputs → null ──────────────

describe("S2-OFFER-11 (S2-T-MONEY-09..17): parseKronerToOre — invalid inputs → null", () => {
  it.each([
    { label: "empty string",             input: "" },
    { label: "thousands separator dot",  input: "1.249,95" },
    { label: "thousands separator comma",input: "1,249.95" },
    { label: "leading sign minus",       input: "-249" },
    { label: "leading sign plus",        input: "+249" },
    { label: "inner space",              input: "249 95" },
    { label: "exponent",                 input: "2e3" },
    { label: "three decimal places",     input: "249.950" },
    { label: "non-numeric",              input: "abc" },
  ])("S2-T-MONEY-$# $label → null", ({ input }) => {
    expect(parseKronerToOre(input)).toBeNull();
  });
});

// ── S2-T-MONEY-18: parseKronerToOre — integer arithmetic (no float drift) ────

describe("S2-OFFER-11 (S2-T-MONEY-18): parseKronerToOre — integer arithmetic, no parseFloat drift", () => {
  it("249.95 returns exactly 24995 (not 24994 or 24996)", () => {
    // parseFloat("249.95") * 100 = 24994.999999... in IEEE-754; must use integer arithmetic
    expect(parseKronerToOre("249.95")).toBe(24995);
  });
});

// ── S2-T-MONEY-19: formatOreAsKroner ─────────────────────────────────────────

describe("S2-OFFER-12 (S2-T-MONEY-19): formatOreAsKroner", () => {
  it.each([
    { ore: 24995, expected: "249,95" },
    { ore: 24900, expected: "249" },
    { ore: 100,   expected: "1" },
    { ore: 25,    expected: "0,25" },
  ])("S2-T-MONEY-$# formatOreAsKroner($ore) → '$expected'", ({ ore, expected }) => {
    expect(formatOreAsKroner(ore)).toBe(expected);
  });
});

// ── S2-T-MONEY-20..21: OFFER_PRICE_MIN_ORE / MAX_ORE constant pins ────────────

describe("S2-OFFER-13 (S2-T-MONEY-20..21): OFFER_PRICE_MIN_ORE and OFFER_PRICE_MAX_ORE pins", () => {
  it("S2-T-MONEY-20: OFFER_PRICE_MIN_ORE === 250", () => {
    expect(OFFER_PRICE_MIN_ORE).toBe(250);
  });

  it("S2-T-MONEY-21: OFFER_PRICE_MAX_ORE === 5000000", () => {
    expect(OFFER_PRICE_MAX_ORE).toBe(5_000_000);
  });
});
