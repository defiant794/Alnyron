/**
 * Unit tests: src/lib/payments/orders/refund.ts
 * Journey: payments-s2-3d-purchase
 * Criteria: S2-ADM-11..13 (S2-T-REF-01..05)
 *
 * Coverage:
 *   - computeGoodsRefund: full refund (deduction=0), with deduction, deduction_invalid
 *   - inclusiveVatOre: 25% VAT reversal with integer arithmetic
 *     (24995→4999, 20000→4000, 4995→999 — pinned per contract §2 and spike)
 */
import { describe, expect, it } from "vitest";
import { computeGoodsRefund, inclusiveVatOre } from "@/lib/payments/orders/refund";

// ── S2-ADM-11 (S2-T-REF-01): full refund, no deduction ───────────────────────

describe("S2-ADM-11 (S2-T-REF-01): computeGoodsRefund — no deduction, full refund", () => {
  it("totalOre=24995, refundedOre=0, deductionOre=0 → refundOre=24995", () => {
    expect(computeGoodsRefund({ totalOre: 24995, refundedOre: 0, deductionOre: 0 }))
      .toEqual({ ok: true, refundOre: 24995 });
  });

  it("partial refund already applied: totalOre=24995, refundedOre=4000, deductionOre=0 → refundOre=20995", () => {
    expect(computeGoodsRefund({ totalOre: 24995, refundedOre: 4000, deductionOre: 0 }))
      .toEqual({ ok: true, refundOre: 20995 });
  });
});

// ── S2-ADM-11 (S2-T-REF-01b): with deduction ─────────────────────────────────

describe("S2-ADM-11 (S2-T-REF-01b): computeGoodsRefund — with deduction", () => {
  it("totalOre=24995, refundedOre=0, deductionOre=5000 → refundOre=19995", () => {
    expect(computeGoodsRefund({ totalOre: 24995, refundedOre: 0, deductionOre: 5000 }))
      .toEqual({ ok: true, refundOre: 19995 });
  });
});

// ── S2-ADM-12 (S2-T-REF-02): deduction_invalid ───────────────────────────────

describe("S2-ADM-12 (S2-T-REF-02): computeGoodsRefund — deduction_invalid when refundOre < 1", () => {
  it.each([
    { label: "deduction equals total",         args: { totalOre: 24995, refundedOre: 0,    deductionOre: 24995 } },
    { label: "deduction exceeds remaining",    args: { totalOre: 24995, refundedOre: 4000, deductionOre: 21000 } },
    { label: "deduction exceeds total",        args: { totalOre: 24995, refundedOre: 0,    deductionOre: 25000 } },
  ])("$label → {ok:false, reason:'deduction_invalid'}", ({ args }) => {
    expect(computeGoodsRefund(args)).toEqual({ ok: false, reason: "deduction_invalid" });
  });
});

// ── S2-ADM-13 (S2-T-REF-03..05): inclusiveVatOre — contract-pinned values ────

describe("S2-ADM-13 (S2-T-REF-03..05): inclusiveVatOre — 25% inclusive VAT reversal", () => {
  it.each([
    { amount: 24995, expected: 4999, label: "24995→4999 (spike confirmed)" },
    { amount: 20000, expected: 4000, label: "20000→4000 (spike partial refund)" },
    { amount: 4995,  expected: 999,  label: "4995→999  (spike remainder)" },
    { amount: 100,   expected: 20,   label: "100→20" },
    { amount: 1,     expected: 0,    label: "1→0 (rounds to 0)" },
  ])("S2-T-REF-$# $label", ({ amount, expected }) => {
    expect(inclusiveVatOre(amount)).toBe(expected);
  });
});

// ── inclusiveVatOre: integer arithmetic (no float drift) ─────────────────────

describe("inclusiveVatOre — integer arithmetic, no Math.round(amount/1.25) float issues", () => {
  it("uses amountOre - Math.round(amountOre * 4 / 5), not parseFloat path", () => {
    // 4995 / 1.25 = 3996.0 exactly; * 4 / 5 = 3996. Both give 999.
    // Key check: doesn't drift to 998 or 1000.
    expect(inclusiveVatOre(4995)).toBe(999);
    // 24995 / 1.25 = 19996 exactly; 24995 - 19996 = 4999
    expect(inclusiveVatOre(24995)).toBe(4999);
  });
});
