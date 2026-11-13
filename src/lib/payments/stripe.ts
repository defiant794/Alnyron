/**
 * Minimal Stripe REST client (https://docs.stripe.com/api): form-encoded
 * `fetch` requests, no SDK, pinned to one API version. It reads no
 * environment and logs nothing; the API key is passed in and never appears in
 * a return value, and neither does a request or response body. Every helper
 * resolves to a {@link StripeResult} and never throws.
 */

import { STRIPE_REQUEST_TIMEOUT_MS } from "@/config/payments";

/**
 * The Stripe API version every request is made with (`Stripe-Version`), so an
 * account default changed in the Dashboard cannot change a request or
 * response shape. scripts/stripe-setup.mjs and the webhook Worker
 * (workers/payments/, and the Dashboard endpoint it serves) use the same.
 */
export const STRIPE_API_VERSION = "2026-10-28.endive";

const STRIPE_API_BASE = "https://api.stripe.com/v1";

/** A request parameter: nested objects and arrays are sent in Stripe's bracket notation. */
export type StripeParamValue = string | number | boolean | undefined | StripeParams | StripeParams[] | string[];

/** Request parameters; a key whose value is `undefined` is not sent. */
export type StripeParams = { [key: string]: StripeParamValue };

/**
 * A request's outcome: the parsed response body, or why there is none —
 * `http` (Stripe answered with an error status; `code` is its `error.code`,
 * else `error.type`, else null), `network` (no answer: connection failure or
 * the {@link STRIPE_REQUEST_TIMEOUT_MS} timeout) or `invalid_response` (a
 * success whose body is not the JSON object expected).
 */
export type StripeResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: "http"; status: number; code: string | null }
  | { ok: false; kind: "network" }
  | { ok: false; kind: "invalid_response" };

/** The Checkout Session fields the app uses: where to send the customer. */
export type CheckoutSession = { id: string; url: string };

/** The Billing Portal session field the app uses: where to send the customer. */
export type BillingPortalSession = { url: string };

const CHECKOUT_URL_PREFIX = "https://checkout.stripe.com/";
const BILLING_PORTAL_URL_PREFIX = "https://billing.stripe.com/";

/**
 * Stripe's `application/x-www-form-urlencoded` body for `params`, keys in
 * insertion order: a nested object becomes `a[b][c]`, an array `a[0]`,
 * `a[1]`, …; numbers are sent as decimal strings and booleans as
 * `true`/`false`; `undefined` values are skipped.
 */
export function encodeStripeForm(params: StripeParams): URLSearchParams {
  const form = new URLSearchParams();
  const append = (key: string, value: StripeParamValue): void => {
    if (value === undefined) return;
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) append(`${key}[${index}]`, value[index]);
      return;
    }
    if (typeof value === "object") {
      for (const [name, nested] of Object.entries(value)) append(`${key}[${name}]`, nested);
      return;
    }
    form.append(key, String(value));
  };
  for (const [key, value] of Object.entries(params)) append(key, value);
  return form;
}

/** The string at `body[field]`, or null when `body` is no object or the field is not a string. */
function stringField(body: unknown, field: string): string | null {
  if (typeof body !== "object" || body === null) return null;
  const value: unknown = (body as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

/** The parsed JSON of `text`, or undefined when it is not JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The HTTP methods the Stripe API is called with. */
export type StripeMethod = "GET" | "POST" | "DELETE";

/**
 * Calls the Stripe API at `path` (e.g. `/subscriptions/sub_…`) with `method`.
 * `params` go into the query string of a GET and into the form body of a POST
 * or DELETE; `idempotencyKey` is sent as `Idempotency-Key`, so Stripe answers
 * a repeated POST with the first one's result instead of acting twice
 * (Stripe ignores it on GET/DELETE, per its idempotent-requests docs).
 * Callers must validate whatever they put into `path`. The success body is
 * returned as `T` unchecked: callers validate the fields they use. Never
 * throws.
 */
export async function stripeRequest<T>(
  apiKey: string,
  method: StripeMethod,
  path: string,
  params?: StripeParams,
  idempotencyKey?: string,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Promise<StripeResult<T>> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Stripe-Version": STRIPE_API_VERSION,
  };
  if (idempotencyKey !== undefined) headers["Idempotency-Key"] = idempotencyKey;
  let url = `${STRIPE_API_BASE}${path}`;
  let body: string | undefined;
  if (method === "GET") {
    const query = params === undefined ? "" : encodeStripeForm(params).toString();
    if (query !== "") url += `?${query}`;
  } else if (params !== undefined) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = encodeStripeForm(params).toString();
  }

  let status: number;
  let text: string;
  try {
    const response = await fetchImpl(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(STRIPE_REQUEST_TIMEOUT_MS),
    });
    status = response.status;
    text = await response.text();
  } catch {
    return { ok: false, kind: "network" };
  }

  const parsed = parseJson(text);
  if (status >= 200 && status < 300) {
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false, kind: "invalid_response" };
    return { ok: true, data: parsed as T };
  }
  const error: unknown = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>).error : null;
  return { ok: false, kind: "http", status, code: stringField(error, "code") ?? stringField(error, "type") };
}

/**
 * POSTs `params` to the Stripe API at `path` (e.g. `/checkout/sessions`):
 * {@link stripeRequest} without an idempotency key. Never throws.
 */
export async function stripePost<T>(
  apiKey: string,
  path: string,
  params: StripeParams,
  fetchImpl?: typeof fetch,
): Promise<StripeResult<T>> {
  return stripeRequest<T>(apiKey, "POST", path, params, undefined, fetchImpl);
}

/**
 * Creates a Checkout Session (`POST /v1/checkout/sessions`). A session whose
 * id is not a `cs_` id or whose url is not on checkout.stripe.com is an
 * `invalid_response`, so the caller never redirects anywhere else.
 */
export async function createCheckoutSession(
  apiKey: string,
  params: StripeParams,
  fetchImpl?: typeof fetch,
): Promise<StripeResult<CheckoutSession>> {
  const result = await stripePost<unknown>(apiKey, "/checkout/sessions", params, fetchImpl);
  if (!result.ok) return result;
  const id = stringField(result.data, "id");
  const url = stringField(result.data, "url");
  if (id === null || !id.startsWith("cs_") || url === null || !url.startsWith(CHECKOUT_URL_PREFIX)) {
    return { ok: false, kind: "invalid_response" };
  }
  return { ok: true, data: { id, url } };
}

/**
 * Creates a Billing Portal session (`POST /v1/billing_portal/sessions`). A
 * url not on billing.stripe.com is an `invalid_response`, so the caller never
 * redirects anywhere else.
 */
export async function createBillingPortalSession(
  apiKey: string,
  params: StripeParams,
  fetchImpl?: typeof fetch,
): Promise<StripeResult<BillingPortalSession>> {
  const result = await stripePost<unknown>(apiKey, "/billing_portal/sessions", params, fetchImpl);
  if (!result.ok) return result;
  const url = stringField(result.data, "url");
  if (url === null || !url.startsWith(BILLING_PORTAL_URL_PREFIX)) return { ok: false, kind: "invalid_response" };
  return { ok: true, data: { url } };
}
