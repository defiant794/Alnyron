import { WITHDRAWAL_LEASE_SECONDS, WITHDRAWAL_MAX_ATTEMPTS, WITHDRAWAL_MAX_MAIL_ATTEMPTS } from "@/config/payments";
import type { StripeResult } from "@/lib/payments/stripe";
import type { WithdrawalManualReason } from "@/lib/payments/withdrawal-emails";
import { WITHDRAWAL_CALC_VERSION, computeWithdrawalRefund } from "@/lib/payments/withdrawal-refund";
import { INV_ID_REGEX, asRecord, isDuplicateMarked, isUnixSeconds, unixToIso } from "@/lib/payments/webhook-mapping";
import type { Json } from "@/types/database";
import { MailError, type Mailer } from "./mail";
import { isDatabaseRefusal } from "./refusal";
import type { WithdrawalRpc, WithdrawalSnapshot, WithdrawalStep } from "./rpc";
import type { StripeApi, WithdrawalStripeApi } from "./stripe-api";

/**
 * One pass over a withdrawal (fortrydelse), shared by `WithdrawalService.withdraw`
 * (right after the notice is recorded) and the hourly sweep. Every rule of
 * the state machine is the database's (`payments_withdrawal_step`); this
 * drives Stripe and the emails between the steps:
 *
 * 1. Claim (a lease of WITHDRAWAL_LEASE_SECONDS): a withdrawal another pass
 *    holds (`busy`) or without work (`done`) is left as it is.
 * 2. After more than WITHDRAWAL_MAX_ATTEMPTS passes, one not yet completed
 *    goes to the owner (`needs_manual retries_exhausted`; from received
 *    without a further cancel attempt).
 * 3. Received: the subscription Stripe returns must be the stored one (same
 *    customer and start, no duplicate mark), else `needs_manual
 *    subscription_mismatch` without a cancel. Then cancel now (no
 *    proration); a refused cancel is done when Stripe shows it canceled.
 * 4. Canceled: the refund, automated only for one paid invoice of the plain
 *    shape (no balance, no credit note but this withdrawal's own, one
 *    subscription line of the whole amount, nothing else open), else
 *    `needs_manual invoice_shape`. Paid nothing: `no_refund_due`. The amount
 *    comes from `computeWithdrawalRefund` with the stored notice time; the
 *    credit note (with refund, VAT reversed on the line) is looked up by its
 *    `metadata.withdrawal_id` first and created only when there is none
 *    (Idempotency-Key `wd-cn-<id>`); the invoice's
 *    `post_payment_credit_notes_amount` must be exactly that note's amount (0
 *    before it exists). Stripe refusing it is `needs_manual stripe_refused`.
 * 5. The receipt once (`withdrawal-ack/<id>`), also while still in progress
 *    after a failure, then the owner alert once for needs_manual
 *    (`withdrawal-alert/<id>`). A send Resend answers as a replay of its key
 *    (an email went out under it before, with the body of an earlier state)
 *    is stamped as sent (`email_id` `idempotent_replay`, see the mailer).
 *
 * A failure a later pass may fix is recorded as `failed <code>` (a code,
 * never free text; the lease is released) and the pass goes on to the
 * emails. The sweep lists a withdrawal whose only work left is an email
 * while it has had fewer than WITHDRAWAL_MAX_MAIL_ATTEMPTS passes
 * (`payments_pending_work`), so the pass that reaches that many and leaves
 * an email unsent logs `mail given_up retries_exhausted`: the sweep retries
 * it no more.
 * Every step logs one JSON line `{msg: "payments withdrawal", withdrawal,
 * step, outcome, code}` with ids and codes only: never the name, an email, a
 * token or free text. Returns the withdrawal as last recorded. Throws only
 * when the claim itself fails.
 *
 * Subrequests: the claim 1; the Stripe part: retrieve, cancel, re-retrieve
 * after a refused cancel, the canceled step, invoices, credit notes, create,
 * and the refunded or needs_manual step (8), or at most 9 when it ends in a
 * `failed` step, which records no reason, so no alert follows; the receipt's
 * send and step, + a `failed` step when one fails (3); the alert's the same
 * (3). At most 1 + 8 + 3 + 3 = 15 (WITHDRAWAL_PASS_MAX_SUBREQUESTS).
 */
