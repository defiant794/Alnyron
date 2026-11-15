import { WorkerEntrypoint } from "cloudflare:workers";
import { buildGoodsCheckoutParams } from "@/lib/payments/orders/checkout-params";
import { verifyOrderLinkToken } from "@/lib/payments/orders/link-token";
import {
  ORDER_SERVICE_CONFLICTS,
  parseOrderServiceInput,
  type OrderServiceFailure,
  type OrderServiceInput,
  type OrderServiceMethod,
  type OrderServiceResult,
} from "@/lib/payments/orders/service-contract";
import { asRecord } from "@/lib/payments/webhook-mapping";
import { parsePaymentsEnv } from "../env";
import { createOrderDeps, type OrderDeps } from "./deps";
import { deliverOrderMail, deliverWithdrawalMail, failureCode, stripeFailure } from "./deliver";
import { parseOrdersEnv } from "./env";
import { orderRefusal, type OrderSnapshot } from "./rpc";
import { orderRefundStatus, processOrderRefund } from "./withdrawal";

/**
 * The goods calls of the web app (slice S2): the named entrypoint
 * `OrderService`, reached over the web Worker's service binding `ORDERS` (root
 * wrangler.jsonc), never over a route. Inputs and answers follow
 * `src/lib/payments/orders/service-contract.ts` (zod, parsed on both sides; a
 * malformed input is `invalid_input`). The web app never sends a user id: the
 * owner of an access token comes from Supabase Auth's answer only, and the
 * owner/admin role is checked by the writers. Goods Checkout sessions are made
 * here with STRIPE_PAYMENTS_KEY, never by the web app. Without a valid payments
 * and orders env every call answers `unavailable`.
 *
 * Each call logs one JSON line `{msg: "payments order service", method,
 * outcome, code, order}`: ids and codes only, never a token, name or email.
 */

const LOG_MSG = "payments order service";

/** What a handler answers: the method's result, plus the order it concerned and a log code. */
type Answer<M extends OrderServiceMethod> = { result: OrderServiceResult<M> | OrderServiceFailure; order?: string; code?: string };

function failure(reason: OrderServiceFailure["reason"], subreason?: string): OrderServiceFailure {
  return subreason === undefined ? { ok: false, reason } : { ok: false, reason, subreason };
}

/**
 * The answer for a failed writer call: 42501 `forbidden`, P0002 `not_found`,
 * P0001 `conflict` (with the refusal as `subreason` when it is one of the
 * method's `conflicts`), 22023 `invalid_input` with the refusal, anything else
 * `unavailable` (a failure a retry may fix).
 */
function writerFailure(error: unknown, conflicts: readonly string[]): { result: OrderServiceFailure; code: string } {
  const refusal = orderRefusal(error);
  const code = failureCode(error);
  if (refusal === null) return { result: failure("unavailable"), code };
  if (refusal.code === "42501") return { result: failure("forbidden"), code };
  if (refusal.code === "P0002") return { result: failure("not_found"), code };
  if (refusal.code === "22023") return { result: failure("invalid_input", refusal.reason), code };
  return { result: failure("conflict", conflicts.includes(refusal.reason) ? refusal.reason : undefined), code };
}

/**
 * `startCheckout`: the item's purchasable snapshot (`payments_goods_offer`;
 * none → `not_purchasable`), the signed-in buyer of `accessToken` when Supabase
 * Auth confirms it and it has an email (else a guest purchase, never an
 * error), the Checkout parameters (`buildGoodsCheckoutParams`: authorize only,
 * the 25 % inclusive Tax Rate, Denmark only) and `POST /v1/checkout/sessions`
 * → `{ok: true, url}` (only ever on checkout.stripe.com, else `unavailable`).
 */
