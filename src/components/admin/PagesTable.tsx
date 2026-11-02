"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Link from "@/components/ui/Link";
import Notice from "@/components/ui/Notice";
import type { PageActionError, PageActionResult, PageStatus } from "@/services/admin/pages";

/** One page in the list, already labelled by the server. */
export type PagesTableRow = {
  id: string;
  /** Fixed name of the page ("Forside", "Kontakt"). */
  name: string;
  /** Its Danish title, shown under the name. */
  title: string;
  status: PageStatus;
  showInNav: boolean;
  editHref: string;
  /** Always first in the public nav (the home page): no move controls. */
  pinned: boolean;
};

export type PagesTableProps = {
  /** Rows in nav order, pinned rows first. */
  rows: PagesTableRow[];
  /** Id of the heading that names the table. */
  labelledBy: string;
  /** The `reorderNav` Server Action. */
  reorder: (pageIds: readonly string[]) => Promise<PageActionResult>;
  labels: {
    page: string;
    status: string;
    actions: string;
    statuses: Record<PageStatus, string>;
    shown: string;
    hidden: string;
    edit: string;
    moveUp: string;
    moveDown: string;
    errors: Record<PageActionError, string>;
  };
};

type Direction = "up" | "down";

/**
 * Admin list of the pages (approved admin mock: Titel / Status /
 * Handlinger): fixed name and Danish title, published and menu status, an
 * edit link and "Flyt op" / "Flyt ned" to change the nav order. A move is
 * saved at once (`reorder`); the server re-renders the list in its new
 * order, and the focus follows the moved page's button so keyboard users can
 * keep moving it. A failed move shows an alert and leaves the order as is.
 */
export default function PagesTable({ rows, labelledBy, reorder, labels }: PagesTableProps) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<PageActionError | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const focusAfterMove = useRef<{ id: string; direction: Direction } | null>(null);
  const movableIds = rows.filter((row) => !row.pinned).map((row) => row.id);

  // After a move the list arrives in its new order: put the focus back on the
  // moved page's button, or on its other one when this one is now disabled.
  useEffect(() => {
    const target = focusAfterMove.current;
    if (!target) return;
    focusAfterMove.current = null;
    const other: Direction = target.direction === "up" ? "down" : "up";
    const button = [target.direction, other]
      .map((direction) => buttons.current.get(`${target.id}:${direction}`))
      .find((candidate) => candidate && !candidate.disabled);
    button?.focus();
  }, [rows]);

  function move(id: string, direction: Direction) {
    const from = movableIds.indexOf(id);
    const to = direction === "up" ? from - 1 : from + 1;
    if (pending || from === -1 || to < 0 || to >= movableIds.length) return;

    const order = movableIds.toSpliced(from, 1).toSpliced(to, 0, id);
    focusAfterMove.current = { id, direction };
    startTransition(async () => {
      const result = await reorder(order);
      if (result.ok) {
        setError(null);
      } else {
        focusAfterMove.current = null;
        setError(result.error);
      }
    });
  }

  const moveButton = (row: PagesTableRow, direction: Direction) => {
    const index = movableIds.indexOf(row.id);
    const atEdge = direction === "up" ? index === 0 : index === movableIds.length - 1;
    return (
      <Button
        ref={(element) => {
          const key = `${row.id}:${direction}`;
          if (element) buttons.current.set(key, element);
          else buttons.current.delete(key);
        }}
        variant="secondary"
        disabled={atEdge}
        onClick={() => move(row.id, direction)}
      >
        {direction === "up" ? labels.moveUp : labels.moveDown}
        <span className="sr-only">: {row.name}</span>
      </Button>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <Notice tone="error" role="alert">
          {labels.errors[error]}
        </Notice>
      )}
      <div className="overflow-x-auto">
        <table aria-labelledby={labelledBy} aria-busy={pending || undefined} className="w-full text-left">
          <thead>
            <tr className="border-b border-border text-small tracking-widest text-muted uppercase">
              <th scope="col" className="py-3 pr-4 font-semibold">
                {labels.page}
              </th>
              <th scope="col" className="hidden py-3 pr-4 font-semibold sm:table-cell">
                {labels.status}
              </th>
              <th scope="col" className="py-3 text-right font-semibold">
                {labels.actions}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const status = (
                <span className="flex flex-col items-start gap-1">
                  <Badge tone={row.status}>{labels.statuses[row.status]}</Badge>
                  <span className="text-small text-muted">{row.showInNav ? labels.shown : labels.hidden}</span>
                </span>
              );
              return (
                <tr key={row.id} className="border-b border-border align-top last:border-b-0">
                  <th scope="row" className="py-4 pr-4 text-left font-normal">
                    <span className="flex flex-col gap-1">
                      <span className="font-semibold">{row.name}</span>
                      {row.title.trim() !== "" && <span className="text-small text-muted">{row.title}</span>}
                      {/* Below 640px the status sits under the title instead of in its own column. */}
                      <span className="pt-1 sm:hidden">{status}</span>
                    </span>
                  </th>
                  <td className="hidden py-4 pr-4 sm:table-cell">{status}</td>
                  <td className="py-4">
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <Link href={row.editHref} className="inline-flex min-h-11 items-center px-2">
                        {labels.edit}
                        <span className="sr-only"> {row.name}</span>
                      </Link>
                      {!row.pinned && (
                        <>
                          {moveButton(row, "up")}
                          {moveButton(row, "down")}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
