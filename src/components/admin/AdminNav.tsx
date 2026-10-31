"use client";

import NextLink from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/lib/cx";

export type AdminNavItem = {
  href: string;
  label: string;
  /** Active only on this exact path (the panel home), not on its sub-paths. */
  exact?: boolean;
};

export type AdminNavProps = {
  /** Accessible name of the navigation landmark. */
  label: string;
  items: AdminNavItem[];
};

/**
 * Admin sidebar navigation (approved admin mock). The current section is
 * marked with `aria-current="page"` and shown with weight plus the accent
 * tint, not colour alone. Horizontal below 768px, vertical in the sidebar.
 */
export default function AdminNav({ label, items }: AdminNavProps) {
  const pathname = usePathname();

  return (
    <nav aria-label={label}>
      <ul className="flex flex-wrap gap-1 md:flex-col">
        {items.map(({ href, label: itemLabel, exact }) => {
          const active = exact
            ? pathname === href
            : pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={href}>
              <NextLink
                href={href}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "flex min-h-11 items-center rounded-btn px-3 text-small transition-[background-color,color]",
                  active
                    ? "bg-accent/10 font-semibold text-accent-hover"
                    : "text-muted hover:bg-border hover:text-fg active:bg-border",
                )}
              >
                {itemLabel}
              </NextLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