export async function startCheckout(
  deps: OrderDeps,
  input: OrderServiceInput<"startCheckout">,
): Promise<Answer<"startCheckout">> {
  let offer;
  try {
    offer = await deps.rpc.goodsOffer(input.itemId, input.locale);
  } catch (error) {
    return { result: failure("unavailable"), code: `offer_${failureCode(error)}` };
  }
  if (offer === null) return { result: failure("not_purchasable") };

  let account: { userId: string; email: string } | null = null;
  if (input.accessToken !== undefined) {
    const user = await deps.auth.getUser(input.accessToken).catch(() => null);
    if (user !== null && user.email !== null) account = { userId: user.id, email: user.email };
  }
  const session = await deps.stripe.createGoodsCheckoutSession(
    buildGoodsCheckoutParams({
      offer,
      locale: input.locale,
      siteOrigin: deps.siteOrigin,
      taxRateId: deps.ordersEnv.stripeTaxRateId,
      nowSeconds: Math.floor(deps.now() / 1000),
      account,
    }),
  );
  if (!session.ok) return { result: failure("unavailable"), code: stripeFailure(session) };
  if (new URL(session.data.url).origin !== "https://checkout.stripe.com") {
    return { result: failure("unavailable"), code: "stripe_invalid_response" };
  }
  return { result: { ok: true, url: session.data.url }, code: account === null ? "guest" : "account" };
}

/**
 * `withdraw`: the order of a personal link (its token must verify under
 * ORDER_LINK_SECRET) or of an order number with the order's email
 * (`payments_find_order`); every identification failure, and a refunded or
 * canceled order without a withdrawal, is the same `refused`.
 * `payments_begin_order_withdrawal` records the notice (never refused for
 * lateness); a new one sends the withdrawal receipt to the order's email
 * (`order-wd-ack/<id>`) and the owner's alert (`order-wd-alert/<id>`), each
 * stamped; a failed send is left to the sweep. A repeated notice (also after
 * the refund or the release) sends nothing. The answer is `received` once the
 * notice is recorded.
 */
export async function withdrawOrder(deps: OrderDeps, input: OrderServiceInput<"withdraw">): Promise<Answer<"withdraw">> {
  let orderId: string | null;
  if (input.channel === "link") {
    const valid = await verifyOrderLinkToken(deps.ordersEnv.orderLinkSecret, input.orderId, input.token);
    orderId = valid ? input.orderId : null;
  } else {
    try {
      orderId = await deps.rpc.findOrder(input.orderNumber, input.email);
    } catch (error) {
      return { result: failure("unavailable"), code: `find_${failureCode(error)}` };
    }
  }
  if (orderId === null) return { result: failure("refused"), code: `${input.channel}_not_matched` };

  let begun;
  try {
    begun = await deps.rpc.beginOrderWithdrawal({
      orderId,
      consumerName: input.consumerName,
      channel: input.channel,
      statementVersion: input.statementVersion,
      locale: input.locale,
    });
  } catch (error) {
    const refusal = orderRefusal(error);
    if (refusal?.code === "P0002") return { result: failure("refused"), order: orderId, code: refusal.reason };
    return { result: failure("unavailable"), order: orderId, code: `begin_${failureCode(error)}` };
  }
  if (begun.outcome === "not_withdrawable") return { result: failure("refused"), order: orderId, code: "not_withdrawable" };
  if (begun.outcome === "created") {
    const { order, withdrawal } = begun;
    await deliverWithdrawalMail(deps.rpc, withdrawal.id, "ack_sent", () => deps.mail.sendWithdrawalAck(order, withdrawal));
    await deliverWithdrawalMail(deps.rpc, withdrawal.id, "owner_alerted", () => deps.mail.sendWithdrawalAlert(order, withdrawal));
  }
  return { result: { ok: true, status: "received" }, order: orderId, code: begun.outcome };
}

/** What capturing an order's payment came to. */
type Capture = "captured" | "authorization_expired" | "capture_refused" | { unavailable: string };

/**
 * Captures the authorized payment of `order` (Idempotency-Key
 * `ord-cap-<order id>`). Stripe refusing it (400 or 402) is decided
 * by what Stripe shows then: `succeeded` (captured before, e.g. by a retry
 * whose answer was lost) is captured; `canceled`, or the refusal
 * `charge_expired_for_capture`, is a lapsed authorization; anything else (a
 * decline) `capture_refused`. A failure a retry may fix (network, 401/403 a
 * key or permission to fix, 404, 409, 429, 5xx, a failed re-read) changes nothing.
 */
