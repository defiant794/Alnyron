// @vitest-environment jsdom
/**
 * Unit tests: src/components/monitor/MonitorShell.tsx
 * Journey: monitor-chrome  MCH-AC3
 *
 * Verifies: brand link accessible name is "Alnyron" (no "Monitor" suffix),
 * brand link href is MONITOR_DASHBOARD_PATH, and SiteFooter is rendered
 * after <main> with locale="da".
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// SiteFooter is an async server component; the shell test stubs it.
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
