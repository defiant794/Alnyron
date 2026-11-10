"use client";

import { unstable_rethrow } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition, type RefObject } from "react";
import { deleteMonitorSignup } from "@/app/admin/(panel)/monitor-users/actions";
import DeleteMonitorSignupDialog, { type DeleteMonitorSignupDialogLabels } from "@/components/admin/DeleteMonitorSignupDialog";
import Badge, { type BadgeTone } from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import { cx } from "@/lib/cx";
import { formatDateTime } from "@/lib/monitor/format";
import type { MonitorSignupStatus } from "@/lib/monitor/signup-status";
import type { DeleteMonitorUserError, DeleteMonitorUserResult, MonitorSignup } from "@/services/admin/monitor-users";

/** One signup in the list, with its status as of the request (computed by the page). */
export type MonitorSignupRow = MonitorSignup & { status: MonitorSignupStatus };

export type MonitorSignupsTableProps = {
  /** Signups newest first, as `listMonitorSignups` returns them. */
  rows: MonitorSignupRow[];
  /** Id of the heading that names the table. */
  labelledBy: string;
  /** Count of each status, ready to show above the table ("2 tilmeldte · 1 afventer · 3 udløbne"). */
  summary: string;
  /** Status badge text of each status. */
  statuses: Record<MonitorSignupStatus, string>;
  labels: {
    /** Column headings. */
    email: string;
    signedUp: string;
    status: string;
    monitors: string;
    actions: string;
    /** Shown instead of the table when there are no signups. */
    empty: string;
    /** The dialog's copy, and `open`: the visible text of a row's delete button (its accessible name adds the address). */
    delete: DeleteMonitorSignupDialogLabels & { open: string };
  };
};

const STATUS_TONES: Record<MonitorSignupStatus, BadgeTone> = { registered: "success", pending: "info", expired: "neutral" };

/** A signup whose row leaves the list (deleted, or already gone), and where that row was. */
type Removal = { userId: string; index: number };

/**
 * Once a removed signup's row has left the list and the dialog is closed, the
 * focus would fall back to the page (its delete button is gone): it moves to
 * the delete button now in that row's place, the new last one, or the empty
 * text when no row is left.
 */
function focusAfterRemoval(
  rows: readonly MonitorSignupRow[],
  removal: RefObject<Removal | null>,
  dialog: HTMLDialogElement | null,
  buttons: ReadonlyMap<string, HTMLButtonElement>,
  empty: HTMLElement | null,
): void {
  const removed = removal.current;
  if (!removed || dialog?.open || rows.some((row) => row.userId === removed.userId)) return;
  removal.current = null;
  const next = rows[Math.min(removed.index, rows.length - 1)];
  (next ? buttons.get(next.userId) : empty)?.focus();
}

/**
 * The public Monitor signups (Admin › Monitor-brugere) under a count of each
 * status: the address (row header), when the account was created (Danish
 * time), its status (Tilmeldt: confirmed; Afventer bekræftelse: unconfirmed
 * within the confirm window; Udløbet: unconfirmed after it, row muted), the
 * number of monitors and "Slet", which opens `DeleteMonitorSignupDialog`. On
 * success the dialog closes, the refreshed list drops the row and the focus
 * moves to the delete button now in its place (the empty text after the last
 * row); a failure (a dropped request included) shows an alert in the dialog,
 * opened again if the browser closed it meanwhile, and leaves the row. Narrow
 * screens scroll the table sideways; without signups only the empty text is
 * shown.
 */
