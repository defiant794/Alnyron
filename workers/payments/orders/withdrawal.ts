import { WITHDRAWAL_LEASE_SECONDS, WITHDRAWAL_MAX_ATTEMPTS } from "@/config/payments";
import type { OrderManualReason } from "@/config/legal/goods-texts";
import { inclusiveVatOre } from "@/lib/payments/orders/refund";
import type { StripeResult } from "@/lib/payments/stripe";
import { asRecord } from "@/lib/payments/webhook-mapping";
import type { Json } from "@/types/database";
import { deliverWithdrawalMail, failureCode, stripeFailure } from "./deliver";
import type { OrderMailer } from "./mail";
import type { OrderRpc, OrderSnapshot, OrderWithdrawalSnapshot } from "./rpc";
import { REFUND_ID_REGEX, type OrderStripeApi } from "./stripe";

/**
 * One pass over an approved goods withdrawal (slice S2, amendment A1), shared
 * by `OrderService.approveRefund` (right after the owner's approval) and the
 * sweep's order pass. Every rule of the state machine is the database's
 * (`payments_order_withdrawal_step`); this drives Stripe and the emails
 * between the steps:
 *
 * 1. Claim (`payments_claim_order_withdrawal`, a WITHDRAWAL_LEASE_SECONDS
 *    lease; it counts the pass in `attempts`). A withdrawal another pass holds
 *    or without work is left as it is.
 * 2. The approved action:
 *    - `cancel_authorization` (goods never shipped, nothing captured):
 *      `POST /v1/payment_intents/{pi}/cancel` (`requested_by_customer`,
 *      Idempotency-Key `ord-cancel-<withdrawal id>`); a refused cancel is done
 *      when Stripe then shows the payment intent `canceled` (a repeated
 *      cancel, or the authorization lapsed). Then step `authorization_canceled`.
 *    - `refund`: first `GET /v1/refunds?payment_intent=<pi>&limit=100`; reuse a
 *      succeeded/pending refund with this `metadata.order_withdrawal_id`, even
 *      after Stripe's 24-hour idempotency window. Otherwise `POST /v1/refunds`
 *      of `refund_ore` with `metadata{order_withdrawal_id, order_number}`,
 *      Idempotency-Key `ord-re-<withdrawal id>`. Then step
 *      `refunded{refund_id, refund_tax_ore: inclusiveVatOre(refund_ore)}`.
 *    No invoice and no credit-note calls: the credit note is the email.
 * 3. Completed: the credit note email (`order-refund/<withdrawal id>`: of the
 *    refund, or of the released reservation), then step `receipt_sent`.
 * 4. Stripe refusing the action (400 or 402, or a new refund it reports
 *    `failed` or `canceled`) is `needs_manual stripe_refused`; a failed refund
 *    lookup or another transient failure is `attempt_failed <code>` (releases
 *    the lease for the sweep). On the last pass (`attempts` =
 *    WITHDRAWAL_MAX_ATTEMPTS) it becomes `needs_manual retries_exhausted`. Both manual
 *    reasons send the owner the manual alert (`order-wd-manual/<withdrawal
 *    id>`), then step `manual_alert_sent` (amendment A3-3); a failed send
 *    records `mail_failed` and the sweep sends it (its `manual_alert` need).
 *
 * Every step logs one JSON line `{msg: "payments order refund", withdrawal,
 * step, outcome, code}`: ids and codes only. Returns what the withdrawal came
 * to: `completed` (refunded), `canceled` (the reservation released),
 * `needs_manual`, or `approved` (left for a later pass). Throws only when the
 * claim itself fails.
 *
 * Subrequests: the claim 1; the cancel and its re-retrieve, or the refund
 * lookup and create (2 at most); the step 1; the receipt or the manual alert
 * with its step (2): at most 6
 * (ORDER_REFUND_PASS_SUBREQUESTS in ./sweep.ts).
 */
export type OrderRefundDeps = {
  stripe: Pick<OrderStripeApi, "cancelPaymentIntent" | "retrievePaymentIntent" | "listPaymentIntentRefunds" | "createOrderRefund">;
  rpc: Pick<OrderRpc, "claimOrderWithdrawal" | "orderWithdrawalStep">;
  mail: Pick<OrderMailer, "sendWithdrawalReceipt" | "sendManualAlert">;
  log: (line: string) => void;
};

/** What an approved withdrawal came to after a pass. */
export type OrderRefundStatus = "completed" | "canceled" | "approved" | "needs_manual";

const LOG_MSG = "payments order refund";

/** What Stripe made of the approved action: its step, a refusal, or a failure a later pass may fix. */
type StripeOutcome =
  | { kind: "done"; step: "authorization_canceled" | "refunded"; data: Record<string, Json> }
  | { kind: "refused"; code: string }
  | { kind: "failed"; code: string };

/**
 * Whether a failed Stripe call is Stripe refusing the request (400 or 402), not a failure a retry
 * may fix. 401/403 (a key or permission to fix, e.g. at go-live), 404, 409 and 429 are retried.
 */
function isRefusal(result: Exclude<StripeResult<unknown>, { ok: true }>): boolean {
  return result.kind === "http" && (result.status === 400 || result.status === 402);
}

/** What a withdrawal snapshot stands for in {@link OrderRefundStatus}. */
export function orderRefundStatus(withdrawal: OrderWithdrawalSnapshot): OrderRefundStatus {
  if (withdrawal.status === "completed") return withdrawal.action === "cancel_authorization" ? "canceled" : "completed";
  return withdrawal.status === "needs_manual" ? "needs_manual" : "approved";
}

