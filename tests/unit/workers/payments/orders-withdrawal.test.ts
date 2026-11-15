/**
 * Unit tests: workers/payments/orders/withdrawal.ts — processOrderRefund (amendment A1: no
 * invoices, no credit notes; a refund of returned goods or the release of an authorization)
 * Journey: payments-s2-3d-purchase
 * Criteria: S2-ADM-14..18 (S2-T-WDR-01..08), S2-CAP-5 (the release step from the Worker side)
 *
 * Coverage:
 *   - action refund: POST /v1/refunds of refund_ore (createOrderRefund with the withdrawal and
 *     order number), step refunded{refund_id, refund_tax_ore = inclusiveVatOre(refund_ore)}, the
 *     credit note email (receipt) and its receipt_sent step; never a cancel or an invoice call
 *   - replay: reconcile the PI's refunds by withdrawal metadata before creating one, even when
 *     the refunded step failed; reuse succeeded/pending, ignore other withdrawals/failed/canceled
 *   - action cancel_authorization: cancel of the payment intent, step authorization_canceled{},
 *     the cancellation credit note; a refused cancel with the payment intent canceled = done,
 *     otherwise needs_manual stripe_refused
 *   - Stripe 4xx → needs_manual{reason:'stripe_refused'} + the owner's manual alert, stamped
 *     manual_alert_sent (amendment A3-3); a failed alert records mail_failed for the sweep
 *   - transient failure → attempt_failed{error}, no receipt; on the last pass retries_exhausted
 *   - claim busy, a failing step, a failing alert, a failing alert stamp
 *
 * The Idempotency-Keys (ord-re-, ord-cancel-) are pinned at the Stripe layer
 * (orders-stripe.test.ts).
 */
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { WITHDRAWAL_LEASE_SECONDS, WITHDRAWAL_MAX_ATTEMPTS } from "@/config/payments";
import { processOrderRefund, type OrderRefundDeps } from "../../../../workers/payments/orders/withdrawal";
import { OrderRpcError, type OrderSnapshot, type OrderWithdrawalSnapshot } from "../../../../workers/payments/orders/rpc";
import { MailError } from "../../../../workers/payments/mail";
import { createOrderStripeApi } from "../../../../workers/payments/orders/stripe";

const WD_ID = "00000000-0000-0000-0000-0000000000a1";
const ORDER_ID = "00000000-0000-0000-0000-0000000000b1";
const PI_ID = "pi_wdr0000000000000001";
const RE_ID = "re_wdr0000000000000001";
const STRIPE_KEY_FX = "sk_test_unitorders1234";

const ORDER: OrderSnapshot = {
  id: ORDER_ID,
  order_number: 1001,
  status: "shipped",
  email: "delivered+s2@resend.dev",
  customer_name: "Lars Andersen",
  phone: "+4520123456",
  shipping_name: "Lars Andersen",
  shipping_address: { line1: "Testvej 1", line2: null, postal_code: "7860", city: "Spøttrup", country: "DK" },
  locale: "da",
  amount_total_ore: 24995,
  amount_refunded_ore: 0,
  paid_at: "2026-11-14T10:00:00.000Z",
  authorization_expires_at: null,
  captured_at: "2026-11-15T10:00:00.000Z",
  cancel_reason: null,
  anomaly: null,
  tracking_ref: "GLS123",
  stripe_payment_intent_id: PI_ID,
  line: { title: "Testfigur", quantity: 1 },
};

/** An approved refund of 20000 øre (49,95 kr deducted), claimed for its first pass. */
const REFUND_WD: OrderWithdrawalSnapshot = {
  id: WD_ID,
  order_id: ORDER_ID,
  status: "approved",
  consumer_name: "Lars Andersen",
  locale: "da",
  requested_at: "2026-11-16T10:00:00.000Z",
  refund_due_at: "2026-11-30T10:00:00.000Z",
  deadline_at: "2026-12-07T23:00:00.000Z",
  late: false,
  shipped_before_notice: true,
  action: "refund",
  refund_ore: 20000,
  deduction_ore: 4995,
  deduction_reason: "Ridser på figuren",
  refunded_at: null,
  authorization_canceled_at: null,
  manual_reason: null,
  attempts: 1,
};

