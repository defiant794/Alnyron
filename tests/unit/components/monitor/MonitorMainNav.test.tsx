// @vitest-environment jsdom
/**
 * Unit tests: src/components/monitor/MonitorMainNav.tsx
 * Journey: monitor-panel-nav  MPN-AC2a, MPN-AC2b, MPN-AC2c, MPN-AC2f
 *
 * Verifies:
 *   MPN-AC2a — renders a <nav> landmark with a distinct accessible label.
 *   MPN-AC2b — relative href items are absolutized to the main-site origin.
 *   MPN-AC2c — already-absolute href items are left unchanged.
 *   MPN-AC2f — every rendered link carries min-h-11 (44 px tap target).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { mockGetNavItems, mockParseSiteEnv } = vi.hoisted(() => ({
  mockGetNavItems: vi.fn(),
  mockParseSiteEnv: vi.fn(() => ({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" })),
}));

// Dynamic import required: vi.mock factories are hoisted by Vite above all static
// imports, so a static import of the helper would not yet exist at factory time.
vi.mock("next-intl/server", async () =>
  (await import("../../../helpers/next-intl-server")).nextIntlServerMock(),
);

vi.mock("@/services/content/nav", () => ({
  getNavItems: mockGetNavItems,
}));

vi.mock("@/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/config/env")>()),
  parseSiteEnv: mockParseSiteEnv,
}));

vi.mock("next/image", () => ({
  default: ({ alt, className }: { alt: string; className?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img alt={alt} className={className ?? ""} />
  ),
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className ?? ""}>
      {children}
    </a>
  ),
}));

import MonitorMainNav from "@/components/monitor/MonitorMainNav";

afterEach(cleanup);

beforeEach(() => {
  // Reset to localhost so a per-test override (MPN-AC2b-3) does not leak into later tests.
  mockParseSiteEnv.mockReturnValue({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" });
  mockGetNavItems.mockReset();
});

/** Minimal NavItem shape returned by getNavItems. */
const RELATIVE_ITEM = {
  key: "system-home",
  label: "Forside",
  href: "/",
  navOrder: 0,
  isHome: true,
};

const ABSOLUTE_ITEM = {
  key: "system-monitor",
  label: "Monitor",
  href: "https://monitor.alnyron.dk/",
  navOrder: 10,
  isHome: false,
};

const RELATIVE_PAGE_ITEM = {
  key: "page-contact",
  label: "Kontakt",
  href: "/kontakt",
  navOrder: 5,
  isHome: false,
};

// ── MPN-AC2a: nav landmark with distinct label ────────────────────────────────

describe("MPN-AC2a: MonitorMainNav renders a labelled nav landmark", () => {
  it("MPN-AC2a-1: renders a <nav> landmark", async () => {
    mockGetNavItems.mockResolvedValue([RELATIVE_ITEM]);
    render(await MonitorMainNav());
    expect(screen.getByRole("navigation")).toBeInTheDocument();
  });

  it("MPN-AC2a-2: the nav aria-label is 'Hovednavigation' (reused from Nav.label / SiteHeader)", async () => {
    mockGetNavItems.mockResolvedValue([RELATIVE_ITEM]);
    render(await MonitorMainNav());
    const nav = screen.getByRole("navigation");
    // Real label confirmed from implementation: Nav.label = "Hovednavigation".
    // Must differ from panel nav label "Monitor" (Monitor.shell.navLabel).
    expect(nav).toHaveAttribute("aria-label", "Hovednavigation");
  });
});

// ── locale pin: getNavItems must be called with "da" ─────────────────────────

describe("MPN-locale: MonitorMainNav fetches nav items in Danish", () => {
  it("MPN-locale-1: calls getNavItems with AUTH_LOCALE ('da')", async () => {
    mockGetNavItems.mockResolvedValue([RELATIVE_ITEM]);
    render(await MonitorMainNav());
    expect(mockGetNavItems).toHaveBeenCalledWith("da");
  });
});

