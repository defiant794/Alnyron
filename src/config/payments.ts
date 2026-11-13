/**
 * Payments (Monitor subscriptions through Stripe's hosted Checkout and
 * Billing Portal). The web app only starts a Checkout or Portal session and
 * reads the user's own payments rows; the Stripe webhooks that write them are
 * handled outside the app.
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
 * Subscription statuses that raise the user's monitor cap to the plan's
 * (`private.entitling_subscription_statuses()`).
 */
export const SUBSCRIPTION_ENTITLING_STATUSES = ["trialing", "active", "past_due"] as const;

/** Whether a subscription in `status` raises the user's monitor cap. */
export function isEntitlingStatus(status: string): boolean {
  return (SUBSCRIPTION_ENTITLING_STATUSES as readonly string[]).includes(status);
}

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
