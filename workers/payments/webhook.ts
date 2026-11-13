import {
  MONITOR_SUBSCRIPTION_KIND,
  PAYMENTS_MAX_DUPLICATE_CANDIDATES,
  PAYMENTS_WEBHOOK_MAX_BODY_BYTES,
  STRIPE_WEBHOOK_TOLERANCE_SECONDS,
  isEntitlingStatus,
} from "@/config/payments";
import type { StripeResult } from "@/lib/payments/stripe";
import { verifyStripeSignature } from "@/lib/payments/stripe-signature";
import {
  EVT_ID_REGEX,
  INV_ID_REGEX,
  PI_ID_REGEX,
  SUB_ID_REGEX,
  asRecord,
  eventForRpc,
  invoiceSubscriptionId,
  isDuplicateMarked,
  isUnixSeconds,
  metadataUserId,
  normalizeInvoice,
  normalizeSubscription,
  toSubscriptionPayload,
  type NormalizedSubscription,
  type RpcEvent,
  type StripeEventHeader,
  type SubscriptionPayload,
} from "@/lib/payments/webhook-mapping";
import { PaymentsRpcError, type PaymentsRpc, type WriterOutcome, type WriterRefusal } from "./rpc";
import type { StripeApi } from "./stripe-api";

/**
 * One Stripe webhook delivery (`POST /webhook`): size cap, signature, event
 * shape, account, mode, then the event's handler. The state of a subscription
 * is always the one retrieved from Stripe at handling time, never the event's
 * copy, and the database writers decide what to store (dedupe by event id,
 * staleness, final statuses, the billing customer, the lapse pause). Every id
 * taken from the event or a Stripe object is checked against its pattern
 * (`webhook-mapping.ts`) before any Stripe call: a malformed one ends the
 * delivery for good (`invalid_event` for the event's own id, else rejected),
 * never as a transient failure. A subscription's latest invoice id is checked
 * only by the duplicate rule, its one reader, so a sync never fails on it: a
 * duplicate with a malformed one is neither refunded nor canceled, and the
 * event is rejected after its write. A payment with a malformed payment
 * intent or amount is not refunded, nor is one that is not paid (never waited
 * for). A subscription carrying the duplicate mark is never kept: while it is
 * entitling, any handled event finishes it, whatever the writer answered
 * (bar a failure a retry may fix). So is an entitling one the database
 * refuses as unknown_user although the app's metadata names its user, once
 * Supabase Auth answers that no such account exists (e.g. deleted since): it
 * can never be recorded. When the account exists, its profile is missing:
 * nothing is done in Stripe and the delivery fails (`missing_profile`, 500)
 * until an operator restores the profile. An `invoice.paid` of a
 * subscription carrying the mark, in any status, or getting it in that
 * delivery, has that invoice's paid payments refunded, also when the invoice
 * or the subscription cannot be recorded (the mark is then read from the
 * subscription as Stripe returned it, which is retrieved before the invoice
 * is checked beyond its id). An event of a connected account (Stripe
 * Connect, `account` set) is ignored: this endpoint serves the account's own
 * Checkouts only.
 *
 * Answers: 413 (body over PAYMENTS_WEBHOOK_MAX_BODY_BYTES), 400
 * `invalid_signature` / `invalid_event`, 200 `{"received":true}` for every
 * handled event (also ignored and rejected ones: a retry cannot change them),
 * 500 `unavailable` for a failure a retry may fix (Stripe redelivers).
 *
 * Every delivery that passes the size cap logs exactly one JSON line
 * (`msg: "payments webhook"`): event id, type, outcome, code, paused; for a
 * bad signature only outcome and reason. Never a header, body, key, secret,
 * email, user id or customer id.
 *
 * Subrequests per delivery (Workers Free allows 50, per Cloudflare's limits):
 * 3 (the event's subscription retrieve, one writer, the database read of the
 * user's other subscriptions), at most PAYMENTS_MAX_DUPLICATE_CANDIDATES (5)
 * retrieves of those, per finished duplicate a mark (unless it already
 * carries the mark), a payments list, one refund per paid payment, a cancel
 * and a re-retrieve after a refused cancel, and on `invoice.paid` of a
 * subscription carrying the mark by then a payments list and its refunds for
 * that invoice (none when its finish refunded it as the latest). With one
 * paid payment each: the event's subscription, unmarked, is itself a
 * candidate to keep, so one is always kept and at most 5 are finished,
 * 3 + 5 + 5 × 5 = 33; when it is one of them, its `invoice.paid` adds 2: the
 * worst case is 35 ≤ 50. A marked event subscription is finished alone,
 * without the read or a mark: 2 + 4 = 6 (8 on `invoice.paid`). An unmarked
 * one refused unknown_user although the app's metadata names its user is
 * finished alone too, without the read but after the Auth lookup:
 * 3 + 5 = 8 (10 on `invoice.paid`).
 * The customer_user_mismatch path finishes only the event's subscription: at
 * most 3 + 5 + 5 = 13 (15 on `invoice.paid`). A marked subscription that is
 * not entitling costs 4 on `invoice.paid` (retrieve, writer, list, refund);
 * an `invoice.paid` whose invoice or subscription the writers cannot take
 * costs the retrieve, and for a marked subscription a list and its refunds
 * (3), without the writer. A user with more other subscriptions is handled
 * over several deliveries: a canceled duplicate leaves the entitling set the
 * database lists.
 */

