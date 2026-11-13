import { PAYMENTS_WEBHOOK_PATH } from "@/config/payments";
import { parsePaymentsEnv, type PaymentsEnv } from "./env";
import { createPaymentsRpc } from "./rpc";
import { createStripeApi } from "./stripe-api";
import { handleStripeWebhook } from "./webhook";

/**
 * Entry of the webhook Worker `alnyron-payments` (wrangler.jsonc beside this
 * file), served on the custom domain pay.alnyron.dk: Stripe POSTs its events
 * to `/webhook`. Every other path is a 404 and every other method a 405, both
 * without a body.
 */

/**
 * Cloudflare's `fetch(request, env, ctx)`, typed by hand (the repo
 * type-checks with the DOM lib, not @cloudflare/workers-types). The handler
 * needs no context: it answers only after all its work is done.
 */
type FetchHandler = (request: Request, env: unknown, ctx: unknown) => Promise<Response>;

const fetchHandler: FetchHandler = async (request, env) => {
  if (new URL(request.url).pathname !== PAYMENTS_WEBHOOK_PATH) return new Response(null, { status: 404 });
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });

  let config: PaymentsEnv;
  try {
    config = parsePaymentsEnv(env);
  } catch (error) {
    // The message names the bad keys only, never a value.
    console.error(error instanceof Error ? error.message : "payments: invalid environment");
    return Response.json({ error: "unavailable" }, { status: 500 });
  }

  try {
    return await handleStripeWebhook(request, {
      webhookSecret: config.webhookSecret,
      livemode: config.livemode,
      stripe: createStripeApi(config.stripeKey),
      rpc: createPaymentsRpc(config.supabaseUrl, config.supabaseSecretKey),
      now: () => Date.now(),
      log: (line) => console.log(line),
    });
  } catch {
    // A defect: log the outcome only (an error's text or stack could carry payload values).
    console.log(
      JSON.stringify({ msg: "payments webhook", event: null, type: null, outcome: "error", code: "unexpected", paused: null }),
    );
    return Response.json({ error: "unavailable" }, { status: 500 });
  }
};

const paymentsWorker = { fetch: fetchHandler };

export default paymentsWorker;