async function capture(deps: OrderDeps, order: OrderSnapshot): Promise<Capture> {
  const result = await deps.stripe.capturePaymentIntent(order.stripe_payment_intent_id, order.id);
  if (result.ok) return asRecord(result.data)?.status === "succeeded" ? "captured" : { unavailable: "stripe_not_succeeded" };
  if (result.kind !== "http" || (result.status !== 400 && result.status !== 402)) {
    return { unavailable: stripeFailure(result) };
  }
  if (result.code === "charge_expired_for_capture") return "authorization_expired";
  const current = await deps.stripe.retrievePaymentIntent(order.stripe_payment_intent_id);
  if (!current.ok) return { unavailable: stripeFailure(current) };
  const status = asRecord(current.data)?.status;
  if (status === "succeeded") return "captured";
  return status === "canceled" ? "authorization_expired" : "capture_refused";
}

/**
 * `markShipped` ("Markér afsendt og træk betalingen", amendments A1 and A2-3):
 * the token's user (`unauthenticated` when Auth refuses it) →
 * `payments_order_begin_ship` (owner/admin, an authorized order without a
 * pending withdrawal; stores the tracking reference) → the capture (skipped
 * when captured at Checkout) → `payments_order_captured` → the shipped email
 * (`order-shipped/<id>`, stamped) → `shipped`. A lapsed authorization cancels
 * the order (`payments_order_capture_failed authorization_expired`, the owner's
 * `order-expired/<id>` alert) → `conflict authorization_expired`; a capture
 * refused for another reason flags it (`capture_refused`: still authorized and
 * unshipped, the owner's `order-capture-failed/<id>` alert) → `conflict
 * capture_refused`; a failure a retry may fix → `unavailable` with nothing
 * marked shipped.
 */
export async function markShipped(deps: OrderDeps, input: OrderServiceInput<"markShipped">): Promise<Answer<"markShipped">> {
  const conflicts = ORDER_SERVICE_CONFLICTS.markShipped;
  let user;
  try {
    user = await deps.auth.getUser(input.accessToken);
  } catch {
    return { result: failure("unavailable"), code: "auth_failed" };
  }
  if (user === null) return { result: failure("unauthenticated") };

  let begun;
  try {
    begun = await deps.rpc.beginShip(input.orderId, user.id, input.trackingRef ?? null);
  } catch (error) {
    return { ...writerFailure(error, conflicts), order: input.orderId };
  }
  if (begun.outcome === "already_shipped") return { result: { ok: true, status: "already_shipped" }, order: input.orderId };

  const captured = begun.order.captured_at !== null ? "captured" : await capture(deps, begun.order);
  if (typeof captured === "object") return { result: failure("unavailable"), order: input.orderId, code: captured.unavailable };

  if (captured === "authorization_expired") {
    let failed;
    try {
      failed = await deps.rpc.captureFailed(input.orderId, "authorization_expired");
    } catch (error) {
      return { result: failure("unavailable"), order: input.orderId, code: `capture_failed_${failureCode(error)}` };
    }
    const { order } = failed;
    const alert = await deliverOrderMail(deps.rpc, order.id, "expired_alert", () => deps.mail.sendAuthorizationExpired(order));
    return { result: failure("conflict", "authorization_expired"), order: input.orderId, code: `alert_${alert}` };
  }
  if (captured === "capture_refused") {
    let failed;
    try {
      failed = await deps.rpc.captureFailed(input.orderId, "capture_refused");
    } catch (error) {
      return { result: failure("unavailable"), order: input.orderId, code: `capture_failed_${failureCode(error)}` };
    }
    // No stamp for this alert: the order's capture_failed anomaly and the admin's message stay.
    const alert = await deps.mail.sendCaptureFailed(failed.order).then(
      () => "sent",
      (error: unknown) => failureCode(error),
    );
    return { result: failure("conflict", "capture_refused"), order: input.orderId, code: `alert_${alert}` };
  }

  let shipped;
  try {
    shipped = await deps.rpc.orderCaptured(input.orderId, user.id);
  } catch (error) {
    // Captured at Stripe: a repeated "Markér afsendt" captures nothing twice (same Idempotency-Key) and records it.
    return { ...writerFailure(error, conflicts), order: input.orderId };
  }
  if (shipped.outcome === "already_shipped") return { result: { ok: true, status: "already_shipped" }, order: input.orderId };
  const { order } = shipped;
  const mail = await deliverOrderMail(deps.rpc, order.id, "shipped", () => deps.mail.sendShipped(order));
  return { result: { ok: true, status: "shipped" }, order: input.orderId, code: `mail_${mail}` };
}

