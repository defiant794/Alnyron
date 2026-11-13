/**
 * Stripe request parameters for the Monitor subscription, built on the server
 * only from server-side data: the signed-in user, the database plan, the
 * Stripe env and the Monitor origin (`monitorSiteOrigin` of
 * `NEXT_PUBLIC_SITE_URL`, never a request's Host). Pure: no I/O, no clock.
 */

import type { Locale } from "next-intl";
import { BILLING_CHECKOUT_DONE, CHECKOUT_SESSION_TTL_SECONDS, MONITOR_BILLING_PATH } from "@/config/payments";

/** Tags the session and the subscription it creates, for the webhook handler. */
export type SubscriptionMetadata = {
  kind: "monitor_subscription";
  user_id: string;
  plan_id: string;
  locale: Locale;
};

export type SubscriptionCheckoutInput = {
  userId: string;
  /** The account's login email: Checkout's prefilled email for a customer Stripe does not know yet. */
  email: string;
  locale: Locale;
  /** The active plan of the chosen interval (`monitor_plans`). */
  plan: { id: string; stripePriceId: string };
  /** The user's `billing_customers` row, or null before their first subscription. */
  stripeCustomerId: string | null;
  taxRateId: string;
  monitorOrigin: string;
  /** Unix time now, in seconds. */
  nowSeconds: number;
};

/** `POST /v1/checkout/sessions` parameters of a Monitor subscription. */
export type SubscriptionCheckoutParams = {
  mode: "subscription";
  ui_mode: "hosted_page";
  locale: Locale;
  line_items: { price: string; quantity: number }[];
  subscription_data: { default_tax_rates: string[]; metadata: SubscriptionMetadata };
  metadata: SubscriptionMetadata;
  client_reference_id: string;
  success_url: string;
  cancel_url: string;
  billing_address_collection: "required";
  expires_at: number;
} & ({ customer: string; customer_email?: never } | { customer_email: string; customer?: never });

export type BillingPortalInput = {
  stripeCustomerId: string;
  locale: Locale;
  configurationId: string;
  monitorOrigin: string;
};

/** `POST /v1/billing_portal/sessions` parameters. */
export type BillingPortalParams = {
  customer: string;
  configuration: string;
  locale: Locale;
  return_url: string;
};

/** The billing page on the Monitor origin. */
function billingUrl(monitorOrigin: string): string {
  return `${monitorOrigin}${MONITOR_BILLING_PATH}`;
}

/**
 * Checkout Session parameters for one `plan` at quantity 1: Stripe charges
 * the plan's Price (never an amount from here) with the 25% inclusive Tax
 * Rate. A returning customer is passed as `customer` (no second Stripe
 * customer); a new one as `customer_email`. Success returns to the billing
 * page with `?checkout=done`, cancel to the billing page; the session expires
 * {@link CHECKOUT_SESSION_TTL_SECONDS} after `nowSeconds`.
 */
export function buildSubscriptionCheckoutParams(input: SubscriptionCheckoutInput): SubscriptionCheckoutParams {
  const { userId, email, locale, plan, stripeCustomerId, taxRateId, monitorOrigin, nowSeconds } = input;
  const metadata: SubscriptionMetadata = { kind: "monitor_subscription", user_id: userId, plan_id: plan.id, locale };
  return {
    mode: "subscription",
    ui_mode: "hosted_page",
    locale,
    line_items: [{ price: plan.stripePriceId, quantity: 1 }],
    subscription_data: { default_tax_rates: [taxRateId], metadata: { ...metadata } },
    metadata: { ...metadata },
    client_reference_id: userId,
    ...(stripeCustomerId === null ? { customer_email: email } : { customer: stripeCustomerId }),
    success_url: `${billingUrl(monitorOrigin)}?checkout=${BILLING_CHECKOUT_DONE}`,
    cancel_url: billingUrl(monitorOrigin),
    billing_address_collection: "required",
    expires_at: nowSeconds + CHECKOUT_SESSION_TTL_SECONDS,
  };
}

/** Billing Portal session parameters: the customer's portal with the app's configuration, back to the billing page. */
export function buildBillingPortalParams(input: BillingPortalInput): BillingPortalParams {
  return {
    customer: input.stripeCustomerId,
    configuration: input.configurationId,
    locale: input.locale,
    return_url: billingUrl(input.monitorOrigin),
  };
}
