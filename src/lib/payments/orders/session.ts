import type { Locale } from "next-intl";
import { goodsTextDigest } from "@/config/legal/goods-texts";
import { GOODS_ORDER_KIND } from "@/config/payments";
import { inclusiveVatOre } from "@/lib/payments/orders/refund";
import {
  CUS_ID_REGEX,
  INV_ID_REGEX,
  PI_ID_REGEX,
  asRecord,
  isUnixSeconds,
  unixToIso,
} from "@/lib/payments/webhook-mapping";

/**
 * A completed goods Checkout Session (`checkout.session.completed` or
 * `checkout.session.async_payment_succeeded`) as the order the
 * `payments_record_order` writer records. Pure: no I/O, no clock. What can be
 * recorded is recorded; what looks wrong is flagged in `anomaly` for the
 * owner (never silently dropped), and only a session that cannot be an order
 * at all is refused.
 *
 * Charge on dispatch (amendment A1): the session's payment intent is only
 * authorized, so a completed session reports `payment_status=unpaid`. The
 * Worker then reads the payment intent (`GET /v1/payment_intents/{pi}` with
 * `expand[]=latest_charge`) and completes the order with
 * {@link applyGoodsPaymentIntent}.
 */

/** A Checkout Session id (`stripe_checkout_session_id` CHECK). */
const CS_ID_REGEX = /^cs_(test|live)_[A-Za-z0-9]+$/;

/** A canonical lowercase UUID, as the Worker puts it into `metadata.user_id` and `client_reference_id`. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** An email the `orders.email` CHECK takes: 3 to 320 characters, one `@` after the first character. */
const EMAIL = /^[^@\s]+@[^@\s]+$/;

/** A positive whole number in Stripe metadata (a string of digits without a leading zero). */
const METADATA_COUNT = /^[1-9][0-9]{0,8}$/;

/** The most order lines' units (`order_items.quantity` CHECK). */
const MAX_QUANTITY = 10;

/** Why something about a recorded order looks wrong (comma-joined in `orders.anomaly`, in this order). */
const GOODS_ORDER_ANOMALIES = [
  "amount_mismatch",
  "currency_not_dkk",
  "consent_missing",
  "terms_version_unknown",
  "shipping_missing",
  "shipping_not_dk",
  "tax_mismatch",
  "user_unverified",
  "captured_at_checkout",
] as const;

export type GoodsOrderAnomaly = (typeof GOODS_ORDER_ANOMALIES)[number];

/**
 * The payment intent's state when the order is recorded: `requires_capture`
 * (authorized, charged at dispatch) or `succeeded` (already captured at
 * Checkout: recorded with the `captured_at_checkout` anomaly).
 */
export type GoodsCaptureState = "requires_capture" | "succeeded";

/**
 * A Danish delivery address as stored in `orders.shipping_address` (`""` stored as null; `state`
 * dropped): the one address type of the order writer, the Worker's reads, the order emails and
 * Admin › Ordrer.
 */
export type OrderShippingAddress = {
  line1: string | null;
  line2: string | null;
  postal_code: string | null;
  city: string | null;
  country: string | null;
};

/** One order line (`order_items`): the item snapshot at purchase. */
export type GoodsOrderLine = {
  line_no: 1;
  item_id: string | null;
  offer_kind: "physical" | "digital";
  title: string;
  quantity: number;
  unit_amount_ore: number;
  amount_total_ore: number;
  amount_tax_ore: number;
};

