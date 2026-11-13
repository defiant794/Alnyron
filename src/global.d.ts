import type { routing } from "@/i18n/routing";
import type da from "../messages/da.json";

// Strict next-intl typing: `Locale` is "da" | "en", and message keys are
// checked against the Danish source file.
declare module "next-intl" {
  interface AppConfig {
    Locale: (typeof routing.locales)[number];
    Messages: typeof da;
  }
}

// Worker bindings the app reads through getCloudflareContext().env, added to
// the global CloudflareEnv that @opennextjs/cloudflare declares for its own
// cache bindings. Each is optional: a Worker or local dev proxy whose
// wrangler config lacks it has none.
declare global {
  interface CloudflareEnv {
    /**
     * Workers Rate Limiting binding (wrangler.jsonc `ratelimits`): the
     * per-user throttle on the Monitor billing actions
     * (src/lib/payments/rate-limit.ts). Typed by hand like
     * @cloudflare/workers-types' `RateLimit`, which this repo does not load.
     */
    BILLING_RATE_LIMITER?: {
      limit(options: { key: string }): Promise<{ success: boolean }>;
    };
  }
}
