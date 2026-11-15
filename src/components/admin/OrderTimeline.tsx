import { createTranslator } from "next-intl";
import { AUTH_LOCALE } from "@/config/auth-areas";
import { loadMessages } from "@/i18n/messages";
import { formatDateTime } from "@/lib/monitor/format";
import { formatKronerWithOre } from "@/lib/payments/money";
import { formatWithdrawalDate, formatWithdrawalLastDay } from "@/lib/payments/withdrawal-emails";
import type { AdminOrderDetail } from "@/services/admin/orders";

export type OrderTimelineProps = {
  order: AdminOrderDetail;
  /** The card look of the section. */
  className?: string;
};

/** One step of the order: when, what, and the details under it. */
type TimelineEntry = { at: string; text: string; details: { text: string; late?: boolean }[] };

/**
 * "Forløb" on an order's admin page: what happened to the order, oldest
 * first, in Danish time. The payment reserved, the order confirmation sent,
 * the payment captured, the goods shipped (with the tracking reference), the
 * withdrawal received (with the deadline it is checked against and whether it
 * came in time, the refund's due date while it waits, or why it needs manual
 * handling), the refund (with any deduction and its reason) or the released
 * reservation, and the cancellation with its reason. A late withdrawal is
 * flagged in words ("For sent (efter fristen)"), never by colour alone.
 */
export default function OrderTimeline({ order, className }: OrderTimelineProps) {
  const t = createTranslator({
    locale: AUTH_LOCALE,
    messages: loadMessages(AUTH_LOCALE),
    namespace: "Admin.orders.detail.timeline",
  });
  const kroner = (amountOre: number) => formatKronerWithOre(amountOre, AUTH_LOCALE);
  const entries: TimelineEntry[] = [{ at: order.paidAt, text: t("reserved", { date: formatDateTime(order.paidAt) }), details: [] }];

  if (order.confirmationSentAt) {
    entries.push({
      at: order.confirmationSentAt,
      text: t("confirmation", { date: formatDateTime(order.confirmationSentAt) }),
      details: [],
    });
  }
  if (order.capturedAt) {
    entries.push({ at: order.capturedAt, text: t("captured", { date: formatDateTime(order.capturedAt) }), details: [] });
  }
  if (order.shippedAt) {
    entries.push({
      at: order.shippedAt,
      text: t("shipped", { date: formatDateTime(order.shippedAt) }),
      details: order.trackingRef ? [{ text: t("tracking", { ref: order.trackingRef }) }] : [],
    });
  }
  const { withdrawal } = order;
  if (withdrawal) {
    const details: TimelineEntry["details"] = [];
    if (withdrawal.deadlineAt) {
      details.push({ text: t("deadline", { date: formatWithdrawalLastDay(withdrawal.deadlineAt, AUTH_LOCALE) }) });
      details.push(withdrawal.late ? { text: t("late"), late: true } : { text: t("onTime") });
    }
    if (withdrawal.status === "received" || withdrawal.status === "approved") {
      details.push({ text: t("refundDue", { date: formatWithdrawalDate(withdrawal.refundDueAt, AUTH_LOCALE) }) });
    }
    if (withdrawal.status === "needs_manual") {
      const reasons = loadMessages(AUTH_LOCALE).Admin.orders.detail.timeline.manualReasons;
      const reason = withdrawal.manualReason ?? "";
      details.push({ text: t("manual", { reason: Object.hasOwn(reasons, reason) ? reasons[reason as keyof typeof reasons] : reason }) });
    }
    entries.push({
      at: withdrawal.requestedAt,
      text: t("withdrawal", { date: formatDateTime(withdrawal.requestedAt) }),
      details,
    });
    if (withdrawal.completedAt && withdrawal.refundOre !== null) {
      entries.push({
        at: withdrawal.completedAt,
        text: t("refunded", { amount: kroner(withdrawal.refundOre), date: formatDateTime(withdrawal.completedAt) }),
        details:
          withdrawal.deductionOre > 0
            ? [{ text: t("deduction", { amount: kroner(withdrawal.deductionOre), reason: withdrawal.deductionReason ?? "" }) }]
            : [],
      });
    } else if (withdrawal.completedAt) {
      entries.push({ at: withdrawal.completedAt, text: t("released", { date: formatDateTime(withdrawal.completedAt) }), details: [] });
    }
  }
  if (order.canceledAt && order.cancelReason) {
    entries.push({
      at: order.canceledAt,
      text: t(`canceled.${order.cancelReason}`, { date: formatDateTime(order.canceledAt) }),
      details: [],
    });
  }

  return (
    <section aria-labelledby="order-timeline" className={className}>
      <h2 id="order-timeline" className="text-h3 font-semibold">
        {t("heading")}
      </h2>
      <ol aria-labelledby="order-timeline" className="flex flex-col gap-3 border-l border-border pl-4">
        {entries
          .toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at))
          .map((entry) => (
            <li key={`${entry.at}-${entry.text}`} className="flex flex-col gap-0.5">
              <span>{entry.text}</span>
              {entry.details.map((detail) => (
                <span
                  key={detail.text}
                  className={detail.late ? "text-small font-semibold text-error" : "text-small text-muted"}
                >
                  {detail.text}
                </span>
              ))}
            </li>
          ))}
      </ol>
    </section>
  );
}
