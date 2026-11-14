/**
 * Stripe request parameters for the Monitor subscription, built on the server
 * only from server-side data: the signed-in user, the database plan, the
 * Stripe env, the Monitor origin (`monitorSiteOrigin` of
 * `NEXT_PUBLIC_SITE_URL`, never a request's Host) and the main site's origin.
 * Pure: no I/O, no clock.
 */

import type { Locale } from "next-intl";
import { WITHDRAWAL_TEXTS, WITHDRAWAL_TEXT_VERSION, checkoutConsentMessage } from "@/config/legal/withdrawal-texts";
import {
  BILLING_CHECKOUT_DONE,
  CHECKOUT_SESSION_TTL_SECONDS,
  MONITOR_BILLING_PATH,
  MONITOR_SUBSCRIPTION_KIND,
  termsPageUrl,
} from "@/config/payments";

/** Tags the session and the subscription it creates, for the webhook handler. */
export type SubscriptionMetadata = {
  kind: typeof MONITOR_SUBSCRIPTION_KIND;
  user_id: string;
  plan_id: string;
  locale: Locale;
  /** The legal text version shown at Checkout (consent and withdrawal information). */
  withdrawal_text_version: string;
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
  /** The main site's origin (`siteOrigin()`), where /terms is served. */
  siteOrigin: string;
  /** Unix time now, in seconds. */
  nowSeconds: number;
};

/** `POST /v1/checkout/sessions` parameters of a Monitor subscription. */
export type SubscriptionCheckoutParams = {
  mode: "subscription";
  ui_mode: "hosted_page";
  locale: Locale;
  line_items: { price: string; quantity: number }[];
  consent_collection: { terms_of_service: "required" };
  custom_text: {
    terms_of_service_acceptance: { message: string };
    submit: { message: string };
  };
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
 *
 * Withdrawal right (fortrydelsesret): Stripe's terms checkbox is required
 * (`consent_collection`) and carries the versioned consent text with a link
 * to the main site's /terms in the session's language; the line above the
 * pay button tells the 14-day right. Both copies of the metadata name the
 * text version, which the webhook Worker records with the consent.
 */
export function buildSubscriptionCheckoutParams(input: SubscriptionCheckoutInput): SubscriptionCheckoutParams {
  const { userId, email, locale, plan, stripeCustomerId, taxRateId, monitorOrigin, siteOrigin, nowSeconds } = input;
  const metadata: SubscriptionMetadata = {
    kind: MONITOR_SUBSCRIPTION_KIND,
    user_id: userId,
    plan_id: plan.id,
    locale,
    withdrawal_text_version: WITHDRAWAL_TEXT_VERSION,
  };
  return {
    mode: "subscription",
    ui_mode: "hosted_page",
    locale,
    line_items: [{ price: plan.stripePriceId, quantity: 1 }],
    consent_collection: { terms_of_service: "required" },
    custom_text: {
      terms_of_service_acceptance: { message: checkoutConsentMessage(locale, termsPageUrl(siteOrigin, locale)) },
      submit: { message: WITHDRAWAL_TEXTS[locale].checkoutSubmit },
    },
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