/** An approved release of an authorization (goods never shipped, nothing captured). */
const RELEASE_WD: OrderWithdrawalSnapshot = {
  ...REFUND_WD,
  action: "cancel_authorization",
  refund_ore: null,
  deduction_ore: 0,
  deduction_reason: null,
  shipped_before_notice: false,
  deadline_at: null,
};

const UNSHIPPED_ORDER: OrderSnapshot = { ...ORDER, status: "authorized", captured_at: null, tracking_ref: null };

type Fakes = {
  stripe: { cancelPaymentIntent: Mock; retrievePaymentIntent: Mock; listPaymentIntentRefunds: Mock; createOrderRefund: Mock };
  rpc: { claimOrderWithdrawal: Mock; orderWithdrawalStep: Mock };
  mail: { sendWithdrawalReceipt: Mock; sendManualAlert: Mock };
  log: Mock;
};

/** The withdrawal as the step writer answers it: `step` with `data` applied to `withdrawal`. */
function stepped(withdrawal: OrderWithdrawalSnapshot, step: string, data: Record<string, unknown>): OrderWithdrawalSnapshot {
  if (step === "refunded") return { ...withdrawal, status: "completed", refunded_at: "2026-11-20T10:00:00.000Z" };
  if (step === "authorization_canceled") {
    return { ...withdrawal, status: "completed", authorization_canceled_at: "2026-11-17T10:00:00.000Z" };
  }
  if (step === "needs_manual") {
    const reason = data.reason === "stripe_refused" || data.reason === "retries_exhausted" ? data.reason : null;
    return { ...withdrawal, status: "needs_manual", manual_reason: reason };
  }
  return withdrawal;
}

function fakes(withdrawal: OrderWithdrawalSnapshot = REFUND_WD, order: OrderSnapshot = ORDER): Fakes & OrderRefundDeps {
  return {
    stripe: {
      cancelPaymentIntent: vi.fn().mockResolvedValue({ ok: true, data: { id: PI_ID, status: "canceled" } }),
      retrievePaymentIntent: vi.fn().mockResolvedValue({ ok: true, data: { id: PI_ID, status: "canceled" } }),
      listPaymentIntentRefunds: vi.fn().mockResolvedValue({ ok: true, data: [] }),
      createOrderRefund: vi.fn().mockResolvedValue({ ok: true, data: { id: RE_ID, status: "succeeded", amount: 20000 } }),
    },
    rpc: {
      claimOrderWithdrawal: vi.fn().mockResolvedValue({ claimed: true, withdrawal, order }),
      orderWithdrawalStep: vi.fn(
        async (
          _id: string,
          step: string,
          data: Record<string, unknown>,
        ): Promise<{ outcome: "applied" | "already"; withdrawal: OrderWithdrawalSnapshot }> => ({
          outcome: "applied",
          withdrawal: stepped(withdrawal, step, data),
        }),
      ),
    },
    mail: {
      sendWithdrawalReceipt: vi.fn().mockResolvedValue({ id: "em-receipt" }),
      sendManualAlert: vi.fn().mockResolvedValue({ id: "em-manual" }),
    },
    log: vi.fn(),
  };
}