export type WithdrawalDeps = {
  stripe: Pick<StripeApi, "retrieveSubscription"> & WithdrawalStripeApi;
  rpc: Pick<WithdrawalRpc, "paymentsClaimWithdrawal" | "paymentsWithdrawalStep">;
  mail: Pick<Mailer, "sendReceiptEmail" | "sendOwnerAlertEmail">;
  /** The current time in milliseconds (`Date.now`). */
  now: () => number;
  /** Writes one log line. */
  log: (line: string) => void;
};

const LOG_MSG = "payments withdrawal";

/** A credit note id. */
const CREDIT_NOTE_ID_REGEX = /^cn_[A-Za-z0-9]+$/;

/** A refund id. */
const REFUND_ID_REGEX = /^re_[A-Za-z0-9]+$/;

/** An invoice line item id. */
const LINE_ID_REGEX = /^il_[A-Za-z0-9]+$/;

/** A step the database refused for good, or the pass decided to end with. */
class StepFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "StepFailure";
  }
}

/** The `failed` code of a failed Stripe call: a 4xx but 429 is a refusal, anything else unavailable. */
function stripeFailureCode(result: Exclude<StripeResult<unknown>, { ok: true }>): string {
  return result.kind === "http" && result.status >= 400 && result.status < 500 && result.status !== 429
    ? "stripe_refused"
    : "stripe_unavailable";
}

/** The `failed` code of a failure: the pass's own or a mail failure's code, else `rpc_failed` (the database or Auth). */
function failureCode(error: unknown): string {
  return error instanceof StepFailure || error instanceof MailError ? error.code : "rpc_failed";
}

/**
 * The plain-shape invoice a withdrawal refunds automatically. `creditedOre` is
 * Stripe's `post_payment_credit_notes_amount`: 0, or this withdrawal's own
 * credit note from an earlier pass (refund() checks which).
 */
type PaidInvoice = {
  invoiceId: string;
  lineId: string;
  paidOre: number;
  creditedOre: number;
  periodStart: number;
  periodEnd: number;
};

/**
 * What the subscription's invoices allow: `none` (nothing paid, nothing
 * open), `one` (exactly one paid invoice of the plain shape, nothing else
 * open), else `manual`.
 */
function invoiceShape(list: unknown): { kind: "none" } | { kind: "manual" } | ({ kind: "one" } & PaidInvoice) {
  const page = asRecord(list);
  const invoices = Array.isArray(page?.data) ? page.data.map(asRecord) : null;
  if (page?.has_more !== false || invoices === null || invoices.some((invoice) => invoice === null)) {
    return { kind: "manual" };
  }
  const paid = invoices.filter((invoice) => typeof invoice?.amount_paid !== "number" || invoice.amount_paid > 0);
  const open = invoices.filter((invoice) => invoice?.status === "open");
  if (paid.length === 0) return open.length === 0 ? { kind: "none" } : { kind: "manual" };
  const invoice = paid[0];
  if (paid.length !== 1 || invoice === undefined || invoice === null || open.some((other) => other !== invoice)) {
    return { kind: "manual" };
  }
  const amount = invoice.amount_paid;
  const lines = asRecord(invoice.lines)?.data;
  const subscriptionLines = (Array.isArray(lines) ? lines.map(asRecord) : []).filter(
    (line) => asRecord(line?.parent)?.type === "subscription_item_details",
  );
  const line = subscriptionLines[0];
  const period = asRecord(line?.period);
  const credited = invoice.post_payment_credit_notes_amount;
  if (
    typeof invoice.id !== "string" ||
    !INV_ID_REGEX.test(invoice.id) ||
    typeof amount !== "number" ||
    !Number.isSafeInteger(amount) ||
    invoice.status !== "paid" ||
    invoice.starting_balance !== 0 ||
    typeof credited !== "number" ||
    !Number.isSafeInteger(credited) ||
    credited < 0 ||
    invoice.total !== amount ||
    subscriptionLines.length !== 1 ||
    typeof line?.id !== "string" ||
    !LINE_ID_REGEX.test(line.id) ||
    line.amount !== amount ||
    !isUnixSeconds(period?.start) ||
    !isUnixSeconds(period?.end) ||
    period.end <= period.start
  ) {
    return { kind: "manual" };
  }
  return {
    kind: "one",
    invoiceId: invoice.id,
    lineId: line.id,
    paidOre: amount,
    creditedOre: credited,
    periodStart: period.start * 1000,
    periodEnd: period.end * 1000,
  };
}

