// @vitest-environment jsdom
/**
 * Unit test — AdminShell includes an "Ordrer" nav link pointing to
 * /admin/orders, right after "Monitor-brugere".
 * Journey: payments-s2-3d-purchase
 * Criteria: S2-SHELL-1 (web: admin nav), contract §3
 *
 * Test IDs: S2-T-SHELL-ORD-01
 *
 * Uses the real nextIntlServerMock() so a missing Admin.nav.orders key in
 * messages/da.json throws at render time.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("next-intl/server", async () =>
  // Exception: vi.mock factory is hoisted; must dynamically import the helper.
  (await import("../../../helpers/next-intl-server")).nextIntlServerMock(),
);
vi.mock("next/navigation", () => ({ usePathname: () => "/admin/orders" }));
vi.mock("@/app/admin/(auth)/actions", () => ({ signOut: vi.fn() }));

import AdminShell from "@/components/admin/AdminShell";
import { ADMIN_ORDERS_PATH } from "@/config/admin";

const USER = { userId: "u-1", email: "ejer@example.com", role: "owner" } as const;

afterEach(cleanup);

describe("S2-T-SHELL-ORD-01: AdminShell — 'Ordrer' nav link pointing to /admin/orders", () => {
  it("S2-T-SHELL-ORD-01a: rendered nav contains a link with href '/admin/orders'", async () => {
    render(await AdminShell({ user: USER, children: null }));
    const nav = screen.getByRole("navigation", { name: "Administration" });
    const link = within(nav).getAllByRole("link").find(
      (l) => l.getAttribute("href") === "/admin/orders",
    );
    expect(link).toBeTruthy();
  });

  it("S2-T-SHELL-ORD-01b: the /admin/orders link is labelled 'Ordrer'", async () => {
    render(await AdminShell({ user: USER, children: null }));
    const nav = screen.getByRole("navigation", { name: "Administration" });
    const link = within(nav).getByRole("link", { name: "Ordrer" });
    expect(link).toHaveAttribute("href", "/admin/orders");
  });

  it("S2-T-SHELL-ORD-01c: 'Ordrer' link appears immediately after 'Monitor-brugere'", async () => {
    render(await AdminShell({ user: USER, children: null }));
    const nav = screen.getByRole("navigation", { name: "Administration" });
    const links = within(nav).getAllByRole("link");
    const monitorUsersIdx = links.findIndex(
      (l) => l.getAttribute("href") === "/admin/monitor-users",
    );
    const ordersIdx = links.findIndex((l) => l.getAttribute("href") === "/admin/orders");
    expect(monitorUsersIdx).toBeGreaterThanOrEqual(0);
    expect(ordersIdx).toBe(monitorUsersIdx + 1);
  });

  it("S2-T-SHELL-ORD-01d: ADMIN_ORDERS_PATH is '/admin/orders'", () => {
    expect(ADMIN_ORDERS_PATH).toBe("/admin/orders");
  });
});
