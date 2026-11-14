import type { Locale } from "next-intl";
import { stripeRequest, type StripeResult } from "@/lib/payments/stripe";
import { DUPLICATE_MARK_KEY, INV_ID_REGEX, PI_ID_REGEX, SUB_ID_REGEX } from "@/lib/payments/webhook-mapping";

/**
 * The Stripe calls the payments Worker makes (the webhook's duplicate rule
 * and the withdrawal flow), over `stripeRequest` (REST, `Stripe-Version`
 * pinned, every request aborted after STRIPE_REQUEST_TIMEOUT_MS, never
 * throws). Each id is checked against its id pattern (`webhook-mapping.ts`,
 * and the withdrawal and line ids below), and an amount to be a positive
 * whole number, before it goes into a path, query or body: a bad one is an
 * `invalid_response` without any request. This is a backstop; the callers
 * reject or skip a malformed one before calling here. The POSTs carry an
 * Idempotency-Key derived from what they act on (the duplicate mark from the
 * subscription, the refund from the payment it refunds, a withdrawal's credit
 * note from the withdrawal), so a retry gets the first request's result
 * instead of a second effect. The cancels carry none: Stripe ignores
 * Idempotency-Key on DELETE requests (per its idempotent-requests docs). If
 * Stripe refuses a repeated cancel with a 4xx, the caller then checks that
 * Stripe shows the subscription canceled.
 */
export type StripeApi = {
  /** `GET /v1/subscriptions/{id}`: the subscription's current state. */
  retrieveSubscription(id: string): Promise<StripeResult<unknown>>;
  /**
   * `POST /v1/subscriptions/{id}` with only `metadata[duplicate_subscription]=true`
   * (Stripe keeps the other metadata keys), Idempotency-Key `dup-mark-<id>`.
   */
  markDuplicateSubscription(id: string): Promise<StripeResult<unknown>>;
  /** `DELETE /v1/subscriptions/{id}` (cancel now), without Idempotency-Key. */
  cancelSubscription(id: string): Promise<StripeResult<unknown>>;
  /** `GET /v1/invoice_payments?invoice=<id>`: the invoice's payments. */
  listInvoicePayments(invoiceId: string): Promise<StripeResult<unknown>>;
  /** `POST /v1/refunds` of `amount` (øre) of a payment as a duplicate, Idempotency-Key `dup-refund-<pi>`. */
  createRefund(paymentIntentId: string, subscriptionId: string, amount: number): Promise<StripeResult<unknown>>;
};

/** The withdrawal flow's Stripe calls (besides {@link StripeApi.retrieveSubscription}). */
export type WithdrawalStripeApi = {
  /**
   * Withdrawal: `DELETE /v1/subscriptions/{id}` with `prorate=false` and
   * `cancellation_details[comment]=withdrawal` (cancel now, no proration credit), without
   * Idempotency-Key.
   */
  cancelSubscriptionForWithdrawal(id: string): Promise<StripeResult<unknown>>;
  /** `GET /v1/invoices?subscription=<id>&limit=10`: the subscription's invoices, newest first. */
  listSubscriptionInvoices(subscriptionId: string): Promise<StripeResult<unknown>>;
  /** `GET /v1/credit_notes?invoice=<id>`: the invoice's credit notes (a withdrawal's is found by its metadata). */
  listInvoiceCreditNotes(invoiceId: string): Promise<StripeResult<unknown>>;
  /**
   * `POST /v1/credit_notes`: a credit note with refund for a withdrawal, on the invoice's one
   * subscription line (`lines[0][type]=invoice_line_item`, `lines[0][amount]`, so the VAT is
   * reversed) with `refund_amount` = the same øre, `reason=order_change`, the memo in the
   * withdrawal's language and `metadata[withdrawal_id]`/`metadata[subscription]`;
   * Idempotency-Key `wd-cn-<withdrawal id>`.
   */
  createWithdrawalCreditNote(input: WithdrawalCreditNoteInput): Promise<StripeResult<unknown>>;
};

/** What a withdrawal's credit note is made of; every id is checked before the request. */
export type WithdrawalCreditNoteInput = {
  withdrawalId: string;
  subscriptionId: string;
  invoiceId: string;
  lineId: string;
  refundOre: number;
  locale: Locale;
};

/** At most this many payments per invoice are listed (Stripe's maximum page size). */
const INVOICE_PAYMENTS_LIMIT = 100;

/** A withdrawal's invoices are listed up to this many (`has_more` beyond: handled by hand). */
const SUBSCRIPTION_INVOICES_LIMIT = 10;

/** An invoice's credit notes are listed up to this many when one of a withdrawal is looked for. */
const CREDIT_NOTES_LIMIT = 100;

/** A withdrawal id (the database's uuid, as Postgres writes it). */
const WITHDRAWAL_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** An invoice line item id. */
const LINE_ID_REGEX = /^il_[A-Za-z0-9]+$/;

