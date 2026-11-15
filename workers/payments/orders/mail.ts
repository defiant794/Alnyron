import { adminOrderPath } from "@/config/admin";
import {
  buildOrderAuthorizationExpiredEmail,
  buildOrderCancellationReceiptEmail,
  buildOrderCaptureFailedEmail,
  buildOrderCaptureWarningEmail,
  buildOrderConfirmationEmail,
  buildOrderManualAlertEmail,
  buildOrderOwnerEmail,
  buildOrderRefundReceiptEmail,
  buildOrderRefundReminderEmail,
  buildOrderShippedEmail,
  buildOrderWithdrawalAckEmail,
  buildOrderWithdrawalAlertEmail,
  type EmailContent,
  type OrderEmailOrder,
  type OrderEmailWithdrawal,
} from "@/lib/payments/orders/emails";
import { orderLinkToken, orderWithdrawUrl } from "@/lib/payments/orders/link-token";
import { sendMail } from "../mail";
import type { OrdersEnv } from "./env";
import type { OrderSnapshot, OrderWithdrawalSnapshot } from "./rpc";

/**
 * The goods emails (slice S2), built by `src/lib/payments/orders/emails.ts`
 * from the order and withdrawal snapshots and sent through Resend like the
 * subscription emails (`sendMail` of ../mail.ts: the Resend id, or
 * `idempotent_replay` when the key already sent one with another body, else a
 * `MailError`). Each send carries its idempotency key, so a retry within
 * Resend's 24 hours sends nothing twice:
 *
 * | email | to | key |
 * |---|---|---|
 * | order confirmation = the invoice (A2-6) | the order's email | `order-confirm/<order id>` |
 * | new order | ORDER_NOTIFY_TO | `order-owner/<order id>` |
 * | shipped (the amount is now charged) | the order's email | `order-shipped/<order id>` |
 * | the reservation lapses within 48 h | ORDER_NOTIFY_TO | `order-capture-warn/<order id>` |
 * | the reservation lapsed: do not send | ORDER_NOTIFY_TO | `order-expired/<order id>` |
 * | Stripe refused the capture | ORDER_NOTIFY_TO | `order-capture-failed/<order id>` |
 * | withdrawal receipt | the order's email | `order-wd-ack/<withdrawal id>` |
 * | withdrawal alert | ORDER_NOTIFY_TO | `order-wd-alert/<withdrawal id>` |
 * | credit note of the refund or of the release | the order's email | `order-refund/<withdrawal id>` |
 * | refund deadline reminder | ORDER_NOTIFY_TO | `order-wd-remind/<withdrawal id>` |
 * | manual handling needed | ORDER_NOTIFY_TO | `order-wd-manual/<withdrawal id>` |
 *
 * The buyer's emails are in the order's language (the withdrawal's for the
 * withdrawal emails); the owner's are Danish. The confirmation and the shipped
 * email carry the personal withdraw link (an HMAC under ORDER_LINK_SECRET).
 * Nothing here logs.
 */
export type OrderMailer = {
  sendConfirmation(order: OrderSnapshot): Promise<{ id: string }>;
  sendOwnerNewOrder(order: OrderSnapshot): Promise<{ id: string }>;
  sendShipped(order: OrderSnapshot): Promise<{ id: string }>;
  /** Needs the order's `authorization_expires_at`. */
  sendCaptureWarning(order: OrderSnapshot): Promise<{ id: string }>;
  sendAuthorizationExpired(order: OrderSnapshot): Promise<{ id: string }>;
  sendCaptureFailed(order: OrderSnapshot): Promise<{ id: string }>;
  sendWithdrawalAck(order: OrderSnapshot, withdrawal: OrderWithdrawalSnapshot): Promise<{ id: string }>;
  sendWithdrawalAlert(order: OrderSnapshot, withdrawal: OrderWithdrawalSnapshot): Promise<{ id: string }>;
  /** The credit note of a completed withdrawal: of the refund, or of the released reservation. */
  sendWithdrawalReceipt(order: OrderSnapshot, withdrawal: OrderWithdrawalSnapshot): Promise<{ id: string }>;
  sendRefundReminder(order: OrderSnapshot, withdrawal: OrderWithdrawalSnapshot): Promise<{ id: string }>;
  /** The owner's manual-handling alert of a `needs_manual` withdrawal, with its `manual_reason`. */
  sendManualAlert(order: OrderSnapshot, withdrawal: OrderWithdrawalSnapshot): Promise<{ id: string }>;
};

export type OrderMailerConfig = {
  resendApiKey: string;
  mailFrom: string;
  /** The main site (https): the withdraw page, /terms and the admin's order pages. */
  siteUrl: string;
  ordersEnv: OrdersEnv;
  /** Stands in for the global fetch (the sweep's subrequest counter). */
  fetchImpl?: typeof fetch;
};

/**
 * An email asked for before its facts exist (a credit note of a withdrawal not completed, a
 * capture warning without an expiry, a manual alert of a withdrawal not needing manual
 * handling): a defect of the caller, nothing is sent.
 */
export class MailNotDueError extends Error {
  constructor() {
    super("mail_not_due");
    this.name = "MailNotDueError";
  }
}

/** The emails' view of an order snapshot. */
function emailOrder(order: OrderSnapshot): OrderEmailOrder {
  return {
    orderNumber: order.order_number,
    itemTitle: order.line.title,
    quantity: order.line.quantity,
    amountTotalOre: order.amount_total_ore,
    email: order.email,
    customerName: order.customer_name,
    phone: order.phone,
    shippingName: order.shipping_name,
    shippingAddress: order.shipping_address,
    locale: order.locale,
    paidAt: order.paid_at,
    authorizationExpiresAt: order.authorization_expires_at,
    anomaly: order.anomaly,
  };
}

