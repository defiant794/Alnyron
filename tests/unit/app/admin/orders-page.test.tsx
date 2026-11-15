// @vitest-environment jsdom
/**
 * Unit tests: src/app/admin/(panel)/orders/page.tsx
 * Journey: payments-s2-3d-purchase
 * Criteria: admin orders list page (contract §3)
 *
 * Test IDs: S2-T-ORD-LST-01..10
 *
 * Copy pinned from s2-admin-orders.html mock, statuses per amendment A1
 * (charge on dispatch; no em-dash):
 *   heading:               "Ordrer"
 *   column headers:        "Nr." | "Dato" | "Køber" | "Vare" | "Beløb" | "Status"
 *   empty state:           "Ingen ordrer endnu."
 *   status badges (cells): "Reserveret" | "Afsendt" | "Refunderet" | "Annulleret"
 *   withdrawal badge:      "Fortrydelse modtaget" (received/approved)
 *   manual badge:          "Til manuel behandling" (needs_manual)
 *   anomaly cell:          "⚠ Afvigelse: tax_mismatch"
 *   overflow wrapper:      class `overflow-x-auto`
 *   filter hrefs:          /admin/orders?status=authorized|shipped|refunded|canceled|withdrawal
 *   order link href:       /admin/orders/1001
 *
 * The page renders inside AdminShell's `<main>` (the panel layout), so the
 * tests wrap it in a `<main>` as the shell does; a page-level `<main>` would
 * nest landmarks.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockRequireAdmin, mockListOrders } = vi.hoisted(() => ({
  mockRequireAdmin: vi.fn(),
  mockListOrders: vi.fn(),
}));

vi.mock("next-intl/server", async () =>
  // Exception: vi.mock factory is hoisted; must dynamically import the helper.
  (await import("../../../helpers/next-intl-server")).nextIntlServerMock(),
);
vi.mock("@/components/site/SiteFooter", () => ({ default: () => <footer /> }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/admin/orders",
}));
vi.mock("@/services/auth/require-admin", () => ({ requireAdmin: mockRequireAdmin }));
vi.mock("@/services/admin/orders", () => ({ listOrders: mockListOrders }));

import AdminOrdersPage from "@/app/admin/(panel)/orders/page";
import type { AdminOrderRow } from "@/services/admin/orders";

afterEach(cleanup);

const ADMIN_USER = { userId: "admin-uuid", email: "admin@example.com", role: "admin" as const };

const PAID_ROW: AdminOrderRow = {
  id: "00000000-0000-0000-0000-000000000001",
  orderNumber: 1001,
  email: "kunde@example.dk",
  shippingName: "Mette Hansen",
  amountTotalOre: 24995,
  status: "authorized",
  paidAt: "2026-11-13T09:40:00Z",
  anomaly: null,
  itemTitle: "Drage, 12 cm",
  withdrawal: null,
};

const SHIPPED_WITH_WD_ROW: AdminOrderRow = {
  id: "00000000-0000-0000-0000-000000000002",
  orderNumber: 1002,
  email: "jens@example.dk",
  shippingName: "Jens Nielsen",
  amountTotalOre: 17900,
  status: "shipped",
  paidAt: "2026-11-13T10:00:00Z",
  anomaly: null,
  itemTitle: "Ugle, 8 cm",
  withdrawal: { status: "received" },
};

const ANOMALY_ROW: AdminOrderRow = {
  id: "00000000-0000-0000-0000-000000000003",
  orderNumber: 1003,
  email: "sara@example.dk",
  shippingName: "Sara Jensen",
  amountTotalOre: 24995,
  status: "authorized",
  paidAt: "2026-11-13T11:00:00Z",
  anomaly: "tax_mismatch",
  itemTitle: "Drage, 12 cm",
  withdrawal: null,
};

const REFUNDED_ROW: AdminOrderRow = {
  id: "00000000-0000-0000-0000-000000000004",
  orderNumber: 1004,
  email: "peter@example.dk",
  shippingName: "Peter Lund",
  amountTotalOre: 19900,
  status: "refunded",
  paidAt: "2026-11-12T08:00:00Z",
  anomaly: null,
  itemTitle: "Kat, 10 cm",
  withdrawal: { status: "completed" },
};

const NEEDS_MANUAL_ROW: AdminOrderRow = {
  id: "00000000-0000-0000-0000-000000000005",
  orderNumber: 1005,
  email: "tom@example.dk",
  shippingName: "Tom Hansen",
  amountTotalOre: 24995,
  status: "shipped",
  paidAt: "2026-11-11T08:00:00Z",
  anomaly: null,
  itemTitle: "Drage, 12 cm",
  withdrawal: { status: "needs_manual" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue(ADMIN_USER);
  mockListOrders.mockResolvedValue([PAID_ROW]);
});

async function renderPage(searchParams: Record<string, string> = {}) {
  render(
    <main>{await AdminOrdersPage({ searchParams: Promise.resolve(searchParams) })}</main>,
  );
}

/** Find the table row that contains the given order number text. */
function getOrderRow(orderNumber: number) {
  const rows = screen.getAllByRole("row");
  const row = rows.find((r) => r.textContent?.includes(String(orderNumber)));
  if (!row) throw new Error(`No row found for order ${orderNumber}`);
  return row;
}