/** A credit note's VAT and refund for the `refunded` step, or null unless it is the withdrawal's whole refund. */
function creditNoteRefund(note: unknown, refundOre: number): { id: string; taxOre: number; refundId: string } | null {
  const record = asRecord(note);
  const taxes = record?.total_taxes;
  const refundId = asRecord(Array.isArray(record?.refunds) ? record.refunds[0] : null)?.refund;
  if (
    typeof record?.id !== "string" ||
    !CREDIT_NOTE_ID_REGEX.test(record.id) ||
    record.amount !== refundOre ||
    !Array.isArray(taxes) ||
    typeof refundId !== "string" ||
    !REFUND_ID_REGEX.test(refundId)
  ) {
    return null;
  }
  let taxOre = 0;
  for (const tax of taxes) {
    const amount = asRecord(tax)?.amount;
    if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) return null;
    taxOre += amount;
  }
  return taxOre <= refundOre ? { id: record.id, taxOre, refundId } : null;
}

/** See the module comment. */
export async function processWithdrawal(deps: WithdrawalDeps, withdrawalId: string): Promise<WithdrawalSnapshot> {
  const log = (step: string, outcome: string, code: string | null = null) =>
    deps.log(JSON.stringify({ msg: LOG_MSG, withdrawal: withdrawalId, step, outcome, code }));

  const claim = await deps.rpc.paymentsClaimWithdrawal(withdrawalId, WITHDRAWAL_LEASE_SECONDS);
  log("claim", claim.outcome);
  if (claim.outcome !== "claimed") return claim.withdrawal;

  // The withdrawal as last recorded (every step answers the new snapshot), read through
  // current(): the steps run in closures, so no check of it may be narrowed across a call.
  let withdrawal = claim.withdrawal;
  const current = (): WithdrawalSnapshot => withdrawal;
  // The reason the owner is alerted with: the stored one, or the one this pass records.
  let manualReason: WithdrawalManualReason | null =
    withdrawal.status === "needs_manual" ? withdrawal.manual_reason : null;

  const step = async (name: WithdrawalStep, data: Record<string, Json>): Promise<void> => {
    const answer = await deps.rpc.paymentsWithdrawalStep(withdrawalId, name, data);
    withdrawal = answer.withdrawal;
    log(name, answer.outcome, name === "failed" || name === "needs_manual" ? String(data.code ?? data.reason) : null);
  };
  const needsManual = async (reason: WithdrawalManualReason): Promise<void> => {
    await step("needs_manual", { reason });
    manualReason = reason;
  };
  const failed = async (code: string): Promise<void> => {
    try {
      await step("failed", { code });
    } catch {
      log("failed", "error", code);
    }
  };

  // Stripe and the refund: a failure a later pass may fix ends this part as `failed <code>`.
  try {
    const claimed = current();
    if ((claimed.status === "received" || claimed.status === "canceled") && claimed.attempts > WITHDRAWAL_MAX_ATTEMPTS) {
      await needsManual("retries_exhausted");
    } else {
      if (claimed.status === "received") await cancel(deps, claimed, step, needsManual);
      const afterCancel = current();
      if (afterCancel.status === "canceled") await refund(deps, afterCancel, step, needsManual);
    }
  } catch (error) {
    await failed(failureCode(error));
  }

  // The receipt (§ 20 a), once: also while the withdrawal is still in progress.
  if (current().ack_sent_at === null) {
    try {
      const sent = await deps.mail.sendReceiptEmail({
        withdrawal: current(),
        idempotencyKey: `withdrawal-ack/${withdrawalId}`,
      });
      await step("ack_sent", { email_id: sent.id });
    } catch (error) {
      await failed(failureCode(error));
    }
  }

  // The owner alert, once, for a withdrawal that needs manual handling.
  const reason = manualReason;
  if (reason !== null && current().alerted_at === null) {
    try {
      await deps.mail.sendOwnerAlertEmail({
        withdrawal: current(),
        reason,
        idempotencyKey: `withdrawal-alert/${withdrawalId}`,
      });
      await step("alerted", {});
    } catch (error) {
      await failed(failureCode(error));
    }
  }

  // Past the sweep's mail attempts, an email left unsent is not retried (payments_pending_work).
  const last = current();
  if (
    last.attempts >= WITHDRAWAL_MAX_MAIL_ATTEMPTS &&
    last.status !== "received" &&
    last.status !== "canceled" &&
    (last.ack_sent_at === null || (last.status === "needs_manual" && last.alerted_at === null))
  ) {
    log("mail", "given_up", "retries_exhausted");
  }
  return last;
}

