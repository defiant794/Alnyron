// @vitest-environment jsdom
/**
 * Unit tests: /monitor/(panel)/dashboard/page.tsx
 * Journey: monitor-web-area  MON-AC23, MON-AC24, MON-AC25, MON-AC26
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockRequireMonitor, mockListMonitors, mockGetMonitorUsage } = vi.hoisted(() => ({
  mockRequireMonitor: vi.fn(),
  mockListMonitors: vi.fn(),
  mockGetMonitorUsage: vi.fn(),
}));

// Real next-intl formatting (the shared helper returns plural syntax as is), so
// the usage pill is asserted as the full text a user reads. A missing key throws.
// The factory is hoisted above the static imports, so it loads its modules itself.
vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const { loadMessages } = await import("@/i18n/messages");
  return {
    getTranslations: vi.fn(async ({ locale, namespace }: { locale: "da"; namespace: "Monitor" | "Monitor.dashboard" }) =>
      createTranslator({
        locale,
        messages: loadMessages(locale),
        namespace,
        onError: (error) => {
          throw error;
        },
      }),
    ),
  };
});
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  usePathname: () => "/monitor/dashboard",
}));
vi.mock("@/services/auth/require-role", () => ({ requireMonitor: mockRequireMonitor }));
vi.mock("@/services/monitor/monitors", () => ({
  listMonitors: mockListMonitors,
  getMonitorUsage: mockGetMonitorUsage,
}));
vi.mock("@/app/monitor/(auth)/actions", () => ({ signOut: vi.fn() }));
// MonitorShell links the footer's privacy page on the main site (NEXT_PUBLIC_SITE_URL).
vi.mock("@/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/config/env")>()),
  parseSiteEnv: () => ({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" }),
}));
vi.mock("@/components/site/SiteFooter", () => ({
  default: ({ locale }: { locale: string }) => (
    <footer data-testid="site-footer" data-locale={locale} />
  ),
}));
vi.mock("@/components/monitor/MonitorMainNav", () => ({
  default: () => <nav aria-label="Hovednavigation" data-testid="monitor-main-nav" />,
}));
// SiteMenu (the shell's small-screen "Menu" disclosure) reads the App Router's
// current route, which a page test has no context for; render its contents.
vi.mock("@/components/site/SiteMenu", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import DashboardPage from "@/app/monitor/(panel)/dashboard/page";
import { loadMessages } from "@/i18n/messages";
import { MONITOR_NEW_PATH } from "@/config/monitor";

const { Monitor } = loadMessages("da");

afterEach(cleanup);

beforeEach(() => {
  mockRequireMonitor.mockResolvedValue({ userId: "u1", email: "mon@test.local", role: "monitor_user" });
});

describe("MON-AC26: dashboard is gated by requireMonitor", () => {
  it("MON-AC26a: calls requireMonitor on render", async () => {
    mockListMonitors.mockResolvedValue([]);
    mockGetMonitorUsage.mockResolvedValue({ count: 0, limit: 5 });
    render(await DashboardPage());
    expect(mockRequireMonitor).toHaveBeenCalledTimes(1);
  });

  it("MON-AC26b: requireMonitor redirect propagates (page never renders)", async () => {
    mockRequireMonitor.mockRejectedValue(new Error("NEXT_REDIRECT:/monitor/no-access"));
    await expect(DashboardPage()).rejects.toThrow("NEXT_REDIRECT:/monitor/no-access");
  });
});

describe("MON-AC24: empty state when no monitors", () => {
  beforeEach(() => {
    mockListMonitors.mockResolvedValue([]);
    mockGetMonitorUsage.mockResolvedValue({ count: 0, limit: 5 });
  });

  it("MON-AC24a: shows teaching empty state", async () => {
    render(await DashboardPage());
    expect(screen.getByText(Monitor.dashboard.emptyTitle)).toBeInTheDocument();
  });

  it("MON-AC24b: empty state has a URL input field for quick-add", async () => {
    render(await DashboardPage());
    const input = screen.getByRole("textbox");
    expect(input).toBeInTheDocument();
  });

  it("MON-AC24c: add-monitor button links to /monitor/monitors/new", async () => {
    render(await DashboardPage());
    const link = screen.getByRole("link", { name: Monitor.dashboard.addButton });
    expect(link).toHaveAttribute("href", expect.stringContaining(MONITOR_NEW_PATH));
  });
});

describe("MON-AC23: monitors list with usage pill", () => {
  // listMonitors() rows carry the detection time of each monitor's latest change ("last change").
  const monitors = [
    { id: "aaa", url: "https://example.com/", label: "Site A", status: "active", interval_minutes: 1440, last_checked_at: null, consecutive_errors: 0, last_change_at: null },
    { id: "bbb", url: "https://other.com/", label: null, status: "paused", interval_minutes: 360, last_checked_at: null, consecutive_errors: 0, last_change_at: null },
  ];

  beforeEach(() => {
    mockListMonitors.mockResolvedValue(monitors);
    mockGetMonitorUsage.mockResolvedValue({ count: 2, limit: 5 });
  });

  it("MON-AC23d: renders a row for each monitor", async () => {
    render(await DashboardPage());
    // At least some identifying text from each monitor appears
    expect(document.body.textContent).toContain("example.com");
    expect(document.body.textContent).toContain("other.com");
  });

  it("MON-AC23e: usage pill reads '2 / 5 overvågninger brugt'", async () => {
    render(await DashboardPage());
    expect(screen.getByText("2 / 5 overvågninger brugt")).toBeInTheDocument();
  });

  it("MON-AC23f: a monitor's latest change shows as 'Ændret …', one without changes as 'Ingen ændringer'", async () => {
    const changedAt = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
    mockListMonitors.mockResolvedValue([{ ...monitors[0], last_change_at: changedAt }, monitors[1]]);
    render(await DashboardPage());
    const rows = within(screen.getByRole("list", { name: Monitor.dashboard.listLabel })).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    const [changedRow, unchangedRow] = rows;
    expect(changedRow).toHaveTextContent(/Ændret /);
    expect(unchangedRow).toHaveTextContent(Monitor.dashboard.noChanges);
    expect(unchangedRow).not.toHaveTextContent(/Ændret /);
  });
});

describe("MON-AC25: owner unlimited usage pill", () => {
  beforeEach(() => {
    mockRequireMonitor.mockResolvedValue({ userId: "u1", email: "owner@test.local", role: "owner" });
    mockListMonitors.mockResolvedValue([]);
  });

  it("MON-AC25b: NULL limit → '3 overvågninger' (no fraction)", async () => {
    mockGetMonitorUsage.mockResolvedValue({ count: 3, limit: null });
    render(await DashboardPage());
    expect(screen.getByText("3 overvågninger")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/3\s*\/\s*\d/);
  });

  it("MON-AC25c: NULL limit, one monitor → singular '1 overvågning'", async () => {
    mockGetMonitorUsage.mockResolvedValue({ count: 1, limit: null });
    render(await DashboardPage());
    expect(screen.getByText("1 overvågning")).toBeInTheDocument();
  });
});
