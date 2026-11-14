/**
 * Pure mappers from Stripe objects (API version 2026-10-28.endive, see
 * STRIPE_API_VERSION) to the JSON payloads of the 1a database writers
 * `payments_sync_subscription` and `payments_record_subscription_invoice`.
 * Every mapper takes `unknown` and never throws: an object without the fields
 * a writer needs maps to null. Money stays integer øre end to end (Stripe's
 * smallest DKK unit): no floats, no division.
 *
 * Field paths are those of the pinned version: a subscription's period end is
 * on its item (`items.data[].current_period_end`), an invoice's subscription
 * under `parent.subscription_details.subscription`, its tax in `total_taxes`.
 */

import { MONITOR_SUBSCRIPTION_KIND } from "@/config/payments";

/** Every status a Stripe subscription can have (the writers accept these and no other). */
export const STRIPE_SUBSCRIPTION_STATUSES = [
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
] as const;

export type StripeSubscriptionStatus = (typeof STRIPE_SUBSCRIPTION_STATUSES)[number];

/** The fields of a verified Stripe event that the writers record. */
export type StripeEventHeader = { id: string; type: string; created: number; livemode: boolean };

/** The writers' `p_event`: `created` as ISO 8601 text. */
export type RpcEvent = { id: string; type: string; created: string; livemode: boolean };

/** The writers' `p_subscription`: exactly the keys 1a reads. */
export type SubscriptionPayload = {
  id: string;
  customer: string;
  user_id: string | null;
  price_id: string;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  /** Stripe's `start_date` (when the contract was made) as ISO text, stored once as `started_at`. */
  start_date: string;
};

/**
 * A subscription the writers can take, plus what the duplicate rule reads:
 * its Stripe `created` (Unix seconds) and whether it carries the duplicate
 * mark. Neither goes to the writers.
 */
export type NormalizedSubscription = Omit<SubscriptionPayload, "status"> & {
  status: StripeSubscriptionStatus;
  created: number;
  duplicate_marked: boolean;
};

/** The invoice writer's `p_invoice`. */
export type InvoicePayload = {
  id: string;
  subscription_id: string;
  email: string;
  amount_total_ore: number;
  amount_tax_ore: number;
  period_start: string | null;
  period_end: string | null;
  paid_at: string;
};

/**
 * The Stripe ids the webhook Worker accepts: the object's prefix, then only
 * letters and digits. Every id from an event or a Stripe object is checked
 * with these before it reaches a writer or a Stripe request path, query or
 * body (the mappers here, the handler, and `workers/payments/stripe-api.ts`).
 */
export const SUB_ID_REGEX = /^sub_[A-Za-z0-9]+$/;
export const INV_ID_REGEX = /^in_[A-Za-z0-9]+$/;
export const PI_ID_REGEX = /^pi_[A-Za-z0-9]+$/;
export const CUS_ID_REGEX = /^cus_[A-Za-z0-9]+$/;
export const EVT_ID_REGEX = /^evt_[A-Za-z0-9]+$/;

/** A canonical lowercase UUID, as the web app puts it into `metadata.user_id`. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The largest |Unix seconds| a Date can hold (±8.64e15 ms). */
const MAX_UNIX_SECONDS = 8_640_000_000_000;

/** `value` as a record of unknown fields, or null when it is no plain object. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Whether `value` is a whole number of Unix seconds a Date can represent. */
export function isUnixSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= MAX_UNIX_SECONDS;
}

