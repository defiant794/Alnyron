// @vitest-environment jsdom
/**
 * Unit test — AdminShell includes a "Sider" nav link (F1.2 pages editor)
 * Journey: pages-editor  AC-PAGES-18
 *
 * Uses the real nextIntlServerMock() WITHOUT a "Sider" override, so a missing
 * Admin.nav.pages key in messages/da.json throws at render time: the nav item
 * and its translation must both exist.
 *
 * The existing F-nav test in AdminShell.test.tsx enforces that every nav href
 * points to an existing panel page.tsx (glob: admin/(panel)/**), so /admin/pages
 * also needs a page.tsx — no separate assertion needed here.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Dynamic import required: vi.mock factories are hoisted by Vite above all static
// imports, so a static import of the helper would not yet exist at factory time.
vi.mock("next-intl/server", async () =>
  (await import("../../../helpers/next-intl-server")).nextIntlServerMock(),
);
vi.mock("next/navigation", () => ({ usePathname: () => "/admin/pages" }));
vi.mock("@/app/admin/(auth)/actions", () => ({ signOut: vi.fn() }));

import AdminShell from "@/components/admin/AdminShell";

const USER = { userId: "u-1", email: "ejer@example.com", role: "owner" } as const;

afterEach(cleanup);

// ── AC-PAGES-18: Sider nav link ───────────────────────────────────────────────

describe("AC-PAGES-18: AdminShell — 'Sider' nav link pointing to /admin/pages", () => {
  it("AC-PAGES-18: rendered nav contains a link with href /admin/pages", async () => {
    render(await AdminShell({ user: USER, children: null }));

    const nav = screen.getByRole("navigation", { name: "Administration" });
    const links = within(nav).getAllByRole("link");
    const pagesLink = links.find((l) => l.getAttribute("href") === "/admin/pages");

    expect(pagesLink).toBeTruthy();
  });

  it("AC-PAGES-18b: the /admin/pages link is labelled 'Sider'", async () => {
    render(await AdminShell({ user: USER, children: null }));

    const nav = screen.getByRole("navigation", { name: "Administration" });
    const pagesLink = within(nav).getByRole("link", { name: "Sider" });

    expect(pagesLink).toHaveAttribute("href", "/admin/pages");
  });

  it("AC-PAGES-18c: the /admin/pages link has aria-current='page' when pathname is /admin/pages", async () => {
    // usePathname() is mocked to /admin/pages above
    render(await AdminShell({ user: USER, children: null }));

    const nav = screen.getByRole("navigation", { name: "Administration" });
    const pagesLink = within(nav).getByRole("link", { name: "Sider" });

    expect(pagesLink).toHaveAttribute("aria-current", "page");
  });
});
