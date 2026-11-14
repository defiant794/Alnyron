/**
 * Payments (Monitor subscriptions through Stripe's hosted Checkout and
 * Billing Portal). The web app only starts a Checkout or Portal session and
 * reads the user's own payments rows; the Stripe webhooks that write them are
 * handled by the separate `alnyron-payments` Worker (workers/payments/), which
 * shares the constants below.
 */

import type { Locale } from "next-intl";
import { SYSTEM_PAGE_PATHNAMES } from "@/config/system-pages";

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
 * Checkout or Billing Portal sessions or withdrawal submits ("Bekræft
 * fortrydelse") together per BILLING_RATE_PERIOD_SECONDS, so one account
 * cannot use up the Stripe API rate limit every customer shares. The
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

/** The withdrawal confirm page (step 2 of 2, "Bekræft fortrydelse"), on the Monitor host. */
export const MONITOR_WITHDRAW_PATH = "/monitor/billing/withdraw";

/**
 * The main site's terms page (/terms, handelsbetingelser) in `locale` as an
 * absolute URL on `siteOrigin`: Danish (the default locale) unprefixed,
 * English under `/en`, as the site routing's as-needed locale prefix serves
 * it. Checkout's consent text and the emails link it; the payments Worker
 * builds it too, without the app's router.
 */
export function termsPageUrl(siteOrigin: string, locale: Locale): string {
  const prefix = locale === "da" ? "" : `/${locale}`;
  return `${siteOrigin}${prefix}${SYSTEM_PAGE_PATHNAMES.terms}`;
}

/** How long one pass over a withdrawal may hold it before another may take it over (`payments_claim_withdrawal`). */
export const WITHDRAWAL_LEASE_SECONDS = 120;

/**
 * Passes over a withdrawal (claims) after which one still not canceled and
 * refunded goes to the owner as `needs_manual retries_exhausted`: the hourly
 * sweep gives up after about eight hours, well inside the 14 days the refund
 * is due in.
 */
export const WITHDRAWAL_MAX_ATTEMPTS = 8;

/**
 * Passes over a withdrawal (claims, counted from its first) after which one
 * whose only work left is an email (the receipt, or the owner alert of a
 * needs_manual one) is no longer listed for the sweep (`payments_pending_work`),
 * so an email Resend keeps refusing cannot hold sweep capacity for ever. A day
 * of hourly sweeps: an email outage or the daily sending quota passes in that
 * time, and the alert of a withdrawal that went to `retries_exhausted` at pass
 * WITHDRAWAL_MAX_ATTEMPTS + 1 still gets the passes up to this one.
 */
export const WITHDRAWAL_MAX_MAIL_ATTEMPTS = 24;

/** How many withdrawals and how many unsent order confirmations one sweep reads (`payments_pending_work`). */
export const PAYMENTS_SWEEP_LIMIT = 20;

/**
 * The subrequests (Stripe, Supabase and Resend fetches) one sweep may make, per
 * contract A8: no item starts whose worst case (a withdrawal pass
 * WITHDRAWAL_PASS_MAX_SUBREQUESTS, an order confirmation
 * PAYMENTS_SWEEP_CONSENT_SUBREQUESTS) could take the run past this many, so a
 * run makes 45 at most. Workers Free allows 50 per invocation (per
 * Cloudflare's limits docs as of 2026-11).
 */
export const PAYMENTS_SWEEP_SUBREQUEST_BUDGET = 45;

/**
 * The least a sweep charges one withdrawal pass, per contract A8: 10. A pass
 * is charged what it really made, at least this, and starts only when its
 * real worst case, WITHDRAWAL_PASS_MAX_SUBREQUESTS (15), still fits the
 * budget.
 */
export const PAYMENTS_SWEEP_WITHDRAWAL_SUBREQUESTS = 10;

/**
 * The most subrequests one `processWithdrawal` pass makes: the claim; the
 * retrieve, the cancel, the re-retrieve after a refused cancel, the canceled
 * step, the invoice list, the credit note list, the create refused and the
 * needs_manual step (8); the receipt's send, its step and a failed step when
 * that fails (3); the owner alert's the same (3): 15.
 */
export const WITHDRAWAL_PASS_MAX_SUBREQUESTS = 15;

/** The subrequests a sweep reserves for one order confirmation (account email lookup, send, stamp, spare). */
export const PAYMENTS_SWEEP_CONSENT_SUBREQUESTS = 4;
