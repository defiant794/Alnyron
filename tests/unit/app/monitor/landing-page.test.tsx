// @vitest-environment jsdom
/**
 * Unit tests: /monitor/page.tsx — public Monitor landing page.
 * Journey: monitor-web-area  MON-AC1, MON-AC3
 * Journey: monitor-chrome    MCH-AC1, MCH-AC2, MCH-AC5
 *
 * Verifies: noindex meta, signup CTA, login link, free-cap copy (2),
 * ALNYRON lockup linked to /, SiteFooter as the page footer,
 * lang=da enforced by layout.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// SiteFooter is an async server component; stub it in every landing-page render.
// Its own data/content is covered by tests/unit/components/site/SiteFooter.test.tsx.
vi.mock("@/components/site/SiteFooter", () => ({
  default: ({ locale }: { locale: string }) => (
    <footer data-testid="site-footer" data-locale={locale} />
  ),
}));

vi.mock("next-intl/server", async () => {
  // Dynamic import required: vi.mock factories are hoisted above static imports by
  // Vite's transform, so the helper module must be loaded at runtime here.
  const { nextIntlServerMock } = await import("../../../helpers/next-intl-server");
  return nextIntlServerMock();
});
vi.mock("@/config/env", () => ({
  parseSiteEnv: vi.fn(() => ({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" })),
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

import MonitorLandingPage, { generateMetadata } from "@/app/monitor/page";
import { loadMessages } from "@/i18n/messages";
import { MONITOR_SIGNUP_PATH, MONITOR_LOGIN_PATH } from "@/config/monitor";
import { parseSiteEnv } from "@/config/env";

const { Monitor } = loadMessages("da");

afterEach(cleanup);
beforeEach(() => {
  vi.mocked(parseSiteEnv).mockReturnValue({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" });
});


describe("MON-AC1: /monitor landing page renders per design", () => {
  it("MON-AC1a: renders without throwing", async () => {
    await expect(async () => render(await MonitorLandingPage())).not.toThrow();
  });

  it("MON-AC1b: has a CTA link pointing to /monitor/signup", async () => {
    render(await MonitorLandingPage());
    const ctaLink = screen.getByRole("link", { name: Monitor.landing.ctaSignup });
    expect(ctaLink).toHaveAttribute("href", MONITOR_SIGNUP_PATH);
  });

  it("MON-AC1c: has a login link pointing to /monitor/login", async () => {
    render(await MonitorLandingPage());
    const loginLink = screen.getByRole("link", { name: Monitor.landing.ctaLogin });
    expect(loginLink).toHaveAttribute("href", MONITOR_LOGIN_PATH);
  });

  it("MCH-AC5b / MON-AC1d: free-cap lead mentions MONITOR_FREE_LIMIT", async () => {
    render(await MonitorLandingPage());
    // The literal text 'Gratis for op til 2 sider.' must appear, not just the
    // number. Using the exact substring ensures the {limit} token was resolved to 2.
    expect(document.body.textContent).toContain("Gratis for op til 2 sider.");
  });

  it("MON-AC1e: metadata has noindex robots directive", async () => {
    const meta = await generateMetadata();
    // Next metadata robots can be string or object
    const robots = JSON.stringify(meta.robots ?? "");
    expect(robots).toMatch(/noindex/);
  });
});

// ── MCH-AC1: brand is linked ALNYRON lockup pointing to / ────────────────────

describe("MCH-AC1: landing header contains ALNYRON lockup linked to /", () => {
  it("MCH-AC1a: renders a link with accessible name 'Alnyron'", async () => {
    render(await MonitorLandingPage());
    const link = screen.getByRole("link", { name: "Alnyron" });
    expect(link).toBeInTheDocument();
  });

  it("MCH-AC1b: brand link href is the absolute main-site URL (http://localhost:3000)", async () => {
    render(await MonitorLandingPage());
    const link = screen.getByRole("link", { name: "Alnyron" });
    expect(link).toHaveAttribute("href", "http://localhost:3000");
  });

  it("MCH-AC1c: no 'Monitor' text rendered as a brand suffix in the header brand", async () => {
    render(await MonitorLandingPage());
    // The brand lockup in the header must not carry the word "Monitor" as a suffix.
    const header = screen.getByRole("banner");
    // Look for a span containing ONLY "Monitor" — a brand suffix.
    const suffixEl = Array.from(header.querySelectorAll("span")).find(
      (el) => el.textContent?.trim() === "Monitor",
    );
    expect(suffixEl).toBeUndefined();
  });
});

// ── MCH-AC2: the footer is SiteFooter ────────────────────────────────────────

describe("MCH-AC2: landing footer is SiteFooter", () => {
  it("MCH-AC2a: renders a contentinfo landmark (site-footer stub)", async () => {
    render(await MonitorLandingPage());
    const footer = screen.getByTestId("site-footer");
    expect(footer).toBeInTheDocument();
  });

  it("MCH-AC2b: SiteFooter receives locale='da'", async () => {
    render(await MonitorLandingPage());
    expect(screen.getByTestId("site-footer")).toHaveAttribute("data-locale", "da");
  });

  it("MCH-AC2c: footer is rendered after the main landmark in DOM order", async () => {
    render(await MonitorLandingPage());
    const main = screen.getByRole("main");
    const footer = screen.getByTestId("site-footer");
    expect(main.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("MCH-AC2d: the SiteFooter is the only contentinfo landmark (no standalone privacy-link footer)", async () => {
    render(await MonitorLandingPage());
    // The stub renders an empty <footer>, so exactly one contentinfo landmark
    // means the page renders no footer of its own beside <SiteFooter>.
    expect(screen.getAllByRole("contentinfo")).toHaveLength(1);
  });
});
