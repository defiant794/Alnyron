import { stripeRequest, type StripeResult } from "@/lib/payments/stripe";
import { DUPLICATE_MARK_KEY, INV_ID_REGEX, PI_ID_REGEX, SUB_ID_REGEX } from "@/lib/payments/webhook-mapping";

/**
 * The Stripe calls the webhook Worker makes, over `stripeRequest` (REST,
 * `Stripe-Version` pinned, every request aborted after
 * STRIPE_REQUEST_TIMEOUT_MS, never throws). Each id is checked against its
 * id pattern (`webhook-mapping.ts`), and a refund's amount to be a positive
 * whole number, before it goes into a path, query or body: a bad one is an
 * `invalid_response` without any request. This is a backstop; the handler
 * rejects or skips a malformed one before calling here. The two POSTs carry
 * an Idempotency-Key derived from what they act on (the duplicate mark from
 * the subscription, the refund from the payment it refunds), so a retried
 * delivery gets the first request's result instead of a second effect. The
 * cancel carries none: Stripe ignores Idempotency-Key on DELETE requests (per
 * its idempotent-requests docs). If Stripe refuses a repeated cancel with a
 * 4xx, the handler then checks that Stripe shows the subscription canceled.
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

/** At most this many payments per invoice are listed (Stripe's maximum page size). */
const INVOICE_PAYMENTS_LIMIT = 100;

const INVALID_INPUT: StripeResult<unknown> = { ok: false, kind: "invalid_response" };

/** {@link StripeApi} with `apiKey`; `fetchImpl` stands in for the global fetch in tests. */
export function createStripeApi(apiKey: string, fetchImpl?: typeof fetch): StripeApi {
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
  };
}