/** The emails' view of a withdrawal snapshot. */
function emailWithdrawal(withdrawal: OrderWithdrawalSnapshot): OrderEmailWithdrawal {
  return {
    id: withdrawal.id,
    consumerName: withdrawal.consumer_name,
    requestedAt: withdrawal.requested_at,
    refundDueAt: withdrawal.refund_due_at,
    late: withdrawal.late,
    shippedBeforeNotice: withdrawal.shipped_before_notice,
    deadlineAt: withdrawal.deadline_at,
    locale: withdrawal.locale,
    refundOre: withdrawal.refund_ore,
    deductionOre: withdrawal.deduction_ore,
    deductionReason: withdrawal.deduction_reason,
  };
}

/**
 * An {@link OrderMailer} sending from `mailFrom` with the Resend key. Every method is async, so
 * an email that is not due or fails to build rejects its promise, never throws at the call.
 */
export function createOrderMailer(config: OrderMailerConfig): OrderMailer {
  const siteOrigin = new URL(config.siteUrl).origin;
  const notifyTo = config.ordersEnv.orderNotifyTo;
  const send = (to: string, content: EmailContent, idempotencyKey: string) =>
    sendMail(config, to, content, idempotencyKey);
  const adminLink = (order: OrderSnapshot) => `${siteOrigin}${adminOrderPath(order.order_number)}`;
  const withdrawLink = async (order: OrderSnapshot) =>
    orderWithdrawUrl(siteOrigin, order.id, await orderLinkToken(config.ordersEnv.orderLinkSecret, order.id), order.locale);

  return {
    async sendConfirmation(order) {
      const content = buildOrderConfirmationEmail({ order: emailOrder(order), withdrawLink: await withdrawLink(order), siteOrigin });
      return send(order.email, content, `order-confirm/${order.id}`);
    },

    async sendOwnerNewOrder(order) {
      return send(notifyTo, buildOrderOwnerEmail({ order: emailOrder(order), adminLink: adminLink(order) }), `order-owner/${order.id}`);
    },

    async sendShipped(order) {
      const content = buildOrderShippedEmail({
        order: emailOrder(order),
        trackingRef: order.tracking_ref,
        withdrawLink: await withdrawLink(order),
      });
      return send(order.email, content, `order-shipped/${order.id}`);
    },

    async sendCaptureWarning(order) {
      const expiresAt = order.authorization_expires_at;
      if (expiresAt === null) throw new MailNotDueError();
      const content = buildOrderCaptureWarningEmail({
        order: { ...emailOrder(order), authorizationExpiresAt: expiresAt },
        adminLink: adminLink(order),
      });
      return send(notifyTo, content, `order-capture-warn/${order.id}`);
    },

    async sendAuthorizationExpired(order) {
      const content = buildOrderAuthorizationExpiredEmail({ order: emailOrder(order), adminLink: adminLink(order) });
      return send(notifyTo, content, `order-expired/${order.id}`);
    },

    async sendCaptureFailed(order) {
      const content = buildOrderCaptureFailedEmail({ order: emailOrder(order), adminLink: adminLink(order) });
      return send(notifyTo, content, `order-capture-failed/${order.id}`);
    },

    async sendWithdrawalAck(order, withdrawal) {
      const content = buildOrderWithdrawalAckEmail({ order: emailOrder(order), withdrawal: emailWithdrawal(withdrawal), siteOrigin });
      return send(order.email, content, `order-wd-ack/${withdrawal.id}`);
    },

    async sendWithdrawalAlert(order, withdrawal) {
      const content = buildOrderWithdrawalAlertEmail({
        order: emailOrder(order),
        withdrawal: emailWithdrawal(withdrawal),
        adminLink: adminLink(order),
      });
      return send(notifyTo, content, `order-wd-alert/${withdrawal.id}`);
    },

    async sendWithdrawalReceipt(order, withdrawal) {
      const common = { order: emailOrder(order), siteOrigin };
      const { refund_ore: refundOre, refunded_at: refundedAt, authorization_canceled_at: canceledAt } = withdrawal;
      let content: EmailContent;
      if (withdrawal.status === "completed" && withdrawal.action === "refund" && refundOre !== null && refundedAt !== null) {
        content = buildOrderRefundReceiptEmail({ ...common, withdrawal: { ...emailWithdrawal(withdrawal), refundOre, refundedAt } });
      } else if (withdrawal.status === "completed" && withdrawal.action === "cancel_authorization" && canceledAt !== null) {
        content = buildOrderCancellationReceiptEmail({ ...common, withdrawal: { ...emailWithdrawal(withdrawal), canceledAt } });
      } else {
        throw new MailNotDueError();
      }
      return send(order.email, content, `order-refund/${withdrawal.id}`);
    },

    async sendRefundReminder(order, withdrawal) {
      const content = buildOrderRefundReminderEmail({
        order: emailOrder(order),
        withdrawal: emailWithdrawal(withdrawal),
        adminLink: adminLink(order),
      });
      return send(notifyTo, content, `order-wd-remind/${withdrawal.id}`);
    },

    async sendManualAlert(order, withdrawal) {
      const reason = withdrawal.manual_reason;
      if (withdrawal.status !== "needs_manual" || reason === null) throw new MailNotDueError();
      const content = buildOrderManualAlertEmail({
        order: emailOrder(order),
        withdrawalId: withdrawal.id,
        reason,
        adminLink: adminLink(order),
      });
      return send(notifyTo, content, `order-wd-manual/${withdrawal.id}`);
    },
  };
}
