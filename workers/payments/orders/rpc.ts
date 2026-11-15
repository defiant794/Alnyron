import { createClient } from "@supabase/supabase-js";
import type { Locale } from "next-intl";
import {
  ORDER_CANCEL_REASONS,
  ORDER_STATUSES,
  ORDER_WITHDRAWAL_STATUSES,
  PAYMENTS_RPC_TIMEOUT_MS,
  type OrderCancelReason,
  type OrderGoodsState,
  type OrderStatus,
  type OrderWithdrawalStatus,
} from "@/config/payments";
import type { OrderManualReason } from "@/config/legal/goods-texts";
import type { GoodsOfferSnapshot } from "@/lib/payments/orders/checkout-params";
import type { GoodsOrderInput, OrderShippingAddress } from "@/lib/payments/orders/session";
import { asRecord, type RpcEvent } from "@/lib/payments/webhook-mapping";
import type { Database, Json } from "@/types/database";

/**
 * The goods (slice S2) door to Supabase: one typed wrapper per service-role
 * writer of migration 20261114000400 and two reads of the order tables (the
 * sweep's and the service's emails need an order's buyer, address and line),
 * over supabase-js with the Supabase secret key. Separate from rpc.ts (the
 * subscription writers). Every rule (event dedupe, the state machines, role
 * checks, amounts) lives in the writers; every answer is checked here and one
 * of the wrong shape is an {@link OrderRpcError} `invalid_response`. The reads
 * are GETs, which postgrest-js would retry with backoff: `.retry(false)` keeps
 * each one attempt, bounded by PAYMENTS_RPC_TIMEOUT_MS like every request.
 */

/** The order fields the Worker uses, from `private.payments_order_json` or a read of `orders`. */
export type OrderSnapshot = {
  id: string;
  order_number: number;
  status: OrderStatus;
  email: string;
  customer_name: string | null;
  phone: string | null;
  shipping_name: string | null;
  shipping_address: OrderShippingAddress | null;
  locale: Locale;
  amount_total_ore: number;
  amount_refunded_ore: number;
  paid_at: string;
  authorization_expires_at: string | null;
  captured_at: string | null;
  cancel_reason: OrderCancelReason | null;
  anomaly: string | null;
  tracking_ref: string | null;
  stripe_payment_intent_id: string;
  /** The order's first line (S2 orders have exactly one): the item's title at purchase and the quantity. */
  line: { title: string; quantity: number };
};

/** The withdrawal fields the Worker uses, from `private.payments_order_withdrawal_json` or a read. */
export type OrderWithdrawalSnapshot = {
  id: string;
  order_id: string;
  status: OrderWithdrawalStatus;
  consumer_name: string;
  locale: Locale;
  requested_at: string;
  refund_due_at: string;
  deadline_at: string | null;
  late: boolean;
  shipped_before_notice: boolean;
  /** Set when approved: release the authorization, or refund `refund_ore`. */
  action: "cancel_authorization" | "refund" | null;
  refund_ore: number | null;
  deduction_ore: number;
  deduction_reason: string | null;
  refunded_at: string | null;
  authorization_canceled_at: string | null;
  /** Why the Worker stopped automating it (status `needs_manual`), else null. */
  manual_reason: OrderManualReason | null;
  attempts: number;
};

/** What `payments_order_mail_sent` stamps (`failed` counts a failed send). */
export type OrderMailKind = "confirmation" | "owner" | "capture_warning" | "expired_alert" | "shipped" | "failed";

/** The steps `payments_order_withdrawal_step` records. */
export type OrderWithdrawalStep =
  | "ack_sent"
  | "owner_alerted"
  | "refunded"
  | "authorization_canceled"
  | "receipt_sent"
  | "reminder_sent"
  | "needs_manual"
  | "manual_alert_sent"
  | "attempt_failed"
  | "mail_failed";

/** An order's missing emails as `payments_pending_order_work` lists them. */
export type OrderMailNeed = "confirmation" | "owner" | "shipped" | "expired_alert";

/** A withdrawal's work as `payments_pending_order_work` lists it. */
export type OrderWithdrawalNeed = "ack" | "owner_alert" | "refund" | "receipt" | "reminder" | "manual_alert";

