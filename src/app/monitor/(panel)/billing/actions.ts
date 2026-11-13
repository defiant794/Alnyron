"use server";

import type { Locale } from "next-intl";
import { redirect } from "next/navigation";
import { z } from "zod";
import { parseSiteEnv } from "@/config/env";
import { monitorSiteOrigin } from "@/config/monitor";
import {
  BILLING_ERROR_CHECKOUT,
  BILLING_ERROR_PORTAL,
  BILLING_INTERVALS,
  MONITOR_BILLING_PATH,
} from "@/config/payments";
import { getStripeEnv, type StripeEnv } from "@/config/stripe-env";
import { getMonitorLocale } from "@/i18n/monitor-locale";
import { buildBillingPortalParams, buildSubscriptionCheckoutParams } from "@/lib/payments/checkout-params";
import { allowBillingSession } from "@/lib/payments/rate-limit";
import { createBillingPortalSession, createCheckoutSession } from "@/lib/payments/stripe";
import { requireMonitor } from "@/services/auth/require-role";
import { getBillingCustomerId, getCurrentSubscription, getMonitorPlanByInterval } from "@/services/payments/billing";

/** The upgrade form's only field: which plan's billing period. */
const intervalSchema = z.enum(BILLING_INTERVALS);

/** Back to the billing page, which then says the Stripe page could not be opened. */
function billingError(error: typeof BILLING_ERROR_CHECKOUT | typeof BILLING_ERROR_PORTAL): never {
  redirect(`${MONITOR_BILLING_PATH}?${new URLSearchParams({ error })}`);
}

/** The Stripe env, or null when it is missing or malformed (the error names variables only and is not shown). */
function stripeEnvOrNull(): StripeEnv | null {
  try {
    return getStripeEnv();
  } catch {
    return null;
  }
}

/** Opens the customer's Billing Portal, or back to the billing page with `?error=portal`. */
async function redirectToBillingPortal(stripeCustomerId: string | null, locale: Locale): Promise<never> {
  const env = stripeEnvOrNull();
  if (stripeCustomerId === null || env === null) billingError(BILLING_ERROR_PORTAL);
  const portal = await createBillingPortalSession(
    env.checkoutKey,
    buildBillingPortalParams({
      stripeCustomerId,
      locale,
      configurationId: env.portalConfigurationId,
      monitorOrigin: monitorSiteOrigin(parseSiteEnv().NEXT_PUBLIC_SITE_URL),
    }),
  );
  if (!portal.ok) billingError(BILLING_ERROR_PORTAL);
  redirect(portal.data.url);
}

/**
 * The upgrade form (`/monitor/billing`): sends the user to Stripe's hosted
 * Checkout for the active plan of the chosen `interval`, the only field read
 * (a price, amount, customer or URL in the form is ignored: Stripe is sent
 * the database plan's Price for the session's user). A user who already has
 * a subscription that has not ended goes to the Billing Portal instead, never
 * to a second Checkout. Any failure (over the per-user rate limit, bad
 * interval, no such plan, missing Stripe env, a Stripe error) returns to the
 * billing page with `?error=checkout`. Owner and `monitor_user` only. Nothing
 * is written: the webhook records the subscription once it is paid.
 */
export async function startSubscriptionCheckout(formData: FormData): Promise<never> {
  const user = await requireMonitor();
  // Before any database or Stripe call; fails closed (see allowBillingSession).
  if (!(await allowBillingSession(user.userId))) billingError(BILLING_ERROR_CHECKOUT);
  const interval = intervalSchema.safeParse(formData.get("interval"));
  if (!interval.success) billingError(BILLING_ERROR_CHECKOUT);

  const [subscription, plan, stripeCustomerId, locale] = await Promise.all([
    getCurrentSubscription(),
    getMonitorPlanByInterval(interval.data),
    getBillingCustomerId(),
    getMonitorLocale(),
  ]);
  if (subscription !== null) return redirectToBillingPortal(stripeCustomerId, locale);
  if (plan === null) billingError(BILLING_ERROR_CHECKOUT);
  const env = stripeEnvOrNull();
  if (env === null) billingError(BILLING_ERROR_CHECKOUT);

  // Duplicate subscriptions are the webhook slice's rule; backstop: Dashboard "Limit customers to one subscription".
  const session = await createCheckoutSession(
    env.checkoutKey,
    buildSubscriptionCheckoutParams({
      userId: user.userId,
      email: user.email,
      locale,
      plan,
      stripeCustomerId,
      taxRateId: env.taxRateId,
      // From NEXT_PUBLIC_SITE_URL (allowlist-checked), never the request's Host.
      monitorOrigin: monitorSiteOrigin(parseSiteEnv().NEXT_PUBLIC_SITE_URL),
      nowSeconds: Math.floor(Date.now() / 1000),
    }),
  );
  if (!session.ok) billingError(BILLING_ERROR_CHECKOUT);
  redirect(session.data.url);
}

/**
 * "Administrér abonnement" (`/monitor/billing`): opens the user's Stripe
 * Billing Portal (cancel, switch between monthly and yearly, payment method),
 * which returns to the billing page. Over the per-user rate limit, without a
 * Stripe customer, or on any Stripe failure, back to the billing page with
 * `?error=portal`. Owner and `monitor_user` only.
 */
export async function openBillingPortal(): Promise<never> {
  const user = await requireMonitor();
  if (!(await allowBillingSession(user.userId))) billingError(BILLING_ERROR_PORTAL);
  const [stripeCustomerId, locale] = await Promise.all([getBillingCustomerId(), getMonitorLocale()]);
  return redirectToBillingPortal(stripeCustomerId, locale);
}
