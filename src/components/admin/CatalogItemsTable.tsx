"use client";

import { useEffect, useRef, useState, useTransition, type DragEvent } from "react";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Link from "@/components/ui/Link";
import LinkButton from "@/components/ui/LinkButton";
import Notice from "@/components/ui/Notice";
import { adminNewItemPath } from "@/config/admin";
import { cx } from "@/lib/cx";
import type { CatalogActionError, CatalogActionResult } from "@/services/admin/catalog";
import type { Database } from "@/types/database";

type ContentStatus = Database["public"]["Enums"]["content_status"];

/** One item of a section, already labelled by the server. */
export type CatalogItemsTableRow = {
  id: string;
  /** The item's Danish title. */
  title: string;
  status: ContentStatus;
  featured: boolean;
  /** Formatted price (`fra 12.000 kr.`), `null` when the item shows none. */
  price: string | null;
  editHref: string;
};

/** Moving items: the `reorderItems` Server Action (bound to the section) and its labels. */
export type CatalogItemsReorder = {
  onReorder: (itemIds: readonly string[]) => Promise<CatalogActionResult>;
  labels: { moveUp: string; moveDown: string; hint: string };
};

export type CatalogItemsTableProps = {
  categoryId: string;
  /** The section's items in their order. */
  rows: CatalogItemsTableRow[];
  /** Id of the heading that names the table. */
  labelledBy?: string;
  /** Publishes (`published`) or hides (`draft`) an item: the `setItemStatus` Server Action. */
  onStatusChange: (itemId: string, status: ContentStatus) => Promise<CatalogActionResult>;
  /** Drag and move controls; without it the order is read-only. */
  reorder?: CatalogItemsReorder;
  labels: {
    newItem: string;
    empty: string;
    edit: string;
    featured: string;
    publish: string;
    hide: string;
    statuses: Record<ContentStatus, string>;
    /** Column headings (Titel / Status / Pris / Handlinger). */
    columns?: { title: string; status: string; price: string; actions: string };
    /** Alert copy for a failed status change or move. */
    errors?: Record<CatalogActionError, string>;
  };
};

type Direction = "up" | "down";

/**
 * The items of a section (approved section-editor mock): "+ Nyt element",
 * then per item its title (with "Udvalgt" when featured), status badge,
 * price, "Rediger" and "Udgiv" / "Skjul", or "Ingen elementer endnu, opret
 * et" when there are none. With `reorder`, an item can be dragged to a new
 * place or moved with "Flyt op" / "Flyt ned" (the keyboard and single-pointer
 * way); each change is saved at once, the server re-renders the list in its
 * new order and the focus follows the moved item's button. A failed change
 * shows an alert and leaves everything as it was.
 */