type Step = (name: WithdrawalStep, data: Record<string, Json>) => Promise<void>;
type NeedsManual = (reason: WithdrawalManualReason) => Promise<void>;

/** The Stripe instant `seconds` as ISO text, else now. */
function instantOrNow(seconds: unknown, deps: WithdrawalDeps): string {
  return isUnixSeconds(seconds) ? unixToIso(seconds) : new Date(deps.now()).toISOString();
}

/** Step 3 (received): cross-check the subscription, then cancel it now. */
async function cancel(deps: WithdrawalDeps, withdrawal: WithdrawalSnapshot, step: Step, needsManual: NeedsManual) {
  const subscriptionId = withdrawal.stripe_subscription_id;
  const retrieved = await deps.stripe.retrieveSubscription(subscriptionId);
  if (!retrieved.ok) {
    if (retrieved.kind === "http" && retrieved.status === 404) return needsManual("subscription_mismatch");
    throw new StepFailure(stripeFailureCode(retrieved));
  }
  const subscription = asRecord(retrieved.data);
  const customer =
    typeof subscription?.customer === "string" ? subscription.customer : asRecord(subscription?.customer)?.id;
  const startedAt = withdrawal.subscription.started_at;
  if (
    subscription?.id !== subscriptionId ||
    customer !== withdrawal.subscription.stripe_customer_id ||
    startedAt === null ||
    subscription.start_date !== Math.floor(Date.parse(startedAt) / 1000) ||
    isDuplicateMarked(subscription)
  ) {
    return needsManual("subscription_mismatch");
  }
  if (subscription.status === "canceled") return step("canceled", { canceled_at: instantOrNow(subscription.canceled_at, deps) });

  const canceled = await deps.stripe.cancelSubscriptionForWithdrawal(subscriptionId);
  if (canceled.ok) return step("canceled", { canceled_at: instantOrNow(asRecord(canceled.data)?.canceled_at, deps) });
  if (stripeFailureCode(canceled) !== "stripe_refused") throw new StepFailure("stripe_unavailable");
  // Refused (e.g. canceled meanwhile): done when Stripe now shows it canceled.
  const again = await deps.stripe.retrieveSubscription(subscriptionId);
  if (!again.ok) throw new StepFailure("stripe_unavailable");
  const now = asRecord(again.data);
  if (now?.status !== "canceled") throw new StepFailure("cancel_failed");
  return step("canceled", { canceled_at: instantOrNow(now.canceled_at, deps) });
}