/** Whether `value` is a non-negative safe integer (an amount in øre). */
function isOre(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Unix seconds as ISO 8601 UTC with milliseconds (`…T…:…:….000Z`). */
export function unixToIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/** `value` when it is a string `pattern` matches, else null. */
function matchingId(value: unknown, pattern: RegExp): string | null {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

function isSubscriptionStatus(value: unknown): value is StripeSubscriptionStatus {
  return (STRIPE_SUBSCRIPTION_STATUSES as readonly unknown[]).includes(value);
}

/** The writers' `p_event` for a verified event. */
export function eventForRpc(event: StripeEventHeader): RpcEvent {
  return { id: event.id, type: event.type, created: unixToIso(event.created), livemode: event.livemode };
}

/**
 * The user a Stripe object's `metadata` names: `metadata.user_id` when
 * `metadata.kind` is {@link MONITOR_SUBSCRIPTION_KIND} and the id is a
 * canonical lowercase UUID, else null. The web app sets both server-side.
 */
export function metadataUserId(object: unknown): string | null {
  const metadata = asRecord(asRecord(object)?.metadata);
  const userId = metadata?.user_id;
  return metadata?.kind === MONITOR_SUBSCRIPTION_KIND && typeof userId === "string" && UUID.test(userId) ? userId : null;
}

/**
 * The metadata key the webhook Worker sets to `"true"` on a subscription it
 * found to be a duplicate, before refunding and canceling it.
 */
export const DUPLICATE_MARK_KEY = "duplicate_subscription";

/** Whether a Stripe subscription carries the duplicate mark (`metadata.duplicate_subscription` is `"true"`). */
export function isDuplicateMarked(subscription: unknown): boolean {
  return asRecord(asRecord(subscription)?.metadata)?.[DUPLICATE_MARK_KEY] === "true";
}

/**
 * A Stripe subscription as the sync writer takes it, or null when it lacks
 * something the writer needs: a {@link SUB_ID_REGEX} id, a {@link CUS_ID_REGEX}
 * customer (an expanded customer's `.id`), one of the 8 statuses, a boolean `cancel_at_period_end`,
 * integer `created` and `start_date` (Unix seconds; `start_date` becomes ISO
 * text, stored once as `started_at`), and exactly one item with a string
 * `price.id`. The item's integer `current_period_end` becomes ISO text, else
 * null; `user_id` is {@link metadataUserId} (null lets the writer fall back to
 * the customer's user); `duplicate_marked` is {@link isDuplicateMarked}.
 */
export function normalizeSubscription(subscription: unknown): NormalizedSubscription | null {
  const sub = asRecord(subscription);
  if (sub === null) return null;
  const id = matchingId(sub.id, SUB_ID_REGEX);
  const customer = matchingId(typeof sub.customer === "string" ? sub.customer : asRecord(sub.customer)?.id, CUS_ID_REGEX);
  const items = asRecord(sub.items)?.data;
  if (
    id === null ||
    customer === null ||
    !isSubscriptionStatus(sub.status) ||
    typeof sub.cancel_at_period_end !== "boolean" ||
    !isUnixSeconds(sub.created) ||
    !isUnixSeconds(sub.start_date) ||
    !Array.isArray(items) ||
    items.length !== 1
  ) {
    return null;
  }
  const item = asRecord(items[0]);
  const priceId = asRecord(item?.price)?.id;
  if (typeof priceId !== "string") return null;
  const periodEnd = item?.current_period_end;
  return {
    id,
    customer,
    user_id: metadataUserId(sub),
    price_id: priceId,
    status: sub.status,
    current_period_end: isUnixSeconds(periodEnd) ? unixToIso(periodEnd) : null,
    cancel_at_period_end: sub.cancel_at_period_end,
    start_date: unixToIso(sub.start_date),
    created: sub.created,
    duplicate_marked: isDuplicateMarked(sub),
  };
}

/** The sync writer's payload: {@link NormalizedSubscription} without `created` and `duplicate_marked`. */
export function toSubscriptionPayload(subscription: NormalizedSubscription): SubscriptionPayload {
  return {
    id: subscription.id,
    customer: subscription.customer,
    user_id: subscription.user_id,
    price_id: subscription.price_id,
    status: subscription.status,
    current_period_end: subscription.current_period_end,
    cancel_at_period_end: subscription.cancel_at_period_end,
    start_date: subscription.start_date,
  };
}

/** The subscription an invoice was billed for (`parent.subscription_details.subscription`), or null. */
export function invoiceSubscriptionId(invoice: unknown): string | null {
  const parent = asRecord(asRecord(invoice)?.parent);
  const subscription = asRecord(parent?.subscription_details)?.subscription;
  return typeof subscription === "string" ? subscription : null;
}

/**
 * A paid Stripe invoice as the invoice writer takes it, or null when it is
 * not a subscription invoice (`parent.type` `subscription_details` with a
 * {@link SUB_ID_REGEX} subscription), has no {@link INV_ID_REGEX} id, no non-negative integer
 * `amount_paid`, no integer `status_transitions.paid_at`, or a `total_taxes`
 * amount that is not a non-negative integer. `email` is `customer_email`, else
 * empty; the tax is the sum of `total_taxes` (0 when there are none); the
 * period runs from the earliest `lines.data[].period.start` to the latest
 * `period.end` (null when no line has one).
 */
export function normalizeInvoice(invoice: unknown): InvoicePayload | null {
  const inv = asRecord(invoice);
  if (inv === null) return null;
  const id = matchingId(inv.id, INV_ID_REGEX);
  const subscriptionId =
    asRecord(inv.parent)?.type === "subscription_details" ? matchingId(invoiceSubscriptionId(inv), SUB_ID_REGEX) : null;
  const paidAt = asRecord(inv.status_transitions)?.paid_at;
  if (id === null || subscriptionId === null || !isOre(inv.amount_paid) || !isUnixSeconds(paidAt)) return null;

  let tax = 0;
  if (inv.total_taxes !== undefined && inv.total_taxes !== null) {
    if (!Array.isArray(inv.total_taxes)) return null;
    for (const entry of inv.total_taxes) {
      const amount = asRecord(entry)?.amount;
      if (!isOre(amount)) return null;
      tax += amount;
    }
    if (!Number.isSafeInteger(tax)) return null;
  }

  let start: number | null = null;
  let end: number | null = null;
  const lines = asRecord(inv.lines)?.data;
  for (const line of Array.isArray(lines) ? lines : []) {
    const period = asRecord(asRecord(line)?.period);
    if (isUnixSeconds(period?.start)) start = start === null ? period.start : Math.min(start, period.start);
    if (isUnixSeconds(period?.end)) end = end === null ? period.end : Math.max(end, period.end);
  }

  return {
    id,
    subscription_id: subscriptionId,
    email: typeof inv.customer_email === "string" ? inv.customer_email : "",
    amount_total_ore: inv.amount_paid,
    amount_tax_ore: tax,
    period_start: start === null ? null : unixToIso(start),
    period_end: end === null ? null : unixToIso(end),
    paid_at: unixToIso(paidAt),
  };
}