/** The order numbers the table lists, in its order (each row links its number). */
function listedOrders(): string[] {
  return within(screen.getByRole("table")).getAllByRole("link").map((link) => link.textContent ?? "");
}

const ALL_ROWS = [PAID_ROW, SHIPPED_WITH_WD_ROW, ANOMALY_ROW, REFUNDED_ROW, NEEDS_MANUAL_ROW];

// ── S2-T-ORD-LST-01: requireAdmin before listOrders ──────────────────────

describe("S2-T-ORD-LST-01: AdminOrdersPage — requireAdmin called before listOrders", () => {
  it("requireAdmin invocation order < listOrders invocation order", async () => {
    await renderPage();
    expect(mockRequireAdmin).toHaveBeenCalled();
    expect(mockListOrders).toHaveBeenCalled();
    expect(mockRequireAdmin.mock.invocationCallOrder[0]).toBeLessThan(
      mockListOrders.mock.invocationCallOrder[0]!,
    );
  });
});

// ── S2-T-ORD-LST-02: heading 'Ordrer' ────────────────────────────────────

describe("S2-T-ORD-LST-02: AdminOrdersPage — heading 'Ordrer'", () => {
  it("renders h1 'Ordrer'", async () => {
    await renderPage();
    expect(within(screen.getByRole("main")).getByRole("heading", { level: 1 }))
      .toHaveTextContent("Ordrer");
  });
});

// ── S2-T-ORD-LST-03: column headers ──────────────────────────────────────

describe("S2-T-ORD-LST-03: AdminOrdersPage — column headers from contract §3", () => {
  it.each(["Nr.", "Dato", "Køber", "Vare", "Beløb", "Status"])(
    "renders column header '%s'",
    async (header) => {
      await renderPage();
      expect(
        screen.getAllByRole("columnheader").some(
          (th) => th.textContent?.trim() === header,
        ),
      ).toBe(true);
    },
  );
});

// ── S2-T-ORD-LST-04: order row link href ─────────────────────────────────

describe("S2-T-ORD-LST-04: AdminOrdersPage — order row link href is '/admin/orders/1001'", () => {
  it("order number link has exact href '/admin/orders/1001'", async () => {
    await renderPage();
    const link = within(getOrderRow(1001)).getByRole("link", { name: "1001" });
    expect(link).toHaveAttribute("href", "/admin/orders/1001");
  });
});

// ── S2-T-ORD-LST-05: row-scoped badges ───────────────────────────────────

describe("S2-T-ORD-LST-05: AdminOrdersPage — status badges scoped to their row", () => {
  it("authorized row (1001) shows 'Reserveret' badge, not 'Afsendt'", async () => {
    mockListOrders.mockResolvedValue([PAID_ROW, SHIPPED_WITH_WD_ROW]);
    await renderPage();
    const paidRow = getOrderRow(1001);
    expect(within(paidRow).getByText("Reserveret")).toBeInTheDocument();
    expect(within(paidRow).queryByText("Afsendt")).toBeNull();
  });

  it("shipped row (1002) shows 'Afsendt' badge and 'Fortrydelse modtaget', not 'Reserveret'", async () => {
    mockListOrders.mockResolvedValue([PAID_ROW, SHIPPED_WITH_WD_ROW]);
    await renderPage();
    const shippedRow = getOrderRow(1002);
    expect(within(shippedRow).getByText("Afsendt")).toBeInTheDocument();
    expect(within(shippedRow).getByText("Fortrydelse modtaget")).toBeInTheDocument();
    expect(within(shippedRow).queryByText("Reserveret")).toBeNull();
  });

  it("refunded row (1004) shows 'Refunderet' badge", async () => {
    mockListOrders.mockResolvedValue([REFUNDED_ROW]);
    await renderPage();
    const refRow = getOrderRow(1004);
    expect(within(refRow).getByText("Refunderet")).toBeInTheDocument();
  });

  it("needs_manual row (1005) shows 'Til manuel behandling' badge", async () => {
    mockListOrders.mockResolvedValue([NEEDS_MANUAL_ROW]);
    await renderPage();
    const manualRow = getOrderRow(1005);
    expect(within(manualRow).getByText("Til manuel behandling")).toBeInTheDocument();
  });

  it("canceled row (1006) shows 'Annulleret' badge (A1: reservation released before dispatch)", async () => {
    mockListOrders.mockResolvedValue([
      { ...PAID_ROW, id: "00000000-0000-0000-0000-000000000006", orderNumber: 1006, status: "canceled" },
    ]);
    await renderPage();
    expect(within(getOrderRow(1006)).getByText("Annulleret")).toBeInTheDocument();
  });
});

// ── S2-T-ORD-LST-06: anomaly scoped to row ───────────────────────────────

