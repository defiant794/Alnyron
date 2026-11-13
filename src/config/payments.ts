/**
 * Payments (Monitor subscriptions through Stripe's hosted Checkout and
 * Billing Portal). The web app only starts a Checkout or Portal session and
 * reads the user's own payments rows; the Stripe webhooks that write them are
 * handled by the separate `alnyron-payments` Worker (workers/payments/), which
 * shares the constants below.
 */

/** The Monitor subscription page: the upgrade card, or the user's subscription and "Administrér abonnement". */
export const MONITOR_BILLING_PATH = "/monitor/billing";

/** Value of `?checkout=` on Checkout's success_url: back from Stripe, the subscription may not be recorded yet. */
export const BILLING_CHECKOUT_DONE = "done";

/** Value of `?error=` after `startSubscriptionCheckout` could not open Stripe's payment page. */
export const BILLING_ERROR_CHECKOUT = "checkout";

/** Value of `?error=` after `openBillingPortal` could not open Stripe's Billing Portal. */
export const BILLING_ERROR_PORTAL = "portal";

/** The billing periods a plan is sold in (`monitor_plans.billing_interval`). */
export const BILLING_INTERVALS = ["month", "year"] as const;

export type BillingInterval = (typeof BILLING_INTERVALS)[number];

/** The period the upgrade form preselects. */
export const BILLING_DEFAULT_INTERVAL: BillingInterval = "year";

/**
 * Subscription statuses that have ended for good (the same two as
 * `admin_delete_monitor_user`'s guard; Stripe never changes either again). A
 * subscription in any other status still exists: the user manages it in the
 * Billing Portal and is never sent to a second Checkout.
 */
export const SUBSCRIPTION_ENDED_STATUSES = ["canceled", "incomplete_expired"] as const;

/**
 * Subscription statuses that raise the user's monitor cap to the plan's: the
 * same list as the database's `private.entitling_subscription_statuses()`.
 * The webhook Worker checks duplicate subscriptions only for these.
 */
export const ENTITLING_SUBSCRIPTION_STATUSES = ["trialing", "active", "past_due"] as const;

/** Whether a subscription in `status` raises the user's monitor cap. */
export function isEntitlingStatus(status: string): boolean {
  return (ENTITLING_SUBSCRIPTION_STATUSES as readonly string[]).includes(status);
}

/**
 * `metadata.kind` of every Monitor subscription Checkout Session and of the
 * subscription it creates (set server-side with `metadata.user_id`); the
 * webhook Worker handles only Checkouts tagged with it.
 */
export const MONITOR_SUBSCRIPTION_KIND = "monitor_subscription";

/**
 * How long a Checkout Session stays open (its `expires_at`, from now). Stripe
 * requires at least 30 minutes after ITS creation time; the extra minute
 * covers the request's latency and clock skew between this server and Stripe.
 */
export const CHECKOUT_SESSION_TTL_SECONDS = 31 * 60;

/** How long one Stripe API request may take before it is aborted and fails. */
export const STRIPE_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Per-user throttle on the billing actions: at most BILLING_RATE_LIMIT
 * Checkout or Billing Portal sessions per BILLING_RATE_PERIOD_SECONDS, so one
 * account cannot use up the Stripe API rate limit every customer shares. The
 * Workers Rate Limiting binding `BILLING_RATE_LIMITER` enforces it with the
 * numbers in wrangler.jsonc (`ratelimits`), the only place Cloudflare reads
 * them; a unit test pins them to these two. The period must be 10 or 60.
 */
export const BILLING_RATE_LIMIT = 10;

/** The window of BILLING_RATE_LIMIT, in seconds. */
export const BILLING_RATE_PERIOD_SECONDS = 60;

/** The webhook Worker's only path (`https://pay.alnyron.dk/webhook`); every other path is a 404. */
export const PAYMENTS_WEBHOOK_PATH = "/webhook";

/**
 * How far a webhook's signed timestamp (`Stripe-Signature` `t=`) may be from
 * the Worker's clock, in the past or the future, in seconds (Stripe's own
 * libraries default to 300): an older delivery is refused as a replay.
 */
export const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300;

/** The largest webhook body the Worker reads (1 MiB); a larger one is refused with 413. */
export const PAYMENTS_WEBHOOK_MAX_BODY_BYTES = 1_048_576;

/** How long one Supabase request of the webhook Worker may take before it is aborted and fails. */
export const PAYMENTS_RPC_TIMEOUT_MS = 5_000;

/**
 * The most `v1` signatures a `Stripe-Signature` header may carry: a header
 * with more is refused as malformed before any HMAC is computed, so one
 * unsigned request cannot make the Worker compute thousands of HMACs over a
 * 1 MiB body.
 */
export const STRIPE_WEBHOOK_MAX_SIGNATURES = 8;

/**
 * The most other subscriptions of a user the webhook Worker's duplicate
 * rule reads and retrieves from Stripe per delivery (the oldest recorded
 * first), which keeps a delivery's subrequests under the Workers Free limit
 * of 50 (the count is in workers/payments/webhook.ts). A user with more is
 * handled over several deliveries: a canceled duplicate leaves the set.
 */
export const PAYMENTS_MAX_DUPLICATE_CANDIDATES = 5;
