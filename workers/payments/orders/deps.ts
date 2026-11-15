import type { PaymentsEnv } from "../env";
import { createPaymentsRpc, type PaymentsRpc, type WithdrawalRpc } from "../rpc";
import type { OrdersEnv } from "./env";
import { createOrderMailer, type OrderMailer } from "./mail";
import { createOrderRpc, type OrderRpc } from "./rpc";
import { createOrderStripeApi, type OrderStripeApi } from "./stripe";

/** Everything the goods code (OrderService, the sweep's order pass) calls out to, built from the Worker's env. */
export type OrderDeps = {
  stripe: OrderStripeApi;
  rpc: OrderRpc;
  /** Supabase Auth through the shared payments client: the user of an access token. */
  auth: Pick<PaymentsRpc & WithdrawalRpc, "getUser">;
  mail: OrderMailer;
  ordersEnv: OrdersEnv;
  /** The main site's origin (`SITE_URL`): Checkout's return URLs, the emails' links. */
  siteOrigin: string;
  /** The current time in milliseconds (`Date.now`). */
  now: () => number;
  /** Writes one log line (JSON, ids and codes only). */
  log: (line: string) => void;
};

/**
 * The goods Stripe, Supabase and Resend clients for `config` and
 * `ordersEnv`. `fetchImpl` stands in for the global fetch in all of them (the
 * sweep counts its subrequests through it).
 */
export function createOrderDeps(config: PaymentsEnv, ordersEnv: OrdersEnv, fetchImpl?: typeof fetch): OrderDeps {
  return {
    stripe: createOrderStripeApi(config.stripeKey, fetchImpl),
    rpc: createOrderRpc(config.supabaseUrl, config.supabaseSecretKey, fetchImpl),
    auth: createPaymentsRpc(config.supabaseUrl, config.supabaseSecretKey, fetchImpl),
    mail: createOrderMailer({
      resendApiKey: config.resendApiKey,
      mailFrom: config.mailFrom,
      siteUrl: config.siteUrl,
      ordersEnv,
      fetchImpl,
    }),
    ordersEnv,
    siteOrigin: new URL(config.siteUrl).origin,
    now: () => Date.now(),
    log: (line) => console.log(line),
  };
}
