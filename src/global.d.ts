import type { routing } from "@/i18n/routing";
import type { OrderServiceInput } from "@/lib/payments/orders/service-contract";
import type { WithdrawInput } from "@/lib/payments/withdrawal-contract";
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
     * per-user throttle on the Monitor billing actions and the per-IP
     * throttle on the goods Buy route and withdrawal action
     * (src/lib/payments/rate-limit.ts). Typed by hand like
     * @cloudflare/workers-types' `RateLimit`, which this repo does not load.
     */
    BILLING_RATE_LIMITER?: {
      limit(options: { key: string }): Promise<{ success: boolean }>;
    };
    /**
     * Service binding to the payments Worker's `WithdrawalService` RPC
     * entrypoint (wrangler.jsonc `services`, workers/payments/withdrawal-service.ts):
     * the Monitor withdrawal action's only way to withdraw a subscription.
     * The answer is `unknown` until `parseWithdrawResult` has checked it.
     * Absent (no binding in this Worker or dev proxy) → the action fails
     * closed with `?error=unavailable`.
     */
    PAYMENTS?: {
      withdraw(input: WithdrawInput): Promise<unknown>;
    };
    /**
     * Service binding to the payments Worker's `OrderService` RPC entrypoint
     * (wrangler.jsonc `services`, workers/payments/orders/service.ts): the
     * only way the web app starts a goods Checkout, sends a goods withdrawal
     * or ships/refunds an order (src/lib/payments/orders/binding.ts). Each
     * answer is `unknown` until `parseOrderServiceResult` has checked it.
     * Absent (no binding in this Worker or dev proxy) → the caller answers
     * `unavailable`.
     */
    ORDERS?: {
      startCheckout(input: OrderServiceInput<"startCheckout">): Promise<unknown>;
      withdraw(input: OrderServiceInput<"withdraw">): Promise<unknown>;
      markShipped(input: OrderServiceInput<"markShipped">): Promise<unknown>;
      approveRefund(input: OrderServiceInput<"approveRefund">): Promise<unknown>;
    };
  }
}
