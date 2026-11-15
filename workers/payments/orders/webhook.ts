import {
  applyGoodsPaymentIntent,
  goodsSessionUserCandidate,
  normalizeGoodsSession,
  type GoodsOrderInput,
} from "@/lib/payments/orders/session";
import { PI_ID_REGEX, eventForRpc, type StripeEventHeader } from "@/lib/payments/webhook-mapping";
import { PaymentsRpcError } from "../rpc";
import { deliverOrderMail, failureCode, stripeFailure } from "./deliver";
import type { OrderMailer } from "./mail";
import { orderRefusal, type OrderRpc, type OrderSnapshot } from "./rpc";
import type { OrderStripeApi } from "./stripe";

/**
 * The webhook's goods events (slice S2): a goods Checkout Session completed
 * (or its async payment succeeded), a refund on a goods payment, and a goods
 * payment intent canceled. webhook.ts routes them here and turns the answer
 * into the delivery's: `retry` fails it with 500 (Stripe delivers again),
 * everything else is 200 with one log line (outcome, code and the `goods`
 * fields: the order id and what became of each email). Ids and codes only,
 * never a name, an email or an address.
 *
 * Subrequests: a session 7 at most (the payment intent, the account lookup,
 * the writer, two emails with their stamps); a refund 1; a canceled payment
 * intent 3 (the writer, the alert and its stamp).
 */
export type OrderWebhookDeps = {
  stripe: Pick<OrderStripeApi, "retrievePaymentIntent">;
  rpc: Pick<OrderRpc, "recordOrder" | "orderMailSent" | "syncOrderRefund" | "authorizationCanceled">;
  /** Whether Supabase Auth has an account with this id (false for 404 `user_not_found`; other failures throw). */
  accountExists: (userId: string) => Promise<boolean>;
  /** Null while the orders env is invalid: orders are still recorded, their emails left to the sweep. */
  mail: OrderMailer | null;
};

/** A verified goods event: the fields the writers record and `data.object`. */
export type GoodsEvent = StripeEventHeader & { object: Record<string, unknown> };

/** The log outcomes of a goods event. */
export type GoodsOutcome = "recorded" | "duplicate" | "synced" | "canceled" | "ignored" | "rejected";

/**
 * The log line's goods fields: the order, and per email `sent`, `deferred`
 * (no orders env: the sweep sends it) or the failure's code.
 */
export type GoodsLog = { order: string | null; confirmation?: string; owner?: string; alert?: string };

/** A goods event's answer: handled (200), or `retry` with the failed call's code (500). */
export type GoodsHandled =
  | { retry: false; outcome: GoodsOutcome; code: string | null; goods: GoodsLog }
  | { retry: true; code: string };

/** Logged when the orders env is invalid: the emails wait for the sweep. */
const ORDERS_ENV_UNAVAILABLE = "orders_env_unavailable";

function handled(outcome: GoodsOutcome, code: string | null, goods: GoodsLog = { order: null }): GoodsHandled {
  return { retry: false, outcome, code, goods };
}

function retry(code: string): GoodsHandled {
  return { retry: true, code };
}

/** The log code of a failed database or Auth call. */
function rpcCode(error: unknown): string {
  if (error instanceof PaymentsRpcError) return error.status === null ? `rpc_${error.code}` : `rpc_${error.code}_${error.status}`;
  return failureCode(error);
}

/** The order as just recorded from `order` (no read needed for its emails). */
function recordedSnapshot(order: GoodsOrderInput, orderId: string, orderNumber: number): OrderSnapshot {
  const captured = order.capture_state === "succeeded";
  const [line] = order.lines;
  return {
    id: orderId,
    order_number: orderNumber,
    status: "authorized",
    email: order.email,
    customer_name: order.customer_name,
    phone: order.phone,
    shipping_name: order.shipping_name,
    shipping_address: order.shipping_address,
    locale: order.locale,
    amount_total_ore: order.amount_total_ore,
    amount_refunded_ore: 0,
    paid_at: order.paid_at,
    authorization_expires_at: captured ? null : order.authorization_expires_at,
    captured_at: captured ? order.paid_at : null,
    cancel_reason: null,
    anomaly: order.anomaly,
    tracking_ref: null,
    stripe_payment_intent_id: order.stripe_payment_intent_id,
    line: { title: line.title, quantity: line.quantity },
  };
}

/**
 * `checkout.session.completed` / `checkout.session.async_payment_succeeded`
 * of a goods session (`mode=payment`, `metadata.kind=goods_order`):
 * 1. `normalizeGoodsSession`: `awaiting_payment` / `invalid_session` →
 *    ignored.
 * 2. An unpaid (authorized) session: `GET /v1/payment_intents/{pi}` with the
 *    latest charge, completed by `applyGoodsPaymentIntent` (`requires_capture`
 *    with the card's `capture_before`, or `succeeded` = captured at
 *    Checkout); any other status → ignored `awaiting_payment`; a failed GET or
 *    an answer for another payment intent → retry. A `paid` session is
 *    recorded as captured at Checkout without the GET.
 * 3. The buyer: `metadata.user_id` equal to `client_reference_id` (both set by
 *    the Worker for a verified signed-in buyer) whose account Supabase Auth
 *    still has; a missing account makes it a guest order; a failed lookup →
 *    retry.
 * 4. `payments_record_order`: `duplicate` → no emails; a refusal (22023) →
 *    rejected; any other failure → retry.
 * 5. Recorded: the order confirmation (the invoice) to the buyer and the new
 *    order to the owner, each stamped; a failed send is counted and the sweep
 *    resends it. Without an orders env both wait for the sweep
 *    (`orders_env_unavailable`).
 */
