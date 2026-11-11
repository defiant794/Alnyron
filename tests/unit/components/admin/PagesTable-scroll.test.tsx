// @vitest-environment jsdom
/**
 * Unit tests — PagesTable scroll wrapper (a11y-polish)
 * Journey: a11y-polish  A11Y-14
 *
 * The overflow-x-auto wrapper must also be `relative` so that sr-only spans
 * (position:absolute) inside the table have their containing block within the
 * wrapper — matching the precedent in MonitorSignupsTable (AC-AMU-16).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  notFound: vi.fn(),
  usePathname: () => "/admin/pages",
}));

import PagesTable, { type PagesTableProps, type PagesTableRow } from "@/components/admin/PagesTable";

afterEach(cleanup);

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CONTENT_ROW: PagesTableRow = {
  id: "contact-uuid",
  name: "Kontakt",
  title: "Kontakt side",
  status: "published",
  showInNav: true,
  pinned: false,
  kind: "content",
  editHref: "/admin/pages/contact-uuid",
};

const AREA_ROW: PagesTableRow = {
  id: "monitor-uuid",
  name: "Monitor",
  status: "published",
  showInNav: false,
  pinned: false,
  kind: "area",
  description: "Appområde på monitor.alnyron.dk",
};

const HOME_ROW: PagesTableRow = {
  id: "home-uuid",
  name: "Forside",
  title: "Forside tekst",
  status: "published",
  showInNav: true,
  pinned: true,
  kind: "content",
  editHref: "/admin/pages/home-uuid",
};

const LABELS: PagesTableProps["labels"] = {
  page: "Side",
  status: "Status",
  actions: "Handlinger",
  statuses: { published: "Offentlig", draft: "Kladde" },
  shown: "Vises i menuen",
  hidden: "Ikke i menuen",
  toggle: "Vis i menuen",
  edit: "Rediger",
  moveUp: "Flyt op",
  moveDown: "Flyt ned",
  errors: {
    invalid: "Ugyldig",
    "da-title-required": "DA titel krævet",
    "slug-taken": "Adresse i brug",
    "system-slug": "Fast adresse",
    "missing-slugs": "Mangler adresse",
    "system-always-published": "Altid offentlig",
    "not-found": "Ikke fundet",
    forbidden: "Ingen adgang",
    failed: "Fejl",
  },
};

const ROWS: PagesTableRow[] = [HOME_ROW, CONTENT_ROW, AREA_ROW];

// ── A11Y-14: scroll wrapper is positioned, sr-only contained ─────────────────

describe("A11Y-14: PagesTable — scroll wrapper is positioned so sr-only spans are contained within it", () => {
  it("A11Y-14: the overflow-x-auto wrapper has 'relative', every sr-only inside has its nearest positioned ancestor within the wrapper", () => {
    render(
      <PagesTable
        rows={ROWS}
        labelledBy="heading"
        reorder={vi.fn().mockResolvedValue({ ok: true })}
        setPageNav={vi.fn().mockResolvedValue({ ok: true })}
        labels={LABELS}
      />,
    );

    const wrapper = screen.getByRole("table").parentElement;
    expect(wrapper).toHaveClass("relative", "overflow-x-auto");

    const srOnlySpans = [...(wrapper?.querySelectorAll(".sr-only") ?? [])];
    expect(srOnlySpans.length).toBeGreaterThan(0);

    for (const span of srOnlySpans) {
      const containingBlock = span.parentElement?.closest(".relative, .absolute, .fixed, .sticky") ?? null;
      expect(
        containingBlock !== null && wrapper?.contains(containingBlock),
        `sr-only "${span.textContent?.trim()}" must have its nearest positioned ancestor inside the scroll wrapper`,
      ).toBe(true);
    }
  });
});
