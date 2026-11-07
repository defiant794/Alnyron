"use client";

import { unstable_rethrow } from "next/navigation";
import { useEffect, useOptimistic, useRef, useState, useTransition } from "react";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Link from "@/components/ui/Link";
import Notice from "@/components/ui/Notice";
import { SWITCH_CLASS } from "@/components/ui/switch-styles";
import { cx } from "@/lib/cx";
import type { PageActionError, PageActionResult, PageStatus } from "@/services/admin/pages";

/** One page in the list, already labelled by the server. */
export type PagesTableRow = {
  id: string;
  /** Fixed name of the page ("Forside", "Kontakt"). */
  name: string;
  status: PageStatus;
  showInNav: boolean;
  /** Always first in the public nav (the home page): no move controls. */
  pinned: boolean;
} & (
  | {
      /** A page with editable copy: an edit link. */
      kind: "content";
      /** Its Danish title, shown under the name. */
      title: string;
      editHref: string;
    }
  | {
      /** An app area (Monitor): no editor, its nav switch sits in the row instead. */
      kind: "area";
      /** What the area is (it has no title), shown under the name ("Appområde på /monitor, …"). */
      description: string;
    }
);

export type PagesTableProps = {
  /** Rows in nav order, pinned rows first. */
  rows: PagesTableRow[];
  /** Id of the heading that names the table. */
  labelledBy: string;
  /** The `reorderNav` Server Action. */
  reorder: (pageIds: readonly string[]) => Promise<PageActionResult>;
  /** The `setPageNav` Server Action, called by an area row's nav switch. */
  setPageNav: (pageId: string, show: boolean) => Promise<PageActionResult>;
  labels: {
    page: string;
    status: string;
    actions: string;
    statuses: Record<PageStatus, string>;
    shown: string;
    hidden: string;
    /** Visible label of an area row's nav switch ("Vis i menuen"); its accessible name adds the page name. */
    toggle: string;
    edit: string;
    moveUp: string;
    moveDown: string;
    errors: Record<PageActionError, string>;
  };
};

type Direction = "up" | "down";

/**
 * Runs a Server Action. A request that gets no answer (the network dropped)
 * rejects: it is reported as a failed save, so the table's alert shows it
 * instead of the route's error boundary. A redirect or not-found from the
 * action (an expired session sent to the login page) is rethrown for the router.
 */
async function attempt(action: () => Promise<PageActionResult>): Promise<PageActionResult> {
  try {
    return await action();
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, error: "failed" };
  }
}

/**
 * Admin list of the pages (approved admin mock: Titel / Status /
 * Handlinger): fixed name and Danish title (an app area: what it is),
 * published and menu status, an edit link and "Flyt op" / "Flyt ned" to
 * change the nav order. A move is saved at once (`reorder`); the server
 * re-renders the list in its new order, and the focus follows the moved
 * page's button so keyboard users can keep moving it. An app area (Monitor)
 * has no editor: its row offers a nav switch instead of the edit link, saved
 * at once (`setPageNav`) and shown in its new state while it saves (marked
 * busy, further clicks ignored). A failed move or switch, a dropped request
 * included, shows an alert and leaves the list as is.
 */
export default function PagesTable({ rows, labelledBy, reorder, setPageNav, labels }: PagesTableProps) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<PageActionError | null>(null);
  // The nav switch being saved shows its new state until the save ends: then
  // the row's own value takes over (refreshed list, or unchanged after a failure).
  const [navChange, setNavChange] = useOptimistic<{ id: string; show: boolean } | null>(null);
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
      const result = await attempt(() => reorder(order));
      if (result.ok) {
        setError(null);
      } else {
        focusAfterMove.current = null;
        setError(result.error);
      }
    });
  }

  function toggleNav(id: string, show: boolean) {
    if (pending) return;
    startTransition(async () => {
      setNavChange({ id, show });
      const result = await attempt(() => setPageNav(id, show));
      setError(result.ok ? null : result.error);
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
              const showInNav = navChange?.id === row.id ? navChange.show : row.showInNav;
              const subtitle = row.kind === "content" ? row.title : row.description;
              const status = (
                <span className="flex flex-col items-start gap-1">
                  <Badge tone={row.status}>{labels.statuses[row.status]}</Badge>
                  <span className="text-small text-muted">{showInNav ? labels.shown : labels.hidden}</span>
                </span>
              );
              return (
                <tr key={row.id} className="border-b border-border align-top last:border-b-0">
                  <th scope="row" className="py-4 pr-4 text-left font-normal">
                    <span className="flex flex-col gap-1">
                      <span className="font-semibold">{row.name}</span>
                      {subtitle.trim() !== "" && <span className="text-small text-muted">{subtitle}</span>}
                      {/* Below 640px the status sits under the title instead of in its own column. */}
                      <span className="pt-1 sm:hidden">{status}</span>
                    </span>
                  </th>
                  <td className="hidden py-4 pr-4 sm:table-cell">{status}</td>
                  <td className="py-4">
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      {row.kind === "content" ? (
                        <Link href={row.editHref} className="inline-flex min-h-11 items-center px-2">
                          {labels.edit}
                          <span className="sr-only">: {row.name}</span>
                        </Link>
                      ) : (
                        <label
                          className={cx(
                            "inline-flex min-h-11 items-center gap-3 px-2",
                            pending ? "cursor-wait opacity-60" : "cursor-pointer",
                          )}
                        >
                          {labels.toggle}
                          <span className="sr-only">: {row.name}</span>
                          {/* Busy, not `disabled`, while a save runs: it keeps the keyboard focus. The
                              attribute variant outranks SWITCH_CLASS's `cursor-pointer` (higher specificity). */}
                          <input
                            type="checkbox"
                            role="switch"
                            checked={showInNav}
                            aria-disabled={pending || undefined}
                            onChange={() => toggleNav(row.id, !showInNav)}
                            className={cx(SWITCH_CLASS, "aria-disabled:cursor-wait")}
                          />
                        </label>
                      )}
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