export type WebhookDeps = {
  /** The endpoint's signing secret (`whsec_…`). */
  webhookSecret: string;
  /** Whether this Worker serves live mode: events of the other mode are ignored. */
  livemode: boolean;
  stripe: StripeApi;
  rpc: PaymentsRpc;
  /** The current time in milliseconds (`Date.now`). */
  now: () => number;
  /** Writes one log line. */
  log: (line: string) => void;
};

type Outcome =
  | WriterOutcome["outcome"]
  | "ignored"
  | "rejected"
  | "duplicate_subscription_canceled"
  | "duplicate_invoice_refunded";

/** What a handled event did: the log line's outcome, code and paused. */
type Handled = { outcome: Outcome; code: string | null; paused: number | null };

/** A verified event: the fields the writers record, `data.object`, and whether a connected account (`account`) sent it. */
type StripeEvent = StripeEventHeader & { object: Record<string, unknown>; connect: boolean };

/**
 * A subscription the duplicate rule may keep or finish: its id, Stripe
 * `created`, whether it carries the duplicate mark, and `latest_invoice` as
 * retrieved, checked only before it is finished ({@link cancelAndRefund}).
 */
type Candidate = { id: string; created: number; marked: boolean; latestInvoice: unknown };

/**
 * What {@link cancelAndRefund} did with one duplicate: finished it, or left it
 * alone for a malformed latest invoice id.
 */
type Finished = "canceled" | "invalid_subscription";

/**
 * What the duplicate rule did in a delivery that finished duplicates: the log
 * outcome and code, and what became of the event's own subscription (`self`:
 * finished, see {@link Finished}, or null when it was kept).
 */
type DuplicateOutcome = { outcome: Outcome; code: string | null; self: Finished | null };

/**
 * A failure a retry may fix (Stripe, the database or Supabase Auth
 * unavailable, an unexpected answer, a missing profile an operator restores):
 * the delivery is answered 500 so Stripe redelivers. `code` names the failed
 * call (`stripe_http_503`, `rpc_unknown`, …) or `missing_profile`, never a value.
 */
class TransientFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "TransientFailure";
  }
}

const LOG_MSG = "payments webhook";

const HANDLED = { received: true };

function ignored(code: string): Handled {
  return { outcome: "ignored", code, paused: null };
}

function rejected(code: string): Handled {
  return { outcome: "rejected", code, paused: null };
}

/** The log code of a failed Stripe call: `stripe_network`, `stripe_invalid_response` or `stripe_http_<status>`. */
function stripeFailure(result: Exclude<StripeResult<unknown>, { ok: true }>): string {
  return result.kind === "http" ? `stripe_http_${result.status}` : `stripe_${result.kind}`;
}

/**
 * The log code of a failed {@link PaymentsRpc} call (a database writer or read,
 * or the Supabase Auth account lookup): `rpc_<code>[_<status>]` for a
 * PaymentsRpcError, else `rpc_failed`.
 */
function rpcFailure(error: unknown): string {
  if (!(error instanceof PaymentsRpcError)) return "rpc_failed";
  return error.status === null ? `rpc_${error.code}` : `rpc_${error.code}_${error.status}`;
}

/** The request body as text, or null when it is longer than PAYMENTS_WEBHOOK_MAX_BODY_BYTES (reading stops there). */
async function readBody(request: Request): Promise<string | null> {
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > PAYMENTS_WEBHOOK_MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}

