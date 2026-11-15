import type { GoodsCheckoutParams } from "@/lib/payments/orders/checkout-params";
import { createCheckoutSession, stripeRequest, type CheckoutSession, type StripeResult } from "@/lib/payments/stripe";
import { asRecord, PI_ID_REGEX } from "@/lib/payments/webhook-mapping";

/**
 * The Stripe calls of goods orders (slice S2), over the shared REST transport
 * (`stripeRequest`: `Stripe-Version` pinned, aborted after
 * STRIPE_REQUEST_TIMEOUT_MS, never throws) with STRIPE_PAYMENTS_KEY. Every id
 * goes into a path or body only after it matched its pattern (a payment intent
 * `pi_…`, an order or withdrawal the database's uuid) and an amount only as a
 * positive whole number of øre: a bad one is an `invalid_response` without any
 * request. The money-moving POSTs carry an Idempotency-Key derived from what
 * they act on: `ord-cap-<order id>` (capture at "Markér afsendt"),
 * `ord-cancel-<withdrawal id>` (release before dispatch) and
 * `ord-re-<withdrawal id>` (refund of returned goods). Refunds are also looked
 * up by withdrawal metadata, since Stripe may discard an Idempotency-Key after 24 hours.
 * Charge on dispatch (amendment A1): no invoice or credit-note calls.
 */
export type OrderStripeApi = {
  /**
   * `POST /v1/checkout/sessions` with the goods parameters (no Idempotency-Key: each Buy is a new
   * session). A session whose id is not `cs_…` or whose url is not on checkout.stripe.com is an
   * `invalid_response`.
   */
  createGoodsCheckoutSession(params: GoodsCheckoutParams): Promise<StripeResult<CheckoutSession>>;
  /** `GET /v1/payment_intents/{id}?expand[]=latest_charge`: its status and the card's `capture_before`. */
  retrievePaymentIntent(paymentIntentId: string): Promise<StripeResult<unknown>>;
  /** `POST /v1/payment_intents/{id}/capture` (the whole authorized amount), Idempotency-Key `ord-cap-<order id>`. */
  capturePaymentIntent(paymentIntentId: string, orderId: string): Promise<StripeResult<unknown>>;
  /**
   * `POST /v1/payment_intents/{id}/cancel` with `cancellation_reason=requested_by_customer`
   * (releases the authorization), Idempotency-Key `ord-cancel-<withdrawal id>`.
   */
  cancelPaymentIntent(paymentIntentId: string, withdrawalId: string): Promise<StripeResult<unknown>>;
  /**
   * `GET /v1/refunds?payment_intent=<id>&limit=100`: validated refund ids, statuses and
   * string-valued metadata. A malformed or incomplete list is `invalid_response`, never empty.
   */
  listPaymentIntentRefunds(paymentIntentId: string): Promise<StripeResult<OrderRefund[]>>;
  /**
   * `POST /v1/refunds` of `amountOre` of the payment intent with
   * `metadata[order_withdrawal_id]` and `metadata[order_number]`, Idempotency-Key
   * `ord-re-<withdrawal id>`.
   */
  createOrderRefund(input: OrderRefundInput): Promise<StripeResult<unknown>>;
};

export type OrderRefundInput = {
  paymentIntentId: string;
  amountOre: number;
  withdrawalId: string;
  orderNumber: number;
};

/** The refund fields needed to reconcile an approved withdrawal before moving money again. */
export type OrderRefund = {
  id: string;
  status: "succeeded" | "pending" | "requires_action" | "failed" | "canceled";
  metadata: Record<string, string>;
};

/** An order or withdrawal id (the database's uuid, as Postgres writes it). */
const ORDER_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A Stripe refund id, shared by list parsing and refund creation responses. */
export const REFUND_ID_REGEX = /^re_[A-Za-z0-9]+$/;

const INVALID_INPUT: StripeResult<never> = { ok: false, kind: "invalid_response" };

/** Every list entry must be valid: dropping a malformed refund could hide an existing payout. */
function isOrderRefund(value: unknown): value is OrderRefund {
  const refund = asRecord(value);
  const metadata = asRecord(refund?.metadata);
  return (
    typeof refund?.id === "string" &&
    REFUND_ID_REGEX.test(refund.id) &&
    (refund.status === "succeeded" || refund.status === "pending" || refund.status === "requires_action" ||
      refund.status === "failed" || refund.status === "canceled") &&
    metadata !== null &&
    Object.values(metadata).every((entry) => typeof entry === "string")
  );
}

/** {@link OrderStripeApi} with `apiKey`; `fetchImpl` stands in for the global fetch (the sweep's counter, tests). */
export function createOrderStripeApi(apiKey: string, fetchImpl?: typeof fetch): OrderStripeApi {
  return {
    createGoodsCheckoutSession(params) {
      return createCheckoutSession(apiKey, params, fetchImpl);
    },

    async retrievePaymentIntent(paymentIntentId) {
      if (!PI_ID_REGEX.test(paymentIntentId)) return INVALID_INPUT;
      return stripeRequest(
        apiKey,
        "GET",
        `/payment_intents/${paymentIntentId}`,
        { expand: ["latest_charge"] },
        undefined,
        fetchImpl,
      );
    },

    async capturePaymentIntent(paymentIntentId, orderId) {
      if (!PI_ID_REGEX.test(paymentIntentId) || !ORDER_UUID_REGEX.test(orderId)) return INVALID_INPUT;
      return stripeRequest(
        apiKey,
        "POST",
        `/payment_intents/${paymentIntentId}/capture`,
        undefined,
        `ord-cap-${orderId}`,
        fetchImpl,
      );
    },

    async cancelPaymentIntent(paymentIntentId, withdrawalId) {
      if (!PI_ID_REGEX.test(paymentIntentId) || !ORDER_UUID_REGEX.test(withdrawalId)) return INVALID_INPUT;
      return stripeRequest(
        apiKey,
        "POST",
        `/payment_intents/${paymentIntentId}/cancel`,
        { cancellation_reason: "requested_by_customer" },
        `ord-cancel-${withdrawalId}`,
        fetchImpl,
      );
    },

    async listPaymentIntentRefunds(paymentIntentId) {
      if (!PI_ID_REGEX.test(paymentIntentId)) return INVALID_INPUT;
      const result = await stripeRequest<unknown>(
        apiKey,
        "GET",
        "/refunds",
        { payment_intent: paymentIntentId, limit: 100 },
        undefined,
        fetchImpl,
      );
      if (!result.ok) return result;
      const list = asRecord(result.data);
      // A truncated page cannot rule out an existing refund; fail closed within the pass's budget.
      if (list?.object !== "list" || list.has_more !== false || !Array.isArray(list.data) || !list.data.every(isOrderRefund)) {
        return { ok: false, kind: "invalid_response" };
      }
      return { ok: true, data: list.data };
    },

    async createOrderRefund({ paymentIntentId, amountOre, withdrawalId, orderNumber }) {
      if (
        !PI_ID_REGEX.test(paymentIntentId) ||
        !ORDER_UUID_REGEX.test(withdrawalId) ||
        !Number.isSafeInteger(amountOre) ||
        amountOre <= 0 ||
        !Number.isSafeInteger(orderNumber) ||
        orderNumber <= 0
      ) {
        return INVALID_INPUT;
      }
      return stripeRequest(
        apiKey,
        "POST",
        "/refunds",
        {
          payment_intent: paymentIntentId,
          amount: amountOre,
          metadata: { order_withdrawal_id: withdrawalId, order_number: String(orderNumber) },
        },
        `ord-re-${withdrawalId}`,
        fetchImpl,
      );
    },
  };
}
