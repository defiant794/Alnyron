import * as z from "zod/mini";

/**
 * Environment of the webhook Worker `alnyron-payments`: `vars` from its
 * wrangler.jsonc plus three secrets (`wrangler secret put … --config
 * workers/payments/wrangler.jsonc`, or `.dev.vars` locally). Separate from the
 * web app's env on purpose: the Supabase secret key bypasses RLS and the
 * Stripe key moves money, so neither may reach the public app bundle.
 *
 * `zod/mini` keeps the bundle small (the classic `zod` import adds about
 * 440 KiB of minified code; the Worker parses its bundle at every cold start).
 */

const httpsUrl = z.string().check(z.refine((value) => URL.canParse(value) && new URL(value).protocol === "https:"));

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
});

export type PaymentsEnv = {
  supabaseUrl: string;
  supabaseSecretKey: string;
  stripeKey: string;
  webhookSecret: string;
  livemode: boolean;
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
  };
}