/**
 * The event in `payload`, or null unless it is an object with an
 * {@link EVT_ID_REGEX} id, a type, Unix `created`, boolean `livemode` and an
 * object `data.object`. `connect` is whether it carries a non-null `account`
 * (an event of a Stripe Connect account).
 */
function parseEvent(payload: string): StripeEvent | null {
  let body: unknown;
  try {
    body = JSON.parse(payload);
  } catch {
    return null;
  }
  const event = asRecord(body);
  const object = asRecord(asRecord(event?.data)?.object);
  if (
    event === null ||
    object === null ||
    typeof event.id !== "string" ||
    !EVT_ID_REGEX.test(event.id) ||
    typeof event.type !== "string" ||
    !isUnixSeconds(event.created) ||
    typeof event.livemode !== "boolean"
  ) {
    return null;
  }
  return {
    id: event.id,
    type: event.type,
    created: event.created,
    livemode: event.livemode,
    object,
    connect: event.account !== undefined && event.account !== null,
  };
}

/**
 * The invoice id in a Stripe subscription's `latest_invoice` (an expanded
 * invoice's `.id`): null when it has none, undefined when it is not an
 * {@link INV_ID_REGEX} id.
 */
function latestInvoiceId(latest: unknown): string | null | undefined {
  if (latest === null || latest === undefined) return null;
  const id = typeof latest === "string" ? latest : asRecord(latest)?.id;
  return typeof id === "string" && INV_ID_REGEX.test(id) ? id : undefined;
}

/** Whether `value` is an amount Stripe can refund: a positive whole number of øre. */
function isRefundableAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Handles one Stripe webhook delivery; see the module comment. Throws only
 * on a defect (the caller answers 500 then); a failure a retry may fix is
 * answered 500 here.
 */
export async function handleStripeWebhook(request: Request, deps: WebhookDeps): Promise<Response> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > PAYMENTS_WEBHOOK_MAX_BODY_BYTES) {
    return new Response(null, { status: 413 });
  }
  const payload = await readBody(request);
  if (payload === null) return new Response(null, { status: 413 });

  const signature = await verifyStripeSignature({
    payload,
    header: request.headers.get("stripe-signature"),
    secret: deps.webhookSecret,
    nowSeconds: Math.floor(deps.now() / 1000),
    toleranceSeconds: STRIPE_WEBHOOK_TOLERANCE_SECONDS,
  });
  if (!signature.ok) {
    deps.log(JSON.stringify({ msg: LOG_MSG, outcome: "invalid_signature", reason: signature.reason }));
    return Response.json({ error: "invalid_signature" }, { status: 400 });
  }

  const event = parseEvent(payload);
  const log = (outcome: Outcome | "invalid_event" | "error", code: string | null, paused: number | null) =>
    deps.log(
      JSON.stringify({ msg: LOG_MSG, event: event?.id ?? null, type: event?.type ?? null, outcome, code, paused }),
    );
  if (event === null) {
    log("invalid_event", null, null);
    return Response.json({ error: "invalid_event" }, { status: 400 });
  }

  let handled: Handled;
  try {
    handled = await handleEvent(event, deps);
  } catch (error) {
    if (!(error instanceof TransientFailure)) throw error;
    log("error", error.code, null);
    return Response.json({ error: "unavailable" }, { status: 500 });
  }
  log(handled.outcome, handled.code, handled.paused);
  return Response.json(HANDLED, { status: 200 });
}