export type PendingOrderWork = {
  ordersMail: { orderId: string; needs: OrderMailNeed[] }[];
  withdrawals: { withdrawalId: string; needs: OrderWithdrawalNeed[] }[];
  /** Orders whose authorization lapses within 48 hours: the owner's capture warning. */
  captureWarnings: string[];
};

export type BeginOrderWithdrawalInput = {
  orderId: string;
  consumerName: string;
  channel: "link" | "form";
  statementVersion: string;
  locale: Locale;
};

export type ApproveOrderRefundInput = {
  orderId: string;
  actor: string;
  goodsState: OrderGoodsState;
  deductionOre: number;
  deductionReason: string | null;
};

export type OrderRpc = {
  /** `payments_goods_offer`: the purchasable snapshot of an item's active physical offer, or null. */
  goodsOffer(itemId: string, locale: Locale): Promise<GoodsOfferSnapshot | null>;
  /** `payments_record_order`: records an authorized goods Checkout (`duplicate` for a seen event or session). */
  recordOrder(
    event: RpcEvent,
    order: GoodsOrderInput,
  ): Promise<{ outcome: "recorded"; orderId: string; orderNumber: number } | { outcome: "duplicate" }>;
  /** `payments_order_mail_sent`: stamps an order email once (`emailId` is ignored for `failed`). */
  orderMailSent(orderId: string, kind: OrderMailKind, emailId: string): Promise<"stamped" | "already" | "counted">;
  /** `payments_order_begin_ship` (42501 forbidden, P0002 order_not_found, P0001 order_closed / withdrawal_pending). */
  beginShip(
    orderId: string,
    actor: string,
    trackingRef: string | null,
  ): Promise<{ outcome: "capture" | "already_shipped"; order: OrderSnapshot }>;
  /** `payments_order_captured`: marks the captured order shipped (P0001 order_closed). */
  orderCaptured(orderId: string, actor: string): Promise<{ outcome: "shipped" | "already_shipped"; order: OrderSnapshot }>;
  /** `payments_order_capture_failed`: `authorization_expired` cancels the order, `capture_refused` flags it. */
  captureFailed(
    orderId: string,
    reason: "authorization_expired" | "capture_refused",
  ): Promise<{ outcome: "canceled" | "unchanged"; order: OrderSnapshot }>;
  /** `payments_find_order`: the order id when the number and email match, else null. */
  findOrder(orderNumber: number, email: string): Promise<string | null>;
  /** `payments_begin_order_withdrawal` (link or form, no account; P0002 order_not_found). */
  beginOrderWithdrawal(
    input: BeginOrderWithdrawalInput,
  ): Promise<
    | { outcome: "not_withdrawable" }
    | { outcome: "created" | "existing"; withdrawal: OrderWithdrawalSnapshot; order: OrderSnapshot }
  >;
  /** `payments_approve_order_refund` (42501, P0002, P0001 order_refunded / order_shipped / order_not_shipped, 22023). */
  approveOrderRefund(
    input: ApproveOrderRefundInput,
  ): Promise<{ outcome: "approved" | "already_approved"; withdrawal: OrderWithdrawalSnapshot; order: OrderSnapshot }>;
  /** `payments_claim_order_withdrawal`: leases an approved withdrawal for one refund or release pass. */
  claimOrderWithdrawal(
    withdrawalId: string,
    leaseSeconds: number,
  ): Promise<{ claimed: boolean; withdrawal: OrderWithdrawalSnapshot; order: OrderSnapshot }>;
  /** `payments_order_withdrawal_step` (P0001 illegal_step). */
  orderWithdrawalStep(
    withdrawalId: string,
    step: OrderWithdrawalStep,
    data: Record<string, Json>,
  ): Promise<{ outcome: "applied" | "already"; withdrawal: OrderWithdrawalSnapshot }>;
  /** `payments_pending_order_work`: what the sweep's order pass finishes. */
  pendingOrderWork(limit: number, maxMailAttempts: number): Promise<PendingOrderWork>;
  /** `payments_sync_order_refund` (charge.refunded). */
  syncOrderRefund(
    event: RpcEvent,
    paymentIntentId: string,
    amountRefundedOre: number,
  ): Promise<
    | { outcome: "unknown_order" }
    | { outcome: "duplicate" }
    | { outcome: "synced"; orderId: string; amountRefundedOre: number; status: OrderStatus }
  >;
  /** `payments_order_authorization_canceled` (payment_intent.canceled). */
  authorizationCanceled(
    event: RpcEvent,
    paymentIntentId: string,
  ): Promise<
    | { outcome: "unknown_order" }
    | { outcome: "duplicate" }
    | { outcome: "ignored"; orderId: string }
    | { outcome: "canceled"; order: OrderSnapshot }
  >;
  /** One order with its first line (a read of `orders`), or null. */
  readOrder(orderId: string): Promise<OrderSnapshot | null>;
  /** One withdrawal with its order (a read of `order_withdrawals`), or null. */
  readOrderWithdrawal(withdrawalId: string): Promise<{ withdrawal: OrderWithdrawalSnapshot; order: OrderSnapshot } | null>;
};

