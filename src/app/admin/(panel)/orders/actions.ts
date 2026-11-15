"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ADMIN_ORDERS_PATH, adminOrderPath } from "@/config/admin";
import { ORDER_GOODS_STATES } from "@/config/payments";
import { callOrderService } from "@/lib/payments/orders/binding";
import { parseKronerToOre } from "@/lib/payments/orders/money";
import type { OrderServiceFailure } from "@/lib/payments/orders/service-contract";
import { createServerClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/services/auth/require-admin";

/**
 * Why "Markér afsendt og træk betalingen" failed (the order page maps each to Danish):
 * - `invalid`: the form is not an order id + number and a tracking reference of at most 200 characters.
 * - `unauthenticated` / `forbidden`: the Worker refused the session, or the account is not owner/admin.
 * - `not-found`: no such order.
 * - `order-closed`: refunded or canceled.
 * - `withdrawal-pending`: the buyer withdrew; never ship it.
 * - `authorization-expired`: Stripe refused the capture, the authorization is gone and the order canceled.
 * - `capture-refused`: Stripe refused the capture for another reason; the order stays reserved, unshipped.
 * - `conflict`: another refusal of the order's state.
 * - `unavailable`: the payments Worker could not be reached or answered something else.
 */
export type ShipOrderError =
  | "invalid"
  | "unauthenticated"
  | "forbidden"
  | "not-found"
  | "order-closed"
  | "withdrawal-pending"
  | "authorization-expired"
  | "capture-refused"
  | "conflict"
  | "unavailable";

export type ShipOrderResult = { ok: true; status: "shipped" | "already_shipped" } | { ok: false; error: ShipOrderError };

/**
 * Why approving a withdrawal failed (the order page maps each to Danish):
 * - `invalid`: the form is not an order id + number and a goods state.
 * - `deduction-format`: the deduction is not kroner ("49,95").
 * - `deduction-too-large`: nothing would be refunded (or a deduction on goods never shipped).
 * - `reason-required`: a deduction without a reason.
 * - `unauthenticated`, `forbidden`, `not-found`, `conflict`, `unavailable`: as for shipping.
 * - `order-refunded`: refunded already.
 * - `order-shipped` / `order-not-shipped`: the goods state contradicts the order.
 */
export type ApproveRefundError =
  | "invalid"
  | "deduction-format"
  | "deduction-too-large"
  | "reason-required"
  | "unauthenticated"
  | "forbidden"
  | "not-found"
  | "order-refunded"
  | "order-shipped"
  | "order-not-shipped"
  | "conflict"
  | "unavailable";

export type ApproveRefundResult =
  | { ok: true; status: "completed" | "canceled" | "approved" | "needs_manual" }
  | { ok: false; error: ApproveRefundError };

/** The order a form acts on: its id (sent to the Worker) and number (its page, to refresh; digits, no sign). */
const orderFields = {
  orderId: z.guid(),
  orderNumber: z
    .string()
    .regex(/^[1-9]\d{0,15}$/)
    .transform(Number)
    .refine(Number.isSafeInteger),
};

const shipSchema = z.object({
  ...orderFields,
  trackingRef: z.string().trim().max(200).optional(),
});

const approveSchema = z.object({
  ...orderFields,
  goodsState: z.enum(ORDER_GOODS_STATES),
  deduction: z.string().trim().optional(),
  deductionReason: z.string().trim().max(500).optional(),
});

/** The form's text fields (a file or a missing field is left out, so the schema sees it as absent). */
function formFields(formData: FormData): Record<string, string> {
  return Object.fromEntries(
    [...formData.entries()].filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

/** The signed-in admin's access token, which the Worker checks with Supabase Auth; null without a session. */
async function accessToken(): Promise<string | null> {
  const supabase = await createServerClient();
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/** Shipping or approving changed the order: its page and the list show the new state. */
function refreshOrder(orderNumber: number): void {
  revalidatePath(ADMIN_ORDERS_PATH);
  revalidatePath(adminOrderPath(orderNumber));
}

/** The Worker's refusals both actions share; null for one of a method's own (`conflict` with its subreason). */
function commonError(failure: OrderServiceFailure): "unauthenticated" | "forbidden" | "not-found" | "unavailable" | null {
  switch (failure.reason) {
    case "unauthenticated":
    case "forbidden":
    case "unavailable":
      return failure.reason;
    case "not_found":
      return "not-found";
    default:
      return null;
  }
}

/**
 * "Markér afsendt og træk betalingen" (Admin › Ordrer › order): the payments
 * Worker's `OrderService.markShipped` over the `ORDERS` binding captures the
 * authorized payment, marks the order shipped with the optional tracking
 * reference and sends the buyer the shipped email. Admins only; the Worker
 * checks the session's access token and the role again. The form is
 * validated, never trusted. The list and the order's page are refreshed
 * whatever the answer (a refused capture may cancel or flag the order).
 */
export async function markShipped(formData: FormData): Promise<ShipOrderResult> {
  await requireAdmin();
  const parsed = shipSchema.safeParse(formFields(formData));
  if (!parsed.success) return { ok: false, error: "invalid" };
  const { orderId, orderNumber, trackingRef } = parsed.data;
  const token = await accessToken();
  if (token === null) return { ok: false, error: "unauthenticated" };

  const result = await callOrderService("markShipped", (orders) =>
    orders.markShipped({ accessToken: token, orderId, ...(trackingRef ? { trackingRef } : {}) }),
  );
  refreshOrder(orderNumber);
  if (result === null) return { ok: false, error: "unavailable" };
  if (result.ok) return { ok: true, status: result.status };
  const common = commonError(result);
  if (common !== null) return { ok: false, error: common };
  switch (result.reason === "conflict" ? result.subreason : undefined) {
    case "order_closed":
      return { ok: false, error: "order-closed" };
    case "withdrawal_pending":
      return { ok: false, error: "withdrawal-pending" };
    case "authorization_expired":
      return { ok: false, error: "authorization-expired" };
    case "capture_refused":
      return { ok: false, error: "capture-refused" };
    default:
      return { ok: false, error: result.reason === "conflict" ? "conflict" : "invalid" };
  }
}

/**
 * Approves a withdrawal (Admin › Ordrer › order, after the confirmation
 * step): `returned` refunds what is left after the optional deduction for
 * diminished value (kroner, `parseKronerToOre`; a reason is required with
 * one); `not_shipped` releases the reservation (or refunds in full what was
 * captured at Checkout), never with a deduction. The payments Worker's
 * `OrderService.approveRefund` records the approval and makes the refund or
 * release. Admins only; the Worker checks the session's access token and the
 * role again. The form is validated, never trusted; the list and the order's
 * page are refreshed once the Worker answered.
 */
export async function approveRefund(formData: FormData): Promise<ApproveRefundResult> {
  await requireAdmin();
  const parsed = approveSchema.safeParse(formFields(formData));
  if (!parsed.success) return { ok: false, error: "invalid" };
  const { orderId, orderNumber, goodsState, deduction = "", deductionReason = "" } = parsed.data;
  const deductionOre = deduction === "" ? 0 : parseKronerToOre(deduction);
  if (deductionOre === null) return { ok: false, error: "deduction-format" };
  if (goodsState === "not_shipped" && deductionOre > 0) return { ok: false, error: "deduction-too-large" };
  if (deductionOre > 0 && deductionReason === "") return { ok: false, error: "reason-required" };
  const token = await accessToken();
  if (token === null) return { ok: false, error: "unauthenticated" };

  const result = await callOrderService("approveRefund", (orders) =>
    orders.approveRefund({ accessToken: token, orderId, goodsState, deductionOre, deductionReason }),
  );
  refreshOrder(orderNumber);
  if (result === null) return { ok: false, error: "unavailable" };
  if (result.ok) return { ok: true, status: result.status };
  const common = commonError(result);
  if (common !== null) return { ok: false, error: common };
  switch (result.subreason) {
    case "order_refunded":
      return { ok: false, error: "order-refunded" };
    case "order_shipped":
      return { ok: false, error: "order-shipped" };
    case "order_not_shipped":
      return { ok: false, error: "order-not-shipped" };
    case "deduction_invalid":
      return { ok: false, error: "deduction-too-large" };
    case "deduction_reason_required":
      return { ok: false, error: "reason-required" };
    default:
      return { ok: false, error: result.reason === "conflict" ? "conflict" : "invalid" };
  }
}