async function handleEvent(event: StripeEvent, deps: WebhookDeps): Promise<Handled> {
  if (event.connect) return ignored("connect_event");
  if (event.livemode !== deps.livemode) return ignored("livemode_mismatch");
  // A subscription the writers cannot take is rejected before the write.
  const sync = async (retrieved: unknown): Promise<Handled> => {
    const subscription = normalizeSubscription(retrieved);
    if (subscription === null) return rejected("invalid_subscription");
    return applySubscription(event, subscription, retrieved, deps, (rpcEvent, payload) =>
      deps.rpc.syncSubscription(rpcEvent, payload),
    );
  };

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.object;
      if (session.mode !== "subscription" || asRecord(session.metadata)?.kind !== MONITOR_SUBSCRIPTION_KIND) {
        return ignored("not_monitor_subscription");
      }
      if (typeof session.subscription !== "string" || !SUB_ID_REGEX.test(session.subscription)) {
        return rejected("invalid_session");
      }
      const retrieved = await retrieveSubscription(deps.stripe, session.subscription);
      if (retrieved === null) return rejected("subscription_not_found");
      // The user comes from server-set metadata only; the session's reference must agree with both copies.
      const userId = session.client_reference_id;
      if (typeof userId !== "string" || userId !== metadataUserId(retrieved.subscription) || userId !== metadataUserId(session)) {
        return rejected("user_mismatch");
      }
      return sync(retrieved.subscription);
    }

    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const id = event.object.id;
      if (typeof id !== "string" || !SUB_ID_REGEX.test(id)) return rejected("invalid_subscription");
      const retrieved = await retrieveSubscription(deps.stripe, id);
      return retrieved === null ? rejected("subscription_not_found") : sync(retrieved.subscription);
    }

    case "invoice.payment_failed": {
      // Syncs Stripe's current status (e.g. past_due).
      const subscriptionId = invoiceSubscriptionId(event.object);
      if (subscriptionId === null) return ignored("not_subscription_invoice");
      if (!SUB_ID_REGEX.test(subscriptionId)) return rejected("invalid_invoice");
      const retrieved = await retrieveSubscription(deps.stripe, subscriptionId);
      return retrieved === null ? rejected("subscription_not_found") : sync(retrieved.subscription);
    }

    case "invoice.paid": {
      const subscriptionId = invoiceSubscriptionId(event.object);
      if (subscriptionId === null) return ignored("not_subscription_invoice");
      // Both ids are checked before any Stripe call, the rest of the invoice once the subscription is known.
      const invoiceId = event.object.id;
      if (!SUB_ID_REGEX.test(subscriptionId) || typeof invoiceId !== "string" || !INV_ID_REGEX.test(invoiceId)) {
        return rejected("invalid_invoice");
      }
      const retrieved = await retrieveSubscription(deps.stripe, subscriptionId);
      if (retrieved === null) return rejected("subscription_not_found");
      return invoicePaid(event, invoiceId, subscriptionId, retrieved.subscription, deps);
    }

    default:
      return ignored("unhandled_type");
  }
}

/**
 * `invoice.paid` once its invoice id (`invoiceId`) and its subscription's id
 * (`subscriptionId`) passed their patterns and the subscription was
 * retrieved (`retrieved`, Stripe's answer): records the invoice with the
 * subscription synced ({@link applySubscription}), the invoice refunded when
 * the subscription carries the duplicate mark by then
 * ({@link refundEventInvoice}). An invoice or subscription the writers cannot
 * take is rejected without a write: `invalid_invoice` (checked first), else
 * `invalid_subscription`. The money of a subscription carrying the mark is
 * always refunded, though, so when Stripe returned that very subscription
 * (its `id` is `subscriptionId`) carrying the mark, the invoice's paid
 * payments are refunded ({@link refundPaidPayments}):
 * `duplicate_invoice_refunded` with that code, paused null; the rejection
 * stands when the invoice has no paid payment.
 */
async function invoicePaid(
  event: StripeEvent,
  invoiceId: string,
  subscriptionId: string,
  retrieved: unknown,
  deps: WebhookDeps,
): Promise<Handled> {
  const invoice = normalizeInvoice(event.object);
  const subscription = normalizeSubscription(retrieved);
  if (invoice !== null && subscription !== null) {
    return applySubscription(
      event,
      subscription,
      retrieved,
      deps,
      (rpcEvent, payload) => deps.rpc.recordSubscriptionInvoice(rpcEvent, payload, invoice),
      invoiceId,
    );
  }
  const refused = rejected(invoice === null ? "invalid_invoice" : "invalid_subscription");
  if (asRecord(retrieved)?.id !== subscriptionId || !isDuplicateMarked(retrieved)) return refused;
  if (!(await refundPaidPayments(invoiceId, subscriptionId, deps))) return refused;
  return { outcome: "duplicate_invoice_refunded", code: refused.code, paused: null };
}

/** The subscription's current state from Stripe; null when Stripe has no such subscription (404). */
async function retrieveSubscription(stripe: StripeApi, id: string): Promise<{ subscription: unknown } | null> {
  const result = await stripe.retrieveSubscription(id);
  if (result.ok) return { subscription: result.data };
  if (result.kind === "http" && result.status === 404) return null;
  throw new TransientFailure(stripeFailure(result));
}

