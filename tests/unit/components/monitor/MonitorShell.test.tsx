// @vitest-environment jsdom
/**
 * Unit tests: src/components/monitor/MonitorShell.tsx
 * Journey: monitor-chrome  MCH-AC3; monitor-ship-routing  SHIP-AC8c
 * Journey: monitor-panel-nav  MPN-AC1a, MPN-AC1b, MPN-AC1c, MPN-AC2d, MPN-AC2e, MPN-AC3a, MPN-AC3b, MPN-AC3c, MPN-AC4a, MPN-AC4c
 *
 * Verifies: brand link accessible name is "Alnyron" (no "Monitor" suffix),
 * brand link href is the MAIN-SITE ORIGIN (not MONITOR_DASHBOARD_PATH — MPN-AC1a),
 * SiteFooter is rendered after <main> with locale="da",
 * SiteFooter gets the main site's origin (`siteOrigin`, from NEXT_PUBLIC_SITE_URL),
 * the main-site nav landmark is present and distinct from the panel nav (MPN-AC2d, MPN-AC2e),
 * the main-site nav sits in the small-screen "Menu" disclosure (MPN-AC4a), apart from the brand,
 * panel nav and account, and ahead of the panel nav in focus order (MPN-AC4c),
 * and the panel's own Dashboard/Settings nav + account/Log ud remain intact (MPN-AC3a, MPN-AC3b, MPN-AC3c).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockParseSiteEnv } = vi.hoisted(() => ({
  mockParseSiteEnv: vi.fn(() => ({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" })),
}));

// MonitorShell links the footer's privacy page on the main site (NEXT_PUBLIC_SITE_URL).
vi.mock("@/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/config/env")>()),
  parseSiteEnv: mockParseSiteEnv,
}));
// SiteFooter is an async server component; the shell test stubs it and records its props.
vi.mock("@/components/site/SiteFooter", () => ({
  default: ({ locale, siteOrigin }: { locale: string; siteOrigin?: string }) => (
    <footer data-testid="site-footer" data-locale={locale} data-site-origin={siteOrigin} />
  ),
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
    "aria-current": ariaCurrent,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
    "aria-current"?: React.AriaAttributes["aria-current"];
  }) => (
    <a href={href} className={className ?? ""} aria-current={ariaCurrent}>
      {children}
    </a>
  ),
}));
vi.mock("@/components/ui/SubmitButton", () => ({
  default: ({ children }: { children: React.ReactNode }) => <button type="submit">{children}</button>,
}));
vi.mock("@/app/monitor/(auth)/actions", () => ({ signOut: vi.fn() }));
// MonitorMainNav is an async server component that fetches getNavItems; stub it.
vi.mock("@/components/monitor/MonitorMainNav", () => ({
  default: () => (
    <nav aria-label="Hovednavigation" data-testid="monitor-main-nav">
      <a href="http://localhost:3000/">Forside</a>
    </nav>
  ),
}));
// SiteMenu (the small-screen "Menu" disclosure) reads the App Router's current
// route, which jsdom has no context for; a fixed panel path stands in.
vi.mock("@/i18n/current-route", () => ({ useCurrentPath: () => "/dashboard" }));

import MonitorShell from "@/components/monitor/MonitorShell";

afterEach(cleanup);

beforeEach(() => {
  mockParseSiteEnv.mockReturnValue({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" });
});

function renderShell() {
  return render(
    <MonitorShell email="test@test.local" section="dashboard">
      <p>page content</p>
    </MonitorShell>,
  );
}

// ── MPN-AC1: brand link now points to the main-site origin ───────────────────

describe("MPN-AC1: MonitorShell header has ALNYRON lockup linked to main-site origin", () => {
  it("MPN-AC1a: renders a link with accessible name 'Alnyron'", () => {
    renderShell();
    const link = screen.getByRole("link", { name: "Alnyron" });
    expect(link).toBeInTheDocument();
  });

  it("MPN-AC1a: brand link href is the main-site origin (http://localhost:3000), NOT MONITOR_DASHBOARD_PATH", () => {
    renderShell();
    const link = screen.getByRole("link", { name: "Alnyron" });
    expect(link).toHaveAttribute("href", "http://localhost:3000");
  });

  it("MPN-AC1b: brand link href uses exact origin from NEXT_PUBLIC_SITE_URL (https://alnyron.dk/ → https://alnyron.dk)", () => {
    mockParseSiteEnv.mockReturnValue({ NEXT_PUBLIC_SITE_URL: "https://alnyron.dk/" });
    renderShell();
    const link = screen.getByRole("link", { name: "Alnyron" });
    expect(link).toHaveAttribute("href", "https://alnyron.dk");
  });

  it("MPN-AC1c: no 'Monitor' text in the brand element", () => {
    renderShell();
    const link = screen.getByRole("link", { name: "Alnyron" });
    expect(link.textContent?.trim()).not.toMatch(/Monitor/);
  });
});

describe("MCH-AC3: MonitorShell renders SiteFooter after main with locale='da'", () => {
  it("MCH-AC3d: renders exactly one contentinfo landmark (site-footer)", () => {
    renderShell();
    expect(screen.getAllByRole("contentinfo")).toHaveLength(1);
  });

  it("MCH-AC3e: footer data-locale is 'da'", () => {
    renderShell();
    expect(screen.getByTestId("site-footer")).toHaveAttribute("data-locale", "da");
  });

  it("MCH-AC3f: footer appears after the main landmark in DOM order", () => {
    renderShell();
    const main = screen.getByRole("main");
    const footer = screen.getByTestId("site-footer");
    expect(main.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

// ── SHIP-AC8c: the footer's privacy link targets the main site ───────────────

describe("SHIP-AC8c: MonitorShell gives SiteFooter the main site's origin", () => {
  it("SHIP-AC8c-shell1: siteOrigin is exactly 'http://localhost:3000' (no path, no trailing slash)", () => {
    renderShell();
    expect(screen.getByTestId("site-footer")).toHaveAttribute("data-site-origin", "http://localhost:3000");
  });

  it("SHIP-AC8c-shell2: siteOrigin follows NEXT_PUBLIC_SITE_URL at render time (https://alnyron.dk/ → https://alnyron.dk)", () => {
    mockParseSiteEnv.mockReturnValue({ NEXT_PUBLIC_SITE_URL: "https://alnyron.dk/" });
    renderShell();
    expect(screen.getByTestId("site-footer")).toHaveAttribute("data-site-origin", "https://alnyron.dk");
  });
});

// ── MPN-AC2d/AC2e: main-site nav is present and distinct from panel nav ───────

describe("MPN-AC2d/AC2e: MonitorShell header includes main-site nav as a distinct landmark", () => {
  it("MPN-AC2d: a nav labelled 'Hovednavigation' (main-site nav) is present in the header", () => {
    renderShell();
    expect(screen.getByRole("navigation", { name: "Hovednavigation" })).toBeInTheDocument();
  });

  it("MPN-AC2e: the main-site nav and the panel nav are two separate nav landmarks with different labels", () => {
    renderShell();
    const navs = screen.getAllByRole("navigation");
    // At least two nav landmarks: main-site nav + panel Dashboard/Settings nav
    expect(navs.length).toBeGreaterThanOrEqual(2);
    const labels = navs.map((n) => n.getAttribute("aria-label")).filter(Boolean);
    // All labels must be unique — no two navs share the same label
    expect(new Set(labels).size).toBe(labels.length);
  });
});

// ── MPN-AC4: the main-site nav collapses behind "Menu" below 768px (DESIGN.md Nav) ──

describe("MPN-AC4: the main-site nav collapses behind a 'Menu' hamburger below 768px", () => {
  function menuPanel() {
    const toggle = screen.getByRole("button", { name: "Menu" });
    return { toggle, panel: document.getElementById(toggle.getAttribute("aria-controls") ?? "") };
  }
  /** Whether `b` comes after `a` in document (and so focus) order. */
  const follows = (a: Node | null, b: Node | null) =>
    a !== null && b !== null && Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  it("MPN-AC4a: a collapsed 'Menu' toggle controls the panel holding the main-site nav", () => {
    renderShell();
    const { toggle, panel } = menuPanel();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(panel).toContainElement(screen.getByRole("navigation", { name: "Hovednavigation" }));
  });

  it("MPN-AC4c: the brand, the panel nav and the account stay outside the collapsible panel", () => {
    renderShell();
    const { panel } = menuPanel();
    expect(panel).not.toContainElement(screen.getByRole("link", { name: "Alnyron" }));
    expect(panel).not.toContainElement(screen.getByRole("link", { name: "Overvågninger" }));
    expect(panel).not.toContainElement(screen.getByRole("button", { name: "Log ud" }));
  });

  it("MPN-AC4c: in focus order the toggle comes first, then its panel, then the panel nav and the account", () => {
    renderShell();
    const { toggle, panel } = menuPanel();
    const dashboard = screen.getByRole("link", { name: "Overvågninger" });
    expect(follows(toggle, panel)).toBe(true);
    expect(follows(panel, dashboard)).toBe(true);
    expect(follows(dashboard, screen.getByRole("button", { name: "Log ud" }))).toBe(true);
  });

  it("MPN-AC4c: the open panel drops down under the brand row, not under the whole wrapped bar", () => {
    renderShell();
    const { panel } = menuPanel();
    // The panel is `absolute top-full`: it opens under its nearest positioned (`relative`) ancestor.
    const container = panel?.parentElement?.closest(".relative") ?? null;
    expect(container).toContainElement(screen.getByRole("link", { name: "Alnyron" }));
    expect(container).not.toContainElement(screen.getByRole("link", { name: "Overvågninger" }));
  });
});

