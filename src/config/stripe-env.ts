import "server-only";
import { z } from "zod";
import { parseWith } from "@/config/env";

/*
 * Stripe, for the Monitor subscription's Checkout and Billing Portal sessions
 * (src/app/monitor/(panel)/billing/actions.ts). Server-only, unlike
 * src/config/env.ts, which client components and the Edge middleware also
 * load: the Stripe variable names and formats stay out of their bundles
 * (importing this module from a client component fails the build). Validated
 * lazily, like env.ts: importing it reads nothing.
 */

/**
 * A Stripe API key: a secret (`sk_`) or restricted (`rk_`) key in test mode,
 * only a restricted key in live mode. A full live secret key opens the whole
 * Stripe account (refunds, customers) to anyone who gets the Worker's secrets,
 * so it is refused (it belongs only to `scripts/stripe-setup.mjs --live`).
 */
const STRIPE_KEY = /^(?:(?:sk|rk)_test|rk_live)_[A-Za-z0-9]+$/;

/** A live-mode key: the mode is the second underscore-separated part. */
const LIVE_KEY = /^[a-z]+_live_/;

// The key is a restricted `rk_live_` key in production (Checkout Sessions
// write + Customer portal write); the ids are the 25% inclusive "Moms" Tax
// Rate and the Billing Portal configuration that scripts/stripe-setup.mjs
// creates; STRIPE_LIVEMODE says which Stripe mode this deployment runs in
// ("true" in production, "false" everywhere else). The schema checks all four
// and names the bad ones in errors; the key's value is then read on its own
// (getStripeEnv).
const stripeSchema = z.object({
  STRIPE_CHECKOUT_KEY: z.string().regex(STRIPE_KEY),
  STRIPE_TAX_RATE_ID: z.string().regex(/^txr_[A-Za-z0-9]+$/),
  STRIPE_PORTAL_CONFIGURATION_ID: z.string().regex(/^bpc_[A-Za-z0-9]+$/),
  STRIPE_LIVEMODE: z.enum(["true", "false"]),
});

/** The Stripe settings, under names that are not the secret's variable name (see getStripeEnv). */
export type StripeEnv = {
  /** STRIPE_CHECKOUT_KEY: the secret API key, sent only as Stripe's bearer token. */
  checkoutKey: string;
  /** STRIPE_TAX_RATE_ID: the inclusive 25% moms Tax Rate. */
  taxRateId: string;
  /** STRIPE_PORTAL_CONFIGURATION_ID: the Billing Portal configuration. */
  portalConfigurationId: string;
  /** STRIPE_LIVEMODE: true when this deployment takes real payments (the key is then a live key). */
  livemode: boolean;
};

/**
 * The Stripe key and ids, read from process.env at CALL time (lazy); throws
 * naming each missing or malformed variable, never a value. Also throws when
 * the key's mode (`_live_` or `_test_`) is not the STRIPE_LIVEMODE one, so
 * production never runs on a test key and no other server on a live key.
 *
 * The key's variable name may reach the Worker bundle only as a literal
 * `process.env.STRIPE_CHECKOUT_KEY` read or as the schema key above (a call
 * follows it): scripts/guard-no-bundled-secrets.mjs fails `npm run cf:build`
 * on any other occurrence, such as a property read of a parsed object, a
 * destructuring or a string. So the key is returned as `checkoutKey`, taken
 * from that literal read and validated again by the same pattern, and the
 * mode-mismatch error names STRIPE_LIVEMODE only.
 */
export function getStripeEnv(): StripeEnv {
  const env = parseWith(stripeSchema, process.env, "Stripe");
  const checkoutKey = z.string().regex(STRIPE_KEY).parse(process.env.STRIPE_CHECKOUT_KEY);
  const livemode = env.STRIPE_LIVEMODE === "true";
  if (LIVE_KEY.test(checkoutKey) !== livemode) {
    throw new Error("Invalid Stripe environment variables: STRIPE_LIVEMODE does not match the API key's mode");
  }
  return {
    checkoutKey,
    taxRateId: env.STRIPE_TAX_RATE_ID,
    portalConfigurationId: env.STRIPE_PORTAL_CONFIGURATION_ID,
    livemode,
  };
}