/** {@link PaymentsRpc.otherEntitlingSubscriptionIds} for the subscription's user (none without one), a failure being transient. */
async function otherEntitlingIds(deps: WebhookDeps, subscription: NormalizedSubscription): Promise<string[]> {
  if (subscription.user_id === null) return [];
  try {
    return await deps.rpc.otherEntitlingSubscriptionIds(subscription.user_id, subscription.id);
  } catch (error) {
    throw new TransientFailure(rpcFailure(error));
  }
}

/** {@link PaymentsRpc.accountExists}, a failure being transient. */
async function accountExists(deps: WebhookDeps, userId: string): Promise<boolean> {
  try {
    return await deps.rpc.accountExists(userId);
  } catch (error) {
    throw new TransientFailure(rpcFailure(error));
  }
}

/**
 * Of the database-listed `otherIds` (at most PAYMENTS_MAX_DUPLICATE_CANDIDATES
 * are retrieved), those Stripe now shows as that very subscription in an
 * entitling status. The database lists them; Stripe's current state decides
 * whether they still count. A malformed id counts like one Stripe does not
 * know (404): no Stripe subscription has such an id.
 */
async function liveOthers(otherIds: readonly string[], deps: WebhookDeps): Promise<Candidate[]> {
  const others: Candidate[] = [];
  for (const id of otherIds.slice(0, PAYMENTS_MAX_DUPLICATE_CANDIDATES)) {
    if (!SUB_ID_REGEX.test(id)) continue;
    const retrieved = await retrieveSubscription(deps.stripe, id);
    const other = asRecord(retrieved?.subscription);
    if (
      other?.id === id &&
      typeof other.status === "string" &&
      isEntitlingStatus(other.status) &&
      isUnixSeconds(other.created)
    ) {
      others.push({ id, created: other.created, marked: isDuplicateMarked(other), latestInvoice: other.latest_invoice });
    }
  }
  return others;
}

/** The older of two candidates by Stripe `created` (tie: the smaller id). */
function older(kept: Candidate, next: Candidate): Candidate {
  return next.created < kept.created || (next.created === kept.created && next.id < kept.id) ? next : kept;
}

/**
 * The duplicate rule's result for the duplicates a delivery finished
 * (`finished`; `self`: what became of the event's own subscription, null when
 * it was kept): rejected `invalid_subscription` when one was left alone for a
 * malformed latest invoice id (only a person can sort it out); else
 * `duplicate_subscription_canceled`, with code `unrecordable_refunded` when no
 * live subscription the user keeps is known (`kept` false), else null.
 */
function duplicateOutcome(finished: readonly Finished[], kept: boolean, self: Finished | null): DuplicateOutcome {
  if (finished.includes("invalid_subscription")) return { outcome: "rejected", code: "invalid_subscription", self };
  return { outcome: "duplicate_subscription_canceled", code: kept ? null : "unrecordable_refunded", self };
}

/** Finishes only the event's own subscription ({@link cancelAndRefund}); `kept`: whether the user keeps a live one. */
async function finishSelf(self: Candidate, kept: boolean, deps: WebhookDeps): Promise<DuplicateOutcome> {
  const finished = await cancelAndRefund(self, deps);
  return duplicateOutcome([finished], kept, finished);
}

/**
 * Writes a subscription retrieved from Stripe (`subscription`, normalized
 * from Stripe's answer `retrieved`) through `write` (the sync or the invoice
 * writer), then applies the duplicate-subscription rule to an entitling one
 * ({@link duplicateRule}). Its latest invoice id is not checked here, only by
 * the duplicate rule (the one reader), so the write never fails on it. A
 * writer refusal ({@link PaymentsRpcError.refusal}) is `rejected` with the
 * refusal as code unless the duplicate rule finishes the subscription (or,
 * for unknown_user, fails the delivery, see {@link unknownUser}); any other
 * writer failure is transient (nothing else is done). When the duplicate
 * rule finished duplicates, the event's outcome is theirs
 * ({@link duplicateOutcome}) with the writer's paused (null after a refusal),
 * and the write stands. For `invoice.paid` (`paidInvoiceId`, the event's own
 * invoice), a subscription carrying the duplicate mark by then has that
 * invoice refunded ({@link refundEventInvoice}).
 */
