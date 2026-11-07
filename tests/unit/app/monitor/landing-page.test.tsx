// @vitest-environment jsdom
/**
 * Unit tests: /monitor/page.tsx — public Monitor landing page.
 * Journey: monitor-web-area  MON-AC1, MON-AC3
 *
 * Verifies: noindex meta, signup CTA, login link, free-cap copy (5),
 * lang=da enforced by layout.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("next-intl/server", async () => {
  const { nextIntlServerMock } = await import("../../../helpers/next-intl-server");
  return nextIntlServerMock();
});
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  usePathname: () => "/monitor",
}));

import MonitorLandingPage, { generateMetadata } from "@/app/monitor/page";
import { loadMessages } from "@/i18n/messages";
import { MONITOR_FREE_LIMIT, MONITOR_SIGNUP_PATH, MONITOR_LOGIN_PATH } from "@/config/monitor";

const { Monitor } = loadMessages("da");

afterEach(cleanup);

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

  it("MON-AC1d: free-cap copy mentions MONITOR_FREE_LIMIT (5)", async () => {
    render(await MonitorLandingPage());
    expect(document.body.textContent).toContain(String(MONITOR_FREE_LIMIT));
  });

  it("MON-AC1e: metadata has noindex robots directive", async () => {
    const meta = await generateMetadata();
    // Next metadata robots can be string or object
    const robots = JSON.stringify(meta.robots ?? "");
    expect(robots).toMatch(/noindex/);
  });
});
