// @vitest-environment jsdom
/**
 * Unit tests: src/components/monitor/MonitorShell.tsx
 * Journey: monitor-chrome  MCH-AC3; monitor-ship-routing  SHIP-AC8c
 *
 * Verifies: brand link accessible name is "Alnyron" (no "Monitor" suffix),
 * brand link href is MONITOR_DASHBOARD_PATH, SiteFooter is rendered after
 * <main> with locale="da", and SiteFooter gets the main site's origin
 * (`siteOrigin`, from NEXT_PUBLIC_SITE_URL at render) so its privacy link is
 * absolute on the Monitor host (SiteFooter's own test pins the href it builds).
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
vi.mock("@/components/ui/SubmitButton", () => ({
  default: ({ children }: { children: React.ReactNode }) => <button type="submit">{children}</button>,
}));
vi.mock("@/app/monitor/(auth)/actions", () => ({ signOut: vi.fn() }));

import MonitorShell from "@/components/monitor/MonitorShell";
import { MONITOR_DASHBOARD_PATH } from "@/config/monitor";

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

// ── MCH-AC3: brand link ───────────────────────────────────────────────────────

describe("MCH-AC3: MonitorShell header has ALNYRON lockup linked to dashboard", () => {
  it("MCH-AC3a: renders a link with accessible name 'Alnyron'", () => {
    renderShell();
    const link = screen.getByRole("link", { name: "Alnyron" });
    expect(link).toBeInTheDocument();
  });

  it("MCH-AC3b: brand link href is MONITOR_DASHBOARD_PATH", () => {
    renderShell();
    const link = screen.getByRole("link", { name: "Alnyron" });
    expect(link).toHaveAttribute("href", MONITOR_DASHBOARD_PATH);
  });

  it("MCH-AC3c: no 'Monitor' text in the brand element", () => {
    renderShell();
    const link = screen.getByRole("link", { name: "Alnyron" });
    // The brand link itself must not contain the word "Monitor" as a suffix label
    expect(link.textContent?.trim()).not.toMatch(/Monitor/);
  });
});

// ── MCH-AC3: SiteFooter ───────────────────────────────────────────────────────

describe("MCH-AC3: MonitorShell renders SiteFooter after main with locale='da'", () => {
  it("MCH-AC3d: renders exactly one contentinfo landmark (site-footer)", () => {
    renderShell();
    // The stub renders an empty <footer> outside <main>: exactly one
    // contentinfo landmark means the shell adds no footer of its own.
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
    // DOCUMENT_POSITION_FOLLOWING (4): footer comes after main
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