/**
 * `approveRefund`: the token's user → `payments_approve_order_refund`
 * (owner/admin; `returned` refunds what is left after the deduction,
 * `not_shipped` releases the authorization, or refunds in full what was
 * captured at Checkout) → one pass of `processOrderRefund` → `completed`
 * (refunded), `canceled` (released), `needs_manual` (the owner was alerted) or
 * `approved` (the sweep finishes it). An approval recorded before answers its
 * state, after a pass when it is still approved.
 */
export async function approveRefund(
  deps: OrderDeps,
  input: OrderServiceInput<"approveRefund">,
): Promise<Answer<"approveRefund">> {
  let user;
  try {
    user = await deps.auth.getUser(input.accessToken);
  } catch {
    return { result: failure("unavailable"), code: "auth_failed" };
  }
  if (user === null) return { result: failure("unauthenticated") };

  let approved;
  try {
    approved = await deps.rpc.approveOrderRefund({
      orderId: input.orderId,
      actor: user.id,
      goodsState: input.goodsState,
      deductionOre: input.deductionOre,
      deductionReason: input.deductionReason ?? null,
    });
  } catch (error) {
    return { ...writerFailure(error, ORDER_SERVICE_CONFLICTS.approveRefund), order: input.orderId };
  }
  const { withdrawal } = approved;
  if (withdrawal.status !== "approved") {
    return { result: { ok: true, status: orderRefundStatus(withdrawal) }, order: input.orderId, code: approved.outcome };
  }
  let status;
  try {
    status = await processOrderRefund(deps, withdrawal.id);
  } catch (error) {
    // Recorded already: the sweep finishes it.
    return { result: { ok: true, status: "approved" }, order: input.orderId, code: `claim_${failureCode(error)}` };
  }
  return { result: { ok: true, status }, order: input.orderId, code: approved.outcome };
}

/**
 * One `OrderService` call: parses `input` for `method` (`invalid_input`),
 * builds the clients from `env` (`unavailable` without a valid payments and
 * orders env), runs `handler` and logs the outcome; a defect is logged and
 * answered `unavailable`. A module function, not a method: every method of
 * the entrypoint class is callable over the binding.
 */
async function runOrderCall<M extends OrderServiceMethod>(
  env: unknown,
  method: M,
  input: unknown,
  handler: (deps: OrderDeps, input: OrderServiceInput<M>) => Promise<Answer<M>>,
): Promise<OrderServiceResult<M> | OrderServiceFailure> {
  const log = (outcome: string, code: string | null, order: string | null = null) =>
    console.log(JSON.stringify({ msg: LOG_MSG, method, outcome, code, order }));

  const parsed = parseOrderServiceInput(method, input);
  if (parsed === null) {
    log("invalid_input", null);
    return failure("invalid_input");
  }
  let deps: OrderDeps;
  try {
    deps = createOrderDeps(parsePaymentsEnv(env), parseOrdersEnv(env));
  } catch {
    log("unavailable", "invalid_env");
    return failure("unavailable");
  }
  try {
    const { result, order, code } = await handler(deps, parsed);
    const answer = asRecord(result);
    const subreason = typeof answer?.subreason === "string" ? answer.subreason : null;
    log(answer?.ok === true ? "ok" : String(answer?.reason), code ?? subreason, order ?? null);
    return result;
  } catch {
    log("unavailable", "unexpected");
    return failure("unavailable");
  }
}

/**
 * The named entrypoint the web app calls over its service binding `ORDERS`;
 * see the module comment and the handlers above.
 */
export class OrderService extends WorkerEntrypoint<unknown> {
  async startCheckout(input: unknown): Promise<OrderServiceResult<"startCheckout">> {
    return runOrderCall(this.env, "startCheckout", input, startCheckout);
  }

  async withdraw(input: unknown): Promise<OrderServiceResult<"withdraw">> {
    return runOrderCall(this.env, "withdraw", input, withdrawOrder);
  }

  async markShipped(input: unknown): Promise<OrderServiceResult<"markShipped">> {
    return runOrderCall(this.env, "markShipped", input, markShipped);
  }

  async approveRefund(input: unknown): Promise<OrderServiceResult<"approveRefund">> {
    return runOrderCall(this.env, "approveRefund", input, approveRefund);
  }
}