/** The steps recorded, as [step, data]. */
function steps(deps: Fakes): unknown[] {
  return deps.rpc.orderWithdrawalStep.mock.calls.map(([id, step, data]) => {
    expect(id).toBe(WD_ID);
    return [step, data];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("S2-ADM-14 (S2-T-WDR-01): action refund → POST /v1/refunds, refunded step, the credit note email", () => {
  it("refunds refund_ore of the payment intent, records the refund id and the reversed moms, sends and stamps the receipt", async () => {
    const deps = fakes();
    await expect(processOrderRefund(deps, WD_ID)).resolves.toBe("completed");

    expect(deps.rpc.claimOrderWithdrawal).toHaveBeenCalledWith(WD_ID, WITHDRAWAL_LEASE_SECONDS);
    expect(deps.stripe.listPaymentIntentRefunds).toHaveBeenCalledExactlyOnceWith(PI_ID);
    expect(deps.stripe.createOrderRefund).toHaveBeenCalledExactlyOnceWith({
      paymentIntentId: PI_ID,
      amountOre: 20000,
      withdrawalId: WD_ID,
      orderNumber: 1001,
    });
    expect(steps(deps)).toEqual([
      ["refunded", { refund_id: RE_ID, refund_tax_ore: 4000 }], // inclusiveVatOre(20000) = 4000
      ["receipt_sent", { email_id: "em-receipt" }],
    ]);
    // The receipt is built from the completed withdrawal (refunded_at set by the step).
    expect(deps.mail.sendWithdrawalReceipt).toHaveBeenCalledExactlyOnceWith(
      ORDER,
      expect.objectContaining({ status: "completed", refunded_at: "2026-11-20T10:00:00.000Z" }),
    );
    // No credit notes, no invoices, no release.
    expect(deps.stripe.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(deps.stripe.retrievePaymentIntent).not.toHaveBeenCalled();
    expect(deps.mail.sendManualAlert).not.toHaveBeenCalled();
  });
});

describe("S2-ADM-15 (S2-T-WDR-02): a re-run after the refund was made finds the same re_ and completes", () => {
  it("the refunded step answered already (the identical replay) still sends the receipt", async () => {
    const deps = fakes();
    deps.stripe.listPaymentIntentRefunds.mockResolvedValue({
      ok: true, data: [{ id: RE_ID, status: "succeeded", metadata: { order_withdrawal_id: WD_ID } }],
    });
    deps.rpc.orderWithdrawalStep.mockImplementation(async (_id: string, step: string, data: Record<string, unknown>) => ({
      outcome: step === "refunded" ? "already" : "applied",
      withdrawal: stepped(REFUND_WD, step, data),
    }));
    await expect(processOrderRefund(deps, WD_ID)).resolves.toBe("completed");
    expect(deps.stripe.listPaymentIntentRefunds).toHaveBeenCalledExactlyOnceWith(PI_ID);
    expect(deps.stripe.createOrderRefund).not.toHaveBeenCalled();
    expect(steps(deps)).toEqual([
      ["refunded", { refund_id: RE_ID, refund_tax_ore: 4000 }],
      ["receipt_sent", { email_id: "em-receipt" }],
    ]);
  });
});

describe("S2-ADM-15 (S2-T-WDR-06): reconcile a refund whose database step failed without a second POST", () => {
  it.each(["succeeded", "pending"])("reuses a %s refund on the next pass and sends the receipt", async (status) => {
    // With a deduction over half the charge, another refund would fit: lookup, not the charge's
    // remaining balance or Stripe's expiring Idempotency-Key, must prevent the second POST.
    const withdrawal = { ...REFUND_WD, refund_ore: 10000, deduction_ore: 14995 };
    const existing = { id: RE_ID, status, metadata: { order_withdrawal_id: WD_ID, order_number: "1001" } };
    const fetchSpy = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ object: "list", data: [], has_more: false }))
      .mockResolvedValueOnce(Response.json(existing))
      .mockResolvedValueOnce(Response.json({ object: "list", data: [existing], has_more: false }));
    const deps = { ...fakes(withdrawal), stripe: createOrderStripeApi(STRIPE_KEY_FX, fetchSpy) };
    deps.rpc.orderWithdrawalStep.mockRejectedValueOnce(new OrderRpcError("rpc_failed", "unknown", 503));

    await expect(processOrderRefund(deps, WD_ID)).resolves.toBe("approved");
    expect(deps.mail.sendWithdrawalReceipt).not.toHaveBeenCalled();
    deps.rpc.claimOrderWithdrawal.mockResolvedValue({ claimed: true, withdrawal: { ...withdrawal, attempts: 2 }, order: ORDER });
    await expect(processOrderRefund(deps, WD_ID)).resolves.toBe("completed");

    expect(fetchSpy.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
      [`https://api.stripe.com/v1/refunds?payment_intent=${PI_ID}&limit=100`, "GET"],
      ["https://api.stripe.com/v1/refunds", "POST"],
      [`https://api.stripe.com/v1/refunds?payment_intent=${PI_ID}&limit=100`, "GET"],
    ]);
    expect(deps.rpc.orderWithdrawalStep.mock.calls.map(([, step, data]) => [step, data])).toEqual([
      ["refunded", { refund_id: RE_ID, refund_tax_ore: 2000 }],
      ["attempt_failed", { error: "rpc_unknown" }],
      ["refunded", { refund_id: RE_ID, refund_tax_ore: 2000 }],
      ["receipt_sent", { email_id: "em-receipt" }],
    ]);
    expect(deps.mail.sendWithdrawalReceipt).toHaveBeenCalledExactlyOnceWith(
      ORDER, expect.objectContaining({ status: "completed", refund_ore: 10000 }),
    );
    expect(deps.mail.sendManualAlert).not.toHaveBeenCalled();
  });
});

