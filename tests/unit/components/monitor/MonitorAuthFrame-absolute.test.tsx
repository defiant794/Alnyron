// @vitest-environment jsdom
/**
 * Unit tests: src/components/monitor/MonitorAuthFrame.tsx — absolute lockup href.
 * Journey: monitor-ship-routing  SHIP-AC8f
 *
 * Verifies:
 *   SHIP-AC8f: the ALNYRON lockup href is the absolute main-site URL
 *              (parseSiteEnv().NEXT_PUBLIC_SITE_URL) evaluated at render time,
 *              not the static relative '/' constant.
 */
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockParseSiteEnv } = vi.hoisted(() => ({
  mockParseSiteEnv: vi.fn(),
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

vi.mock("@/config/env", () => ({
  parseSiteEnv: mockParseSiteEnv,
}));

import MonitorAuthFrame from "@/components/monitor/MonitorAuthFrame";

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
});

// ── SHIP-AC8f: lockup href is absolute main-site URL ─────────────────────────

describe("MonitorAuthFrame — SHIP-AC8f: ALNYRON lockup href is absolute main-site URL", () => {
  it("SHIP-AC8f-1: href is 'http://localhost:3000' when NEXT_PUBLIC_SITE_URL=http://localhost:3000", () => {
    mockParseSiteEnv.mockReturnValue({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" });
    render(
      <MonitorAuthFrame>
        <p>child</p>
      </MonitorAuthFrame>,
    );
    const link = screen.getByRole("link", { name: /alnyron/i });
    expect(link).toHaveAttribute("href", "http://localhost:3000");
  });

  it("SHIP-AC8f-2: href is 'https://alnyron.dk' when NEXT_PUBLIC_SITE_URL=https://alnyron.dk", () => {
    mockParseSiteEnv.mockReturnValue({ NEXT_PUBLIC_SITE_URL: "https://alnyron.dk" });
    render(
      <MonitorAuthFrame>
        <p>child</p>
      </MonitorAuthFrame>,
    );
    const link = screen.getByRole("link", { name: /alnyron/i });
    expect(link).toHaveAttribute("href", "https://alnyron.dk");
  });

  it("SHIP-AC8f-3: href is NOT the static '/' constant", () => {
    mockParseSiteEnv.mockReturnValue({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" });
    render(
      <MonitorAuthFrame>
        <p>child</p>
      </MonitorAuthFrame>,
    );
    const link = screen.getByRole("link", { name: /alnyron/i });
    expect(link).not.toHaveAttribute("href", "/");
  });
});