/** Step 4 (canceled): refund the unused part of the one paid invoice with a credit note. */
async function refund(deps: WithdrawalDeps, withdrawal: WithdrawalSnapshot, step: Step, needsManual: NeedsManual) {
  const subscriptionId = withdrawal.stripe_subscription_id;
  const listed = await deps.stripe.listSubscriptionInvoices(subscriptionId);
  if (!listed.ok) throw new StepFailure(stripeFailureCode(listed));
  const shape = invoiceShape(listed.data);
  if (shape.kind === "manual") return needsManual("invoice_shape");
  if (shape.kind === "none") {
    return step("no_refund_due", { stripe_invoice_id: null, paid_ore: 0, calc_version: WITHDRAWAL_CALC_VERSION });
  }

  const amounts = computeWithdrawalRefund({
    paidOre: shape.paidOre,
    periodStart: shape.periodStart,
    periodEnd: shape.periodEnd,
    requestedAt: Date.parse(withdrawal.requested_at),
    basis: withdrawal.retention_basis ?? "no_consent",
  });
  if (amounts.refundOre === 0) {
    if (shape.creditedOre !== 0) return needsManual("invoice_shape");
    return step("no_refund_due", {
      stripe_invoice_id: shape.invoiceId,
      paid_ore: amounts.paidOre,
      calc_version: WITHDRAWAL_CALC_VERSION,
    });
  }

  // A credit note made by an earlier pass (also past Stripe's 24 h idempotency window, per
  // Stripe's docs as of 2026-11) is reused.
  // Stripe counts it in the invoice's post_payment_credit_notes_amount, so that amount must be
  // exactly this withdrawal's own note (0 without one): any other credit is for the owner.
  const notes = await deps.stripe.listInvoiceCreditNotes(shape.invoiceId);
  if (!notes.ok) throw new StepFailure(stripeFailureCode(notes));
  const list = asRecord(notes.data)?.data;
  let note: unknown = (Array.isArray(list) ? list : []).find(
    (candidate) => asRecord(asRecord(candidate)?.metadata)?.withdrawal_id === withdrawal.id,
  );
  if (shape.creditedOre !== (note === undefined ? 0 : asRecord(note)?.amount)) return needsManual("invoice_shape");
  if (note === undefined) {
    const created = await deps.stripe.createWithdrawalCreditNote({
      withdrawalId: withdrawal.id,
      subscriptionId,
      invoiceId: shape.invoiceId,
      lineId: shape.lineId,
      refundOre: amounts.refundOre,
      locale: withdrawal.locale,
    });
    if (!created.ok) {
      const code = stripeFailureCode(created);
      if (code === "stripe_refused") return needsManual("stripe_refused");
      throw new StepFailure(code);
    }
    note = created.data;
  }
  const credited = creditNoteRefund(note, amounts.refundOre);
  if (credited === null) return needsManual("stripe_refused");

  try {
    await step("refunded", {
      stripe_invoice_id: shape.invoiceId,
      service_start_at: new Date(shape.periodStart).toISOString(),
      period_end_at: new Date(shape.periodEnd).toISOString(),
      paid_ore: amounts.paidOre,
      retained_ore: amounts.retainedOre,
      refund_ore: amounts.refundOre,
      refund_tax_ore: credited.taxOre,
      calc_version: WITHDRAWAL_CALC_VERSION,
      stripe_credit_note_id: credited.id,
      stripe_refund_id: credited.refundId,
    });
  } catch (error) {
    if (isDatabaseRefusal(error, "invoice_not_recorded")) throw new StepFailure("invoice_not_recorded");
    throw error;
  }
}