describe("S2-ADM-15 (S2-T-WDR-07): unrelated and unsuccessful refunds do not satisfy this withdrawal", () => {
  it("ignores another withdrawal's refund and this withdrawal's failed/canceled refunds, then creates its refund", async () => {
    const listed = [
      { id: "re_other", status: "succeeded", metadata: { order_withdrawal_id: ORDER_ID } },
      { id: "re_failed", status: "failed", metadata: { order_withdrawal_id: WD_ID } },
      { id: "re_canceled", status: "canceled", metadata: { order_withdrawal_id: WD_ID } },
      { id: "re_action", status: "requires_action", metadata: { order_withdrawal_id: WD_ID } },
    ];
    const fetchSpy = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ object: "list", data: listed, has_more: false }))
      .mockResolvedValueOnce(Response.json({ id: RE_ID, status: "succeeded" }));
    const deps = { ...fakes(), stripe: createOrderStripeApi(STRIPE_KEY_FX, fetchSpy) };

    await expect(processOrderRefund(deps, WD_ID)).resolves.toBe("completed");
    expect(fetchSpy.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
      [`https://api.stripe.com/v1/refunds?payment_intent=${PI_ID}&limit=100`, "GET"],
      ["https://api.stripe.com/v1/refunds", "POST"],
    ]);
    expect(deps.rpc.orderWithdrawalStep).toHaveBeenCalledWith(WD_ID, "refunded", { refund_id: RE_ID, refund_tax_ore: 4000 });
  });
});

describe("S2-ADM-15 (S2-T-WDR-08): a failed or malformed refund list cannot authorize a POST", () => {
  it.each([
    { label: "400", status: 400, answer: { error: { code: "invalid_request" } }, code: "stripe_http_400" },
    { label: "402", status: 402, answer: { error: { code: "refused" } }, code: "stripe_http_402" },
    { label: "403", status: 403, answer: { error: { code: "permission" } }, code: "stripe_http_403" },
    { label: "429", status: 429, answer: { error: { code: "rate_limit" } }, code: "stripe_http_429" },
    { label: "503", status: 503, answer: {}, code: "stripe_http_503" },
    { label: "missing list", status: 200, answer: {}, code: "stripe_invalid_response" },
    {
      label: "invalid refund",
      status: 200,
      answer: { object: "list", data: [{ id: "re_bad", status: "succeeded", metadata: null }], has_more: false },
      code: "stripe_invalid_response",
    },
    {
      label: "incomplete list",
      status: 200,
      answer: { object: "list", data: [], has_more: true },
      code: "stripe_invalid_response",
    },
  ])("$label → attempt_failed, no POST or receipt", async ({ status, answer, code }) => {
    const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(Response.json(answer, { status }));
    const deps = { ...fakes(), stripe: createOrderStripeApi(STRIPE_KEY_FX, fetchSpy) };

    await expect(processOrderRefund(deps, WD_ID)).resolves.toBe("approved");
    expect(fetchSpy.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
      [`https://api.stripe.com/v1/refunds?payment_intent=${PI_ID}&limit=100`, "GET"],
    ]);
    expect(deps.rpc.orderWithdrawalStep).toHaveBeenCalledExactlyOnceWith(WD_ID, "attempt_failed", { error: code });
    expect(deps.mail.sendWithdrawalReceipt).not.toHaveBeenCalled();
    expect(deps.mail.sendManualAlert).not.toHaveBeenCalled();
  });

  it("a network failure also releases the lease without a refund POST", async () => {
    const fetchSpy = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("network"));
    const deps = { ...fakes(), stripe: createOrderStripeApi(STRIPE_KEY_FX, fetchSpy) };
    await expect(processOrderRefund(deps, WD_ID)).resolves.toBe("approved");
    expect(fetchSpy.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
      [`https://api.stripe.com/v1/refunds?payment_intent=${PI_ID}&limit=100`, "GET"],
    ]);
    expect(deps.rpc.orderWithdrawalStep).toHaveBeenCalledExactlyOnceWith(WD_ID, "attempt_failed", { error: "stripe_network" });
  });
});

