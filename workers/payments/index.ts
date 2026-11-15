import { PAYMENTS_WEBHOOK_PATH } from "@/config/payments";
import { parsePaymentsEnv, type PaymentsEnv } from "./env";
import { createMailer } from "./mail";
import { createPaymentsRpc } from "./rpc";
import { createStripeApi } from "./stripe-api";
import { runSweep } from "./sweep";
import { handleStripeWebhook } from "./webhook";
import { parseOrdersEnv, type OrdersEnv } from "./orders/env";
import { createOrderMailer } from "./orders/mail";
import { createOrderRpc } from "./orders/rpc";
import { createOrderStripeApi } from "./orders/stripe";

/**
 * Entry of the payments Worker `alnyron-payments` (wrangler.jsonc beside this
 * file):
 * - `fetch`: served on the custom domain pay.alnyron.dk, where Stripe POSTs
 *   its events to `/webhook`. Every other path is a 404 and every other
 *   method a 405, both without a body.
 * - `scheduled`: the hourly sweep (cron `0 * * * *`), see sweep.ts.
 * - `WithdrawalService` and `OrderService`: the named entrypoints the web app
 *   calls over its service bindings `PAYMENTS` (withdrawal-service.ts) and
 *   `ORDERS` (orders/service.ts, goods); routes never reach them.
 */
export { WithdrawalService } from "./withdrawal-service";
export { OrderService } from "./orders/service";

/**
 * Cloudflare's `fetch(request, env, ctx)` and `scheduled(controller, env,
 * ctx)`, typed by hand (the repo type-checks with the DOM lib, not
 * @cloudflare/workers-types). Neither needs the context: they answer only
 * after all their work is done.
 */
type FetchHandler = (request: Request, env: unknown, ctx: unknown) => Promise<Response>;
type ScheduledHandler = (controller: unknown, env: unknown, ctx: unknown) => Promise<void>;

/** The environment, or null after logging the bad keys (names only, never a value). */
function configOrNull(env: unknown): PaymentsEnv | null {
  try {
    return parsePaymentsEnv(env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "payments: invalid environment");
    return null;
  }
}

const fetchHandler: FetchHandler = async (request, env) => {
  if (new URL(request.url).pathname !== PAYMENTS_WEBHOOK_PATH) return new Response(null, { status: 404 });
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });

  const config = configOrNull(env);
  if (config === null) return Response.json({ error: "unavailable" }, { status: 500 });

  try {
    const rpc = createPaymentsRpc(config.supabaseUrl, config.supabaseSecretKey);
    let ordersEnv: OrdersEnv | null;
    try {
      ordersEnv = parseOrdersEnv(env);
    } catch {
      // The goods branch still records orders (logged orders_env_unavailable); the sweep sends their emails.
      ordersEnv = null;
    }
    return await handleStripeWebhook(request, {
      webhookSecret: config.webhookSecret,
      livemode: config.livemode,
      stripe: createStripeApi(config.stripeKey),
      rpc,
      mail: createMailer(config),
      now: () => Date.now(),
      log: (line) => console.log(line),
      orders: {
        stripe: createOrderStripeApi(config.stripeKey),
        rpc: createOrderRpc(config.supabaseUrl, config.supabaseSecretKey),
        accountExists: (userId) => rpc.accountExists(userId),
        mail: ordersEnv === null ? null : createOrderMailer({ ...config, ordersEnv }),
      },
    });
  } catch {
    // A defect: log the outcome only (an error's text or stack could carry payload values).
    console.log(
      JSON.stringify({ msg: "payments webhook", event: null, type: null, outcome: "error", code: "unexpected", paused: null }),
    );
    return Response.json({ error: "unavailable" }, { status: 500 });
  }
};

const scheduledHandler: ScheduledHandler = async (_controller, env) => {
  const config = configOrNull(env);
  if (config === null) return;
  try {
    await runSweep(config, env);
  } catch {
    // runSweep isolates its items; this is a defect. Log the outcome only.
    console.log(JSON.stringify({ msg: "payments sweep", outcome: "error", code: "unexpected" }));
  }
};

const paymentsWorker = { fetch: fetchHandler, scheduled: scheduledHandler };

export default paymentsWorker;