/** The order writer's `p_order` (snake_case, every key present). */
export type GoodsOrderInput = {
  stripe_checkout_session_id: string;
  stripe_payment_intent_id: string;
  stripe_customer_id: string | null;
  stripe_invoice_id: string | null;
  /** Always null here: the Worker sets it only after checking the account exists (see {@link goodsSessionUserCandidate}). */
  user_id: string | null;
  email: string;
  customer_name: string | null;
  phone: string | null;
  shipping_name: string | null;
  shipping_address: OrderShippingAddress | null;
  locale: Locale;
  currency: string;
  /**
   * The session's `amount_subtotal`: the line amounts before discounts and shipping. With the
   * inclusive Tax Rate it includes the moms (a TEST-mode session of 249,95 kr. answered
   * `amount_subtotal` 24995, `total_details.amount_tax` 4999, `amount_total` 24995 on
   * 2026-11-15), so for a goods order it equals the total.
   */
  amount_subtotal_ore: number;
  amount_tax_ore: number;
  amount_total_ore: number;
  terms_version: string;
  terms_sha256: string | null;
  stripe_consent: "accepted" | null;
  /** Comma-joined {@link GoodsOrderAnomaly} codes, null when none. */
  anomaly: string | null;
  /** The event's `created`, ISO: when the payment was authorized. */
  paid_at: string;
  capture_state: GoodsCaptureState;
  /**
   * When the card authorization lapses (the latest charge's
   * `payment_method_details.card.capture_before`), ISO; null once captured
   * or for a method without one.
   */
  authorization_expires_at: string | null;
  lines: [GoodsOrderLine];
};

/** An order whose payment intent the Worker has not read yet (no capture fields). */
export type GoodsOrderDraft = Omit<GoodsOrderInput, "capture_state" | "authorization_expires_at">;

/**
 * The order of a goods session: complete when Stripe reports it `paid`
 * (captured at Checkout), or a draft to complete with
 * {@link applyGoodsPaymentIntent} (`captureCheck: true`); else why there is
 * none.
 */
export type GoodsSessionResult =
  | { ok: true; captureCheck: false; order: GoodsOrderInput }
  | { ok: true; captureCheck: true; order: GoodsOrderDraft }
  | { ok: false; reason: "not_goods" | "awaiting_payment" | "invalid_session" };

/** A draft completed from its payment intent, or why it cannot be recorded (yet). */
export type GoodsCaptureResult =
  | { ok: true; order: GoodsOrderInput }
  | { ok: false; reason: "awaiting_payment" | "invalid_payment_intent" };

/** The event fields the order needs. */
export type GoodsSessionEvent = { id: string; type: string; created: number };

/** `value` trimmed and cut to `max` characters, or null when it is no string or blank. */
function optionalText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" ? null : [...text].slice(0, max).join("");
}

