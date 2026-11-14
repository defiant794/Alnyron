import * as z from "zod/mini";
import { monitorSiteOrigin } from "@/config/monitor";

/**
 * Environment of the payments Worker `alnyron-payments`: `vars` from its
 * wrangler.jsonc plus four secrets (`wrangler secret put … --config
 * workers/payments/wrangler.jsonc`, or `.dev.vars` locally). Separate from the
 * web app's env on purpose: the Supabase secret key bypasses RLS, the Stripe
 * key moves money and the Resend key sends mail from our domain, so none may
 * reach the public app bundle.
 *
 * `zod/mini` keeps the bundle small (the classic `zod` import adds about
 * 440 KiB of minified code; the Worker parses its bundle at every cold start).
 */

const httpsUrl = z.string().check(z.refine((value) => URL.canParse(value) && new URL(value).protocol === "https:"));

/** A main-site URL whose Monitor host exists (`monitorSiteOrigin` maps it: https://alnyron.dk → https://monitor.alnyron.dk). */
const siteUrl = httpsUrl.check(
  z.refine((value) => {
    try {
      monitorSiteOrigin(value);
      return true;
    } catch {
      return false;
    }
  }),
);

/** Keys in this order: the five of slice 1c, then the four of the withdrawal flow (1d). */
export const paymentsEnvSchema = z.object({
  /** The Supabase project the writers live in. */
  SUPABASE_URL: httpsUrl,
  /** Supabase secret API key (`sb_secret_…`, service_role): EXECUTE on the payments writers. */
  SUPABASE_SECRET_KEY: z.string().check(z.regex(/^sb_secret_[A-Za-z0-9_-]+$/)),
  /** Stripe key: a restricted `rk_live_…` in production, `sk_test_…`/`rk_test_…` in test mode. */
  STRIPE_PAYMENTS_KEY: z.string().check(z.regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/)),
  /** Signing secret (`whsec_…`) of the Stripe Dashboard endpoint this Worker serves. */
  STRIPE_WEBHOOK_SECRET: z.string().check(z.regex(/^whsec_[A-Za-z0-9]+$/)),
  /** `"true"` in production: only live-mode events are processed (test-mode ones are ignored). */
  STRIPE_LIVEMODE: z.enum(["true", "false"]),
  /** Resend API key (`re_…`): the order confirmation, the withdrawal receipt and the owner alert. */
  RESEND_API_KEY: z.string().check(z.regex(/^re_[A-Za-z0-9_]+$/)),
  /** The emails' sender (`Alnyron <noreply@send.alnyron.dk>`), a domain verified at Resend. */
  MAIL_FROM: z.string().check(z.minLength(1)),
  /** Where the owner alert about a withdrawal that needs manual handling goes. */
  WITHDRAWAL_ALERT_TO: z.string().check(z.regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/)),
  /** The main site (https): the emails link /terms there and the withdraw page on its Monitor host. */
  SITE_URL: siteUrl,
});

export type PaymentsEnv = {
  supabaseUrl: string;
  supabaseSecretKey: string;
  stripeKey: string;
  webhookSecret: string;
  livemode: boolean;
  resendApiKey: string;
  mailFrom: string;
  withdrawalAlertTo: string;
  siteUrl: string;
};

/**
 * Validates the Worker's environment. On failure throws an Error that names
 * only the missing or invalid keys (in schema order), never a value. The key
 * must match the mode: live takes only a restricted `rk_live_` key (a full
 * `sk_live_` secret key is refused), test an `sk_test_` or `rk_test_` key.
 */
export function parsePaymentsEnv(raw: unknown): PaymentsEnv {
  const result = paymentsEnvSchema.safeParse(raw);
  if (!result.success) {
    const keys = [...new Set(result.error.issues.map((issue) => String(issue.path[0] ?? "(env)")))];
    throw new Error(`payments: missing or invalid environment keys: ${keys.join(", ")}`);
  }
  const env = result.data;
  const livemode = env.STRIPE_LIVEMODE === "true";
  const keyMatchesMode = livemode
    ? env.STRIPE_PAYMENTS_KEY.startsWith("rk_live_")
    : env.STRIPE_PAYMENTS_KEY.startsWith("sk_test_") || env.STRIPE_PAYMENTS_KEY.startsWith("rk_test_");
  if (!keyMatchesMode) throw new Error("payments: STRIPE_LIVEMODE does not match STRIPE_PAYMENTS_KEY's mode");
  return {
    supabaseUrl: env.SUPABASE_URL,
    supabaseSecretKey: env.SUPABASE_SECRET_KEY,
    stripeKey: env.STRIPE_PAYMENTS_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    livemode,
    resendApiKey: env.RESEND_API_KEY,
    mailFrom: env.MAIL_FROM,
    withdrawalAlertTo: env.WITHDRAWAL_ALERT_TO,
    siteUrl: env.SITE_URL,
  };
}