/** The credit note's memo, shown on the customer's credit note (kreditnota), in the withdrawal's language. */
const CREDIT_NOTE_MEMO: Record<Locale, string> = {
  da: "Fortrydelse af Monitor-abonnement",
  en: "Withdrawal from Monitor subscription",
};

const INVALID_INPUT: StripeResult<unknown> = { ok: false, kind: "invalid_response" };

/** {@link StripeApi} and {@link WithdrawalStripeApi} with `apiKey`; `fetchImpl` stands in for the global fetch in tests. */
export function createStripeApi(apiKey: string, fetchImpl?: typeof fetch): StripeApi & WithdrawalStripeApi {
  return {
    async retrieveSubscription(id) {
      if (!SUB_ID_REGEX.test(id)) return INVALID_INPUT;
      return stripeRequest(apiKey, "GET", `/subscriptions/${id}`, undefined, undefined, fetchImpl);
    },

    async markDuplicateSubscription(id) {
      if (!SUB_ID_REGEX.test(id)) return INVALID_INPUT;
      return stripeRequest(
        apiKey,
        "POST",
        `/subscriptions/${id}`,
        { metadata: { [DUPLICATE_MARK_KEY]: "true" } },
        `dup-mark-${id}`,
        fetchImpl,
      );
    },

    async cancelSubscription(id) {
      if (!SUB_ID_REGEX.test(id)) return INVALID_INPUT;
      return stripeRequest(
        apiKey,
        "DELETE",
        `/subscriptions/${id}`,
        { cancellation_details: { comment: "duplicate_subscription" } },
        undefined,
        fetchImpl,
      );
    },

    async listInvoicePayments(invoiceId) {
      if (!INV_ID_REGEX.test(invoiceId)) return INVALID_INPUT;
      return stripeRequest(
        apiKey,
        "GET",
        "/invoice_payments",
        { invoice: invoiceId, limit: INVOICE_PAYMENTS_LIMIT },
        undefined,
        fetchImpl,
      );
    },

    async createRefund(paymentIntentId, subscriptionId, amount) {
      if (
        !PI_ID_REGEX.test(paymentIntentId) ||
        !SUB_ID_REGEX.test(subscriptionId) ||
        !Number.isSafeInteger(amount) ||
        amount <= 0
      ) {
        return INVALID_INPUT;
      }
      return stripeRequest(
        apiKey,
        "POST",
        "/refunds",
        {
          payment_intent: paymentIntentId,
          amount,
          reason: "duplicate",
          metadata: { reason: "duplicate_subscription", subscription: subscriptionId },
        },
        `dup-refund-${paymentIntentId}`,
        fetchImpl,
      );
    },

    async cancelSubscriptionForWithdrawal(id) {
      if (!SUB_ID_REGEX.test(id)) return INVALID_INPUT;
      return stripeRequest(
        apiKey,
        "DELETE",
        `/subscriptions/${id}`,
        { prorate: false, cancellation_details: { comment: "withdrawal" } },
        undefined,
        fetchImpl,
      );
    },

    async listSubscriptionInvoices(subscriptionId) {
      if (!SUB_ID_REGEX.test(subscriptionId)) return INVALID_INPUT;
      return stripeRequest(
        apiKey,
        "GET",
        "/invoices",
        { subscription: subscriptionId, limit: SUBSCRIPTION_INVOICES_LIMIT },
        undefined,
        fetchImpl,
      );
    },

    async listInvoiceCreditNotes(invoiceId) {
      if (!INV_ID_REGEX.test(invoiceId)) return INVALID_INPUT;
      return stripeRequest(
        apiKey,
        "GET",
        "/credit_notes",
        { invoice: invoiceId, limit: CREDIT_NOTES_LIMIT },
        undefined,
        fetchImpl,
      );
    },

    async createWithdrawalCreditNote({ withdrawalId, subscriptionId, invoiceId, lineId, refundOre, locale }) {
      if (
        !WITHDRAWAL_ID_REGEX.test(withdrawalId) ||
        !SUB_ID_REGEX.test(subscriptionId) ||
        !INV_ID_REGEX.test(invoiceId) ||
        !LINE_ID_REGEX.test(lineId) ||
        !Number.isSafeInteger(refundOre) ||
        refundOre <= 0
      ) {
        return INVALID_INPUT;
      }
      return stripeRequest(
        apiKey,
        "POST",
        "/credit_notes",
        {
          invoice: invoiceId,
          lines: [{ type: "invoice_line_item", invoice_line_item: lineId, amount: refundOre }],
          refund_amount: refundOre,
          reason: "order_change",
          memo: CREDIT_NOTE_MEMO[locale],
          metadata: { withdrawal_id: withdrawalId, subscription: subscriptionId },
        },
        `wd-cn-${withdrawalId}`,
        fetchImpl,
      );
    },
  };
}
