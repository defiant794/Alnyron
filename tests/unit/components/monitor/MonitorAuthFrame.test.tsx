// @vitest-environment jsdom
/**
 * Unit tests: src/components/monitor/MonitorAuthFrame.tsx
 * Journey: monitor-chrome  MCH-AC4
 *
 * Verifies: contains ALNYRON lockup linked to the frontpage
 * (MONITOR_SITE_HOME_HREF, `/`); no footer landmark
 * (contentinfo) rendered by the auth card.
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

import MonitorAuthFrame from "@/components/monitor/MonitorAuthFrame";
import { MONITOR_SITE_HOME_HREF } from "@/config/monitor";

afterEach(cleanup);

describe("MCH-AC4: MonitorAuthFrame renders ALNYRON lockup → / with no footer", () => {
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

  it("MCH-AC4b: the ALNYRON link href is MONITOR_SITE_HOME_HREF ('/')", () => {
    render(
      <MonitorAuthFrame>
        <p>child</p>
      </MonitorAuthFrame>,
    );
    const link = screen.getByRole("link", { name: "Alnyron" });
    expect(link).toHaveAttribute("href", MONITOR_SITE_HOME_HREF);
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