/** Releases the authorization of goods withdrawn before dispatch. */
async function release(deps: OrderRefundDeps, withdrawal: OrderWithdrawalSnapshot, order: OrderSnapshot): Promise<StripeOutcome> {
  const done: StripeOutcome = { kind: "done", step: "authorization_canceled", data: {} };
  const canceled = await deps.stripe.cancelPaymentIntent(order.stripe_payment_intent_id, withdrawal.id);
  if (canceled.ok) {
    return asRecord(canceled.data)?.status === "canceled" ? done : { kind: "failed", code: "stripe_unexpected_state" };
  }
  if (!isRefusal(canceled)) return { kind: "failed", code: stripeFailure(canceled) };
  // Refused: done when the payment intent is canceled already (a repeated cancel, a lapsed authorization).
  const current = await deps.stripe.retrievePaymentIntent(order.stripe_payment_intent_id);
  if (!current.ok) return { kind: "failed", code: stripeFailure(current) };
  return asRecord(current.data)?.status === "canceled" ? done : { kind: "refused", code: stripeFailure(canceled) };
}

/** Refunds `refund_ore` of the captured payment of returned goods. */
async function refund(deps: OrderRefundDeps, withdrawal: OrderWithdrawalSnapshot, order: OrderSnapshot): Promise<StripeOutcome> {
  const refundOre = withdrawal.refund_ore;
  if (refundOre === null) return { kind: "refused", code: "no_refund_amount" };
  const listed = await deps.stripe.listPaymentIntentRefunds(order.stripe_payment_intent_id);
  if (!listed.ok) return { kind: "failed", code: stripeFailure(listed) };
  const existing = listed.data.find(
    (candidate) => candidate.metadata.order_withdrawal_id === withdrawal.id &&
      (candidate.status === "succeeded" || candidate.status === "pending"),
  );
  if (existing !== undefined) {
    return { kind: "done", step: "refunded", data: { refund_id: existing.id, refund_tax_ore: inclusiveVatOre(refundOre) } };
  }
  const result = await deps.stripe.createOrderRefund({
    paymentIntentId: order.stripe_payment_intent_id,
    amountOre: refundOre,
    withdrawalId: withdrawal.id,
    orderNumber: order.order_number,
  });
  if (!result.ok) return isRefusal(result) ? { kind: "refused", code: stripeFailure(result) } : { kind: "failed", code: stripeFailure(result) };
  const created = asRecord(result.data);
  if (created?.status === "failed" || created?.status === "canceled") return { kind: "refused", code: "stripe_refund_failed" };
  if (typeof created?.id !== "string" || !REFUND_ID_REGEX.test(created.id)) return { kind: "failed", code: "stripe_invalid_response" };
  return { kind: "done", step: "refunded", data: { refund_id: created.id, refund_tax_ore: inclusiveVatOre(refundOre) } };
}

/** One pass over an approved goods withdrawal (see the module comment above {@link OrderRefundDeps}). */
export async function processOrderRefund(deps: OrderRefundDeps, withdrawalId: string): Promise<OrderRefundStatus> {
  const log = (step: string, outcome: string, code: string | null = null) =>
    deps.log(JSON.stringify({ msg: LOG_MSG, withdrawal: withdrawalId, step, outcome, code }));

  const claim = await deps.rpc.claimOrderWithdrawal(withdrawalId, WITHDRAWAL_LEASE_SECONDS);
  log("claim", claim.claimed ? "claimed" : "busy");
  if (!claim.claimed) return orderRefundStatus(claim.withdrawal);
  const { order } = claim;
  let withdrawal = claim.withdrawal;

  const manual = async (reason: OrderManualReason, code: string): Promise<void> => {
    withdrawal = (await deps.rpc.orderWithdrawalStep(withdrawalId, "needs_manual", { reason })).withdrawal;
    log("needs_manual", reason, code);
    const alerted = withdrawal;
    const alert = await deliverWithdrawalMail(deps.rpc, withdrawalId, "manual_alert_sent", () =>
      deps.mail.sendManualAlert(order, alerted),
    );
    log("manual_alert", alert === "sent" ? "sent" : "failed", alert === "sent" ? null : alert);
  };

  try {
    const outcome = withdrawal.action === "cancel_authorization" ? await release(deps, withdrawal, order) : await refund(deps, withdrawal, order);
    if (outcome.kind === "done") {
      const stepped = await deps.rpc.orderWithdrawalStep(withdrawalId, outcome.step, outcome.data);
      withdrawal = stepped.withdrawal;
      log(outcome.step, stepped.outcome);
      const receipt = await deliverWithdrawalMail(deps.rpc, withdrawalId, "receipt_sent", () =>
        deps.mail.sendWithdrawalReceipt(order, withdrawal),
      );
      log("receipt", receipt === "sent" ? "sent" : "failed", receipt === "sent" ? null : receipt);
    } else if (outcome.kind === "refused") {
      await manual("stripe_refused", outcome.code);
    } else if (withdrawal.attempts >= WITHDRAWAL_MAX_ATTEMPTS) {
      // The sweep lists a withdrawal for at most WITHDRAWAL_MAX_ATTEMPTS passes: this was the last.
      await manual("retries_exhausted", outcome.code);
    } else {
      withdrawal = (await deps.rpc.orderWithdrawalStep(withdrawalId, "attempt_failed", { error: outcome.code })).withdrawal;
      log("attempt_failed", "applied", outcome.code);
    }
  } catch (error) {
    // A step failed (the database): release the lease for the next pass, best effort.
    const code = failureCode(error);
    log("step", "error", code);
    await deps.rpc.orderWithdrawalStep(withdrawalId, "attempt_failed", { error: code }).catch(() => undefined);
    return "approved";
  }
  return orderRefundStatus(withdrawal);
}
