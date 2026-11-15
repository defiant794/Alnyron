/**
 * E2E seed helpers for S2 goods (physical 3D figure purchase), amendments
 * A1/A2: Checkout only authorizes the payment; "Markér afsendt" captures it; a
 * withdrawal before dispatch releases it, after dispatch it is refunded.
 *
 * Each spec passes its own scope (admin UUID/email, section+item slug, buyer
 * email prefix) so specs never collide on rows.
 *
 * Orders are written through the real service_role writer
 * `public.payments_record_order` (the RPC the Worker calls), never by
 * hand-written INSERTs, so the column contract stays in one place.
 *
 * Stripe: goods Checkout sessions are created by the payments Worker with
 * STRIPE_PAYMENTS_KEY. The same test-mode key (environment, else the Worker's
 * workers/payments/.dev.vars) is used here for read-only API checks and to
 * create a real, authorized test PaymentIntent. STRIPE_CHECKOUT_KEY is
 * subscriptions-only and is never used for goods. Key values are never printed.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type pg from "pg";
import { signStripeHeader } from "../../helpers/stripe-webhook";
import { E2E_EMAIL_DOMAIN } from "./admin-auth-seed";
import { DB_AVAILABLE, endPool, getClient } from "../../integration/rls/helpers/db";
import { deleteUser, insertUser, randomE2ePassword } from "./monitor-seed";

export { DB_AVAILABLE, endPool, getClient };

export const GOODS_TERMS_VERSION = "goods-2026-11-14.1";
/** 249,95 kr incl. 25% VAT. */
export const S2_PRICE_ORE = 24995;
/** inclusiveVatOre(24995) = 4999. */
export const S2_TAX_ORE = 4999;
/**
 * Stripe's `amount_subtotal` of a goods session: the line amount with the inclusive moms in it
 * (a TEST-mode session of 24995 øre answered amount_subtotal 24995, amount_tax 4999 on
 * 2026-11-15), so the price itself.
 */
export const S2_SUBTOTAL_ORE = S2_PRICE_ORE;
export const S2_ITEM_TITLE = "S2 E2E Drage";

/** Local payments Worker (wrangler dev). Contract §5: use 127.0.0.1, not localhost. */
export const PAYMENTS_WORKER_URL = process.env.PAYMENTS_WORKER_URL ?? "http://127.0.0.1:8787";

/** `^evt_[A-Za-z0-9]+$` (the Worker's EVT_ID_REGEX): a fresh event id per call, no second underscore. */
export function newEventId(): string {
  return `evt_s2e2e${randomBytes(8).toString("hex")}`;
}

/**
 * `name` from workers/payments/.dev.vars (the local payments Worker's
 * secrets), or null when the file or the key is absent or its value is empty
 * (`NAME=` as in .dev.vars.example; the value is read from the same line only).
 * Never printed.
 */