export default function CatalogItemsTable({
  categoryId,
  rows,
  labelledBy,
  onStatusChange,
  reorder,
  labels,
}: CatalogItemsTableProps) {
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<CatalogActionError | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const focusAfterMove = useRef<{ id: string; direction: Direction } | null>(null);
  const ids = rows.map((row) => row.id);

  // After a move the list arrives in its new order: put the focus back on the
  // moved item's button, or on its other one when this one is now disabled.
  useEffect(() => {
    const target = focusAfterMove.current;
    if (!target) return;
    focusAfterMove.current = null;
    const other: Direction = target.direction === "up" ? "down" : "up";
    [target.direction, other]
      .map((direction) => buttons.current.get(`${target.id}:${direction}`))
      .find((candidate) => candidate && !candidate.disabled)
      ?.focus();
  }, [rows]);

  /** Runs one change, tracking which row is busy and keeping its error. */
  function run(id: string, change: () => Promise<CatalogActionResult>) {
    if (pending) return;
    setBusyId(id);
    startTransition(async () => {
      const result = await change();
      startTransition(() => {
        setBusyId(null);
        setError(result.ok ? null : result.error);
        if (!result.ok) focusAfterMove.current = null;
      });
    });
  }

  function saveOrder(id: string, to: number) {
    const from = ids.indexOf(id);
    if (!reorder || from === -1 || to < 0 || to >= ids.length || from === to) return;
    run(id, () => reorder.onReorder(ids.toSpliced(from, 1).toSpliced(to, 0, id)));
  }

  function move(id: string, direction: Direction) {
    focusAfterMove.current = { id, direction };
    saveOrder(id, ids.indexOf(id) + (direction === "up" ? -1 : 1));
  }

  function handleDrop(event: DragEvent<HTMLTableRowElement>, targetId: string) {
    event.preventDefault();
    if (dragId) saveOrder(dragId, ids.indexOf(targetId));
    setDragId(null);
    setDropId(null);
  }

  const moveButton = (row: CatalogItemsTableRow, direction: Direction, moveLabels: CatalogItemsReorder["labels"]) => {
    const index = ids.indexOf(row.id);
    const atEdge = direction === "up" ? index === 0 : index === ids.length - 1;
    return (
      <button
        type="button"
        ref={(element) => {
          const key = `${row.id}:${direction}`;
          if (element) buttons.current.set(key, element);
          else buttons.current.delete(key);
        }}
        disabled={atEdge || pending}
        onClick={() => move(row.id, direction)}
        className="inline-flex size-11 cursor-pointer items-center justify-center rounded-btn text-muted transition-[background-color,color] not-disabled:hover:bg-surface not-disabled:hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
      >
        <span aria-hidden="true">{direction === "up" ? "↑" : "↓"}</span>
        <span className="sr-only">
          {direction === "up" ? moveLabels.moveUp : moveLabels.moveDown}: {row.title}
        </span>
      </button>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        {reorder && rows.length > 1 && <p className="text-small text-muted">{reorder.labels.hint}</p>}
        <LinkButton href={adminNewItemPath(categoryId)} className="ml-auto">
          {labels.newItem}
        </LinkButton>
      </div>

      {error && labels.errors && (
        <Notice tone="error" role="alert">
          {labels.errors[error]}
        </Notice>
      )}

      {rows.length === 0 ? (
        <p className="rounded-input border border-dashed border-border-input bg-surface px-4 py-6 text-center text-muted">
          {labels.empty}
        </p>
      ) : (
        // `relative`: the sr-only (absolute) move-button names are placed and clipped here, not on the page.
        <div className="relative overflow-x-auto">
          <table aria-labelledby={labelledBy} aria-busy={pending || undefined} className="w-full min-w-xl text-left">
            {labels.columns && (
              <thead>
                <tr className="border-b border-border text-xs tracking-widest text-muted uppercase">
                  <th scope="col" className="py-3 pr-4 font-semibold">
                    {labels.columns.title}
                  </th>
                  <th scope="col" className="py-3 pr-4 font-semibold">
                    {labels.columns.status}
                  </th>
                  <th scope="col" className="py-3 pr-4 font-semibold">
                    {labels.columns.price}
                  </th>
                  <th scope="col" className="py-3 text-right font-semibold">
                    {labels.columns.actions}
                  </th>
                </tr>
              </thead>
            )}
            <tbody>
              {rows.map((row) => {
                const titleId = `catalog-item-${row.id}`;
                const busy = busyId === row.id;
                const nextStatus: ContentStatus = row.status === "published" ? "draft" : "published";
                return (
                  <tr
                    key={row.id}
                    draggable={Boolean(reorder) && !pending}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move";
                      setDragId(row.id);
                    }}
                    onDragOver={(event) => {
                      if (!dragId) return;
                      event.preventDefault();
                      setDropId(row.id);
                    }}
                    onDrop={(event) => handleDrop(event, row.id)}
                    onDragEnd={() => {
                      setDragId(null);
                      setDropId(null);
                    }}
                    className={cx(
                      "border-b border-border align-middle last:border-b-0 transition-[background-color,opacity]",
                      dragId === row.id && "opacity-50",
                      dropId === row.id && dragId !== row.id && "bg-accent/5",
                    )}
                  >
                    <th scope="row" className="py-3 pr-4 text-left font-normal">
                      <span className="flex items-center gap-2">
                        {reorder && (
                          <span aria-hidden="true" className="cursor-grab text-border-input select-none">
                            ⠿
                          </span>
                        )}
                        <span className="flex flex-col gap-1">
                          <span id={titleId} className="font-semibold">
                            {row.title}
                          </span>
                          {row.featured && (
                            <span className="inline-flex items-center gap-1 text-small font-semibold text-accent">
                              <span aria-hidden="true">★</span>
                              <span>{labels.featured}</span>
                            </span>
                          )}
                        </span>
                      </span>
                    </th>
                    <td className="py-3 pr-4">
                      <Badge tone={row.status}>{labels.statuses[row.status]}</Badge>
                    </td>
                    <td className="py-3 pr-4 text-small whitespace-nowrap">{row.price}</td>
                    <td className="py-3">
                      <div className="flex items-center justify-end gap-1">
                        <Link
                          href={row.editHref}
                          aria-describedby={titleId}
                          className="inline-flex min-h-11 items-center px-2"
                        >
                          {labels.edit}
                        </Link>
                        <Button
                          variant="secondary"
                          loading={busy && pending}
                          disabled={pending && !busy}
                          aria-describedby={titleId}
                          onClick={() => run(row.id, () => onStatusChange(row.id, nextStatus))}
                        >
                          {row.status === "published" ? labels.hide : labels.publish}
                        </Button>
                        {reorder && moveButton(row, "up", reorder.labels)}
                        {reorder && moveButton(row, "down", reorder.labels)}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
