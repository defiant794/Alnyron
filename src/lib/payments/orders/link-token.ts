import type { Locale } from "next-intl";
import { ORDER_WITHDRAW_PATH } from "@/config/payments";

/**
 * The personal withdraw link of a goods order (`/order/withdraw?o=&t=`), sent
 * in the order confirmation and the shipped email: the token is an
 * HMAC-SHA256 of the order id under ORDER_LINK_SECRET (a payments Worker
 * secret only; the web app never holds it), so only the Worker can issue or
 * check one. WebCrypto only: runs the same in the Workers runtime and in
 * Node. Never logs.
 */

/** What the HMAC signs: a versioned, purpose-bound message, so the token is useless elsewhere. */
function signedMessage(orderId: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`order-link:v1:${orderId}`);
}

/** An HMAC-SHA256 key for `secret` (UTF-8), for signing or verifying. */
function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    usage,
  ]);
}

/** A 32-byte HMAC as base64url without padding: exactly 43 characters. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** The bytes of a {@link TOKEN_SHAPE} token. */
function fromBase64Url(token: string): Uint8Array<ArrayBuffer> {
  const binary = atob(`${token.replaceAll("-", "+").replaceAll("_", "/")}=`);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** The order's link token: base64url (no padding) of HMAC-SHA256(secret, `order-link:v1:<orderId>`). */
export async function orderLinkToken(secret: string, orderId: string): Promise<string> {
  const key = await hmacKey(secret, "sign");
  return toBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, signedMessage(orderId))));
}

/**
 * Whether `token` is the order's link token under `secret`. Compared with
 * `crypto.subtle.verify` (constant time), never as strings; any malformed
 * input (not a string, not 43 base64url characters) is false. Never throws.
 */
export async function verifyOrderLinkToken(secret: string, orderId: string, token: string): Promise<boolean> {
  if (typeof secret !== "string" || typeof orderId !== "string" || typeof token !== "string") return false;
  if (!TOKEN_SHAPE.test(token)) return false;
  try {
    const key = await hmacKey(secret, "verify");
    return await crypto.subtle.verify("HMAC", key, fromBase64Url(token), signedMessage(orderId));
  } catch {
    return false;
  }
}

/** The order's personal withdraw link on `siteOrigin`: `/order/withdraw?o=<id>&t=<token>&lang=<locale>`. */
export function orderWithdrawUrl(siteOrigin: string, orderId: string, token: string, locale: Locale): string {
  const query = new URLSearchParams({ o: orderId, t: token, lang: locale });
  return `${siteOrigin}${ORDER_WITHDRAW_PATH}?${query.toString()}`;
}
