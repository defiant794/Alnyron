/**
 * Test helper: generate a Stripe-style webhook signature header.
 *
 * The HMAC key is the FULL `whsec_…` string as UTF-8 (prefix not stripped,
 * not base64-decoded) — per contract §4.2. The message is `${t}.${payload}`.
 *
 * Uses node:crypto createHmac so tests compute the expected value
 * independently of the production `crypto.subtle` path.
 */
import { createHmac } from "node:crypto";

/**
 * Sign `payload` with `secret` at time `t` (Unix seconds) and return the
 * `stripe-signature` header value: `t=<t>,v1=<hex>`.
 */
export function signStripeHeader(
  payload: string,
  secret: string,
  t: number,
): string {
  const message = `${t}.${payload}`;
  const sig = createHmac("sha256", secret).update(message, "utf8").digest("hex");
  return `t=${t},v1=${sig}`;
}
