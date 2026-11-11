// @vitest-environment jsdom
/**
 * Unit tests: src/components/monitor/MonitorShell.tsx — the `locale` prop:
 * MonitorLocaleSwitcher in the top bar (with the page's path), the shell's own
 * copy in that language and the ALNYRON lockup to that language's frontpage.
 * Journey: monitor-i18n  AC-I18N-MON-22
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// ── vi.hoisted ─────────────────────────────────────────────────────────────────

const { mockParseSiteEnv } = vi.hoisted(() => ({
  mockParseSiteEnv: vi.fn(() => ({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" })),
}));

// ── Mocks ──────────────────────────────────────────────────────────────────────

import type * as EnvModule from "@/config/env";

vi.mock("@/config/env", async (importOriginal) => {
  // dynamic-import: importOriginal requires async factory per Vitest's API
  const actual = await importOriginal<typeof EnvModule>();
  return { ...actual, parseSiteEnv: mockParseSiteEnv };
});

vi.mock("@/components/site/SiteFooter", () => ({
  default: ({ locale }: { locale: string }) => (
    <footer data-testid="site-footer" data-locale={locale} />
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
  default: ({ children }: { children: React.ReactNode }) => (
    <button type="submit">{children}</button>
  ),
}));

vi.mock("@/app/monitor/(auth)/actions", () => ({ signOut: vi.fn() }));

vi.mock("@/components/monitor/MonitorMainNav", () => ({
  default: () => (
    <nav aria-label="Hovednavigation" data-testid="monitor-main-nav">
      <a href="http://localhost:3000/">Forside</a>
    </nav>
  ),
}));

// The switcher records the props MonitorShell hands it.
vi.mock("@/components/monitor/MonitorLocaleSwitcher", () => ({
  default: ({ locale, currentPath }: { locale: string; currentPath: string }) => (
    <div
      data-testid="locale-switcher"
      data-locale={locale}
      data-current-path={currentPath}
    />
  ),
}));

vi.mock("@/components/site/SiteMenu", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// ── Import ─────────────────────────────────────────────────────────────────────

import MonitorShell from "@/components/monitor/MonitorShell";
import { MONITOR_DASHBOARD_PATH, monitorDetailPath } from "@/config/monitor";
import { loadMessages } from "@/i18n/messages";

// ── Fixtures ───────────────────────────────────────────────────────────────────

afterEach(() => {
  cleanup();
  mockParseSiteEnv.mockReturnValue({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" });
});

function renderShell(locale: "da" | "en" = "da", currentPath?: string) {
  return render(
    <MonitorShell email="user@test.local" section="dashboard" locale={locale} currentPath={currentPath}>
      <main id="main">content</main>
    </MonitorShell>,
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("AC-I18N-MON-22: MonitorShell renders MonitorLocaleSwitcher", () => {
  it("AC-I18N-MON-22a: renders the locale switcher when locale='da'", () => {
    renderShell("da");
    expect(screen.getByTestId("locale-switcher")).toBeInTheDocument();
  });

  it("AC-I18N-MON-22b: renders the locale switcher when locale='en'", () => {
    renderShell("en");
    expect(screen.getByTestId("locale-switcher")).toBeInTheDocument();
  });

  it("AC-I18N-MON-22c: passes locale='en' through to MonitorLocaleSwitcher", () => {
    renderShell("en");
    expect(screen.getByTestId("locale-switcher")).toHaveAttribute("data-locale", "en");
  });

  it("AC-I18N-MON-22d: passes locale='da' through to MonitorLocaleSwitcher", () => {
    renderShell("da");
    expect(screen.getByTestId("locale-switcher")).toHaveAttribute("data-locale", "da");
  });

  it("AC-I18N-MON-22e: MonitorLocaleSwitcher is inside the site-style top bar (before panel nav links)", () => {
    renderShell("da");
    const switcher = screen.getByTestId("locale-switcher");
    // The panel nav (Dashboard / Settings) is in the slim app bar below the top bar.
    // The switcher must precede the panel nav links in document order.
    const dashboardLink = screen.getByRole("link", { name: /overvågninger|dashboard/i });
    // compareDocumentPosition bit 4 = DOCUMENT_POSITION_FOLLOWING
    // If dashboardLink follows the switcher, the switcher is higher in the DOM.
    expect(
      switcher.compareDocumentPosition(dashboardLink) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("AC-I18N-MON-22f: the switcher returns to the section's start page by default", () => {
    renderShell("en");
    expect(screen.getByTestId("locale-switcher")).toHaveAttribute("data-current-path", MONITOR_DASHBOARD_PATH);
  });

  it("AC-I18N-MON-22g: the switcher returns to the given currentPath (a page below the section)", () => {
    renderShell("en", monitorDetailPath("m1"));
    expect(screen.getByTestId("locale-switcher")).toHaveAttribute("data-current-path", monitorDetailPath("m1"));
  });
});

describe("MonitorShell copy follows locale", () => {
  it.each(["en", "da"] as const)(
    "%s: section links, panel nav label, account region and the sign-out button are in that language",
    (locale) => {
      const { Monitor, Auth } = loadMessages(locale);
      renderShell(locale);
      const panelNav = screen.getByRole("navigation", { name: Monitor.shell.navLabel });
      expect(panelNav).toContainElement(screen.getByRole("link", { name: Monitor.shell.dashboard }));
      expect(panelNav).toContainElement(screen.getByRole("link", { name: Monitor.shell.settings }));
      const account = screen.getByRole("region", { name: Monitor.shell.account });
      expect(account).toHaveTextContent("user@test.local");
      expect(account).toContainElement(screen.getByRole("button", { name: Auth.signOut }));
    },
  );

  it("en: the shell shows no Danish chrome copy", () => {
    const da = loadMessages("da");
    renderShell("en");
    expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
    expect(screen.queryByText(da.Auth.signOut)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: da.Monitor.shell.dashboard })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: da.Monitor.shell.settings })).not.toBeInTheDocument();
  });
});

describe("MonitorShell ALNYRON lockup links the main-site frontpage in locale", () => {
  it("en: the lockup links the English frontpage (origin + /en)", () => {
    renderShell("en");
    expect(screen.getByRole("link", { name: "Alnyron" })).toHaveAttribute("href", "http://localhost:3000/en");
  });

  it("da: the lockup links the Danish frontpage (the bare origin)", () => {
    renderShell("da");
    expect(screen.getByRole("link", { name: "Alnyron" })).toHaveAttribute("href", "http://localhost:3000");
  });

  it("en: the frontpage follows NEXT_PUBLIC_SITE_URL at render time (https://alnyron.dk/ → https://alnyron.dk/en)", () => {
    mockParseSiteEnv.mockReturnValue({ NEXT_PUBLIC_SITE_URL: "https://alnyron.dk/" });
    renderShell("en");
    expect(screen.getByRole("link", { name: "Alnyron" })).toHaveAttribute("href", "https://alnyron.dk/en");
  });
});
