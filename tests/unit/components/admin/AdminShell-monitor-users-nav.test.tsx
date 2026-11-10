// @vitest-environment jsdom
/**
 * Unit test — AdminShell includes a "Monitor-brugere" nav link pointing to
 * /admin/monitor-users, right after the "Sider" link.
 * Journey: admin-monitor-users  AC-AMU-01
 *
 * Uses the real nextIntlServerMock() so a missing Admin.nav.monitorUsers key
 * in messages/da.json throws at render time: the nav item and its translation
 * must both exist.
 *
 * The existing AdminShell.test.tsx enforces that every nav href points to an
 * existing panel page.tsx (glob: admin/(panel)/**), so /admin/monitor-users
 * also needs a page.tsx — no separate assertion is needed here.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// vi.mock factories are hoisted above static imports by Vite, so the helper
// must be imported dynamically inside the factory (a static import would not
// exist at hoist time).
vi.mock("next-intl/server", async () =>
  (await import("../../../helpers/next-intl-server")).nextIntlServerMock(),
);
vi.mock("next/navigation", () => ({ usePathname: () => "/admin/monitor-users" }));
vi.mock("@/app/admin/(auth)/actions", () => ({ signOut: vi.fn() }));

import AdminShell from "@/components/admin/AdminShell";

const USER = { userId: "u-1", email: "ejer@example.com", role: "owner" } as const;

afterEach(cleanup);

// ── AC-AMU-01: Monitor-brugere nav link ──────────────────────────────────────

describe("AC-AMU-01: AdminShell — 'Monitor-brugere' nav link pointing to /admin/monitor-users", () => {
  it("AC-AMU-01a: rendered nav contains a link with href '/admin/monitor-users'", async () => {
    render(await AdminShell({ user: USER, children: null }));

    const nav = screen.getByRole("navigation", { name: "Administration" });
    const links = within(nav).getAllByRole("link");
    const monitorUsersLink = links.find((l) => l.getAttribute("href") === "/admin/monitor-users");

    expect(monitorUsersLink).toBeTruthy();
  });

  it("AC-AMU-01b: the /admin/monitor-users link is labelled 'Monitor-brugere'", async () => {
    render(await AdminShell({ user: USER, children: null }));

    const nav = screen.getByRole("navigation", { name: "Administration" });
    const link = within(nav).getByRole("link", { name: "Monitor-brugere" });

    expect(link).toHaveAttribute("href", "/admin/monitor-users");
  });

  it("AC-AMU-01c: the /admin/monitor-users link has aria-current='page' when pathname is /admin/monitor-users", async () => {
    // usePathname() is mocked to /admin/monitor-users above.
    render(await AdminShell({ user: USER, children: null }));

    const nav = screen.getByRole("navigation", { name: "Administration" });
    const monitorUsersLink = within(nav).getByRole("link", { name: "Monitor-brugere" });
    const pagesLink = within(nav).getByRole("link", { name: "Sider" });

    expect(monitorUsersLink).toHaveAttribute("aria-current", "page");
    expect(pagesLink).not.toHaveAttribute("aria-current", "page");
  });

  it("AC-AMU-01d: 'Monitor-brugere' link appears immediately after 'Sider' link in the nav", async () => {
    render(await AdminShell({ user: USER, children: null }));

    const nav = screen.getByRole("navigation", { name: "Administration" });
    const links = within(nav).getAllByRole("link");
    const pagesIdx = links.findIndex((l) => l.getAttribute("href") === "/admin/pages");
    const monitorUsersIdx = links.findIndex((l) => l.getAttribute("href") === "/admin/monitor-users");

    expect(pagesIdx).toBeGreaterThanOrEqual(0);
    expect(monitorUsersIdx).toBe(pagesIdx + 1);
  });
});