// ── MPN-AC2b: relative hrefs are absolutized to siteOrigin ───────────────────

describe("MPN-AC2b: MonitorMainNav absolutizes relative hrefs to main-site origin", () => {
  it("MPN-AC2b-1: a relative '/' href becomes 'http://localhost:3000/'", async () => {
    mockGetNavItems.mockResolvedValue([RELATIVE_ITEM]);
    render(await MonitorMainNav());
    const nav = screen.getByRole("navigation");
    const link = within(nav).getByRole("link", { name: "Forside" });
    expect(link).toHaveAttribute("href", "http://localhost:3000/");
  });

  it("MPN-AC2b-2: a relative '/kontakt' href becomes 'http://localhost:3000/kontakt'", async () => {
    mockGetNavItems.mockResolvedValue([RELATIVE_PAGE_ITEM]);
    render(await MonitorMainNav());
    const nav = screen.getByRole("navigation");
    const link = within(nav).getByRole("link", { name: "Kontakt" });
    expect(link).toHaveAttribute("href", "http://localhost:3000/kontakt");
  });

  it("MPN-AC2b-3: absolutization follows NEXT_PUBLIC_SITE_URL at render time (https://alnyron.dk)", async () => {
    mockParseSiteEnv.mockReturnValue({ NEXT_PUBLIC_SITE_URL: "https://alnyron.dk" });
    mockGetNavItems.mockResolvedValue([RELATIVE_PAGE_ITEM]);
    render(await MonitorMainNav());
    const nav = screen.getByRole("navigation");
    const link = within(nav).getByRole("link", { name: "Kontakt" });
    expect(link).toHaveAttribute("href", "https://alnyron.dk/kontakt");
  });
});

// ── MPN-AC2c: already-absolute hrefs are left unchanged ──────────────────────

describe("MPN-AC2c: MonitorMainNav leaves already-absolute hrefs unchanged", () => {
  it("MPN-AC2c-1: https://monitor.alnyron.dk/ href is not re-joined to siteOrigin", async () => {
    mockParseSiteEnv.mockReturnValue({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" });
    mockGetNavItems.mockResolvedValue([ABSOLUTE_ITEM]);
    render(await MonitorMainNav());
    const nav = screen.getByRole("navigation");
    const link = within(nav).getByRole("link", { name: "Monitor" });
    // Must equal the original absolute href, not 'http://localhost:3000/https://monitor…'
    expect(link).toHaveAttribute("href", "https://monitor.alnyron.dk/");
  });

  it("MPN-AC2c-2: a mix of relative and absolute items both resolve correctly", async () => {
    mockParseSiteEnv.mockReturnValue({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" });
    mockGetNavItems.mockResolvedValue([RELATIVE_ITEM, ABSOLUTE_ITEM]);
    render(await MonitorMainNav());
    const nav = screen.getByRole("navigation");
    expect(within(nav).getByRole("link", { name: "Forside" })).toHaveAttribute(
      "href",
      "http://localhost:3000/",
    );
    expect(within(nav).getByRole("link", { name: "Monitor" })).toHaveAttribute(
      "href",
      "https://monitor.alnyron.dk/",
    );
  });
});

// ── MPN-AC2f: tap-target rule — every link has min-h-11 ──────────────────────

describe("MPN-AC2f: MonitorMainNav — every nav link has min-h-11 tap target class", () => {
  it("MPN-AC2f-1: each link in the nav carries a class containing 'min-h-11'", async () => {
    mockGetNavItems.mockResolvedValue([RELATIVE_ITEM, RELATIVE_PAGE_ITEM, ABSOLUTE_ITEM]);
    render(await MonitorMainNav());
    const nav = screen.getByRole("navigation");
    const links = within(nav).getAllByRole("link");
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.className).toMatch(/min-h-11/);
    }
  });
});
