import * as z from "zod/mini";
import { GOODS_TEXT_VERSION } from "@/config/legal/goods-texts";
import { ORDER_GOODS_STATES } from "@/config/payments";
import { parseConsumerName } from "@/lib/payments/withdrawal-contract";

/**
 * The contract between the web app and the payments Worker's `OrderService`
 * (a Cloudflare service binding RPC, `ORDERS`): what the web sends to each of
 * its four methods and what the Worker answers. Both sides parse what they
 * receive with {@link parseOrderServiceInput} / {@link parseOrderServiceResult};
 * the web treats an unparsable answer as `unavailable`. The web never sends a
 * user id: the Worker takes the user only from Supabase Auth's answer for the
 * access token.
 *
 * `zod/mini` keeps the Worker bundle small (see workers/payments/env.ts).
 */

/** Why the Worker refused or could not do a call. */
export const ORDER_SERVICE_ERRORS = [
  "invalid_input",
  "not_purchasable",
  "unauthenticated",
  "forbidden",
  "not_found",
  "refused",
  "conflict",
  "unavailable",
] as const;

export type OrderServiceError = (typeof ORDER_SERVICE_ERRORS)[number];

/**
 * The `subreason` of a `conflict` per method, for the admin's message:
 * - markShipped: `order_closed` (refunded or canceled), `withdrawal_pending`
 *   (never ship withdrawn goods), `authorization_expired` (Stripe refused the
 *   capture: the authorization is gone and the order is now canceled; do not
 *   send the goods, contact the buyer), `capture_refused` (Stripe refused the
 *   capture for another reason, e.g. a decline: the order stays reserved and is
 *   not marked shipped; do not send the goods, the owner was alerted).
 * - approveRefund: `order_refunded`, `order_shipped` (not_shipped for a
 *   shipped order), `order_not_shipped` (returned for an unshipped order).
 */
export const ORDER_SERVICE_CONFLICTS = {
  markShipped: ["order_closed", "withdrawal_pending", "authorization_expired", "capture_refused"],
  approveRefund: ["order_refunded", "order_shipped", "order_not_shipped"],
} as const;

/** The most UTF-16 code units an access token may have. */
const ACCESS_TOKEN_MAX = 4096;

const id = z.guid();
const locale = z.enum(["da", "en"]);
const accessToken = z.string().check(
  z.minLength(1),
  z.maxLength(ACCESS_TOKEN_MAX),
  z.refine((value) => !/\s/.test(value)),
);
const consumerName = z.string().check(z.refine((value) => parseConsumerName(value) !== null));
/** The statement shown must be the current goods text version. */
const statementVersion = z.literal(GOODS_TEXT_VERSION);

const inputSchemas = {
  /** Start a Checkout for an item's active physical offer; a valid access token makes it an account purchase. */
  startCheckout: z.strictObject({ itemId: id, locale, accessToken: z.optional(accessToken) }),
  /** A withdrawal notice: by the personal link (order id + token) or by order number + the order's email. */
  withdraw: z.discriminatedUnion("channel", [
    z.strictObject({
      channel: z.literal("link"),
      orderId: id,
      token: z.string().check(z.minLength(1), z.maxLength(128)),
      consumerName,
      statementVersion,
      locale,
    }),
    z.strictObject({
      channel: z.literal("form"),
      orderNumber: z.int().check(z.positive(), z.maximum(Number.MAX_SAFE_INTEGER)),
      email: z.string().check(z.minLength(3), z.maxLength(320), z.regex(/^[^@\s]+@[^@\s]+$/)),
      consumerName,
      statementVersion,
      locale,
    }),
  ]),
  /** The owner marks an order shipped ("Markér afsendt og træk betalingen": the payment is captured), with an optional tracking reference. */
  markShipped: z.strictObject({
    accessToken,
    orderId: id,
    trackingRef: z.optional(z.string().check(z.maxLength(200))),
  }),
  /**
   * The owner approves a withdrawal: returned (refund, optional deduction) or never shipped (the
   * authorization is released, or a payment captured at Checkout refunded in full; no deduction).
   */
  approveRefund: z.strictObject({
    accessToken,
    orderId: id,
    goodsState: z.enum(ORDER_GOODS_STATES),
    deductionOre: z.int().check(z.minimum(0), z.maximum(Number.MAX_SAFE_INTEGER)),
    deductionReason: z.optional(z.string().check(z.maxLength(500))),
  }),
};

/** A refusal: the code, plus for `conflict` ({@link ORDER_SERVICE_CONFLICTS}) / `invalid_input` the reason (e.g. `order_refunded`). */
const failure = z.strictObject({
  ok: z.literal(false),
  reason: z.enum(ORDER_SERVICE_ERRORS),
  subreason: z.optional(z.string().check(z.regex(/^[a-z_]{1,64}$/))),
});

const resultSchemas = {
  /** Stripe's hosted Checkout page (only ever on checkout.stripe.com). */
  startCheckout: z.union([
    z.strictObject({
      ok: z.literal(true),
      url: z.string().check(z.refine((value) => URL.canParse(value) && new URL(value).origin === "https://checkout.stripe.com")),
    }),
    failure,
  ]),
  /** A new or repeated notice is `received`; every identification failure is the same `refused`. */
  withdraw: z.union([z.strictObject({ ok: z.literal(true), status: z.literal("received") }), failure]),
  /**
   * `shipped`: captured and marked shipped (then the shipped email); `already_shipped`: nothing changed.
   * A refused capture is `conflict` with `authorization_expired` (the order is canceled) or
   * `capture_refused` (the order stays reserved and unshipped).
   */
  markShipped: z.union([z.strictObject({ ok: z.literal(true), status: z.enum(["shipped", "already_shipped"]) }), failure]),
  /**
   * `completed`: refunded; `canceled`: the authorization was released (nothing was charged);
   * `approved`: recorded, the refund or release is left to the sweep; `needs_manual`: the owner was alerted.
   */
  approveRefund: z.union([
    z.strictObject({ ok: z.literal(true), status: z.enum(["completed", "canceled", "approved", "needs_manual"]) }),
    failure,
  ]),
};

/** The name of an `OrderService` method. */
export type OrderServiceMethod = keyof typeof inputSchemas;

export type OrderServiceInput<M extends OrderServiceMethod> = z.infer<(typeof inputSchemas)[M]>;

export type OrderServiceResult<M extends OrderServiceMethod> = z.infer<(typeof resultSchemas)[M]>;

export type OrderServiceFailure = z.infer<typeof failure>;

/** `value` as `method`'s input, or null for any other shape (the Worker answers `invalid_input`). */
export function parseOrderServiceInput<M extends OrderServiceMethod>(method: M, value: unknown): OrderServiceInput<M> | null {
  const result = inputSchemas[method].safeParse(value);
  return result.success ? (result.data as OrderServiceInput<M>) : null;
}

/** `value` as `method`'s answer, or null for any other shape (the web treats it as `unavailable`). */
export function parseOrderServiceResult<M extends OrderServiceMethod>(
  method: M,
  value: unknown,
): OrderServiceResult<M> | null {
  const result = resultSchemas[method].safeParse(value);
  return result.success ? (result.data as OrderServiceResult<M>) : null;
}
