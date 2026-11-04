"use client";

import NextLink from "next/link";
import { usePathname } from "next/navigation";
import { useId } from "react";
import { useActiveCatalogKind } from "@/components/admin/ActiveCatalogKind";
import type { CatalogKind } from "@/config/catalog";
import { cx } from "@/lib/cx";

export type AdminNavItem = {
  href: string;
  label: string;
  /** Active only on this exact path (the panel home), not on its sub-paths. */
  exact?: boolean;
  /**
   * Active on a page that edits a section of this kind (it declares the kind
   * with `ActiveCatalogKind`), ahead of any path match: a section editor's
   * path (`/admin/catalog/categories/<id>`) lies only under "Katalog".
   */
  matchKind?: CatalogKind;
};

/** Links listed under a group label ("Kataloger"). */
export type AdminNavGroup = {
  label: string;
  items: AdminNavItem[];
};

export type AdminNavEntry = AdminNavItem | AdminNavGroup;

export type AdminNavProps = {
  /** Accessible name of the navigation landmark. */
  label: string;
  items: AdminNavEntry[];
};

/**
 * Admin sidebar navigation (approved admin mock). The current section is
 * marked with `aria-current="page"` and shown with weight plus the accent
 * tint, not colour alone. A group's links form a nested list named by the
 * group label. When several links match the path (`/admin/catalog` and a
 * deeper catalog link), only the most specific one is current; on a section
 * editor, the link of the section's kind is current instead.
 * Horizontal below 768px, vertical in the sidebar.
 */
export default function AdminNav({ label, items }: AdminNavProps) {
  const pathname = usePathname();
  const activeKind = useActiveCatalogKind();
  const groupId = useId();
  const links = items.flatMap((entry) => ("items" in entry ? entry.items : [entry]));
  const kindHref = activeKind ? links.find(({ matchKind }) => matchKind === activeKind)?.href : undefined;
  const activeHref =
    kindHref ??
    links
      .filter(({ href, exact }) => pathname === href || (!exact && pathname.startsWith(`${href}/`)))
      .reduce<string | undefined>((best, { href }) => (best && best.length >= href.length ? best : href), undefined);

  const link = ({ href, label: itemLabel }: AdminNavItem) => (
    <li key={href}>
      <NextLink
        href={href}
        aria-current={href === activeHref ? "page" : undefined}
        className={cx(
          "flex min-h-11 items-center rounded-btn px-3 text-small transition-[background-color,color]",
          href === activeHref
            ? "bg-accent/10 font-semibold text-accent-hover"
            : "text-muted hover:bg-border hover:text-fg active:bg-border",
        )}
      >
        {itemLabel}
      </NextLink>
    </li>
  );

  return (
    <nav aria-label={label}>
      <ul className="flex flex-wrap gap-1 md:flex-col">
        {items.map((entry, index) => {
          if (!("items" in entry)) return link(entry);
          const id = `${groupId}-${index}`;
          return (
            <li key={id} className="flex basis-full flex-col gap-1 md:basis-auto">
              <span id={id} className="px-3 pt-3 text-xs font-semibold tracking-widest text-muted uppercase">
                {entry.label}
              </span>
              <ul aria-labelledby={id} className="flex flex-wrap gap-1 md:flex-col">
                {entry.items.map(link)}
              </ul>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