describe("S2-ADM-16 (S2-T-WDR-03): action cancel_authorization → release the authorization, nothing refunded", () => {
  it("cancels the payment intent, records authorization_canceled and sends the cancellation credit note", async () => {
    const deps = fakes(RELEASE_WD, UNSHIPPED_ORDER);
    await expect(processOrderRefund(deps, WD_ID)).resolves.toBe("canceled");
    expect(deps.stripe.cancelPaymentIntent).toHaveBeenCalledExactlyOnceWith(PI_ID, WD_ID);
    expect(deps.stripe.createOrderRefund).not.toHaveBeenCalled();
    expect(deps.stripe.listPaymentIntentRefunds).not.toHaveBeenCalled();
    expect(steps(deps)).toEqual([
      ["authorization_canceled", {}],
      ["receipt_sent", { email_id: "em-receipt" }],
    ]);
    expect(deps.mail.sendWithdrawalReceipt).toHaveBeenCalledWith(
      UNSHIPPED_ORDER,
      expect.objectContaining({ action: "cancel_authorization", authorization_canceled_at: "2026-11-17T10:00:00.000Z" }),
    );
  });

  it("a refused cancel (400) whose payment intent Stripe shows canceled is done (a repeat, or a lapsed authorization)", async () => {
    const deps = fakes(RELEASE_WD, UNSHIPPED_ORDER);
    deps.stripe.cancelPaymentIntent.mockResolvedValue({ ok: false, kind: "http", status: 400, code: "payment_intent_unexpected_state" });
    await expect(processOrderRefund(deps, WD_ID)).resolves.toBe("canceled");
    expect(deps.stripe.retrievePaymentIntent).toHaveBeenCalledExactlyOnceWith(PI_ID);
    expect(steps(deps)).toEqual([
      ["authorization_canceled", {}],
      ["receipt_sent", { email_id: "em-receipt" }],
    ]);
  });

  it("a refused cancel whose payment intent is not canceled (captured) → needs_manual stripe_refused + manual alert", async () => {
    const deps = fakes(RELEASE_WD, UNSHIPPED_ORDER);
    deps.stripe.cancelPaymentIntent.mockResolvedValue({ ok: false, kind: "http", status: 400, code: "payment_intent_unexpected_state" });
    deps.stripe.retrievePaymentIntent.mockResolvedValue({ ok: true, data: { id: PI_ID, status: "succeeded" } });
    await expect(processOrderRefund(deps, WD_ID)).resolves.toBe("needs_manual");
    expect(steps(deps)).toEqual([
      ["needs_manual", { reason: "stripe_refused" }],
      ["manual_alert_sent", { email_id: "em-manual" }],
    ]);
    expect(deps.mail.sendManualAlert).toHaveBeenCalledWith(
      UNSHIPPED_ORDER,
      expect.objectContaining({ status: "needs_manual", manual_reason: "stripe_refused" }),
    );
    expect(deps.mail.sendWithdrawalReceipt).not.toHaveBeenCalled();
  });
});