async function applySubscription(
  event: StripeEvent,
  subscription: NormalizedSubscription,
  retrieved: unknown,
  deps: WebhookDeps,
  write: (event: RpcEvent, payload: SubscriptionPayload) => Promise<WriterOutcome>,
  paidInvoiceId?: string,
): Promise<Handled> {
  const self: Candidate = {
    id: subscription.id,
    created: subscription.created,
    marked: subscription.duplicate_marked,
    latestInvoice: asRecord(retrieved)?.latest_invoice,
  };

  let written: Handled;
  let refusal: WriterRefusal | null = null;
  try {
    const answer = await write(eventForRpc(event), toSubscriptionPayload(subscription));
    written = { outcome: answer.outcome, code: null, paused: answer.paused };
  } catch (error) {
    refusal = error instanceof PaymentsRpcError ? error.refusal : null;
    if (refusal === null) throw new TransientFailure(rpcFailure(error));
    written = rejected(refusal);
  }

  const duplicates = isEntitlingStatus(subscription.status) ? await duplicateRule(subscription, self, refusal, deps) : null;
  const handled: Handled =
    duplicates === null ? written : { outcome: duplicates.outcome, code: duplicates.code, paused: written.paused };
  if (paidInvoiceId === undefined) return handled;
  return refundEventInvoice(handled, self, duplicates?.self ?? null, paidInvoiceId, deps);
}

/**
 * The duplicate-subscription rule for an entitling subscription once the
 * writer answered (`refusal`: its refusal, null when it wrote, also as
 * duplicate or stale: an earlier delivery may have been written and then
 * failed before its Stripe calls). One carrying the duplicate mark was found
 * to be a duplicate before and may already be refunded, so it never stays:
 * it is finished whatever the writer answered, alone, without reading the
 * user's others (each is handled at its own events), and no live
 * subscription the user keeps is known (code `unrecordable_refunded`).
 * Otherwise a written one takes the parallel-Checkouts rule
 * ({@link cancelDuplicates}), one refused as customer_user_mismatch the
 * mismatch path ({@link customerUserMismatch}), and one refused as
 * unknown_user although the app's own metadata names its user (`user_id`)
 * the unknown-user path ({@link unknownUser}). Any other refusal stands,
 * unknown_user without a `user_id` (no app metadata: not the app's
 * subscription) included. Null when nothing was finished.
 */
async function duplicateRule(
  subscription: NormalizedSubscription,
  self: Candidate,
  refusal: WriterRefusal | null,
  deps: WebhookDeps,
): Promise<DuplicateOutcome | null> {
  if (self.marked) return finishSelf(self, false, deps);
  if (refusal === null) return cancelDuplicates(subscription, self, deps);
  if (refusal === "customer_user_mismatch") return customerUserMismatch(subscription, self, deps);
  return refusal === "unknown_user" && subscription.user_id !== null ? unknownUser(subscription.user_id, self, deps) : null;
}

/**
 * An entitling subscription without the duplicate mark that the database
 * refused as unknown_user although its app metadata names its user
 * (`userId`): the database has no profile for that user. Before it is
 * finished, Supabase Auth is asked whether the account exists
 * ({@link PaymentsRpc.accountExists}). It does not (e.g. deleted since its
 * Checkout): the subscription can never be recorded, so it is finished alone
 * like a marked one ({@link finishSelf}), without reading the user's others
 * (there is no such user), code `unrecordable_refunded`. It does: its
 * profile is missing, a database inconsistency an operator must fix, so
 * nothing is done in Stripe and the delivery fails (`missing_profile`,
 * transient): Stripe redelivers it, and once the profile is restored the
 * retry records the subscription. A failed lookup is transient too. One whose
 * malformed latest invoice id leaves it alone ({@link cancelAndRefund}) is not
 * finished whatever Auth answers, so it is rejected `invalid_subscription`
 * without the lookup.
 */
async function unknownUser(userId: string, self: Candidate, deps: WebhookDeps): Promise<DuplicateOutcome> {
  if (latestInvoiceId(self.latestInvoice) !== undefined && (await accountExists(deps, userId))) {
    throw new TransientFailure("missing_profile");
  }
  return finishSelf(self, false, deps);
}

/**
 * Parallel Checkouts, for a written subscription without the duplicate mark:
 * of the user's subscriptions in an entitling status (as retrieved from
 * Stripe now; the database lists the others, see {@link liveOthers}), the
 * one kept is the oldest (Stripe `created`, tie: the smaller id) among those
 * WITHOUT the duplicate mark, the event's own one included; every other one
 * is finished ({@link cancelAndRefund}). A marked subscription was found to
 * be a duplicate before and may already be refunded, so it is never kept.
 * Null when nothing was finished.
 */
