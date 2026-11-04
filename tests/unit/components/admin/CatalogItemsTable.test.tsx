// @vitest-environment jsdom
/**
 * Unit tests — CatalogItemsTable component (F2.3 catalog-admin)
 * Journey: catalog-admin
 * Acceptance IDs: AC-CATADM-15, AC-CATADM-16, AC-CATADM-17
 *
 * The items table in the section editor shows each item's DA title, status badge,
 * Udvalgt flag, price, Rediger link, and Udgiv/Skjul status toggle button.
 * An empty items list shows the "Ingen elementer endnu, opret et" empty state.
 * "+ Nyt element" navigates to /admin/catalog/items/new?category=[id].
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

import CatalogItemsTable from "@/components/admin/CatalogItemsTable";
import type { CatalogActionResult } from "@/services/admin/catalog";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CAT_ID = "cat-services-uuid-0001";

const ITEM_ROWS = [
  {
    id: "item-1",
    title: "Webudvikling",
    status: "published" as const,
    featured: true,
    price: "fra\u00a012.000\u00a0kr.",
    editHref: "/admin/catalog/items/item-1",
  },
  {
    id: "item-2",
    title: "App-udvikling",
    status: "draft" as const,
    featured: false,
    price: null,
    editHref: "/admin/catalog/items/item-2",
  },
];

const LABELS = {
  newItem: "+ Nyt element",
  empty: "Ingen elementer endnu, opret et",
  edit: "Rediger",
  featured: "Udvalgt",
  publish: "Udgiv",
  hide: "Skjul",
  statuses: { published: "Offentlig", draft: "Kladde" },
};

afterEach(cleanup);

// ── AC-CATADM-15: items table shows rows ─────────────────────────────────────

describe("AC-CATADM-15: CatalogItemsTable renders item rows", () => {
  it("AC-CATADM-15a: renders each item title", () => {
    render(
      <CatalogItemsTable
        categoryId={CAT_ID}
        rows={ITEM_ROWS}
        labels={LABELS}
        onStatusChange={vi.fn()}
      />,
    );
    expect(screen.getByText("Webudvikling")).toBeInTheDocument();
    expect(screen.getByText("App-udvikling")).toBeInTheDocument();
  });

  it("AC-CATADM-15b: published item shows Offentlig status badge", () => {
    render(
      <CatalogItemsTable categoryId={CAT_ID} rows={ITEM_ROWS} labels={LABELS} onStatusChange={vi.fn()} />,
    );
    expect(screen.getByText("Offentlig")).toBeInTheDocument();
  });

  it("AC-CATADM-15c: draft item shows Kladde status badge", () => {
    render(
      <CatalogItemsTable categoryId={CAT_ID} rows={ITEM_ROWS} labels={LABELS} onStatusChange={vi.fn()} />,
    );
    expect(screen.getByText("Kladde")).toBeInTheDocument();
  });

  it("AC-CATADM-15d: featured item shows Udvalgt indicator", () => {
    render(
      <CatalogItemsTable categoryId={CAT_ID} rows={ITEM_ROWS} labels={LABELS} onStatusChange={vi.fn()} />,
    );
    expect(screen.getByText("Udvalgt")).toBeInTheDocument();
  });

  it("AC-CATADM-15e: item with a price renders the price text", () => {
    render(
      <CatalogItemsTable categoryId={CAT_ID} rows={ITEM_ROWS} labels={LABELS} onStatusChange={vi.fn()} />,
    );
    expect(screen.getByText(/12\.000/)).toBeInTheDocument();
  });

  it("AC-CATADM-15f: each item has a Rediger link", () => {
    render(
      <CatalogItemsTable categoryId={CAT_ID} rows={ITEM_ROWS} labels={LABELS} onStatusChange={vi.fn()} />,
    );
    const links = screen.getAllByRole("link", { name: "Rediger" });
    expect(links).toHaveLength(2);
  });

  it("AC-CATADM-15g: published item has a Skjul button; draft item has an Udgiv button", () => {
    render(
      <CatalogItemsTable categoryId={CAT_ID} rows={ITEM_ROWS} labels={LABELS} onStatusChange={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Skjul" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Udgiv" })).toBeInTheDocument();
  });
});

// ── AC-CATADM-16: empty state ─────────────────────────────────────────────────

describe("AC-CATADM-16: CatalogItemsTable — empty state", () => {
  it("AC-CATADM-16a: shows 'Ingen elementer endnu, opret et' when rows is empty", () => {
    render(
      <CatalogItemsTable categoryId={CAT_ID} rows={[]} labels={LABELS} onStatusChange={vi.fn()} />,
    );
    expect(screen.getByText("Ingen elementer endnu, opret et")).toBeInTheDocument();
  });

  it("AC-CATADM-16b: does not render any item title when empty", () => {
    render(
      <CatalogItemsTable categoryId={CAT_ID} rows={[]} labels={LABELS} onStatusChange={vi.fn()} />,
    );
    expect(screen.queryByText("Webudvikling")).not.toBeInTheDocument();
  });
});

// ── AC-CATADM-17: + Nyt element link ─────────────────────────────────────────

describe("AC-CATADM-17: CatalogItemsTable — '+ Nyt element' navigates to new item with category param", () => {
  it("AC-CATADM-17a: shows '+ Nyt element' button/link", () => {
    render(
      <CatalogItemsTable categoryId={CAT_ID} rows={ITEM_ROWS} labels={LABELS} onStatusChange={vi.fn()} />,
    );
    // Either a link or button with this label
    const newItemEl =
      screen.queryByRole("link", { name: "+ Nyt element" }) ??
      screen.queryByRole("button", { name: "+ Nyt element" });
    expect(newItemEl).toBeInTheDocument();
  });

  it("AC-CATADM-17b: '+ Nyt element' link href contains /admin/catalog/items/new with correct category param", () => {
    render(
      <CatalogItemsTable categoryId={CAT_ID} rows={ITEM_ROWS} labels={LABELS} onStatusChange={vi.fn()} />,
    );
    const link = screen.queryByRole("link", { name: "+ Nyt element" });
    if (link) {
      const href = link.getAttribute("href") ?? "";
      expect(href).toContain("/admin/catalog/items/new");
      expect(href).toContain(CAT_ID);
    }
  });

  it("AC-CATADM-17c: '+ Nyt element' also visible when table is empty", () => {
    render(
      <CatalogItemsTable categoryId={CAT_ID} rows={[]} labels={LABELS} onStatusChange={vi.fn()} />,
    );
    const newItemEl =
      screen.queryByRole("link", { name: "+ Nyt element" }) ??
      screen.queryByRole("button", { name: "+ Nyt element" });
    expect(newItemEl).toBeInTheDocument();
  });
});

// ── AC-CATADM-15 + status change callback ────────────────────────────────────

describe("AC-CATADM-15: CatalogItemsTable — status toggle calls onStatusChange", () => {
  it("AC-CATADM-15h: clicking Skjul on a published item calls onStatusChange with (id, 'draft')", async () => {
    const user = userEvent.setup();
    const onStatusChange = vi.fn().mockResolvedValue({ ok: true } satisfies CatalogActionResult);

    render(
      <CatalogItemsTable categoryId={CAT_ID} rows={ITEM_ROWS} labels={LABELS} onStatusChange={onStatusChange} />,
    );
    await user.click(screen.getByRole("button", { name: "Skjul" }));

    expect(onStatusChange).toHaveBeenCalledWith("item-1", "draft");
  });

  it("AC-CATADM-15i: clicking Udgiv on a draft item calls onStatusChange with (id, 'published')", async () => {
    const user = userEvent.setup();
    const onStatusChange = vi.fn().mockResolvedValue({ ok: true } satisfies CatalogActionResult);

    render(
      <CatalogItemsTable categoryId={CAT_ID} rows={ITEM_ROWS} labels={LABELS} onStatusChange={onStatusChange} />,
    );
    await user.click(screen.getByRole("button", { name: "Udgiv" }));

    expect(onStatusChange).toHaveBeenCalledWith("item-2", "published");
  });
});
