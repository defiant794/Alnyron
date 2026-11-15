// @vitest-environment jsdom
/**
 * Admin breadcrumb navigation; payments S2 design finding D3.
 * Journey: payments-s2-3d-purchase
 * Criteria: S2-ADM-* (web detail), design finding D3
 * Test IDs: S2-T-ORD-DET-D3
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import AdminBreadcrumb from "@/components/admin/AdminBreadcrumb";

afterEach(cleanup);

describe("S2-T-ORD-DET-D3: AdminBreadcrumb standalone navigation targets", () => {
  it("gives every ancestor link the 44px minimum in both dimensions, including short labels", () => {
    render(
      <AdminBreadcrumb
        label="Brødkrummesti"
        items={[
          { label: "Ordrer", href: "/admin/orders" },
          { label: "Katalog", href: "/admin/catalog" },
          { label: "#1489" },
        ]}
      />,
    );

    const breadcrumb = within(screen.getByRole("navigation", { name: "Brødkrummesti" }));
    const links = breadcrumb.getAllByRole("link");
    expect(links).toHaveLength(2);
    for (const link of links) expect(link).toHaveClass("inline-flex", "min-h-11", "min-w-11", "items-center");
    expect(breadcrumb.getByRole("link", { name: "Ordrer" })).toHaveAttribute("href", "/admin/orders");
    expect(breadcrumb.getByText("#1489")).toHaveAttribute("aria-current", "page");
    expect(breadcrumb.queryByRole("link", { name: "#1489" })).toBeNull();
  });
});