async function cancelDuplicates(
  subscription: NormalizedSubscription,
  self: Candidate,
  deps: WebhookDeps,
): Promise<DuplicateOutcome | null> {
  const otherIds = await otherEntitlingIds(deps, subscription);
  if (otherIds.length === 0) return null;
  const others = await liveOthers(otherIds, deps);
  const keeper = others.filter((other) => !other.marked).reduce(older, self);
  const duplicates = [self, ...others].filter((candidate) => candidate !== keeper);
  if (duplicates.length === 0) return null;
  // One at a time: a duplicate left alone does not stop the others.
  const finished: Finished[] = [];
  let own: Finished | null = null;
  for (const duplicate of duplicates) {
    const result = await cancelAndRefund(duplicate, deps);
    if (duplicate === self) own = result;
    finished.push(result);
  }
  return duplicateOutcome(finished, true, own);
}

/**
 * The writer refused an entitling subscription without the duplicate mark
 * because the customer is linked to another user or the user to another
 * customer (a second Checkout made a second customer): it can never be
 * recorded for this user, so it is always finished
 * ({@link cancelAndRefund}), whatever else the user has. The user's other
 * subscriptions (listed by the database, checked in Stripe like the
 * duplicate rule's, see {@link liveOthers}) only set the log code: null when
 * one is live and unmarked (the user keeps it), `unrecordable_refunded` when
 * none is or there is no user id (the customer is refunded and left without
 * a subscription). A malformed latest invoice id leaves the subscription
 * alone, rejected `invalid_subscription`, before any further Stripe call.
 */
async function customerUserMismatch(
  subscription: NormalizedSubscription,
  self: Candidate,
  deps: WebhookDeps,
): Promise<DuplicateOutcome> {
  const otherIds = await otherEntitlingIds(deps, subscription);
  const kept =
    latestInvoiceId(self.latestInvoice) !== undefined &&
    (await liveOthers(otherIds, deps)).some((other) => !other.marked);
  return finishSelf(self, kept, deps);
}

/**
 * Finishes a duplicate: marks it (`metadata.duplicate_subscription=true`,
 * unless it already carries the mark), refunds the paid payments of its
 * latest invoice ({@link refundPaidPayments}; a duplicate is caught at its
 * first event, so that is normally its only one), then cancels it now:
 * `canceled`. One without a latest invoice is marked and canceled. A payment
 * that is not paid yet (e.g. `open`: a payment method that settles later) is
 * not waited for: canceling at once ends the subscription's billing, so no
 * further invoice follows, and a payment that still settles after the cancel
 * is refunded when its `invoice.paid` arrives, the subscription carrying the
 * mark ({@link refundEventInvoice}).
 *
 * Left alone instead: one whose `latest_invoice` is present but not an
 * {@link INV_ID_REGEX} id (or an expanded invoice with one), as the paid
 * invoice is unknown: `invalid_subscription`, without any Stripe call.
 *
 * Callers pass only subscriptions in an entitling status. Mark, then refund,
 * then cancel: after any failure the subscription is still entitling and
 * marked, so the retried delivery finishes it rather than keeping it; once
 * canceled the duplicate rule never looks at it again, so a refund after the
 * cancel would be lost to a failure in between. The mark carries an
 * Idempotency-Key, so a retry gets the first request's result. The cancel
 * carries none (Stripe ignores Idempotency-Key on DELETE): if Stripe refuses
 * a repeated cancel with a 4xx, that refusal, like any 4xx answer to the
 * cancel, is done when Stripe now shows the subscription canceled. Any other
 * failure is transient, with the code of the call that failed.
 */
async function cancelAndRefund(subscription: Candidate, deps: WebhookDeps): Promise<Finished> {
  const latestInvoice = latestInvoiceId(subscription.latestInvoice);
  if (latestInvoice === undefined) return "invalid_subscription";

  if (!subscription.marked) {
    const marked = await deps.stripe.markDuplicateSubscription(subscription.id);
    if (!marked.ok) throw new TransientFailure(stripeFailure(marked));
  }

  if (latestInvoice !== null) await refundPaidPayments(latestInvoice, subscription.id, deps);

  const canceled = await deps.stripe.cancelSubscription(subscription.id);
  if (canceled.ok) return "canceled";
  if (canceled.kind !== "http" || canceled.status < 400 || canceled.status >= 500) {
    throw new TransientFailure(stripeFailure(canceled));
  }
  // Refused (e.g. if it was canceled meanwhile or by an earlier delivery): done only when Stripe now shows it canceled.
  const again = await deps.stripe.retrieveSubscription(subscription.id);
  if (!again.ok) throw new TransientFailure(stripeFailure(again));
  if (asRecord(again.data)?.status !== "canceled") throw new TransientFailure(stripeFailure(canceled));
  return "canceled";
}

