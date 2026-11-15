import type { Locale } from "next-intl";
import {
  OFFER_KINDS,
  ORDER_CANCEL_REASONS,
  ORDER_STATUSES,
  ORDER_WITHDRAWAL_STATUSES,
  type OfferKind,
  type OrderCancelReason,
  type OrderStatus,
  type OrderWithdrawalStatus,
} from "@/config/payments";
import type { OrderShippingAddress } from "@/lib/payments/orders/session";
import { createServerClient } from "@/lib/supabase/server";
import type { Json } from "@/types/database";

/** An order's withdrawal as the list shows it (its badge). */
export interface AdminOrderRowWithdrawal {
  status: OrderWithdrawalStatus;
}

/** One goods order in Admin › Ordrer. */
export interface AdminOrderRow {
  id: string;
  orderNumber: number;
  /** The order's email (the buyer's). */
  email: string;
  /** The delivery name; `null` when Stripe collected none (an anomaly). */
  shippingName: string | null;
  /** Total in øre incl. moms and delivery. */
  amountTotalOre: number;
  status: OrderStatus;
  /** When the payment was authorized at Checkout (ISO). */
  paidAt: string;
  /** Comma list of anomaly codes the owner should check; `null` = none. */
  anomaly: string | null;
  /** The title of the order's first line (the item as bought). */
  itemTitle: string;
  withdrawal: AdminOrderRowWithdrawal | null;
}

/** One line of an order, as bought. */
export interface AdminOrderLine {
  title: string;
  offerKind: OfferKind;
  quantity: number;
  unitAmountOre: number;
  /** The line total in øre incl. moms. */
  amountTotalOre: number;
}

/** An order's withdrawal on the order page. */
export interface AdminOrderWithdrawal {
  status: OrderWithdrawalStatus;
  /** When the notice arrived (the database clock: the authoritative notice time). */
  requestedAt: string;
  /** The deadline it is checked against (the start of the day after the last day); `null` when not shipped at notice time. */
  deadlineAt: string | null;
  late: boolean;
  /** When the refund is due at the latest (14 days after the notice). */
  refundDueAt: string;
  /** The deduction for diminished value in øre (0 = none), and its reason. */
  deductionOre: number;
  deductionReason: string | null;
  /** The refund in øre; `null` for a released authorization or before approval. */
  refundOre: number | null;
  /** When the refund was made, or the authorization released; `null` before. */
  completedAt: string | null;
  /** Why it needs manual handling (`stripe_refused`, `retries_exhausted`); `null` otherwise. */
  manualReason: string | null;
}

/** A goods order with everything Admin › Ordrer › one order shows. */
export interface AdminOrderDetail {
  id: string;
  orderNumber: number;
  email: string;
  customerName: string | null;
  phone: string | null;
  shippingName: string | null;
  shippingAddress: OrderShippingAddress | null;
  /** Amounts in øre: total incl. moms and delivery, the moms in it, refunded so far. */
  amountTotalOre: number;
  amountTaxOre: number;
  amountRefundedOre: number;
  /** The buyer's language (emails, withdrawal). */
  locale: Locale;
  status: OrderStatus;
  /** When the payment was authorized at Checkout. */
  paidAt: string;
  /** When the card authorization lapses (Stripe's `capture_before`); `null` for other payment methods. */
  authorizationExpiresAt: string | null;
  /** When the payment was captured (at dispatch, or at Checkout); `null` while only authorized. */
  capturedAt: string | null;
  canceledAt: string | null;
  cancelReason: OrderCancelReason | null;
  confirmationSentAt: string | null;
  shippedAt: string | null;
  trackingRef: string | null;
  anomaly: string | null;
  stripeCheckoutSessionId: string;
  stripePaymentIntentId: string;
  stripeCustomerId: string | null;
  stripeInvoiceId: string | null;
  lines: AdminOrderLine[];
  withdrawal: AdminOrderWithdrawal | null;
}

const LIST_SELECT = `id, order_number, email, shipping_name, amount_total_ore, status, paid_at, anomaly,
  order_items(line_no, title),
  order_withdrawals(status)`;

const DETAIL_SELECT = `id, order_number, email, customer_name, phone, shipping_name, shipping_address,
  amount_total_ore, amount_tax_ore, amount_refunded_ore, locale, status,
  paid_at, authorization_expires_at, captured_at, canceled_at, cancel_reason, confirmation_sent_at,
  shipped_at, tracking_ref, anomaly, stripe_checkout_session_id, stripe_payment_intent_id,
  stripe_customer_id, stripe_invoice_id,
  order_items(line_no, title, offer_kind, quantity, unit_amount_ore, amount_total_ore),
  order_withdrawals(status, requested_at, deadline_at, late, refund_due_at, deduction_ore,
    deduction_reason, refund_ore, refunded_at, authorization_canceled_at, manual_reason)`;

/**
 * `value` as one of `values`. The tables' CHECK constraints allow nothing
 * else, so another value means the schema and this code disagree.
 *
 * @throws on any other value.
 */
