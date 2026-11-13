// @vitest-environment jsdom
/**
 * Unit tests: src/components/monitor/MonitorShell.tsx
 * Journey: monitor-chrome  MCH-AC3; monitor-ship-routing  SHIP-AC8c
 * Journey: monitor-panel-nav  MPN-AC1a, MPN-AC1b, MPN-AC1c, MPN-AC2, MPN-AC2d, MPN-AC2e, MPN-AC3a, MPN-AC3b, MPN-AC4a, MPN-AC4b, MPN-AC4c
 * Journey: monitor-i18n  AC-I18N-MON-22 (supersedes MPN-AC3c "no language switcher")
 * Journey: payments-slice1b-billing  PAY1B-AC33, PAY1B-AC34 (+ design review D-4: the three tabs fit on one row from 320px, wrapping instead of scrolling)
 *
 * Verifies: brand link accessible name is "Alnyron" (no "Monitor" suffix),
 * brand link href is the MAIN-SITE ORIGIN (not MONITOR_DASHBOARD_PATH — MPN-AC1a),
 * SiteFooter is rendered after <main> with locale="da",
 * SiteFooter gets the main site's origin (`siteOrigin`, from NEXT_PUBLIC_SITE_URL),
 * the main-site nav landmark is present and distinct from the panel nav (MPN-AC2d, MPN-AC2e),
 * the header is two rows (MPN-AC2): the site-style top bar (brand left, main-site
 * nav right — MPN-AC4b) and, under a divider, the slim Monitor app bar (panel nav
 * left, account right). The main-site nav sits in the small-screen "Menu"
 * disclosure (MPN-AC4a) opening under the top bar, before the app bar's panel nav
 * and account in focus order (MPN-AC4c),
 * and the panel's own Dashboard/Settings nav + account/Log ud remain intact (MPN-AC3a, MPN-AC3b),
 * and the DA | EN switcher follows the main-site nav in the top bar's menu (AC-I18N-MON-22).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
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
    <MonitorShell email="test@test.local" section="dashboard" locale="da">
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
  /** The top bar: the menu panel is `absolute top-full`, so it opens under its nearest positioned (`relative`) ancestor. */
  function topBar() {
    return menuPanel().panel?.parentElement?.closest<HTMLElement>(".relative") ?? null;
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

  it("MPN-AC4c: focus order is brand, toggle, its panel, then the app bar's panel nav and Log ud", () => {
    renderShell();
    const { toggle, panel } = menuPanel();
    const brand = screen.getByRole("link", { name: "Alnyron" });
    const dashboard = screen.getByRole("link", { name: "Overvågninger" });
    const signOut = screen.getByRole("button", { name: "Log ud" });
    expect(follows(brand, toggle)).toBe(true);
    expect(follows(toggle, panel)).toBe(true);
    expect(follows(panel, dashboard)).toBe(true);
    expect(follows(dashboard, signOut)).toBe(true);
  });

  it("MPN-AC2/MPN-AC4b: the menu opens under the site-style top bar, which holds the brand (left) and the main-site nav (right) only", () => {
    renderShell();
    const bar = topBar();
    // Row 1 of the header, and the menu's positioned container (so the open panel spans the bar).
    expect(screen.getByRole("banner").firstElementChild).toBe(bar);
    expect(bar?.firstElementChild).toContainElement(screen.getByRole("link", { name: "Alnyron" }));
    expect(bar?.lastElementChild).toContainElement(screen.getByRole("navigation", { name: "Hovednavigation" }));
    expect(bar).not.toContainElement(screen.getByRole("navigation", { name: "Monitor" }));
    expect(bar).not.toContainElement(screen.getByRole("link", { name: "Overvågninger" }));
    expect(bar).not.toContainElement(screen.getByRole("button", { name: "Log ud" }));
  });

  it("MPN-AC2: the slim app bar under the divider holds the panel nav (left) and the account (right), not the brand or the main-site nav", () => {
    renderShell();
    const appBar = topBar()?.nextElementSibling ?? null;
    // Row 2 of the header, right under the top bar.
    expect(appBar?.parentElement).toBe(screen.getByRole("banner"));
    // The divider between the top bar and the app bar.
    expect(appBar).toHaveClass("border-t");
    const row = appBar?.firstElementChild ?? null;
    const panelNav = screen.getByRole("navigation", { name: "Monitor" });
    expect(row?.firstElementChild).toBe(panelNav);
    expect(panelNav).toContainElement(screen.getByRole("link", { name: "Overvågninger" }));
    expect(panelNav).toContainElement(screen.getByRole("link", { name: "Indstillinger" }));
    const account = screen.getByRole("region", { name: "Konto" });
    expect(row?.lastElementChild).toBe(account);
    expect(account).toContainElement(screen.getByText("test@test.local"));
    expect(account).toContainElement(screen.getByRole("button", { name: "Log ud" }));
    expect(appBar).not.toContainElement(screen.getByRole("link", { name: "Alnyron" }));
    expect(appBar).not.toContainElement(screen.getByRole("navigation", { name: "Hovednavigation" }));
    expect(appBar).not.toContainElement(screen.getByRole("button", { name: "Menu" }));
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

// MPN-AC3c ("no language switcher") is superseded by monitor-i18n AC-I18N-MON-22:
// the panel is bilingual, and its DA | EN switcher sits in the site-style top bar.
describe("AC-I18N-MON-22: MonitorShell — the DA | EN switcher follows the main-site nav", () => {
  it("AC-I18N-MON-22f: a nav landmark labelled 'Sprog' marks DA as the current language", () => {
    renderShell();
    const switcher = screen.getByRole("navigation", { name: "Sprog" });
    expect(within(switcher).getByText("DA", { selector: "[aria-current]" })).toBeInTheDocument();
  });

  it("AC-I18N-MON-22g: it sits after the main-site nav inside the small-screen menu panel", () => {
    renderShell();
    const toggle = screen.getByRole("button", { name: "Menu" });
    const panel = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    const mainNav = screen.getByRole("navigation", { name: "Hovednavigation" });
    const switcher = screen.getByRole("navigation", { name: "Sprog" });
    expect(panel).toContainElement(switcher);
    expect(mainNav.compareDocumentPosition(switcher) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("AC-I18N-MON-22h: the page has exactly three nav landmarks (main-site nav, language, panel nav)", () => {
    renderShell();
    expect(screen.getAllByRole("navigation")).toHaveLength(3);
  });
});

// ── PAY1B-AC33/34: 3 panel-nav tabs; Abonnement aria-current on billing ──────

describe("PAY1B-AC33: MonitorShell panel nav has 3 tabs in order: Overvågninger, Indstillinger, Abonnement", () => {
  it("PAY1B-AC33a: 'Abonnement' link is present in the panel nav", () => {
    renderShell();
    const panelNav = screen.getByRole("navigation", { name: "Monitor" });
    expect(panelNav).toContainElement(screen.getByRole("link", { name: "Abonnement" }));
  });

  it("PAY1B-AC33b: panel nav has exactly 3 links: Overvågninger, Indstillinger, Abonnement", () => {
    renderShell();
    const panelNav = screen.getByRole("navigation", { name: "Monitor" });
    const links = within(panelNav).getAllByRole("link");
    const names = links.map((l) => l.textContent?.trim());
    expect(names).toEqual(["Overvågninger", "Indstillinger", "Abonnement"]);
  });
});

describe("PAY1B-AC33: MonitorShell Abonnement tab links to MONITOR_BILLING_PATH and has EN label", () => {
  it("PAY1B-AC33d: Abonnement link href is '/monitor/billing' (MONITOR_BILLING_PATH)", () => {
    renderShell();
    const link = screen.getByRole("link", { name: "Abonnement" });
    expect(link).toHaveAttribute("href", "/monitor/billing");
  });

  it("PAY1B-AC33e: EN locale renders 'Subscription' tab label", () => {
    render(
      <MonitorShell email="test@test.local" section="dashboard" locale="en">
        <p>page</p>
      </MonitorShell>,
    );
    const panelNav = screen.getByRole("navigation", { name: "Monitor" });
    const links = within(panelNav).getAllByRole("link");
    const names = links.map((l) => l.textContent?.trim());
    expect(names[2]).toBe("Subscription");
  });
});

describe("PAY1B-AC34: MonitorShell billing section — Abonnement tab has aria-current='page'", () => {
  it("PAY1B-AC34a: aria-current='page' on Abonnement link when section='billing'", () => {
    render(
      <MonitorShell email="test@test.local" section="billing" locale="da">
        <p>billing page</p>
      </MonitorShell>,
    );
    const link = screen.getByRole("link", { name: "Abonnement" });
    expect(link).toHaveAttribute("aria-current", "page");
  });

  it("PAY1B-AC34b: Abonnement link has no aria-current on dashboard section", () => {
    renderShell(); // section="dashboard" (default renderShell)
    const link = screen.getByRole("link", { name: "Abonnement" });
    expect(link).not.toHaveAttribute("aria-current");
  });

  it("PAY1B-AC34c: only Abonnement has aria-current when section='billing'; others do not", () => {
    render(
      <MonitorShell email="test@test.local" section="billing" locale="da">
        <p>billing page</p>
      </MonitorShell>,
    );
    const panelNav = screen.getByRole("navigation", { name: "Monitor" });
    const links = within(panelNav).getAllByRole("link");
    const currentLinks = links.filter((l) => l.getAttribute("aria-current") === "page");
    expect(currentLinks).toHaveLength(1);
    expect(currentLinks[0]?.textContent?.trim()).toBe("Abonnement");
  });
});

// ── PAY1B-AC51 (design review D-4): the three app-bar tabs fit on one row ────
// Measured in Chromium (Inter): the Danish labels at 14px span 262.4px in the
// widest case, Indstillinger current: Overvågninger 98.2, Indstillinger 79.6
// (semibold), Abonnement 84.6. Between the bar's 24px gutters with 12px gaps
// the row needs 334.4px (fits from 360px, even beside a 15px classic
// scrollbar); below 360px 8px gaps and a 12px bar inset need 302.4px, one line
// at 320px as measured in Chromium with a 15px scrollbar (305px of layout).
// With a 17px scrollbar or other text rendering the row may wrap, a harmless
// fallback (larger text wraps it too); nothing scrolls sideways, so no tab is
// ever clipped. These pin the classes; E2E-PAY1B-14 checks the real layout.

describe("PAY1B-AC51: the app-bar tabs fit on one row on small screens (design review D-4)", () => {
  const panelNav = () => screen.getByRole("navigation", { name: "Monitor" });
  const tabList = () => panelNav().querySelector("ul");
  /** The app bar row holding the panel nav and the account. */
  const appBarRow = () => panelNav().parentElement;
  /** Utilities (variant prefix dropped) that would make the list a clipping scroll row. */
  const SCROLL_ROW = /^(?:overflow|scroll-|flex-nowrap|-?m[xy]?-|p[xy]?-)/;

  it("PAY1B-AC51a: below sm the tab list is a wrapping row of 14px labels, never a sideways-scrolling one", () => {
    renderShell();
    const list = tabList();
    expect(list).toHaveClass("flex", "flex-wrap", "items-center", "gap-x-3", "text-small");
    const scrollRow = [...(list?.classList ?? [])].filter((c) => SCROLL_ROW.test(c.split(":").at(-1) ?? c));
    expect(scrollRow).toEqual([]);
  });

  it("PAY1B-AC51b: below 360px the gaps drop to 8px and the bar's inset to 12px; below sm the links have no side padding", () => {
    renderShell();
    expect(tabList()).toHaveClass("max-[360px]:gap-x-2");
    expect(appBarRow()).toHaveClass("px-6", "max-[360px]:px-3");
    for (const link of within(panelNav()).getAllByRole("link")) {
      expect(link).toHaveClass("sm:px-1");
      expect([...link.classList].filter((c) => /^p[xlr]?-/.test(c))).toEqual([]);
    }
  });

  it("PAY1B-AC51c: from sm up the tab list is the unchanged wrapping row at body size, 16px gaps and 4px link padding", () => {
    renderShell();
    expect(tabList()).toHaveClass("flex-wrap", "sm:gap-x-4", "sm:text-body");
    // The 12px inset ends below 360px: from sm up the bar keeps its 24px gutter.
    expect([...(appBarRow()?.classList ?? [])].filter((c) => c.startsWith("sm:"))).toEqual([]);
    for (const link of within(panelNav()).getAllByRole("link")) {
      expect(link).toHaveClass("sm:px-1");
    }
  });

  it("PAY1B-AC51d: every tab keeps its 44px target, the global focus ring, and the current tab its accent underline", () => {
    render(
      <MonitorShell email="test@test.local" section="billing" locale="da">
        <p>billing page</p>
      </MonitorShell>,
    );
    for (const link of within(panelNav()).getAllByRole("link")) {
      expect(link).toHaveClass("inline-flex", "min-h-11", "items-center");
      expect([...link.classList].filter((c) => c.includes("outline"))).toEqual([]);
    }
    expect(screen.getByRole("link", { name: "Abonnement" })).toHaveClass(
      "aria-[current]:underline",
      "aria-[current]:decoration-accent",
      "aria-[current]:decoration-2",
    );
  });
});