/**
 * Refunds every paid payment of the duplicate `subscriptionId`'s invoice
 * `invoiceId` (`GET /v1/invoice_payments`) by the payment's `amount_paid`;
 * true when the invoice had one. A payment that is not `paid` (e.g. `open`)
 * is ignored, and so is one that is not a payment intent or whose payment
 * intent id or `amount_paid` (a positive whole number of øre) is malformed.
 * A refund carries an Idempotency-Key (`dup-refund-<payment intent id>`), so
 * a retry gets the first request's result, and one Stripe reports as
 * `charge_already_refunded` is done. Any other failure is transient.
 */
async function refundPaidPayments(invoiceId: string, subscriptionId: string, deps: WebhookDeps): Promise<boolean> {
  const listed = await deps.stripe.listInvoicePayments(invoiceId);
  if (!listed.ok) throw new TransientFailure(stripeFailure(listed));
  const payments = asRecord(listed.data)?.data;
  if (!Array.isArray(payments)) throw new TransientFailure("stripe_invalid_response");
  let refunded = false;
  for (const entry of payments) {
    const invoicePayment = asRecord(entry);
    const payment = asRecord(invoicePayment?.payment);
    const paymentIntent = payment?.payment_intent;
    const amount = invoicePayment?.amount_paid;
    if (
      invoicePayment?.status !== "paid" ||
      payment?.type !== "payment_intent" ||
      typeof paymentIntent !== "string" ||
      !PI_ID_REGEX.test(paymentIntent) ||
      !isRefundableAmount(amount)
    ) {
      continue;
    }
    const refund = await deps.stripe.createRefund(paymentIntent, subscriptionId, amount);
    if (!refund.ok && !(refund.kind === "http" && refund.code === "charge_already_refunded")) {
      throw new TransientFailure(stripeFailure(refund));
    }
    refunded = true;
  }
  return refunded;
}

/**
 * The money of a subscription carrying the duplicate mark is always refunded:
 * on `invoice.paid` (`invoiceId`, the event's own invoice) of a subscription
 * that carried the mark when retrieved, in any status, canceled included, or
 * got it in this delivery (its finish marked it), after the write
 * (`handled`: what the write and the duplicate rule made of the event). When
 * the duplicate rule finished it in this delivery (`finished`, see
 * {@link cancelAndRefund}; null when it was not), its latest invoice is
 * refunded already (none when it has none or a malformed id left it alone):
 * this invoice is refunded too unless it is that one (never listed twice),
 * and the outcome stays the finish's. Otherwise (a marked one that is not
 * entitling) the paid payments of this invoice are refunded
 * ({@link refundPaidPayments}): `duplicate_invoice_refunded`, code null, the
 * writer's paused (null after a refusal); without a paid payment the outcome
 * stays the writer's. So a payment that settles after its duplicate was
 * canceled (a payment method that settles later, an older open invoice paid
 * later) is refunded when its `invoice.paid` arrives, and so is an older
 * invoice of a duplicate first found at that invoice's event. A failure is
 * transient: the write is idempotent per event id and the refunds per payment
 * intent, so the retried delivery refunds what is left.
 */
async function refundEventInvoice(
  handled: Handled,
  self: Candidate,
  finished: Finished | null,
  invoiceId: string,
  deps: WebhookDeps,
): Promise<Handled> {
  // Only a canceled finish marked it here: a malformed latest invoice id leaves an unmarked one unmarked.
  if (!self.marked && finished !== "canceled") return handled;
  if (finished !== null) {
    if (latestInvoiceId(self.latestInvoice) !== invoiceId) await refundPaidPayments(invoiceId, self.id, deps);
    return handled;
  }
  if (!(await refundPaidPayments(invoiceId, self.id, deps))) return handled;
  return { outcome: "duplicate_invoice_refunded", code: null, paused: handled.paused };
}