export async function onSessionPaid(event: GoodsEvent, deps: OrderWebhookDeps): Promise<GoodsHandled> {
  const session = normalizeGoodsSession(event.object, event);
  if (!session.ok) return handled("ignored", session.reason === "not_goods" ? "not_goods_order" : session.reason);

  let order: GoodsOrderInput;
  if (session.captureCheck) {
    const intent = await deps.stripe.retrievePaymentIntent(session.order.stripe_payment_intent_id);
    if (!intent.ok) return retry(`payment_intent_${stripeFailure(intent)}`);
    const completed = applyGoodsPaymentIntent(session.order, intent.data);
    if (!completed.ok) return completed.reason === "awaiting_payment" ? handled("ignored", "awaiting_payment") : retry(completed.reason);
    order = completed.order;
  } else {
    order = session.order;
  }

  let userId: string | null = null;
  const candidate = goodsSessionUserCandidate(event.object);
  if (candidate !== null) {
    try {
      userId = (await deps.accountExists(candidate)) ? candidate : null;
    } catch (error) {
      return retry(`account_${rpcCode(error)}`);
    }
  }

  let recorded;
  try {
    recorded = await deps.rpc.recordOrder(eventForRpc(event), { ...order, user_id: userId });
  } catch (error) {
    const refusal = orderRefusal(error);
    if (refusal?.code === "22023") return handled("rejected", `order_${refusal.reason}`);
    return retry(`record_${rpcCode(error)}`);
  }
  if (recorded.outcome === "duplicate") return handled("duplicate", null);

  const snapshot = recordedSnapshot(order, recorded.orderId, recorded.orderNumber);
  const mail = deps.mail;
  if (mail === null) {
    return handled("recorded", ORDERS_ENV_UNAVAILABLE, { order: snapshot.id, confirmation: "deferred", owner: "deferred" });
  }
  const confirmation = await deliverOrderMail(deps.rpc, snapshot.id, "confirmation", () => mail.sendConfirmation(snapshot));
  const owner = await deliverOrderMail(deps.rpc, snapshot.id, "owner", () => mail.sendOwnerNewOrder(snapshot));
  return handled("recorded", null, { order: snapshot.id, confirmation, owner });
}

/**
 * `charge.refunded`: Stripe's cumulative `amount_refunded` of the charge's
 * payment intent goes to `payments_sync_order_refund`, which never lowers it
 * and bounds it by the captured amount. A charge of no goods order (a
 * subscription's) is `unknown_order` and ignored: nothing of the subscription
 * tables is touched. No email (the admin page shows a Dashboard refund).
 */
export async function onChargeRefunded(event: GoodsEvent, deps: Pick<OrderWebhookDeps, "rpc">): Promise<GoodsHandled> {
  const { payment_intent: paymentIntent, amount_refunded: amount } = event.object;
  if (paymentIntent === null || paymentIntent === undefined) return handled("ignored", "no_payment_intent");
  if (
    typeof paymentIntent !== "string" ||
    !PI_ID_REGEX.test(paymentIntent) ||
    typeof amount !== "number" ||
    !Number.isSafeInteger(amount) ||
    amount < 0
  ) {
    return handled("rejected", "invalid_charge");
  }
  let synced;
  try {
    synced = await deps.rpc.syncOrderRefund(eventForRpc(event), paymentIntent, amount);
  } catch (error) {
    const refusal = orderRefusal(error);
    if (refusal?.code === "22023") return handled("rejected", `sync_${refusal.reason}`);
    return retry(`sync_${rpcCode(error)}`);
  }
  if (synced.outcome === "unknown_order") return handled("ignored", "unknown_order");
  if (synced.outcome === "duplicate") return handled("duplicate", null);
  return handled("synced", null, { order: synced.orderId });
}

/**
 * `payment_intent.canceled`: `payments_order_authorization_canceled` cancels
 * an authorized, uncaptured goods order (`withdrawn` when its withdrawal
 * released it, else `authorization_expired`). A lapsed authorization sends
 * the owner "Betalingen for ordre <n> er udløbet; send ikke varen"
 * (`order-expired/<id>`), stamped `expired_alert`; a failed send is counted and
 * the sweep resends it (as it does while the orders env is invalid). Any other
 * PI, a repeated event or an order in another state: 200 without email.
 */
export async function onPaymentIntentCanceled(event: GoodsEvent, deps: OrderWebhookDeps): Promise<GoodsHandled> {
  const paymentIntent = event.object.id;
  if (typeof paymentIntent !== "string" || !PI_ID_REGEX.test(paymentIntent)) return handled("rejected", "invalid_payment_intent");
  let canceled;
  try {
    canceled = await deps.rpc.authorizationCanceled(eventForRpc(event), paymentIntent);
  } catch (error) {
    const refusal = orderRefusal(error);
    if (refusal?.code === "22023") return handled("rejected", `cancel_${refusal.reason}`);
    return retry(`cancel_${rpcCode(error)}`);
  }
  if (canceled.outcome === "unknown_order") return handled("ignored", "unknown_order");
  if (canceled.outcome === "duplicate") return handled("duplicate", null);
  if (canceled.outcome === "ignored") return handled("ignored", "order_not_authorized", { order: canceled.orderId });

  const { order } = canceled;
  if (order.cancel_reason !== "authorization_expired") return handled("canceled", null, { order: order.id });
  const mail = deps.mail;
  if (mail === null) return handled("canceled", ORDERS_ENV_UNAVAILABLE, { order: order.id, alert: "deferred" });
  const alert = await deliverOrderMail(deps.rpc, order.id, "expired_alert", () => mail.sendAuthorizationExpired(order));
  return handled("canceled", null, { order: order.id, alert });
}
