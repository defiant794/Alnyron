/**
 * Unit tests: src/lib/payments/withdrawal-refund.ts — computeWithdrawalRefund
 * Journey: payments-slice1d-withdrawal
 * Criteria: WD-J4-C08 (architect §2 refund table)
 *
 * Table (30-day / 1000 øre, consent):
 *   1h→1/999, 1d→33/967, 7d→233/767, 13d→433/567, 14d→466/534
 * Table (365-day / 9500 øre, consent):
 *   1h→1/9499, 1d→26/9474, 7d→182/9318, 13d→338/9162, 14d→364/9136
 * Specific: 31-day at 14d→451/549; 28-day at 14d→500/500
 * no_consent: retained=0, full refund regardless of elapsed time
 */
import { describe, expect, it } from "vitest";
import { computeWithdrawalRefund, WITHDRAWAL_CALC_VERSION } from "@/lib/payments/withdrawal-refund";

// ── Period anchors (epoch ms) ─────────────────────────────────────────────────

const START_30  = new Date("2026-06-01T00:00:00Z").getTime(); // 30-day period (June 2026)
const END_30    = new Date("2026-07-01T00:00:00Z").getTime();
const START_31  = new Date("2026-01-01T00:00:00Z").getTime(); // 31-day period (January 2026)
const END_31    = new Date("2026-02-01T00:00:00Z").getTime();
const START_28  = new Date("2026-02-01T00:00:00Z").getTime(); // 28-day period (February 2026)
const END_28    = new Date("2026-03-01T00:00:00Z").getTime();
const START_365 = new Date("2026-01-01T00:00:00Z").getTime(); // 365-day year
const END_365   = new Date("2027-01-01T00:00:00Z").getTime();

/**
 * Offset a start by whole days + hours. Used at 15+ call sites with the
 * non-obvious mixed-unit formula days*86400 + hours*3600 (seconds to ms).
 */
function at(startMs: number, offset: { days?: number; hours?: number }): number {
  const d = offset.days  ?? 0;
  const h = offset.hours ?? 0;
  return startMs + (d * 86400 + h * 3600) * 1000;
}

// ── WD-J4-C08: WITHDRAWAL_CALC_VERSION constant pin ──────────────────────────

describe("WD-J4-C08: WITHDRAWAL_CALC_VERSION is pinned", () => {
  it("WD-T-REF-00: WITHDRAWAL_CALC_VERSION equals 'wd-refund-1'", () => {
    expect(WITHDRAWAL_CALC_VERSION).toBe("wd-refund-1");
  });
});

// ── WD-J4-C08: 30-day month / 1000 øre — consent basis ──────────────────────

describe("WD-J4-C08 (WD-T-REF-01..05): 30-day / 1000 øre / consent — architect table", () => {
  it.each([
    { label: "1h",  offset: { hours: 1  }, retained:   1, refund: 999 },
    { label: "1d",  offset: { days:  1  }, retained:  33, refund: 967 },
    { label: "7d",  offset: { days:  7  }, retained: 233, refund: 767 },
    { label: "13d", offset: { days: 13  }, retained: 433, refund: 567 },
    { label: "14d", offset: { days: 14  }, retained: 466, refund: 534 },
  ])("WD-T-REF-$label: at $label retained=$retained refund=$refund", ({ offset, retained, refund }) => {
    const r = computeWithdrawalRefund({
      paidOre: 1000,
      periodStart: START_30,
      periodEnd:   END_30,
      requestedAt: at(START_30, offset),
      basis: "consent",
    });
    expect(r).toEqual({ paidOre: 1000, retainedOre: retained, refundOre: refund });
  });
});

// ── WD-J4-C08: 31-day / 28-day at 14 days ────────────────────────────────────

describe("WD-J4-C08 (WD-T-REF-06): 31-day / 1000 øre / consent — 14d retained=451 refund=549", () => {
  it("WD-T-REF-06: 31-day month at 14 days", () => {
    const r = computeWithdrawalRefund({
      paidOre: 1000,
      periodStart: START_31,
      periodEnd:   END_31,
      requestedAt: at(START_31, { days: 14 }),
      basis: "consent",
    });
    expect(r).toEqual({ paidOre: 1000, retainedOre: 451, refundOre: 549 });
  });
});

