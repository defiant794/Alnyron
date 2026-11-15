import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * One call against the Workers Rate Limiting binding `BILLING_RATE_LIMITER`
 * (wrangler.jsonc): at most BILLING_RATE_LIMIT calls per `key` per
 * BILLING_RATE_PERIOD_SECONDS (src/config/payments.ts). Cloudflare's limit is
 * approximate and counted per location.
 *
 * Fails closed: false when the key is over the limit, when there is no
 * Cloudflare context or no BILLING_RATE_LIMITER binding, and when the
 * limiter throws or answers anything but `success: true`.
 */
async function allow(key: string): Promise<boolean> {
  try {
    const limiter = getCloudflareContext().env.BILLING_RATE_LIMITER;
    if (limiter === undefined) return false;
    const { success } = await limiter.limit({ key });
    return success === true;
  } catch {
    return false;
  }
}

/**
 * Whether the user may start another Stripe Checkout or Billing Portal
 * session (or send a withdrawal) now, counting this call, keyed on `userId`.
 * Fails closed (see {@link allow}).
 */
export function allowBillingSession(userId: string): Promise<boolean> {
  return allow(userId);
}

/**
 * The anonymous goods endpoints, each throttled per client IP: the Buy route
 * (`POST /api/checkout/item`) and the online withdrawal ("Bekræft
 * fortrydelse" on /order/withdraw).
 */
export type GoodsRateLimitScope = "goods-checkout" | "order-withdraw";

/**
 * Whether the client at `ip` (Cloudflare's `cf-connecting-ip`; null when the
 * request has none, which all share the key `<scope>:unknown`) may call the
 * goods endpoint `scope` now, counting this call. Fails closed (see
 * {@link allow}).
 */
export function allowGoodsRequest(scope: GoodsRateLimitScope, ip: string | null): Promise<boolean> {
  return allow(`${scope}:${ip ?? "unknown"}`);
}