describe("S2-ADM-17 (S2-T-WDR-04): Stripe refuses (4xx) → needs_manual stripe_refused + owner alert", () => {
  it("an over-refund 400 → needs_manual{reason:'stripe_refused'}, the manual alert stamped (A3-3), no receipt", async () => {
    const deps = fakes();
    deps.stripe.createOrderRefund.mockResolvedValue({ ok: false, kind: "http", status: 400, code: "amount_too_large" });
    await expect(processOrderRefund(deps, WD_ID)).resolves.toBe("needs_manual");
    expect(steps(deps)).toEqual([
      ["needs_manual", { reason: "stripe_refused" }],
      ["manual_alert_sent", { email_id: "em-manual" }],
    ]);
    expect(deps.mail.sendManualAlert).toHaveBeenCalledExactlyOnceWith(
      ORDER,
      expect.objectContaining({ id: WD_ID, status: "needs_manual", manual_reason: "stripe_refused" }),
    );
    expect(deps.mail.sendWithdrawalReceipt).not.toHaveBeenCalled();
  });

  it("a refund Stripe reports failed is a refusal too", async () => {
    const deps = fakes();
    deps.stripe.createOrderRefund.mockResolvedValue({ ok: true, data: { id: RE_ID, status: "failed" } });
    await expect(processOrderRefund(deps, WD_ID)).resolves.toBe("needs_manual");
    expect(steps(deps)).toEqual([
      ["needs_manual", { reason: "stripe_refused" }],
      ["manual_alert_sent", { email_id: "em-manual" }],
    ]);
  });

  it("a manual alert Resend refuses records mail_failed and no stamp, so the sweep sends it (the withdrawal stays needs_manual)", async () => {
    const deps = fakes();
    deps.stripe.createOrderRefund.mockResolvedValue({ ok: false, kind: "http", status: 400, code: null });
    deps.mail.sendManualAlert.mockRejectedValue(new MailError("transient"));
    await expect(processOrderRefund(deps, WD_ID)).resolves.toBe("needs_manual");
    expect(steps(deps)).toEqual([
      ["needs_manual", { reason: "stripe_refused" }],
      ["mail_failed", {}],
    ]);
    const lines = deps.log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(lines.at(-1)).toEqual({ msg: "payments order refund", withdrawal: WD_ID, step: "manual_alert", outcome: "failed", code: "mail_transient" });
  });

  it("a stamp that fails after the alert went out is no failed send (no mail_failed; the sweep resends under the same key)", async () => {
    const deps = fakes();
    deps.stripe.createOrderRefund.mockResolvedValue({ ok: false, kind: "http", status: 402, code: null });
    deps.rpc.orderWithdrawalStep.mockImplementation(async (_id: string, step: string, data: Record<string, unknown>) => {
      if (step === "manual_alert_sent") throw new OrderRpcError("rpc_failed", "unknown", 503);
      return { outcome: "applied", withdrawal: stepped(REFUND_WD, step, data) };
    });
    await expect(processOrderRefund(deps, WD_ID)).resolves.toBe("needs_manual");
    expect(steps(deps)).toEqual([
      ["needs_manual", { reason: "stripe_refused" }],
      ["manual_alert_sent", { email_id: "em-manual" }],
    ]);
  });
});