/** A non-negative safe integer, or null. */
function wholeOre(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isLocale(value: unknown): value is Locale {
  return value === "da" || value === "en";
}

/** The delivery address of `collected_information.shipping_details`, or null when there is none. */
function shippingAddress(address: Record<string, unknown> | null): OrderShippingAddress | null {
  if (address === null) return null;
  return {
    line1: optionalText(address.line1, 200),
    line2: optionalText(address.line2, 200),
    postal_code: optionalText(address.postal_code, 20),
    city: optionalText(address.city, 200),
    country: optionalText(address.country, 2),
  };
}

/**
 * The account a goods session names, for the Worker's existence check: its
 * `metadata.user_id` when that is a UUID equal to `client_reference_id` (both
 * set server-side by the Worker for a verified signed-in buyer), else null
 * (a guest order).
 */
export function goodsSessionUserCandidate(session: unknown): string | null {
  const record = asRecord(session);
  const userId = asRecord(record?.metadata)?.user_id;
  return typeof userId === "string" && UUID.test(userId) && userId === record?.client_reference_id ? userId : null;
}

/** `anomaly` (a comma list of known codes, or null) with `code` added, in {@link GOODS_ORDER_ANOMALIES} order. */
function withAnomaly(anomaly: string | null, code: GoodsOrderAnomaly): string {
  const codes = new Set<string>([...(anomaly === null ? [] : anomaly.split(",")), code]);
  return GOODS_ORDER_ANOMALIES.filter((known) => codes.has(known)).join(",");
}

/** `order` as captured at Checkout: `succeeded`, no authorization to lapse, the `captured_at_checkout` anomaly. */
function capturedAtCheckout(order: GoodsOrderDraft): GoodsOrderInput {
  return {
    ...order,
    anomaly: withAnomaly(order.anomaly, "captured_at_checkout"),
    capture_state: "succeeded",
    authorization_expires_at: null,
  };
}

/**
 * The order of a completed goods Checkout Session, or why there is none:
 * - `not_goods`: not `mode=payment` with `metadata.kind = goods_order`.
 * - `awaiting_payment`: the session is not `complete`, or its
 *   `payment_status` is neither `unpaid` nor `paid`.
 * - `invalid_session`: no `cs_` id or `pi_` payment intent, no valid buyer
 *   email, no positive whole `amount_total`, no 3-letter currency, no item
 *   title (1 to 160 characters) in the metadata, or an event time that is no
 *   Unix time.
 *
 * A complete session with `payment_status=unpaid` (the normal case: the
 * payment is only authorized) answers a draft with `captureCheck: true`: the
 * Worker reads the payment intent and completes it with
 * {@link applyGoodsPaymentIntent}. `payment_status=paid` (captured at
 * Checkout, which manual capture should prevent) answers the order with
 * `capture_state=succeeded` and the `captured_at_checkout` anomaly.
 *
 * Anomalies are recorded, not refused: `amount_mismatch` (metadata unit price
 * × quantity is not the total, or those numbers are invalid),
 * `currency_not_dkk`, `consent_missing` (terms checkbox not `accepted`),
 * `terms_version_unknown` (no goods text digest for the version and locale),
 * `shipping_missing`, `shipping_not_dk`, `tax_mismatch` (the session's tax is
 * not the 25 % included in the total), `user_unverified`
 * (`metadata.user_id` set but not a UUID equal to `client_reference_id`) and
 * `captured_at_checkout`. `user_id` is always null: the Worker sets it after
 * its check.
 */
export function normalizeGoodsSession(session: unknown, event: GoodsSessionEvent): GoodsSessionResult {
  const record = asRecord(session);
  const metadata = asRecord(record?.metadata);
  if (record === null || record.mode !== "payment" || metadata === null || metadata.kind !== GOODS_ORDER_KIND) {
    return { ok: false, reason: "not_goods" };
  }
  const captured = record.payment_status === "paid";
  if (record.status !== "complete" || (!captured && record.payment_status !== "unpaid")) {
    return { ok: false, reason: "awaiting_payment" };
  }

  const customerDetails = asRecord(record.customer_details);
  const email = typeof customerDetails?.email === "string" ? customerDetails.email.trim() : null;
  const total = wholeOre(record.amount_total);
  const title = typeof metadata.title === "string" ? metadata.title.trim() : "";
  if (
    typeof record.id !== "string" ||
    !CS_ID_REGEX.test(record.id) ||
    typeof record.payment_intent !== "string" ||
    !PI_ID_REGEX.test(record.payment_intent) ||
    email === null ||
    email.length < 3 ||
    email.length > 320 ||
    !EMAIL.test(email) ||
    total === null ||
    total <= 0 ||
    typeof record.currency !== "string" ||
    !/^[a-z]{3}$/.test(record.currency) ||
    title === "" ||
    [...title].length > 160 ||
    !isUnixSeconds(event.created)
  ) {
    return { ok: false, reason: "invalid_session" };
  }

  const anomalies = new Set<GoodsOrderAnomaly>();
  const locale: Locale = isLocale(metadata.locale) ? metadata.locale : isLocale(record.locale) ? record.locale : "da";

  // The metadata's unit price and quantity must make up the total.
  const unitText = metadata.unit_amount_ore;
  const quantityText = metadata.quantity;
  const unit = typeof unitText === "string" && METADATA_COUNT.test(unitText) ? Number(unitText) : null;
  const quantity = typeof quantityText === "string" && METADATA_COUNT.test(quantityText) ? Number(quantityText) : null;
  const lineValid = unit !== null && quantity !== null && quantity <= MAX_QUANTITY;
  if (!lineValid || unit * quantity !== total) anomalies.add("amount_mismatch");

  if (record.currency !== "dkk") anomalies.add("currency_not_dkk");

  const consent = asRecord(record.consent)?.terms_of_service === "accepted" ? "accepted" : null;
  if (consent === null) anomalies.add("consent_missing");

  const version = typeof metadata.terms_version === "string" ? metadata.terms_version : "";
  const termsVersion = version.length >= 1 && version.length <= 64 ? version : "unknown";
  const termsSha256 = goodsTextDigest(termsVersion, locale);
  if (termsSha256 === null) anomalies.add("terms_version_unknown");

  const shippingDetails = asRecord(asRecord(record.collected_information)?.shipping_details);
  const address = shippingAddress(asRecord(shippingDetails?.address));
  if (address === null) anomalies.add("shipping_missing");
  else if (address.country !== "DK") anomalies.add("shipping_not_dk");

  const expectedTax = inclusiveVatOre(total);
  const sessionTax = wholeOre(asRecord(record.total_details)?.amount_tax);
  if (sessionTax !== expectedTax) anomalies.add("tax_mismatch");
  const tax = sessionTax ?? expectedTax;
  // Stripe's subtotal: the line amounts before discounts and shipping, the inclusive moms in them.
  const subtotal = wholeOre(record.amount_subtotal) ?? total;

  const metadataUser = metadata.user_id;
  if (metadataUser !== undefined && goodsSessionUserCandidate(record) === null) anomalies.add("user_unverified");

  const itemId = typeof metadata.item_id === "string" && UUID.test(metadata.item_id) ? metadata.item_id : null;
  const ordered = GOODS_ORDER_ANOMALIES.filter((code) => anomalies.has(code));

  const order: GoodsOrderDraft = {
    stripe_checkout_session_id: record.id,
    stripe_payment_intent_id: record.payment_intent,
    stripe_customer_id: typeof record.customer === "string" && CUS_ID_REGEX.test(record.customer) ? record.customer : null,
    stripe_invoice_id: typeof record.invoice === "string" && INV_ID_REGEX.test(record.invoice) ? record.invoice : null,
    user_id: null,
    email,
    customer_name: optionalText(customerDetails?.name, 200),
    phone: optionalText(customerDetails?.phone, 40),
    shipping_name: optionalText(shippingDetails?.name, 200),
    shipping_address: address,
    locale,
    currency: record.currency,
    amount_subtotal_ore: subtotal,
    amount_tax_ore: tax,
    amount_total_ore: total,
    terms_version: termsVersion,
    terms_sha256: termsSha256,
    stripe_consent: consent,
    anomaly: ordered.length === 0 ? null : ordered.join(","),
    paid_at: unixToIso(event.created),
    lines: [
      {
        line_no: 1,
        item_id: itemId,
        offer_kind: metadata.offer_kind === "digital" ? "digital" : "physical",
        title,
        quantity: lineValid ? quantity : 1,
        unit_amount_ore: lineValid ? unit : total,
        amount_total_ore: total,
        amount_tax_ore: tax,
      },
    ],
  };
  if (captured) return { ok: true, captureCheck: false, order: capturedAtCheckout(order) };
  return { ok: true, captureCheck: true, order };
}

/**
 * Completes a draft (`captureCheck: true`) from its payment intent as
 * `GET /v1/payment_intents/{pi}?expand[]=latest_charge` answers it:
 * - `requires_capture` (authorized): `capture_state=requires_capture` and
 *   `authorization_expires_at` from the latest charge's
 *   `payment_method_details.card.capture_before` (null without one: not a
 *   card, or `latest_charge` not expanded).
 * - `succeeded` (captured at Checkout): `capture_state=succeeded` and the
 *   `captured_at_checkout` anomaly.
 * - any other status (`processing`, `requires_action`, `canceled`, …):
 *   `awaiting_payment`, nothing to record yet.
 * - not an object, or another payment intent's id: `invalid_payment_intent`.
 */
export function applyGoodsPaymentIntent(order: GoodsOrderDraft, paymentIntent: unknown): GoodsCaptureResult {
  const intent = asRecord(paymentIntent);
  if (intent === null || intent.id !== order.stripe_payment_intent_id) return { ok: false, reason: "invalid_payment_intent" };
  if (intent.status === "succeeded") return { ok: true, order: capturedAtCheckout(order) };
  if (intent.status !== "requires_capture") return { ok: false, reason: "awaiting_payment" };
  const card = asRecord(asRecord(asRecord(intent.latest_charge)?.payment_method_details)?.card);
  const captureBefore = card?.capture_before;
  return {
    ok: true,
    order: {
      ...order,
      capture_state: "requires_capture",
      authorization_expires_at: isUnixSeconds(captureBefore) ? unixToIso(captureBefore) : null,
    },
  };
}
