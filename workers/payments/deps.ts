import type { PaymentsEnv } from "./env";
import { createMailer, type Mailer } from "./mail";
import { createPaymentsRpc, type PaymentsRpc, type WithdrawalRpc } from "./rpc";
import { createStripeApi, type StripeApi, type WithdrawalStripeApi } from "./stripe-api";

/** Everything the Worker's handlers call out to, built from its environment. */
export type WorkerDeps = {
  stripe: StripeApi & WithdrawalStripeApi;
  rpc: PaymentsRpc & WithdrawalRpc;
  mail: Mailer;
  /** The current time in milliseconds (`Date.now`). */
  now: () => number;
  /** Writes one log line (JSON, ids and codes only). */
  log: (line: string) => void;
};

/**
 * The Worker's Stripe, Supabase and Resend clients for `config`. `fetchImpl`
 * stands in for the global fetch in all three (the sweep counts its
 * subrequests through it).
 */
export function createWorkerDeps(config: PaymentsEnv, fetchImpl?: typeof fetch): WorkerDeps {
  return {
    stripe: createStripeApi(config.stripeKey, fetchImpl),
    rpc: createPaymentsRpc(config.supabaseUrl, config.supabaseSecretKey, fetchImpl),
    mail: createMailer({
      resendApiKey: config.resendApiKey,
      mailFrom: config.mailFrom,
      withdrawalAlertTo: config.withdrawalAlertTo,
      siteUrl: config.siteUrl,
      fetchImpl,
    }),
    now: () => Date.now(),
    log: (line) => console.log(line),
  };
}