export default function MonitorSignupsTable({ rows, labelledBy, summary, statuses, labels }: MonitorSignupsTableProps) {
  const [pending, startTransition] = useTransition();
  const [target, setTarget] = useState<(Removal & { email: string }) | null>(null);
  const [error, setError] = useState<DeleteMonitorUserError | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const emptyRef = useRef<HTMLParagraphElement>(null);
  const deleteButtons = useRef(new Map<string, HTMLButtonElement>());
  const removal = useRef<Removal | null>(null);
  const summaryId = useId();

  // The refreshed list arrives after the dialog closed on success.
  useEffect(() => {
    focusAfterRemoval(rows, removal, dialogRef.current, deleteButtons.current, emptyRef.current);
  }, [rows]);

  function openDelete(row: MonitorSignupRow, index: number) {
    if (pending) return;
    removal.current = null;
    setTarget({ userId: row.userId, email: row.email, index });
    setError(null);
    dialogRef.current?.showModal();
  }

  function confirmDelete() {
    if (!target || pending) return;
    // `index` is the row's when its Slet button was used: a refreshed list may lack the row by now.
    const { userId, index } = target;
    // A retry starts without the last failure's alert, so a repeated failure is announced again.
    setError(null);
    startTransition(async () => {
      let result: DeleteMonitorUserResult;
      try {
        result = await deleteMonitorSignup(userId);
      } catch (caught) {
        // A redirect from the action (an expired session sent to the login page) is the
        // router's; a request that got no answer is a failed delete.
        unstable_rethrow(caught);
        result = { ok: false, error: "failed" };
      }
      if (result.ok || result.error === "not-found") removal.current = { userId, index };
      if (result.ok) dialogRef.current?.close();
      else setError(result.error);
      // Chromium closes a modal dialog on a repeated Escape despite the prevented `cancel`: a failure opens it again.
      if (!result.ok && !dialogRef.current?.open) dialogRef.current?.showModal();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {rows.length === 0 ? (
        <p ref={emptyRef} tabIndex={-1} className="text-muted">{labels.empty}</p>
      ) : (
        <>
          <p id={summaryId} className="text-small text-muted">{summary}</p>
          {/* `relative`: the sr-only (absolute) Slet suffixes are placed and clipped here, not on the page. */}
          <div className="relative overflow-x-auto">
            <table
              aria-labelledby={labelledBy}
              aria-describedby={summaryId}
              aria-busy={pending || undefined}
              className="w-full text-left"
            >
              <thead>
                <tr className="border-b border-border text-small tracking-widest text-muted uppercase">
                  <th scope="col" className="py-3 pr-4 font-semibold">{labels.email}</th>
                  <th scope="col" className="py-3 pr-4 font-semibold">{labels.signedUp}</th>
                  <th scope="col" className="py-3 pr-4 font-semibold">{labels.status}</th>
                  <th scope="col" className="py-3 pr-4 text-right font-semibold">{labels.monitors}</th>
                  <th scope="col" className="py-3 text-right font-semibold">{labels.actions}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr
                    key={row.userId}
                    className={cx(
                      "border-b border-border align-middle last:border-b-0",
                      row.status === "expired" && "text-muted",
                    )}
                  >
                    <th scope="row" className="py-4 pr-4 text-left font-semibold">{row.email}</th>
                    {/* Formatted again in the browser, whose date data may print it slightly differently. */}
                    <td className="py-4 pr-4 whitespace-nowrap" suppressHydrationWarning>
                      {formatDateTime(row.signedUpAt)}
                    </td>
                    <td className="py-4 pr-4">
                      <Badge tone={STATUS_TONES[row.status]}>{statuses[row.status]}</Badge>
                    </td>
                    <td className="py-4 pr-4 text-right tabular-nums">{row.monitorCount}</td>
                    <td className="py-4 text-right">
                      <Button
                        ref={(element) => {
                          if (element) deleteButtons.current.set(row.userId, element);
                          else deleteButtons.current.delete(row.userId);
                        }}
                        variant="danger"
                        aria-haspopup="dialog"
                        onClick={() => openDelete(row, index)}
                      >
                        {labels.delete.open}
                        <span className="sr-only">: {row.email}</span>
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {/* Rendered without rows too: a not-found on the last row empties the list while the dialog shows its alert. */}
      <DeleteMonitorSignupDialog
        ref={dialogRef}
        email={target?.email ?? null}
        pending={pending}
        error={error}
        labels={labels.delete}
        onConfirm={confirmDelete}
        onClose={() => focusAfterRemoval(rows, removal, dialogRef.current, deleteButtons.current, emptyRef.current)}
      />
    </div>
  );
}
