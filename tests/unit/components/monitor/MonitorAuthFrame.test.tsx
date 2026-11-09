// @vitest-environment jsdom
/**
 * Unit tests: src/components/monitor/MonitorAuthFrame.tsx
 * Journey: monitor-chrome  MCH-AC4
 * Journey: monitor-ship-routing  SHIP-AC8f
 *
 * Verifies: contains ALNYRON lockup linked to the absolute main-site URL
 * (parseSiteEnv().NEXT_PUBLIC_SITE_URL, evaluated at render time);
 * no footer landmark (contentinfo) rendered by the auth card.
 */
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
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
const { mockParseSiteEnv } = vi.hoisted(() => ({
  mockParseSiteEnv: vi.fn(() => ({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" })),
}));
vi.mock("@/config/env", () => ({ parseSiteEnv: mockParseSiteEnv }));


import MonitorAuthFrame from "@/components/monitor/MonitorAuthFrame";

afterEach(cleanup);
beforeEach(() => {
  mockParseSiteEnv.mockReturnValue({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" });
});


describe("MCH-AC4: MonitorAuthFrame renders ALNYRON lockup → main-site URL with no footer", () => {
  it("MCH-AC4a: renders a link with accessible name 'Alnyron'", () => {
    render(
      <MonitorAuthFrame>
        <p>child</p>
      </MonitorAuthFrame>,
    );
    // MonitorAuthFrame wraps the Logo wordmark in a link to the frontpage.
    const link = screen.getByRole("link", { name: "Alnyron" });
    expect(link).toBeInTheDocument();
  });

  it("MCH-AC4b: the ALNYRON link href is the absolute main-site URL ('http://localhost:3000')", () => {
    render(
      <MonitorAuthFrame>
        <p>child</p>
      </MonitorAuthFrame>,
    );
    const link = screen.getByRole("link", { name: "Alnyron" });
    expect(link).toHaveAttribute("href", "http://localhost:3000");
  });

  it("MCH-AC4c: no contentinfo landmark (auth card has no footer)", () => {
    render(
      <MonitorAuthFrame>
        <p>child</p>
      </MonitorAuthFrame>,
    );
    expect(screen.queryByRole("contentinfo")).toBeNull();
  });

  it("MCH-AC4d: no 'Monitor' text rendered as a brand label", () => {
    render(
      <MonitorAuthFrame>
        <p>child</p>
      </MonitorAuthFrame>,
    );
    expect(screen.queryByText(/Monitor/)).toBeNull();
  });
});
