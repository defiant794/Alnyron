import { sendEmail } from "@/lib/email/resend";
import { parseMonitorCronEnv } from "./env";
import { createSupabaseEngineRpc } from "./rpc";
import { runMonitorChecks } from "./run";

/**
 * Entry of the cron Worker `alnyron-monitor-cron` (wrangler.jsonc beside this
 * file): every cron trigger runs one batch of the monitor engine. Only a
 * `scheduled` handler: the Worker has no route and no workers.dev URL, so it
 * takes no HTTP requests.
 */

/**
 * Cloudflare's `scheduled(controller, env, ctx)`, typed by hand (the repo
 * type-checks with the DOM lib, not @cloudflare/workers-types). The handler
 * needs neither controller nor context: it awaits the whole run.
 */
type ScheduledHandler = (controller: unknown, env: unknown, ctx: unknown) => Promise<void>;

/** Validates the environment (throws naming bad keys only), then runs the engine once. */
const scheduled: ScheduledHandler = async (_controller, env) => {
  const config = parseMonitorCronEnv(env);
  await runMonitorChecks({
    rpc: createSupabaseEngineRpc(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY),
    mailer: (message, idempotencyKey) => sendEmail(config.RESEND_API_KEY, message, idempotencyKey),
    config: {
      batchSize: config.MONITOR_BATCH_SIZE,
      subrequestLimit: config.MONITOR_SUBREQUEST_LIMIT,
      siteUrl: config.MONITOR_SITE_URL,
      mailFrom: config.MAIL_FROM,
    },
  });
};

const monitorCronWorker = { scheduled };

export default monitorCronWorker;