function oneOf<T extends string>(value: string, values: readonly T[]): T {
  const match = values.find((candidate) => candidate === value);
  if (match === undefined) throw new Error(`Unexpected order value: ${value}`);
  return match;
}

/** `orders.shipping_address` (a JSON object, CHECKed to hold line1, postal_code, city and country) with its string fields. */
function toShippingAddress(value: Json | null): OrderShippingAddress | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const field = (key: string) => {
    const text = value[key];
    return typeof text === "string" ? text : null;
  };
  return {
    line1: field("line1"),
    line2: field("line2"),
    postal_code: field("postal_code"),
    city: field("city"),
    country: field("country"),
  };
}

/**
 * Every goods order for Admin › Ordrer, newest first, with the first line's
 * title and the withdrawal's status. Read with the admin's own session
 * (orders RLS: an admin reads every order). The page filters and counts these
 * rows itself, so one read serves the list and every filter.
 *
 * @throws when the query fails.
 */
export async function listOrders(): Promise<AdminOrderRow[]> {
  const supabase = await createServerClient();
  const { data, error } = await supabase
    .from("orders")
    .select(LIST_SELECT)
    .order("created_at", { ascending: false })
    .order("order_number", { ascending: false });
  if (error) throw new Error(`Failed to load the orders: ${error.message}`);

  return data.map((row) => ({
    id: row.id,
    orderNumber: row.order_number,
    email: row.email,
    shippingName: row.shipping_name,
    amountTotalOre: row.amount_total_ore,
    status: oneOf(row.status, ORDER_STATUSES),
    paidAt: row.paid_at,
    anomaly: row.anomaly,
    itemTitle: row.order_items.toSorted((a, b) => a.line_no - b.line_no)[0]?.title ?? "",
    withdrawal: row.order_withdrawals && { status: oneOf(row.order_withdrawals.status, ORDER_WITHDRAWAL_STATUSES) },
  }));
}

/**
 * The order with number `orderNumber` for its admin page, or `null` when no
 * order has it (or it is not a positive whole number: no query then). Read
 * with the admin's own session (orders RLS).
 *
 * @throws when the query fails.
 */
export async function getOrderByNumber(orderNumber: number): Promise<AdminOrderDetail | null> {
  if (!Number.isSafeInteger(orderNumber) || orderNumber < 1) return null;
  const supabase = await createServerClient();
  const { data: row, error } = await supabase
    .from("orders")
    .select(DETAIL_SELECT)
    .eq("order_number", orderNumber)
    .maybeSingle();
  if (error) throw new Error(`Failed to load order ${orderNumber}: ${error.message}`);
  if (!row) return null;

  const withdrawal = row.order_withdrawals;
  return {
    id: row.id,
    orderNumber: row.order_number,
    email: row.email,
    customerName: row.customer_name,
    phone: row.phone,
    shippingName: row.shipping_name,
    shippingAddress: toShippingAddress(row.shipping_address),
    amountTotalOre: row.amount_total_ore,
    amountTaxOre: row.amount_tax_ore,
    amountRefundedOre: row.amount_refunded_ore,
    locale: row.locale,
    status: oneOf(row.status, ORDER_STATUSES),
    paidAt: row.paid_at,
    authorizationExpiresAt: row.authorization_expires_at,
    capturedAt: row.captured_at,
    canceledAt: row.canceled_at,
    cancelReason: row.cancel_reason === null ? null : oneOf(row.cancel_reason, ORDER_CANCEL_REASONS),
    confirmationSentAt: row.confirmation_sent_at,
    shippedAt: row.shipped_at,
    trackingRef: row.tracking_ref,
    anomaly: row.anomaly,
    stripeCheckoutSessionId: row.stripe_checkout_session_id,
    stripePaymentIntentId: row.stripe_payment_intent_id,
    stripeCustomerId: row.stripe_customer_id,
    stripeInvoiceId: row.stripe_invoice_id,
    lines: row.order_items.toSorted((a, b) => a.line_no - b.line_no).map((line) => ({
      title: line.title,
      offerKind: oneOf(line.offer_kind, OFFER_KINDS),
      quantity: line.quantity,
      unitAmountOre: line.unit_amount_ore,
      amountTotalOre: line.amount_total_ore,
    })),
    withdrawal: withdrawal && {
      status: oneOf(withdrawal.status, ORDER_WITHDRAWAL_STATUSES),
      requestedAt: withdrawal.requested_at,
      deadlineAt: withdrawal.deadline_at,
      late: withdrawal.late === true,
      refundDueAt: withdrawal.refund_due_at,
      deductionOre: withdrawal.deduction_ore,
      deductionReason: withdrawal.deduction_reason,
      refundOre: withdrawal.refund_ore,
      completedAt: withdrawal.refunded_at ?? withdrawal.authorization_canceled_at,
      manualReason: withdrawal.manual_reason,
    },
  };
}