/** The goods writers' refusals per SQLSTATE: retrying the same call cannot change them. */
const ORDER_REFUSALS: Readonly<Record<string, readonly string[]>> = {
  P0001: ["order_closed", "withdrawal_pending", "order_refunded", "order_shipped", "order_not_shipped", "illegal_step"],
  P0002: ["order_not_found", "withdrawal_not_found"],
  "42501": ["forbidden"],
  "22023": ["invalid_payload", "deduction_invalid", "deduction_reason_required"],
};

/**
 * A failed goods database call. `message` is the writer's refusal (one of
 * {@link ORDER_REFUSALS} for its SQLSTATE), else `rpc_failed`: never a
 * message, detail or hint of the answer, which may echo payload values.
 * `code` is the PostgREST/Postgres error code (`unknown` without one,
 * `invalid_response` for an answer of the wrong shape); `status` the HTTP
 * status, null without an answer (status 0 is stored as null).
 */
export class OrderRpcError extends Error {
  readonly code: string;
  readonly status: number | null;
  /** The refusal keyword when the database refused the call for good, else null. */
  readonly refusal: string | null;

  constructor(message: string, code = "unknown", status: number | null = null) {
    const refusal = ORDER_REFUSALS[code]?.includes(message) ? message : null;
    super(refusal ?? "rpc_failed");
    this.name = "OrderRpcError";
    this.code = code;
    this.status = status === 0 ? null : status;
    this.refusal = refusal;
  }
}

/** The refusal of a failed goods call (`{code, reason}`), or null for a failure a retry may fix. */
export function orderRefusal(error: unknown): { code: string; reason: string } | null {
  return error instanceof OrderRpcError && error.refusal !== null ? { code: error.code, reason: error.refusal } : null;
}

type RpcAnswer = { data: unknown; error: { code?: string; message?: string } | null; status: number };

/** The answer's data as a record, after throwing its error; a non-object is `invalid_response`. */
function answerRecord({ data, error, status }: RpcAnswer): Record<string, unknown> {
  if (error) throw new OrderRpcError(error.message ?? "", error.code || "unknown", status);
  const record = asRecord(data);
  if (record === null) throw invalidResponse(status);
  return record;
}