export function workerDevVar(name: string): string | null {
  let text: string;
  try {
    text = readFileSync(path.resolve(process.cwd(), "workers/payments/.dev.vars"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const match = new RegExp(`^${name}[ \\t]*=[ \\t]*(\\S.*)$`, "m").exec(text);
  const value = match?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
  return value === "" ? null : value;
}

/** Test-mode goods key (STRIPE_PAYMENTS_KEY: environment, else the Worker's .dev.vars), or null. Never printed. */
export const STRIPE_TEST_KEY: string | null = (() => {
  const key = process.env.STRIPE_PAYMENTS_KEY ?? workerDevVar("STRIPE_PAYMENTS_KEY");
  return typeof key === "string" && /^(sk|rk)_test_/.test(key) ? key : null;
})();

/** Shared password for the S2 admin accounts of this run. */
export const S2_PASSWORD = randomE2ePassword();

export interface S2Scope {
  adminUuid: string;
  adminEmail: string;
  /** Section route slug (DA and EN). */
  sectionSlug: string;
  /** EN item slug (URL_SLUG_LOCALE = "en": public URLs use the EN slug). */
  itemSlug: string;
  /** Buyer email for order `n` of this scope: a Resend test sink, so no order mail reaches a real inbox. */
  buyerEmail: (n: number) => string;
  /** SQL LIKE pattern matching this scope's buyer emails. */
  emailLike: string;
}

/** Signed POST of `event` to the local payments Worker's webhook endpoint. */
export async function postSignedEvent(event: unknown, secret: string): Promise<Response> {
  const body = JSON.stringify(event);
  const header = signStripeHeader(body, secret, Math.floor(Date.now() / 1000));
  return fetch(`${PAYMENTS_WORKER_URL}/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": header },
    body,
  });
}

/** Stripe REST call. Errors name endpoint and status only, never the key. */
export async function stripeRequest<T>(
  key: string,
  method: "GET" | "POST",
  endpoint: string,
  form?: URLSearchParams,
): Promise<T> {
  const resp = await fetch(`https://api.stripe.com/v1/${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form?.toString(),
  });
  if (!resp.ok) {
    throw new Error(`Stripe ${method} /v1/${endpoint} failed: ${resp.status}`);
  }
  return (await resp.json()) as T;
}

export interface StripePaymentIntent {
  id: string;
  status: string;
  amount: number;
  amount_received: number;
  amount_capturable: number;
}

/**
 * A real test PaymentIntent of 249,95 kr. authorized with Stripe's test card
 * and not captured (`capture_method=manual`, `requires_capture`), like a
 * goods Checkout leaves it: the release test cancels it through the Worker.
 */
export async function createAuthorizedPaymentIntent(key: string): Promise<StripePaymentIntent> {
  return stripeRequest<StripePaymentIntent>(
    key,
    "POST",
    "payment_intents",
    new URLSearchParams({
      amount: String(S2_PRICE_ORE),
      currency: "dkk",
      capture_method: "manual",
      confirm: "true",
      payment_method: "pm_card_visa",
      "automatic_payment_methods[enabled]": "true",
      "automatic_payment_methods[allow_redirects]": "never",
      "metadata[kind]": "goods_order",
    }),
  );
}

export async function seedAdmin(client: pg.PoolClient, scope: S2Scope, password: string): Promise<void> {
  await insertUser(client, scope.adminUuid, scope.adminEmail, "admin", password);
}

/**
 * Published models3d category, routed section (DA + EN), item with EN item
 * slug (URL_SLUG_LOCALE = "en"), active physical offer 24995 øre.
 * Returns the item id.
 */
export async function seedGoodsItem(client: pg.PoolClient, scope: S2Scope): Promise<string> {
  const cat = await client.query<{ id: string }>(
    `INSERT INTO public.categories (kind, status) VALUES ('models3d', 'published') RETURNING id`,
  );
  const categoryId = cat.rows[0]!.id;
  await client.query(
    `INSERT INTO public.category_translations (category_id, locale, title)
     VALUES ($1, 'da', '3D-figurer'), ($1, 'en', '3D figures')`,
    [categoryId],
  );
  await client.query(
    `INSERT INTO public.routes (locale, slug, category_id)
     VALUES ('da', $1, $2), ('en', $1, $2)`,
    [scope.sectionSlug, categoryId],
  );
  const itm = await client.query<{ id: string }>(
    `INSERT INTO public.items (category_id, status, published_at) VALUES ($1, 'published', now()) RETURNING id`,
    [categoryId],
  );
  const itemId = itm.rows[0]!.id;
  // DA slug is internal only; the EN slug forms the public address (URL_SLUG_LOCALE = "en").
  await client.query(
    `INSERT INTO public.item_translations (item_id, locale, slug, title)
     VALUES ($1, 'da', $2 || '-da', $3), ($1, 'en', $2, $3)`,
    [itemId, scope.itemSlug, S2_ITEM_TITLE],
  );
  await client.query(
    `INSERT INTO public.item_offers (item_id, kind, price_ore, active) VALUES ($1, 'physical', $2, true)`,
    [itemId, S2_PRICE_ORE],
  );
  return itemId;
}

export interface SeedAuthorizedOrderInput {
  itemId: string;
  buyerEmail: string;
  /** A Checkout Session id (`cs_test_…`); the order's other key. */
  checkoutSessionId: string;
  /** The order's authorized (uncaptured) test PaymentIntent. */
  paymentIntentId: string;
}

/**
 * Records an authorized goods order (A1: charged at dispatch) through
 * `payments_record_order`, as the webhook does for a completed Checkout
 * whose payment intent is `requires_capture` (a card's capture_before is 7
 * days later). No Stripe invoice or Customer (A1). Returns the order id and number.
 */
export async function seedAuthorizedOrder(
  client: pg.PoolClient,
  input: SeedAuthorizedOrderInput,
): Promise<{ orderId: string; orderNumber: number }> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  // The 1c eventForRpc shape the writer validates: created as ISO text, livemode present.
  const event = {
    id: newEventId(),
    type: "checkout.session.completed",
    created: new Date(nowSeconds * 1000).toISOString(),
    livemode: false,
  };
  const order = {
    stripe_checkout_session_id: input.checkoutSessionId,
    stripe_payment_intent_id: input.paymentIntentId,
    stripe_customer_id: null,
    stripe_invoice_id: null,
    user_id: null,
    email: input.buyerEmail,
    customer_name: "E2E Køber",
    phone: "+4512345678",
    shipping_name: "E2E Køber",
    shipping_address: { line1: "Testvej 1", line2: null, postal_code: "7860", city: "Spøttrup", country: "DK" },
    locale: "da",
    currency: "dkk",
    amount_subtotal_ore: S2_SUBTOTAL_ORE,
    amount_tax_ore: S2_TAX_ORE,
    amount_total_ore: S2_PRICE_ORE,
    terms_version: GOODS_TERMS_VERSION,
    terms_sha256: createHash("sha256").update(`e2e-${event.id}`).digest("hex"),
    stripe_consent: "accepted",
    anomaly: null,
    paid_at: new Date(nowSeconds * 1000).toISOString(),
    capture_state: "requires_capture",
    authorization_expires_at: new Date((nowSeconds + 7 * 86_400) * 1000).toISOString(),
    lines: [
      {
        line_no: 1,
        item_id: input.itemId,
        offer_kind: "physical",
        title: S2_ITEM_TITLE,
        quantity: 1,
        unit_amount_ore: S2_PRICE_ORE,
        amount_total_ore: S2_PRICE_ORE,
        amount_tax_ore: S2_TAX_ORE,
      },
    ],
  };
  const { rows } = await client.query<{
    result: { outcome: string; order_id: string; order_number: number | string };
  }>(`SELECT public.payments_record_order($1::jsonb, $2::jsonb) AS result`, [
    JSON.stringify(event),
    JSON.stringify(order),
  ]);
  const result = rows[0]!.result;
  if (result.outcome !== "recorded") throw new Error(`payments_record_order outcome: ${result.outcome}`);
  return { orderId: result.order_id, orderNumber: Number(result.order_number) };
}

/** Removes every row this scope created (orders by buyer email, the item and section, the admin). */
export async function cleanupS2(client: pg.PoolClient, scope: S2Scope): Promise<void> {
  const scoped = `SELECT id FROM public.orders WHERE email LIKE $1`;
  await client.query(`DELETE FROM public.order_withdrawals WHERE order_id IN (${scoped})`, [scope.emailLike]);
  await client.query(`DELETE FROM public.order_items WHERE order_id IN (${scoped})`, [scope.emailLike]);
  await client.query(`DELETE FROM public.orders WHERE email LIKE $1`, [scope.emailLike]);
  // item_offers cascade from items
  await client.query(
    `DELETE FROM public.items WHERE id IN (SELECT item_id FROM public.item_translations WHERE slug = $1)`,
    [scope.itemSlug],
  );
  await client.query(
    `DELETE FROM public.categories WHERE id IN (SELECT category_id FROM public.routes WHERE slug = $1)`,
    [scope.sectionSlug],
  );
  await deleteUser(client, scope.adminUuid, scope.adminEmail);
}

export function newS2Scope(prefix: string, sectionSlug: string, itemSlug: string): S2Scope {
  // Resend's test sink takes a +label: delivered+<label>@resend.dev.
  const run = randomBytes(4).toString("hex");
  return {
    adminUuid: randomUUID(),
    adminEmail: `e2e-s2-${prefix}-admin@${E2E_EMAIL_DOMAIN}`,
    sectionSlug,
    itemSlug,
    buyerEmail: (n) => `delivered+e2e-s2-${prefix}-${run}-${n}@resend.dev`,
    emailLike: `delivered+e2e-s2-${prefix}-%@resend.dev`,
  };
}