describe("S2-T-ORD-LST-06: AdminOrdersPage — anomaly marker scoped to anomaly row", () => {
  it("shows '⚠ Afvigelse: tax_mismatch' in Sara's row (1003), not in Mette's (1001)", async () => {
    mockListOrders.mockResolvedValue([PAID_ROW, ANOMALY_ROW]);
    await renderPage();
    const anomalyRow = getOrderRow(1003);
    const paidRow = getOrderRow(1001);
    expect(within(anomalyRow).getByText(/⚠.*tax_mismatch/)).toBeInTheDocument();
    expect(within(paidRow).queryByText(/⚠/)).toBeNull();
  });
});

// ── S2-T-ORD-LST-07: empty state 'Ingen ordrer endnu.' ───────────────────

describe("S2-T-ORD-LST-07: AdminOrdersPage — empty state", () => {
  it("shows 'Ingen ordrer endnu.' when no rows", async () => {
    mockListOrders.mockResolvedValue([]);
    await renderPage();
    expect(screen.getByRole("main").textContent).toContain("Ingen ordrer endnu.");
  });

  it("does not render a table when empty", async () => {
    mockListOrders.mockResolvedValue([]);
    await renderPage();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows 'Ingen ordrer med denne status.' when a filter matches nothing but orders exist", async () => {
    mockListOrders.mockResolvedValue([PAID_ROW]);
    await renderPage({ status: "canceled" });
    expect(screen.getByRole("main").textContent).toContain("Ingen ordrer med denne status.");
    expect(screen.queryByRole("table")).toBeNull();
  });
});

// ── S2-T-ORD-LST-08: overflow-x-auto wrapper ─────────────────────────────

describe("S2-T-ORD-LST-08: AdminOrdersPage — table inside overflow-x-auto wrapper", () => {
  it("table is wrapped in an element with class overflow-x-auto", async () => {
    await renderPage();
    const wrapper = screen.getByRole("main").querySelector(".overflow-x-auto");
    expect(wrapper).not.toBeNull();
    expect(wrapper!.querySelector("table")).not.toBeNull();
  });
});

// ── S2-T-ORD-LST-09: status filter links with exact hrefs ────────────────

describe("S2-T-ORD-LST-09: AdminOrdersPage — filter links with exact hrefs", () => {
  it.each([
    "/admin/orders",
    "/admin/orders?status=authorized",
    "/admin/orders?status=shipped",
    "/admin/orders?status=refunded",
    "/admin/orders?status=canceled",
    "/admin/orders?status=withdrawal",
  ])("renders filter link with href '%s'", async (href) => {
    await renderPage();
    const links = within(screen.getByRole("main")).getAllByRole("link");
    expect(links.some((l) => l.getAttribute("href") === href)).toBe(true);
  });

  it("each filter link shows its count over all orders; the current one is aria-current='page'", async () => {
    mockListOrders.mockResolvedValue(ALL_ROWS);
    await renderPage({ status: "shipped" });
    const nav = screen.getByRole("navigation", { name: "Filtrér efter status" });
    const names = within(nav).getAllByRole("link").map((link) => link.textContent);
    expect(names).toEqual([
      "Alle (5)",
      "Reserveret (2)",
      "Afsendt (2)",
      "Fortrydelse (3)",
      "Refunderet (1)",
      "Annulleret (0)",
    ]);
    expect(within(nav).getByRole("link", { name: "Afsendt (2)" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Alle (5)" })).not.toHaveAttribute("aria-current");
    expect(listedOrders()).toEqual(["1002", "1005"]);
  });
});

// ── S2-T-ORD-LST-10: ?status filters the one read of every order ─────────

describe("S2-T-ORD-LST-10: AdminOrdersPage — ?status filters the one listOrders() read in memory", () => {
  it("?status=authorized → one listOrders() call; only the reserved orders are listed", async () => {
    mockListOrders.mockResolvedValue(ALL_ROWS);
    await renderPage({ status: "authorized" });
    expect(mockListOrders).toHaveBeenCalledTimes(1);
    expect(mockListOrders).toHaveBeenCalledWith();
    expect(listedOrders()).toEqual(["1001", "1003"]);
  });

  it("?status=withdrawal → every order with a withdrawal, whatever its status", async () => {
    mockListOrders.mockResolvedValue(ALL_ROWS);
    await renderPage({ status: "withdrawal" });
    expect(mockListOrders).toHaveBeenCalledTimes(1);
    expect(listedOrders()).toEqual(["1002", "1004", "1005"]);
  });

  it.each([
    ["the pre-A1 ?status=paid", { status: "paid" }],
    ["an unknown ?status=xyz", { status: "xyz" }],
    ["no ?status", {}],
  ])("%s → every order, one listOrders() call", async (_, searchParams: Record<string, string>) => {
    mockListOrders.mockResolvedValue(ALL_ROWS);
    await renderPage(searchParams);
    expect(mockListOrders).toHaveBeenCalledTimes(1);
    expect(mockListOrders).toHaveBeenCalledWith();
    expect(listedOrders()).toEqual(["1001", "1002", "1003", "1004", "1005"]);
  });
});