function invalidResponse(status: number | null = null): OrderRpcError {
  return new OrderRpcError("rpc_failed", "invalid_response", status);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isLocale(value: unknown): value is Locale {
  return value === "da" || value === "en";
}

/** `value` when it is one of `options`, else undefined. */
function oneOf<T extends string>(value: unknown, options: readonly T[]): T | undefined {
  return options.find((option) => option === value);
}

const MAIL_NEEDS: readonly OrderMailNeed[] = ["confirmation", "owner", "shipped", "expired_alert"];
const WITHDRAWAL_NEEDS: readonly OrderWithdrawalNeed[] = ["ack", "owner_alert", "refund", "receipt", "reminder", "manual_alert"];

/** Every {@link OrderManualReason} (tsc checks the keys against the union). */
const MANUAL_REASONS: Readonly<Record<OrderManualReason, true>> = { stripe_refused: true, retries_exhausted: true };

function isManualReason(value: unknown): value is OrderManualReason {
  return typeof value === "string" && Object.hasOwn(MANUAL_REASONS, value);
}

/** A stored delivery address, null for none; undefined when it is malformed. */
function parseAddress(value: unknown): OrderShippingAddress | null | undefined {
  if (value === null) return null;
  const address = asRecord(value);
  if (address === null) return undefined;
  const field = (key: string): string | null | undefined => {
    const text = address[key];
    return text === undefined || text === null ? null : typeof text === "string" ? text : undefined;
  };
  const line1 = field("line1");
  const line2 = field("line2");
  const postalCode = field("postal_code");
  const city = field("city");
  const country = field("country");
  if (line1 === undefined || line2 === undefined || postalCode === undefined || city === undefined || country === undefined) {
    return undefined;
  }
  return { line1, line2, postal_code: postalCode, city, country };
}

/** The first line (lowest `line_no`) of `lines` (the snapshot's) or `order_items` (a read's). */
function firstLine(lines: unknown): { title: string; quantity: number } | null {
  if (!Array.isArray(lines)) return null;
  const parsed = lines.map(asRecord).filter((line) => line !== null);
  const first = parsed.sort((a, b) => Number(a.line_no) - Number(b.line_no))[0];
  if (first === undefined || parsed.length !== lines.length || !isString(first.title) || !isCount(first.quantity)) {
    return null;
  }
  return { title: first.title, quantity: first.quantity };
}

/** `value` as an {@link OrderSnapshot}, or null when a field is missing or of the wrong type. */
export function parseOrderSnapshot(value: unknown): OrderSnapshot | null {
  const o = asRecord(value);
  if (o === null) return null;
  const status = oneOf(o.status, ORDER_STATUSES);
  const cancelReason = o.cancel_reason === null ? null : oneOf(o.cancel_reason, ORDER_CANCEL_REASONS);
  const address = parseAddress(o.shipping_address);
  const line = firstLine(o.lines ?? o.order_items);
  if (
    status === undefined ||
    cancelReason === undefined ||
    address === undefined ||
    line === null ||
    !isString(o.id) ||
    !isCount(o.order_number) ||
    !isString(o.email) ||
    !isNullableString(o.customer_name) ||
    !isNullableString(o.phone) ||
    !isNullableString(o.shipping_name) ||
    !isLocale(o.locale) ||
    !isCount(o.amount_total_ore) ||
    !isCount(o.amount_refunded_ore) ||
    !isString(o.paid_at) ||
    !isNullableString(o.authorization_expires_at) ||
    !isNullableString(o.captured_at) ||
    !isNullableString(o.anomaly) ||
    !isNullableString(o.tracking_ref) ||
    !isString(o.stripe_payment_intent_id)
  ) {
    return null;
  }
  return {
    id: o.id,
    order_number: o.order_number,
    status,
    email: o.email,
    customer_name: o.customer_name,
    phone: o.phone,
    shipping_name: o.shipping_name,
    shipping_address: address,
    locale: o.locale,
    amount_total_ore: o.amount_total_ore,
    amount_refunded_ore: o.amount_refunded_ore,
    paid_at: o.paid_at,
    authorization_expires_at: o.authorization_expires_at,
    captured_at: o.captured_at,
    cancel_reason: cancelReason,
    anomaly: o.anomaly,
    tracking_ref: o.tracking_ref,
    stripe_payment_intent_id: o.stripe_payment_intent_id,
    line,
  };
}

/** `value` as an {@link OrderWithdrawalSnapshot}, or null when a field is missing or of the wrong type. */
export function parseOrderWithdrawalSnapshot(value: unknown): OrderWithdrawalSnapshot | null {
  const w = asRecord(value);
  if (w === null) return null;
  const status = oneOf(w.status, ORDER_WITHDRAWAL_STATUSES);
  const action = w.action === null ? null : oneOf(w.action, ["cancel_authorization", "refund"] as const);
  const manualReason = w.manual_reason === null ? null : isManualReason(w.manual_reason) ? w.manual_reason : undefined;
  if (
    status === undefined ||
    action === undefined ||
    manualReason === undefined ||
    !isString(w.id) ||
    !isString(w.order_id) ||
    !isString(w.consumer_name) ||
    !isLocale(w.locale) ||
    !isString(w.requested_at) ||
    !isString(w.refund_due_at) ||
    !isNullableString(w.deadline_at) ||
    typeof w.late !== "boolean" ||
    typeof w.shipped_before_notice !== "boolean" ||
    !(w.refund_ore === null || isCount(w.refund_ore)) ||
    !isCount(w.deduction_ore) ||
    !isNullableString(w.deduction_reason) ||
    !isNullableString(w.refunded_at) ||
    !isNullableString(w.authorization_canceled_at) ||
    !isCount(w.attempts)
  ) {
    return null;
  }
  return {
    id: w.id,
    order_id: w.order_id,
    status,
    consumer_name: w.consumer_name,
    locale: w.locale,
    requested_at: w.requested_at,
    refund_due_at: w.refund_due_at,
    deadline_at: w.deadline_at,
    late: w.late,
    shipped_before_notice: w.shipped_before_notice,
    action,
    refund_ore: w.refund_ore,
    deduction_ore: w.deduction_ore,
    deduction_reason: w.deduction_reason,
    refunded_at: w.refunded_at,
    authorization_canceled_at: w.authorization_canceled_at,
    manual_reason: manualReason,
    attempts: w.attempts,
  };
}

/** The answer's `outcome` when it is one of `outcomes`, else an `invalid_response`. */
function outcomeOf<Outcome extends string>(record: Record<string, unknown>, outcomes: readonly Outcome[], status: number): Outcome {
  const outcome = oneOf(record.outcome, outcomes);
  if (outcome === undefined) throw invalidResponse(status);
  return outcome;
}

/** `record[key]` as an order snapshot, else an `invalid_response`. */
function orderOf(record: Record<string, unknown>, status: number, key = "order"): OrderSnapshot {
  const order = parseOrderSnapshot(record[key]);
  if (order === null) throw invalidResponse(status);
  return order;
}

/** `record.withdrawal` as a withdrawal snapshot, else an `invalid_response`. */
function withdrawalOf(record: Record<string, unknown>, status: number): OrderWithdrawalSnapshot {
  const withdrawal = parseOrderWithdrawalSnapshot(record.withdrawal);
  if (withdrawal === null) throw invalidResponse(status);
  return withdrawal;
}

/** `value` as a list of `{<idKey>, needs}` with known needs, else null. */
function pendingList<Need extends string>(
  value: unknown,
  idKey: string,
  needs: readonly Need[],
): { id: string; needs: Need[] }[] | null {
  if (!Array.isArray(value)) return null;
  const items: { id: string; needs: Need[] }[] = [];
  for (const entry of value) {
    const item = asRecord(entry);
    const id = item?.[idKey];
    const listed = item?.needs;
    if (!isString(id) || !Array.isArray(listed)) return null;
    const known = listed.map((need) => oneOf(need, needs));
    if (known.some((need) => need === undefined)) return null;
    items.push({ id, needs: known.filter((need) => need !== undefined) });
  }
  return items;
}

/** The order columns a read selects: every column, plus each line's number, title and quantity. */
const ORDER_SELECT = "*, order_items(line_no, title, quantity)";

/**
 * {@link OrderRpc} over supabase-js with the Supabase secret key (no session,
 * no token refresh). Arguments go as JSON (PostgREST parameters), never as
 * SQL. Every request, its body included, is aborted after
 * PAYMENTS_RPC_TIMEOUT_MS; `fetchImpl` stands in for the global fetch (the
 * sweep's subrequest counter).
 */
export function createOrderRpc(url: string, secretKey: string, fetchImpl?: typeof fetch): OrderRpc {
  const base = fetchImpl ?? ((input, init) => fetch(input, init));
  const client = createClient<Database>(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: (input, init) => {
        const timeout = AbortSignal.timeout(PAYMENTS_RPC_TIMEOUT_MS);
        return base(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
      },
    },
  });

  return {
    async goodsOffer(itemId, locale) {
      const answer = await client.rpc("payments_goods_offer", { p_item_id: itemId, p_locale: locale });
      if (answer.error) throw new OrderRpcError(answer.error.message, answer.error.code || "unknown", answer.status);
      if (answer.data === null) return null;
      const offer = asRecord(answer.data);
      if (
        offer === null ||
        !isString(offer.item_id) ||
        !isCount(offer.price_ore) ||
        offer.price_ore <= 0 ||
        !isString(offer.title) ||
        !isString(offer.section_slug) ||
        !isString(offer.item_slug) ||
        !isLocale(offer.locale)
      ) {
        throw invalidResponse(answer.status);
      }
      return {
        item_id: offer.item_id,
        price_ore: offer.price_ore,
        title: offer.title,
        section_slug: offer.section_slug,
        item_slug: offer.item_slug,
        locale: offer.locale,
      };
    },

    async recordOrder(event, order) {
      const answer = await client.rpc("payments_record_order", { p_event: event, p_order: order });
      const record = answerRecord(answer);
      const outcome = outcomeOf(record, ["recorded", "duplicate"] as const, answer.status);
      if (outcome === "duplicate") return { outcome };
      if (!isString(record.order_id) || !isCount(record.order_number)) throw invalidResponse(answer.status);
      return { outcome, orderId: record.order_id, orderNumber: record.order_number };
    },

    async orderMailSent(orderId, kind, emailId) {
      const answer = await client.rpc("payments_order_mail_sent", {
        p_order_id: orderId,
        p_kind: kind,
        p_email_id: emailId,
      });
      return outcomeOf(answerRecord(answer), ["stamped", "already", "counted"] as const, answer.status);
    },

    async beginShip(orderId, actor, trackingRef) {
      const answer = await client.rpc("payments_order_begin_ship", {
        p_order_id: orderId,
        p_actor: actor,
        ...(trackingRef === null ? {} : { p_tracking_ref: trackingRef }),
      });
      const record = answerRecord(answer);
      return {
        outcome: outcomeOf(record, ["capture", "already_shipped"] as const, answer.status),
        order: orderOf(record, answer.status),
      };
    },

    async orderCaptured(orderId, actor) {
      const answer = await client.rpc("payments_order_captured", { p_order_id: orderId, p_actor: actor });
      const record = answerRecord(answer);
      return {
        outcome: outcomeOf(record, ["shipped", "already_shipped"] as const, answer.status),
        order: orderOf(record, answer.status),
      };
    },

    async captureFailed(orderId, reason) {
      const answer = await client.rpc("payments_order_capture_failed", { p_order_id: orderId, p_reason: reason });
      const record = answerRecord(answer);
      return {
        outcome: outcomeOf(record, ["canceled", "unchanged"] as const, answer.status),
        order: orderOf(record, answer.status),
      };
    },

    async findOrder(orderNumber, email) {
      const answer = await client.rpc("payments_find_order", { p_order_number: orderNumber, p_email: email });
      const orderId = answerRecord(answer).order_id;
      if (!isNullableString(orderId)) throw invalidResponse(answer.status);
      return orderId;
    },

    async beginOrderWithdrawal(input) {
      const answer = await client.rpc("payments_begin_order_withdrawal", {
        p_order_id: input.orderId,
        p_consumer_name: input.consumerName,
        p_channel: input.channel,
        p_statement_version: input.statementVersion,
        p_locale: input.locale,
      });
      const record = answerRecord(answer);
      const outcome = outcomeOf(record, ["not_withdrawable", "created", "existing"] as const, answer.status);
      if (outcome === "not_withdrawable") return { outcome };
      return { outcome, withdrawal: withdrawalOf(record, answer.status), order: orderOf(record, answer.status) };
    },

    async approveOrderRefund(input) {
      const answer = await client.rpc("payments_approve_order_refund", {
        p_order_id: input.orderId,
        p_actor: input.actor,
        p_goods_state: input.goodsState,
        p_deduction_ore: input.deductionOre,
        ...(input.deductionReason === null ? {} : { p_deduction_reason: input.deductionReason }),
      });
      const record = answerRecord(answer);
      return {
        outcome: outcomeOf(record, ["approved", "already_approved"] as const, answer.status),
        withdrawal: withdrawalOf(record, answer.status),
        order: orderOf(record, answer.status),
      };
    },

    async claimOrderWithdrawal(withdrawalId, leaseSeconds) {
      const answer = await client.rpc("payments_claim_order_withdrawal", {
        p_withdrawal_id: withdrawalId,
        p_lease_seconds: leaseSeconds,
      });
      const record = answerRecord(answer);
      if (typeof record.claimed !== "boolean") throw invalidResponse(answer.status);
      return { claimed: record.claimed, withdrawal: withdrawalOf(record, answer.status), order: orderOf(record, answer.status) };
    },

    async orderWithdrawalStep(withdrawalId, step, data) {
      const answer = await client.rpc("payments_order_withdrawal_step", {
        p_withdrawal_id: withdrawalId,
        p_step: step,
        p_data: data,
      });
      const record = answerRecord(answer);
      return {
        outcome: outcomeOf(record, ["applied", "already"] as const, answer.status),
        withdrawal: withdrawalOf(record, answer.status),
      };
    },

    async pendingOrderWork(limit, maxMailAttempts) {
      const answer = await client.rpc("payments_pending_order_work", {
        p_limit: limit,
        p_max_mail_attempts: maxMailAttempts,
      });
      const record = answerRecord(answer);
      const ordersMail = pendingList(record.orders_mail, "order_id", MAIL_NEEDS);
      const withdrawals = pendingList(record.withdrawals, "withdrawal_id", WITHDRAWAL_NEEDS);
      const warnings = pendingList(record.orders_capture_warning, "order_id", ["capture_warning"] as const);
      if (ordersMail === null || withdrawals === null || warnings === null) throw invalidResponse(answer.status);
      return {
        ordersMail: ordersMail.map(({ id, needs }) => ({ orderId: id, needs })),
        withdrawals: withdrawals.map(({ id, needs }) => ({ withdrawalId: id, needs })),
        captureWarnings: warnings.map(({ id }) => id),
      };
    },

    async syncOrderRefund(event, paymentIntentId, amountRefundedOre) {
      const answer = await client.rpc("payments_sync_order_refund", {
        p_event: event,
        p_payment_intent: paymentIntentId,
        p_amount_refunded: amountRefundedOre,
      });
      const record = answerRecord(answer);
      const outcome = outcomeOf(record, ["unknown_order", "duplicate", "synced"] as const, answer.status);
      if (outcome !== "synced") return { outcome };
      const status = oneOf(record.status, ORDER_STATUSES);
      if (!isString(record.order_id) || !isCount(record.amount_refunded_ore) || status === undefined) {
        throw invalidResponse(answer.status);
      }
      return { outcome, orderId: record.order_id, amountRefundedOre: record.amount_refunded_ore, status };
    },

    async authorizationCanceled(event, paymentIntentId) {
      const answer = await client.rpc("payments_order_authorization_canceled", {
        p_event: event,
        p_payment_intent: paymentIntentId,
      });
      const record = answerRecord(answer);
      const outcome = outcomeOf(record, ["unknown_order", "duplicate", "ignored", "canceled"] as const, answer.status);
      if (outcome === "unknown_order" || outcome === "duplicate") return { outcome };
      if (outcome === "canceled") return { outcome, order: orderOf(record, answer.status) };
      if (!isString(record.order_id)) throw invalidResponse(answer.status);
      return { outcome, orderId: record.order_id };
    },

    async readOrder(orderId) {
      const { data, error, status } = await client
        .from("orders")
        .select(ORDER_SELECT)
        .eq("id", orderId)
        .maybeSingle()
        .retry(false);
      if (error) throw new OrderRpcError(error.message, error.code || "unknown", status);
      if (data === null) return null;
      const order = parseOrderSnapshot(data);
      if (order === null) throw invalidResponse(status);
      return order;
    },

    async readOrderWithdrawal(withdrawalId) {
      const { data, error, status } = await client
        .from("order_withdrawals")
        .select(`*, orders(${ORDER_SELECT})`)
        .eq("id", withdrawalId)
        .maybeSingle()
        .retry(false);
      if (error) throw new OrderRpcError(error.message, error.code || "unknown", status);
      if (data === null) return null;
      const withdrawal = parseOrderWithdrawalSnapshot(data);
      const order = parseOrderSnapshot(asRecord(data)?.orders);
      if (withdrawal === null || order === null) throw invalidResponse(status);
      return { withdrawal, order };
    },
  };
}
