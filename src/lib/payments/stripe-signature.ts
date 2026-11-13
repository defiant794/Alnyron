/**
 * Stripe webhook signature check (https://docs.stripe.com/webhooks#verify-manually),
 * pure and runtime-neutral: WebCrypto only, so it runs the same in the
 * Workers runtime and in Node. Never throws; logs nothing.
 */

import { STRIPE_WEBHOOK_MAX_SIGNATURES } from "@/config/payments";

/** Why a `Stripe-Signature` header was refused. */
export type StripeSignatureFailure = "missing_header" | "malformed_header" | "stale_timestamp" | "no_signature_match";

export type StripeSignatureResult = { ok: true; timestamp: number } | { ok: false; reason: StripeSignatureFailure };

export type StripeSignatureInput = {
  /** The raw request body, exactly as received. */
  payload: string;
  /** The `Stripe-Signature` header; null when the request has none. */
  header: string | null;
  /** The endpoint's signing secret, the whole `whsec_…` string. */
  secret: string;
  /** The current time, in Unix seconds. */
  nowSeconds: number;
  /** How far the signed timestamp may be from `nowSeconds`, either way. */
  toleranceSeconds: number;
};

/** A v1 signature: an HMAC-SHA256 as 64 hex digits, either case. */
const V1_SIGNATURE = /^[0-9a-fA-F]{64}$/;

const DIGITS = /^[0-9]+$/;

/** The 32 bytes of a {@link V1_SIGNATURE} hex string. */
function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Checks a webhook delivery's `Stripe-Signature` header against its raw body.
 *
 * The header is comma-separated `key=value` items: exactly one `t` (the signed
 * Unix time, digits only) and one to STRIPE_WEBHOOK_MAX_SIGNATURES `v1`; other
 * keys (`v0`, …) are ignored. A v1 is the hex HMAC-SHA256 of `${t}.${payload}`
 * keyed with the whole `whsec_…` secret as UTF-8 (prefix kept, not
 * base64-decoded); a v1 that is not 64 hex digits never matches. Signatures
 * are compared with `crypto.subtle.verify` (constant time), never as strings.
 *
 * Order: header shape (`missing_header` for none or an empty one,
 * `malformed_header`, also for too many `v1` items, before any HMAC), then the
 * signatures (`no_signature_match` unless one matches), then the time: a
 * correctly signed `t` more than `toleranceSeconds` before or after
 * `nowSeconds` is `stale_timestamp`; exactly at the tolerance passes.
 */
export async function verifyStripeSignature(input: StripeSignatureInput): Promise<StripeSignatureResult> {
  const { payload, header, secret, nowSeconds, toleranceSeconds } = input;
  if (header === null || header === "") return { ok: false, reason: "missing_header" };

  const timestamps: string[] = [];
  const signatures: string[] = [];
  for (const item of header.split(",")) {
    const separator = item.indexOf("=");
    if (separator < 1) return { ok: false, reason: "malformed_header" };
    const key = item.slice(0, separator);
    const value = item.slice(separator + 1);
    if (key === "t") timestamps.push(value);
    else if (key === "v1") signatures.push(value);
  }
  const [timestampText] = timestamps;
  if (
    timestamps.length !== 1 ||
    timestampText === undefined ||
    !DIGITS.test(timestampText) ||
    signatures.length === 0 ||
    signatures.length > STRIPE_WEBHOOK_MAX_SIGNATURES
  ) {
    return { ok: false, reason: "malformed_header" };
  }
  const timestamp = Number(timestampText);
  if (!Number.isSafeInteger(timestamp)) return { ok: false, reason: "malformed_header" };

  const candidates = signatures.filter((signature) => V1_SIGNATURE.test(signature));
  if (candidates.length === 0) return { ok: false, reason: "no_signature_match" };

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const message = encoder.encode(`${timestampText}.${payload}`);
  let matched = false;
  for (const candidate of candidates) {
    if (await crypto.subtle.verify("HMAC", key, hexBytes(candidate), message)) {
      matched = true;
      break;
    }
  }
  if (!matched) return { ok: false, reason: "no_signature_match" };

  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return { ok: false, reason: "stale_timestamp" };
  return { ok: true, timestamp };
}
