// @vitest-environment jsdom
/**
 * Unit tests: src/components/monitor/MonitorBrand.tsx
 * Journey: monitor-chrome  MCH-AC1, MCH-AC3, MCH-AC4
 *
 * Verifies: single accessible link "Alnyron", href = prop value, no "Monitor"
 * suffix text, no [&_img]:w-8 small-mark override in the DOM (the lockup
 * uses the full-size Logo wordmark identical to SiteHeader).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

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

import MonitorBrand from "@/components/monitor/MonitorBrand";

afterEach(cleanup);

// ── MCH-AC1 / MCH-AC3 / MCH-AC4: MonitorBrand is a single link ───────────────

describe("MCH-AC1/AC3/AC4: MonitorBrand renders an accessible ALNYRON link", () => {
  it("MCH-AC1a: renders a single link with accessible name 'Alnyron'", () => {
    render(<MonitorBrand href="/monitor/dashboard" />);
    // Logo wordmark renders <span role="img" aria-label="Alnyron"> — the link's
    // accessible name is exactly "Alnyron", with no "Monitor" suffix.
    const link = screen.getByRole("link", { name: "Alnyron" });
    expect(link).toBeInTheDocument();
  });

  it("MCH-AC1b: link href matches the required href prop", () => {
    render(<MonitorBrand href="https://alnyron.dk" />);
    const link = screen.getByRole("link", { name: "Alnyron" });
    expect(link).toHaveAttribute("href", "https://alnyron.dk");
  });

  it("MCH-AC1c: passes the given href through unchanged", () => {
    render(<MonitorBrand href="http://localhost:3000" />);
    const link = screen.getByRole("link", { name: "Alnyron" });
    expect(link).toHaveAttribute("href", "http://localhost:3000");
  });

  it("MCH-AC1d: no 'Monitor' text rendered as a brand suffix", () => {
    const { container } = render(<MonitorBrand href="/" />);
    // The word "Monitor" must not appear as visible text in the brand element.
    // container.textContent reads the DOM text nodes, not aria — the right check.
    expect(container.textContent).not.toContain("Monitor");
  });

  it("MCH-AC1e: no tiny-mark override — no element carries a class with 'w-8'", () => {
    const { container } = render(<MonitorBrand href="/" />);
    // The lockup is the full-size Logo wordmark (as in SiteHeader): no
    // "[&_img]:w-8" small-mark override, so no class containing "w-8".
    const smallMark = container.querySelector("[class*='w-8']");
    expect(smallMark).toBeNull();
  });

  it("MCH-AC1f: exactly one link is rendered (no duplicate Alnyron links)", () => {
    render(<MonitorBrand href="/" />);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
  });
});
