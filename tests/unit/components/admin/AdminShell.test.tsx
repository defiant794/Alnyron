// @vitest-environment jsdom
// Design review F1.1 F-7 + F-9 + F-nav: the admin shell's account block, <main>, and nav routes.
// - Below 768px the account ("Log ud") shares the top row with the logo and
//   comes BEFORE the navigation, so nothing sits between the navigation and
//   the page content (reading and tab order). From 768px a second copy closes
//   the sidebar AFTER the navigation. Each copy is display:none outside its
//   breakpoint (jsdom loads no CSS, so that is asserted through the classes);
//   tests/e2e/admin-auth.spec.ts checks the real layout at 375px.
// - <main id="main"> takes the skip link's focus (tabindex="-1").
// - F-nav: every navigation link AdminShell renders leads to a built panel page.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { render, screen, cleanup, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// vi.mock is hoisted above the imports, so the shared factory is loaded lazily.
vi.mock("next-intl/server", async () =>
  (await import("../../../helpers/next-intl-server")).nextIntlServerMock(),
);
vi.mock("next/navigation", () => ({ usePathname: () => "/admin" }));
vi.mock("@/app/admin/(auth)/actions", () => ({ signOut: vi.fn() }));

import AdminShell from "@/components/admin/AdminShell";
import AuthFrame from "@/components/admin/AuthFrame";
import { ADMIN_HOME_PATH } from "@/config/admin";

const USER = { userId: "u-1", email: "ejer@example.com", role: "owner" } as const;

afterEach(cleanup);

const follows = (a: Node, b: Node) =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe("F-7: AdminShell keeps the account out of the navigation → content flow", () => {
  let nav: HTMLElement;
  let main: HTMLElement;
  let bar: HTMLElement;
  let sidebar: HTMLElement;

  beforeEach(async () => {
    render(await AdminShell({ user: USER, children: <p>Indhold</p> }));
    nav = screen.getByRole("navigation", { name: "Administration" });
    main = screen.getByRole("main");
    // Both copies are in the DOM; CSS shows one per breakpoint.
    const regions = document.querySelectorAll<HTMLElement>('section[aria-label="Konto"]');
    expect(regions).toHaveLength(2);
    [bar, sidebar] = [regions[0]!, regions[1]!];
  });

  it("small screens: the account comes before the navigation and is hidden from 768px", () => {
    expect(follows(bar, nav)).toBe(true);
    expect(bar).toHaveClass("md:hidden");
    expect(within(bar).getByRole("button", { name: "Log ud" })).toBeInTheDocument();
  });

  it("small screens: the compact account still names the account for screen readers", () => {
    expect(bar).toHaveTextContent("ejer@example.com, Ejer");
  });

  it("wide screens: the account closes the sidebar after the navigation, hidden below 768px", () => {
    expect(follows(nav, sidebar)).toBe(true);
    expect(sidebar).toHaveClass("hidden", "md:flex");
    expect(within(sidebar).getByText("ejer@example.com")).toBeInTheDocument();
    expect(within(sidebar).getByText("Ejer")).toBeInTheDocument();
    expect(within(sidebar).getByRole("button", { name: "Log ud" })).toBeInTheDocument();
  });

  it("the content follows the whole sidebar", () => {
    expect(follows(sidebar, main)).toBe(true);
    expect(main).toHaveTextContent("Indhold");
  });
});

describe("F-9: admin <main> takes the skip link's focus", () => {
  it("AdminShell <main id=main> has tabindex=-1", async () => {
    render(await AdminShell({ user: USER, children: null }));
    const main = screen.getByRole("main");
    expect(main).toHaveAttribute("id", "main");
    expect(main).toHaveAttribute("tabindex", "-1");
  });

  it("AuthFrame <main id=main> has tabindex=-1", () => {
    render(<AuthFrame>Log ind</AuthFrame>);
    const main = screen.getByRole("main");
    expect(main).toHaveAttribute("id", "main");
    expect(main).toHaveAttribute("tabindex", "-1");
  });
});

// ── F-nav: every rendered nav href maps to an existing panel page ────────────

const PANEL_DIR = join(process.cwd(), "src/app/admin/(panel)");

/** URL path of every `page.tsx` under `src/app/admin/(panel)`, route groups stripped. */
function panelRoutes(dir = PANEL_DIR, segments: string[] = []): string[] {
  const routes: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name === "page.tsx") {
      routes.push(["/admin", ...segments].join("/"));
    } else if (entry.isDirectory()) {
      const isGroup = entry.name.startsWith("(") && entry.name.endsWith(")");
      routes.push(...panelRoutes(join(dir, entry.name), isGroup ? segments : [...segments, entry.name]));
    }
  }
  return routes;
}

describe("F-nav: every AdminShell nav link points to an existing panel route", () => {
  it("F-nav: each rendered nav href resolves to a src/app/admin/(panel)/**/page.tsx", async () => {
    render(await AdminShell({ user: USER, children: null }));
    const nav = screen.getByRole("navigation", { name: "Administration" });
    const hrefs = within(nav)
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));

    expect(hrefs).toContain(ADMIN_HOME_PATH);
    const routes = panelRoutes();
    expect(hrefs.filter((href) => href === null || !routes.includes(href))).toEqual([]);
  });
});