describe("WD-J4-C08 (WD-T-REF-07): 28-day / 1000 øre / consent — 14d retained=500 refund=500", () => {
  it("WD-T-REF-07: 28-day month at 14 days", () => {
    const r = computeWithdrawalRefund({
      paidOre: 1000,
      periodStart: START_28,
      periodEnd:   END_28,
      requestedAt: at(START_28, { days: 14 }),
      basis: "consent",
    });
    expect(r).toEqual({ paidOre: 1000, retainedOre: 500, refundOre: 500 });
  });
});

// ── WD-J4-C08: 365-day / 9500 øre — consent basis ───────────────────────────

describe("WD-J4-C08 (WD-T-REF-08..12): 365-day / 9500 øre / consent — architect table", () => {
  it.each([
    { label: "1h",  offset: { hours: 1  }, retained:   1, refund: 9499 },
    { label: "1d",  offset: { days:  1  }, retained:  26, refund: 9474 },
    { label: "7d",  offset: { days:  7  }, retained: 182, refund: 9318 },
    { label: "13d", offset: { days: 13  }, retained: 338, refund: 9162 },
    { label: "14d", offset: { days: 14  }, retained: 364, refund: 9136 },
  ])("WD-T-REF-$label: at $label retained=$retained refund=$refund", ({ offset, retained, refund }) => {
    const r = computeWithdrawalRefund({
      paidOre: 9500,
      periodStart: START_365,
      periodEnd:   END_365,
      requestedAt: at(START_365, offset),
      basis: "consent",
    });
    expect(r).toEqual({ paidOre: 9500, retainedOre: retained, refundOre: refund });
  });
});

// ── WD-J4-C08: no_consent — retained=0, full refund ─────────────────────────

describe("WD-J4-C08 (WD-T-REF-NC): no_consent basis — retained=0, full refund regardless of elapsed time", () => {
  it.each([
    { label: "1h in",    requestedAt: at(START_30, { hours: 1 }) },
    { label: "14d in",   requestedAt: at(START_30, { days: 14 }) },
    { label: "at start", requestedAt: START_30 },
  ])("WD-T-REF-NC: no_consent $label — retained=0 refund=1000", ({ requestedAt }) => {
    const r = computeWithdrawalRefund({
      paidOre: 1000,
      periodStart: START_30,
      periodEnd:   END_30,
      requestedAt,
      basis: "no_consent",
    });
    expect(r).toEqual({ paidOre: 1000, retainedOre: 0, refundOre: 1000 });
  });
});

// ── Clamping ──────────────────────────────────────────────────────────────────

describe("WD-J4-C08: clamp — before start (E=0) → retained=0; after end (E=len) → retained=paid", () => {
  it("before start: requestedAt 1s before periodStart → E=0, full refund", () => {
    const r = computeWithdrawalRefund({
      paidOre: 1000,
      periodStart: START_30,
      periodEnd:   END_30,
      requestedAt: START_30 - 1000,
      basis: "consent",
    });
    expect(r).toEqual({ paidOre: 1000, retainedOre: 0, refundOre: 1000 });
  });

  it("after end: requestedAt 1 day after periodEnd → E=len, retained=paid, refund=0", () => {
    const r = computeWithdrawalRefund({
      paidOre: 1000,
      periodStart: START_30,
      periodEnd:   END_30,
      requestedAt: END_30 + 86400_000,
      basis: "consent",
    });
    expect(r).toEqual({ paidOre: 1000, retainedOre: 1000, refundOre: 0 });
  });
});

// ── RangeError guards ─────────────────────────────────────────────────────────

describe("WD-J4-C08: RangeError on invalid inputs (BigInt-safe guards)", () => {
  it("paid < 0 throws RangeError", () => {
    expect(() =>
      computeWithdrawalRefund({ paidOre: -1, periodStart: START_30, periodEnd: END_30, requestedAt: at(START_30, { days: 1 }), basis: "consent" })
    ).toThrow(RangeError);
  });

  it("non-integer paidOre throws RangeError", () => {
    expect(() =>
      computeWithdrawalRefund({ paidOre: 1.5, periodStart: START_30, periodEnd: END_30, requestedAt: at(START_30, { days: 1 }), basis: "consent" })
    ).toThrow(RangeError);
  });

  it("periodEnd <= periodStart (len=0) throws RangeError", () => {
    expect(() =>
      computeWithdrawalRefund({ paidOre: 1000, periodStart: END_30, periodEnd: START_30, requestedAt: at(START_30, { days: 1 }), basis: "consent" })
    ).toThrow(RangeError);
  });
});
