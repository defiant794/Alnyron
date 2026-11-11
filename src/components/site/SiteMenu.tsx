"use client";

import { useId, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useCurrentPath } from "@/i18n/current-route";
import { cx } from "@/lib/cx";

export type SiteMenuProps = {
  /** Visible label of the small-screen toggle ("Menu"). */
  toggleLabel: string;
  /** The collapsible header content (a nav, and optionally a language switcher). */
  children: ReactNode;
};

/**
 * Below 768px the collapsible header content (a nav, and optionally a
 * language switcher) sits behind a "Menu" disclosure button that opens it as
 * a full-width panel under the caller's positioned container (the header, or
 * the header row the menu sits in; DESIGN.md Nav); from 768px up it sits
 * inline and the button is hidden. The panel closes on Escape (focus returns
 * to the button), on a link click, on any navigation and when focus moves to
 * an element outside the menu.
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

  // Close when focus moves to an element outside the menu (WCAG 2.4.7; 2.4.11
  // Focus Not Obscured in 2.2): the open panel overlays the content below the
  // header, so the next element tabbed to (or clicked) would otherwise get its
  // focus ring hidden behind the panel.
  // React's onBlur is focusout, so it bubbles from the toggle and every panel
  // link; focus moving within the menu keeps it open. A null relatedTarget
  // (focus went to nothing: a window/tab switch, a click on non-focusable
  // content, or WebKit dropping focus when a button is clicked) is NOT outside:
  // nothing is focused, so there is no focus ring to obscure, and closing on it
  // breaks the toggle in WebKit (bug 229895), whose click would then find the
  // menu already closed by that focusout and reopen it.
  function handleBlur(event: FocusEvent<HTMLDivElement>) {
    if (open && event.relatedTarget !== null && !event.currentTarget.contains(event.relatedTarget)) setOpenOn(null);
  }

  return (
    <div onKeyDown={handleKeyDown} onBlur={handleBlur} className="flex items-center">
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
      {/* tabIndex -1: a click on non-focusable panel content focuses the panel
          (no focus-visible ring), so it stays inside the menu and keeps it open. */}
      <div
        id={panelId}
        tabIndex={-1}
        onClick={handlePanelClick}
        className={cx(
          "absolute inset-x-0 top-full flex-col items-start gap-4 border-b border-border bg-bg px-6 pt-2 pb-6 focus:outline-none",
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
