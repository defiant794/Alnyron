"use client";

import { useId, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useCurrentPath } from "@/i18n/current-route";
import { cx } from "@/lib/cx";

export type SiteMenuProps = {
  /** Visible label of the small-screen toggle ("Menu"). */
  toggleLabel: string;
  /** Header contents that collapse: the site nav and the language switcher. */
  children: ReactNode;
};

/**
 * Below 768px the header nav and language switcher collapse behind a "Menu"
 * disclosure button that opens them as a panel under the header (DESIGN.md
 * Nav); from 768px up they sit inline and the button is hidden. The panel
 * closes on Escape (focus returns to the button), on a link click and on
 * any navigation.
 */
export default function SiteMenu({ toggleLabel, children }: SiteMenuProps) {
  const currentPath = useCurrentPath();
  // Open only on the page where it was opened, so navigating anywhere
  // (links, back/forward) closes it without an effect.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === currentPath;
  const panelId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key !== "Escape" || !open) return;
    setOpenOn(null);
    toggleRef.current?.focus();
  }

  // Delegated: also closes on a link to the page already shown.
  function handlePanelClick(event: MouseEvent) {
    if (event.target instanceof Element && event.target.closest("a")) setOpenOn(null);
  }

  return (
    <div onKeyDown={handleKeyDown} className="flex items-center">
      <button
        ref={toggleRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpenOn(open ? null : currentPath)}
        className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center gap-2 rounded-btn px-2 text-body font-semibold text-fg transition-colors hover:bg-surface active:bg-border sm:px-3 md:hidden"
      >
        <MenuIcon open={open} />
        {/* Icon-only below 640px (the label stays the accessible name) so the header fits 320px. */}
        <span className="sr-only sm:not-sr-only">{toggleLabel}</span>
      </button>
      <div
        id={panelId}
        onClick={handlePanelClick}
        className={cx(
          "absolute inset-x-0 top-full flex-col items-start gap-4 border-b border-border bg-bg px-6 pt-2 pb-6",
          open ? "flex" : "hidden",
          "md:static md:flex md:flex-row md:items-center md:gap-8 md:border-0 md:bg-transparent md:p-0",
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** Hamburger when closed, cross when open (decorative: the button has a text label). */
function MenuIcon({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      className="size-6"
    >
      {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
    </svg>
  );
}
