import Badge, { type BadgeTone } from "@/components/ui/Badge";
import Link from "@/components/ui/Link";
import { adminOrderPath } from "@/config/admin";
import type { OrderStatus, OrderWithdrawalStatus } from "@/config/payments";
import { formatDateTime } from "@/lib/monitor/format";
import type { AdminOrderRow } from "@/services/admin/orders";

/** Badge tone of each order status: reserved (to ship) stands out, closed orders are muted. */
export const ORDER_STATUS_TONES: Record<OrderStatus, BadgeTone> = {
  authorized: "info",
  shipped: "success",
  refunded: "neutral",
  canceled: "neutral",
};

/** A withdrawal the owner still has to act on (or check by hand) gets a badge; a completed one shows in the status. */
export type OrderWithdrawalBadge = Exclude<OrderWithdrawalStatus, "completed">;

export type OrdersTableProps = {
  rows: AdminOrderRow[];
  /** The table's caption (read by screen readers only). */
  caption: string;
  labels: {
    /** Column headings. */
    number: string;
    date: string;
    buyer: string;
    item: string;
    amount: string;
    status: string;
    /** Shown instead of a missing delivery name. */
    noName: string;
  };
  statuses: Record<OrderStatus, string>;
  withdrawals: Record<OrderWithdrawalBadge, string>;
  /** "249,95 kr." for an order's total in øre. */
  formatAmount: (amountOre: number) => string;
  /** "Afvigelse: tax_mismatch" for an order's anomaly codes. */
  formatAnomaly: (codes: string) => string;
};

/**
 * The goods orders of Admin › Ordrer (approved admin orders mock), newest
 * first: the order number (row header, links to the order), when it was
 * placed (Danish time), the buyer's delivery name and email, the item, the
 * total and the status badge, with a second badge while a withdrawal waits
 * for the owner (or needs manual handling) and a warning line for an order
 * with an anomaly. Narrow screens scroll the table sideways in its own frame.
 */
export default function OrdersTable({
  rows,
  caption,
  labels,
  statuses,
  withdrawals,
  formatAmount,
  formatAnomaly,
}: OrdersTableProps) {
  return (
    <div className="relative overflow-x-auto">
      <table className="w-full min-w-3xl text-left">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-border text-small tracking-widest text-muted uppercase">
            <th scope="col" className="py-3 pr-4 font-semibold">{labels.number}</th>
            <th scope="col" className="py-3 pr-4 font-semibold">{labels.date}</th>
            <th scope="col" className="py-3 pr-4 font-semibold">{labels.buyer}</th>
            <th scope="col" className="py-3 pr-4 font-semibold">{labels.item}</th>
            <th scope="col" className="py-3 pr-4 text-right font-semibold">{labels.amount}</th>
            <th scope="col" className="py-3 font-semibold">{labels.status}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const withdrawal = row.withdrawal && row.withdrawal.status !== "completed" ? row.withdrawal.status : null;
            return (
              <tr key={row.id} className="border-b border-border align-top last:border-b-0">
                <th scope="row" className="py-3 pr-4 text-left">
                  <Link href={adminOrderPath(row.orderNumber)} className="inline-flex min-h-11 items-center font-semibold">
                    {row.orderNumber}
                  </Link>
                </th>
                <td className="py-4 pr-4 whitespace-nowrap">{formatDateTime(row.paidAt)}</td>
                <td className="py-4 pr-4">
                  <span className="block">{row.shippingName ?? labels.noName}</span>
                  <span className="block text-small break-all text-muted">{row.email}</span>
                </td>
                <td className="py-4 pr-4">{row.itemTitle}</td>
                <td className="py-4 pr-4 text-right whitespace-nowrap tabular-nums">{formatAmount(row.amountTotalOre)}</td>
                <td className="py-4">
                  <div className="flex flex-col items-start gap-1">
                    <Badge tone={ORDER_STATUS_TONES[row.status]}>{statuses[row.status]}</Badge>
                    {withdrawal && <Badge tone="error">{withdrawals[withdrawal]}</Badge>}
                    {row.anomaly && (
                      <p className="text-small font-semibold text-error">⚠ {formatAnomaly(row.anomaly)}</p>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
