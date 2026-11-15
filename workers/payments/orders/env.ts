import * as z from "zod/mini";

/**
 * The goods (slice S2) part of the payments Worker's environment, parsed apart
 * from `parsePaymentsEnv` (../env.ts) so the subscription and
 * withdrawal code never reads it and a bad goods key never stops them: a goods
 * path without a valid orders env fails closed (`unavailable`), except the
 * webhook's goods branch, which still records the order and leaves its emails
 * to the sweep.
 *
 * - `ORDER_LINK_SECRET` (secret, at least 32 characters): the HMAC key of the
 *   personal withdraw links (`src/lib/payments/orders/link-token.ts`). Held by
 *   this Worker only, never by the web app.
 * - `ORDER_NOTIFY_TO` (var): where the owner's order emails go.
 * - `STRIPE_TAX_RATE_ID` (var): the 25 % inclusive Tax Rate on every goods
 *   Checkout line.
 */
const ordersEnvSchema = z.object({
  /** Whitespace-free, 32 to 256 characters (e.g. `openssl rand -base64 48`). */
  ORDER_LINK_SECRET: z.string().check(z.regex(/^\S{32,256}$/)),
  ORDER_NOTIFY_TO: z.string().check(z.regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/)),
  STRIPE_TAX_RATE_ID: z.string().check(z.regex(/^txr_[A-Za-z0-9]+$/)),
});

export type OrdersEnv = {
  orderLinkSecret: string;
  orderNotifyTo: string;
  stripeTaxRateId: string;
};

/**
 * Validates the goods keys of the Worker's environment. On failure throws an
 * Error that names only the missing or invalid keys (in schema order), never a
 * value.
 */
export function parseOrdersEnv(raw: unknown): OrdersEnv {
  const result = ordersEnvSchema.safeParse(raw);
  if (!result.success) {
    const keys = [...new Set(result.error.issues.map((issue) => String(issue.path[0] ?? "(env)")))];
    throw new Error(`payments: missing or invalid orders environment keys: ${keys.join(", ")}`);
  }
  return {
    orderLinkSecret: result.data.ORDER_LINK_SECRET,
    orderNotifyTo: result.data.ORDER_NOTIFY_TO,
    stripeTaxRateId: result.data.STRIPE_TAX_RATE_ID,
  };
}
