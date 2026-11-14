/**
 * The refund of a withdrawal (fortrydelse) from the Monitor subscription,
 * computed by us in øre rather than by Stripe proration (a proration credit
 * goes to the customer balance and is measured at cancel time, not at the
 * notice). Forbrugeraftaleloven § 25 stk. 2: a consumer who asked the service
 * to start at once pays for the time it ran until the notice; without that
 * recorded request (§ 25 stk. 1) everything is refunded. Pure: no I/O, no
 * clock (the notice time is the stored `requested_at`), so a retry computes
 * the same amount and Stripe's idempotency key keeps matching.
 */

/** Stored with every refunded withdrawal (`calc_version`): which formula computed it. */
export const WITHDRAWAL_CALC_VERSION = "wd-refund-1";

/** Whether the consumer's express request to start at once was recorded (`retention_basis`). */
export type RetentionBasis = "consent" | "no_consent";

/** A point in time: a Date or epoch milliseconds. */
type Instant = Date | number;

export type WithdrawalRefundInput = {
  /** What the invoice's period was paid, in øre (a whole number ≥ 0). */
  paidOre: number;
  /** The paid period (the invoice line's `period`). */
  periodStart: Instant;
  periodEnd: Instant;
  /** When the withdrawal notice was received (the database's `requested_at`). */
  requestedAt: Instant;
  basis: RetentionBasis;
};

export type WithdrawalRefund = { paidOre: number; retainedOre: number; refundOre: number };

/** BigInt zero (the repo targets ES2017, which has no `0n` literal). */
const ZERO = BigInt(0);

/** Whole seconds since the epoch, rounded down. */
function epochSeconds(instant: Instant): bigint {
  const ms = instant instanceof Date ? instant.getTime() : instant;
  if (!Number.isFinite(ms)) throw new RangeError("withdrawal refund: invalid time");
  return BigInt(Math.floor(ms / 1000));
}

/**
 * Splits `paidOre` into what is kept and what is refunded:
 * `E = clamp(requestedAt - periodStart, 0, len)` in whole seconds,
 * `retained = basis === "consent" ? floor(paid × E / len) : 0`,
 * `refund = paid - retained`. Rounding down favours the consumer. Computed
 * in BigInt, so no product loses precision.
 *
 * @throws RangeError when `paidOre` is negative or not a safe integer, a time
 *   is not finite, or the period is empty or reversed (`len ≤ 0`).
 */
export function computeWithdrawalRefund(input: WithdrawalRefundInput): WithdrawalRefund {
  const { paidOre, basis } = input;
  if (!Number.isSafeInteger(paidOre) || paidOre < 0) throw new RangeError("withdrawal refund: invalid paid amount");
  const start = epochSeconds(input.periodStart);
  const length = epochSeconds(input.periodEnd) - start;
  if (length <= ZERO) throw new RangeError("withdrawal refund: empty period");
  const requested = epochSeconds(input.requestedAt);

  let elapsed = requested - start;
  if (elapsed < ZERO) elapsed = ZERO;
  if (elapsed > length) elapsed = length;

  const retained = basis === "consent" ? (BigInt(paidOre) * elapsed) / length : ZERO;
  const retainedOre = Number(retained);
  return { paidOre, retainedOre, refundOre: paidOre - retainedOre };
}
