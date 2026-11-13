import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * Whether the user may start another Stripe Checkout or Billing Portal
 * session now, counting this call: at most BILLING_RATE_LIMIT per
 * BILLING_RATE_PERIOD_SECONDS (src/config/payments.ts), enforced by the
 * Workers Rate Limiting binding `BILLING_RATE_LIMITER` (wrangler.jsonc),
 * keyed on `userId`. Cloudflare's limit is approximate and counted per
 * location.
 *
 * Fails closed: false when the user is over the limit, when there is no
 * Cloudflare context or no BILLING_RATE_LIMITER binding, and when the
 * limiter throws or answers anything but `success: true`.
 */
export async function allowBillingSession(userId: string): Promise<boolean> {
  try {
    const limiter = getCloudflareContext().env.BILLING_RATE_LIMITER;
    if (limiter === undefined) return false;
    const { success } = await limiter.limit({ key: userId });
    return success === true;
  } catch {
    return false;
  }
}