// ── MPN-AC3a/AC3b/AC3c: panel's own nav + account controls remain intact ─────

describe("MPN-AC3a: MonitorShell panel nav — Overvågninger and Indstillinger links still present", () => {
  it("MPN-AC3a-1: 'Overvågninger' link is present in the panel nav (t('shell.dashboard') = 'Overvågninger')", () => {
    renderShell();
    expect(screen.getByRole("link", { name: "Overvågninger" })).toBeInTheDocument();
  });

  it("MPN-AC3a-2: 'Indstillinger' link is present in the panel nav", () => {
    renderShell();
    expect(screen.getByRole("link", { name: "Indstillinger" })).toBeInTheDocument();
  });

  it("MPN-AC3a-3: Overvågninger link carries aria-current='page' when section='dashboard'", () => {
    renderShell();
    const dashLink = screen.getByRole("link", { name: "Overvågninger" });
    expect(dashLink).toHaveAttribute("aria-current", "page");
  });
});

describe("MPN-AC3b: MonitorShell account area — email and Log ud button still present", () => {
  it("MPN-AC3b-1: the signed-in email is visible in the shell", () => {
    renderShell();
    expect(screen.getByText("test@test.local")).toBeInTheDocument();
  });

  it("MPN-AC3b-2: a 'Log ud' submit button is present", () => {
    renderShell();
    expect(screen.getByRole("button", { name: "Log ud" })).toBeInTheDocument();
  });
});

describe("MPN-AC3c: MonitorShell — NO language switcher present", () => {
  it("MPN-AC3c: no nav landmark labelled 'Sprog' (or similar) is rendered", () => {
    renderShell();
    // No navigation whose accessible name suggests a language switcher
    expect(screen.queryByRole("navigation", { name: /sprog/i })).toBeNull();
  });

  it("MPN-AC3c: page contains at most two nav landmarks (panel nav + main-site nav)", () => {
    renderShell();
    // A language switcher would add a third nav; guard that it stays absent.
    const navs = screen.getAllByRole("navigation");
    expect(navs.length).toBeLessThanOrEqual(2);
  });
});

