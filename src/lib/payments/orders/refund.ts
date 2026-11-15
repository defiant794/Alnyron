/**
 * The refund of a goods withdrawal, mirroring `payments_approve_order_refund`
 * (the database is the source of truth): what is left of the order's total
 * after earlier refunds and the owner's deduction for diminished value.
 * Integer øre only.
 */

export type GoodsRefundInput = {
  /** The order's `amount_total_ore`. */
  totalOre: number;
  /** The order's `amount_refunded_ore` so far. */
  refundedOre: number;
  /** The deduction for diminished value, 0 for none. */
  deductionOre: number;
};

export type GoodsRefundResult = { ok: true; refundOre: number } | { ok: false; reason: "deduction_invalid" };

/**
 * `totalOre − refundedOre − deductionOre`, or `deduction_invalid` when the
 * deduction is not a whole non-negative øre amount or leaves less than 1 øre
 * to refund (the SQL rule: refund_ore ≥ 1).
 */
export function computeGoodsRefund({ totalOre, refundedOre, deductionOre }: GoodsRefundInput): GoodsRefundResult {
  if (!Number.isSafeInteger(deductionOre) || deductionOre < 0) return { ok: false, reason: "deduction_invalid" };
  const refundOre = totalOre - refundedOre - deductionOre;
  return refundOre >= 1 ? { ok: true, refundOre } : { ok: false, reason: "deduction_invalid" };
}

/**
 * The 25 % Danish moms included in `amountOre` (an inclusive price):
 * `amountOre − round(amountOre / 1.25)`, computed as
 * `amountOre − Math.round(amountOre * 4 / 5)` so no division by 1.25 drifts
 * (24995 → 4999, 20000 → 4000, 4995 → 999), as Stripe reverses it.
 */
export function inclusiveVatOre(amountOre: number): number {
  return amountOre - Math.round((amountOre * 4) / 5);
}
