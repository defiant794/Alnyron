/**
 * Unit tests: src/lib/payments/orders/service-contract.ts: OrderService answers (amendments A1, A2)
 * Journey: payments-s2-3d-purchase
 * Criteria: S2-CAP-12 (S2-T-SC-01..06)
 *
 * Charge on dispatch: markShipped captures the payment; a refused capture is `conflict` with
 * subreason `authorization_expired` (the authorization lapsed: the order is canceled) or, per
 * amendment A2-3, `capture_refused` (refused for another reason: the order stays reserved and
 * unshipped). approveRefund of goods never shipped releases the authorization and answers
 * `canceled`.
 */
import { describe, expect, it } from "vitest";
import { ORDER_SERVICE_CONFLICTS, parseOrderServiceResult } from "@/lib/payments/orders/service-contract";

describe("S2-CAP-12 (S2-T-SC-01..06): OrderService results under charge on dispatch", () => {
  it("S2-T-SC-01: markShipped conflict reasons are order_closed, withdrawal_pending, authorization_expired, capture_refused", () => {
    expect(ORDER_SERVICE_CONFLICTS.markShipped).toEqual([
      "order_closed",
      "withdrawal_pending",
      "authorization_expired",
      "capture_refused",
    ]);
    expect(ORDER_SERVICE_CONFLICTS.approveRefund).toEqual(["order_refunded", "order_shipped", "order_not_shipped"]);
  });

  it("S2-T-SC-02: a capture refused because the authorization lapsed parses as {ok:false, reason:'conflict', subreason:'authorization_expired'}", () => {
    const answer = { ok: false, reason: "conflict", subreason: "authorization_expired" };
    expect(parseOrderServiceResult("markShipped", answer)).toEqual(answer);
  });

  it("S2-T-SC-06: a capture refused for another reason (A2-3) parses as {ok:false, reason:'conflict', subreason:'capture_refused'}", () => {
    const answer = { ok: false, reason: "conflict", subreason: "capture_refused" };
    expect(parseOrderServiceResult("markShipped", answer)).toEqual(answer);
  });

  it.each(["shipped", "already_shipped"])("S2-T-SC-03: markShipped ok status %s parses", (status) => {
    expect(parseOrderServiceResult("markShipped", { ok: true, status })).toEqual({ ok: true, status });
  });

  it.each(["completed", "canceled", "approved", "needs_manual"])("S2-T-SC-04: approveRefund ok status %s parses", (status) => {
    expect(parseOrderServiceResult("approveRefund", { ok: true, status })).toEqual({ ok: true, status });
  });

  it.each([
    ["markShipped", { ok: true, status: "captured" }],
    ["markShipped", { ok: true, status: "shipped", extra: 1 }],
    ["approveRefund", { ok: true, status: "refunded" }],
    ["approveRefund", { ok: false, reason: "conflict", subreason: "Authorization expired" }],
  ] as const)("S2-T-SC-05: %s answer %j is unparsable (the web treats it as unavailable)", (method, answer) => {
    expect(parseOrderServiceResult(method, answer)).toBeNull();
  });
});