describe("S2-ADM-18 (S2-T-WDR-05): a transient failure → attempt_failed, the lease released for the sweep", () => {
  it.each([
    ["Stripe 503", { ok: false, kind: "http", status: 503, code: null }, "stripe_http_503"],
    ["Stripe 429", { ok: false, kind: "http", status: 429, code: "rate_limit" }, "stripe_http_429"],
    ["Stripe 403 (a permission to fix)", { ok: false, kind: "http", status: 403, code: null }, "stripe_http_403"],
    ["network", { ok: false, kind: "network" }, "stripe_network"],
  ])("%s → attempt_failed{error: %s}, no receipt, still approved", async (_label, answer, code) => {
    const deps = fakes();
    deps.stripe.createOrderRefund.mockResolvedValue(answer);
    await expect(processOrderRefund(deps, WD_ID)).resolves.toBe("approved");
    expect(steps(deps)).toEqual([["attempt_failed", { error: code }]]);
    expect(deps.mail.sendWithdrawalReceipt).not.toHaveBeenCalled();
    expect(deps.mail.sendManualAlert).not.toHaveBeenCalled();
  });

  it(`on the last pass (attempts = ${WITHDRAWAL_MAX_ATTEMPTS}) a transient failure → needs_manual retries_exhausted + alert`, async () => {
    const deps = fakes({ ...REFUND_WD, attempts: WITHDRAWAL_MAX_ATTEMPTS });
    deps.stripe.createOrderRefund.mockResolvedValue({ ok: false, kind: "network" });
    await expect(processOrderRefund(deps, WD_ID)).resolves.toBe("needs_manual");
    expect(steps(deps)).toEqual([
      ["needs_manual", { reason: "retries_exhausted" }],
      ["manual_alert_sent", { email_id: "em-manual" }],
    ]);
    expect(deps.mail.sendManualAlert).toHaveBeenCalledExactlyOnceWith(
      ORDER,
      expect.objectContaining({ status: "needs_manual", manual_reason: "retries_exhausted" }),
    );
  });

  it("a failing step (the database) releases the lease with attempt_failed and leaves it approved", async () => {
    const deps = fakes();
    deps.rpc.orderWithdrawalStep.mockImplementation(async (_id: string, step: string) => {
      if (step === "refunded") throw new OrderRpcError("rpc_failed", "unknown", 503);
      return { outcome: "applied", withdrawal: REFUND_WD };
    });
    await expect(processOrderRefund(deps, WD_ID)).resolves.toBe("approved");
    expect(steps(deps)).toEqual([
      ["refunded", { refund_id: RE_ID, refund_tax_ore: 4000 }],
      ["attempt_failed", { error: "rpc_unknown" }],
    ]);
    expect(deps.mail.sendWithdrawalReceipt).not.toHaveBeenCalled();
  });

  it("a receipt Resend refuses records mail_failed: the refund stays completed, the sweep resends the receipt", async () => {
    const deps = fakes();
    deps.mail.sendWithdrawalReceipt.mockRejectedValue(new MailError("rate_limited"));
    await expect(processOrderRefund(deps, WD_ID)).resolves.toBe("completed");
    expect(steps(deps)).toEqual([
      ["refunded", { refund_id: RE_ID, refund_tax_ore: 4000 }],
      ["mail_failed", {}],
    ]);
  });
});

describe("processOrderRefund: claim", () => {
  it("a withdrawal another pass holds is left alone: no Stripe call, its state answered", async () => {
    const deps = fakes();
    deps.rpc.claimOrderWithdrawal.mockResolvedValue({ claimed: false, withdrawal: REFUND_WD, order: ORDER });
    await expect(processOrderRefund(deps, WD_ID)).resolves.toBe("approved");
    expect(deps.stripe.listPaymentIntentRefunds).not.toHaveBeenCalled();
    expect(deps.stripe.createOrderRefund).not.toHaveBeenCalled();
    expect(deps.rpc.orderWithdrawalStep).not.toHaveBeenCalled();
  });

  it("logs ids, steps and codes only (never the name, an email or an amount)", async () => {
    const deps = fakes();
    await processOrderRefund(deps, WD_ID);
    const lines = deps.log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(lines).toEqual([
      { msg: "payments order refund", withdrawal: WD_ID, step: "claim", outcome: "claimed", code: null },
      { msg: "payments order refund", withdrawal: WD_ID, step: "refunded", outcome: "applied", code: null },
      { msg: "payments order refund", withdrawal: WD_ID, step: "receipt", outcome: "sent", code: null },
    ]);
  });

  it("a failing claim throws (the caller logs it; nothing else is called)", async () => {
    const deps = fakes();
    deps.rpc.claimOrderWithdrawal.mockRejectedValue(new OrderRpcError("rpc_failed", "unknown", 500));
    await expect(processOrderRefund(deps, WD_ID)).rejects.toThrow(OrderRpcError);
    expect(deps.stripe.listPaymentIntentRefunds).not.toHaveBeenCalled();
    expect(deps.stripe.createOrderRefund).not.toHaveBeenCalled();
  });
});
