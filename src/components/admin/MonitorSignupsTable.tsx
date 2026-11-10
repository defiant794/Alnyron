import Badge from "@/components/ui/Badge";
import { formatDateTime } from "@/lib/monitor/format";
import type { MonitorSignup } from "@/services/admin/monitor-users";

export type MonitorSignupsTableProps = {
  /** Signups newest first, as `listMonitorSignups` returns them. */
  rows: MonitorSignup[];
  /** Id of the heading that names the table. */
  labelledBy: string;
  labels: {
    /** Column headings. */
    email: string;
    signedUp: string;
    confirmed: string;
    monitors: string;
    /** Text of the confirmed / unconfirmed badge. */
    yes: string;
    no: string;
    /** Shown instead of the table when there are no signups. */
    empty: string;
  };
};

/**
 * The public Monitor signups (Admin › Monitor-brugere): the address as the
 * row header, the signup time in Danish time, a confirmed badge (✓ Ja in
 * green, ✗ Nej neutral; the word carries the meaning, the glyph is hidden
 * from screen readers) and the number of monitors. Read-only; narrow screens
 * scroll the table sideways. Without signups only the empty text is shown.
 */
export default function MonitorSignupsTable({ rows, labelledBy, labels }: MonitorSignupsTableProps) {
  if (rows.length === 0) return <p className="text-muted">{labels.empty}</p>;

  return (
    <div className="overflow-x-auto">
      <table aria-labelledby={labelledBy} className="w-full text-left">
        <thead>
          <tr className="border-b border-border text-small tracking-widest text-muted uppercase">
            <th scope="col" className="py-3 pr-4 font-semibold">
              {labels.email}
            </th>
            <th scope="col" className="py-3 pr-4 font-semibold">
              {labels.signedUp}
            </th>
            <th scope="col" className="py-3 pr-4 font-semibold">
              {labels.confirmed}
            </th>
            <th scope="col" className="py-3 text-right font-semibold">
              {labels.monitors}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.email} className="border-b border-border align-middle last:border-b-0">
              <th scope="row" className="py-4 pr-4 text-left font-semibold">
                {row.email}
              </th>
              <td className="py-4 pr-4 whitespace-nowrap">{formatDateTime(row.signedUpAt)}</td>
              <td className="py-4 pr-4">
                {row.confirmed ? (
                  <Badge tone="success" className="gap-1">
                    <span aria-hidden="true">✓</span> {labels.yes}
                  </Badge>
                ) : (
                  <Badge tone="neutral" className="gap-1">
                    <span aria-hidden="true">✗</span> {labels.no}
                  </Badge>
                )}
              </td>
              <td className="py-4 text-right tabular-nums">{row.monitorCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
