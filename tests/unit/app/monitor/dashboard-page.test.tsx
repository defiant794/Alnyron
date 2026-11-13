// @vitest-environment jsdom
/**
 * Unit tests: /monitor/(panel)/dashboard/page.tsx
 * Journey: monitor-web-area  MON-AC23, MON-AC24, MON-AC25, MON-AC26
 * Journey: payments-slice1b-billing  PAY1B-AC29, PAY1B-AC30, PAY1B-AC31, PAY1B-AC46
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type * as NextNavigation from "next/navigation";
import type * as MonitorLocaleModule from "@/i18n/monitor-locale";

const { mockRequireMonitor, mockListMonitors, mockGetMonitorUsage, mockGetCurrentSubscription } = vi.hoisted(() => ({
  mockRequireMonitor: vi.fn(),
  mockListMonitors: vi.fn(),
  mockGetMonitorUsage: vi.fn(),
  mockGetCurrentSubscription: vi.fn(),
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
// Partial: the locale-aware frontpage link builds on next-intl's navigation, which needs the real module.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
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
vi.mock("@/services/payments/billing", () => ({
  getCurrentSubscription: mockGetCurrentSubscription,
}));
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

// The page reads the visitor's Monitor language from a cookie; there is no request here: Danish.
vi.mock("@/i18n/monitor-locale", async (importOriginal) => ({
  ...(await importOriginal<typeof MonitorLocaleModule>()),
  getMonitorLocale: vi.fn(async () => "da" as const),
}));

import DashboardPage from "@/app/monitor/(panel)/dashboard/page";
import { loadMessages } from "@/i18n/messages";
import { MONITOR_NEW_PATH } from "@/config/monitor";

const { Monitor } = loadMessages("da");

afterEach(cleanup);

beforeEach(() => {
  mockRequireMonitor.mockResolvedValue({ userId: "u1", email: "mon@test.local", role: "monitor_user" });
  mockGetCurrentSubscription.mockResolvedValue(null);
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

// ── PAY1B-AC29/30/31/46: dashboard billing links and upgradeNote removal ──────

describe("PAY1B-AC29: dashboard — upgradeLink to /monitor/billing when no subscription", () => {
  beforeEach(() => {
    mockListMonitors.mockResolvedValue([]);
    mockGetMonitorUsage.mockResolvedValue({ count: 1, limit: 5 });
  });

  it("PAY1B-AC29a: shows upgradeLink 'Opgradér for flere' linking to /monitor/billing", async () => {
    render(await DashboardPage());
    const link = screen.getByRole("link", { name: "Opgradér for flere" });
    expect(link).toHaveAttribute("href", "/monitor/billing");
  });

  it("PAY1B-AC29b: upgradeNote text 'Opgradér for flere (snart)' is gone", async () => {
    render(await DashboardPage());
    expect(document.body.textContent).not.toContain("snart");
  });
});

describe("PAY1B-AC30: dashboard — manageLink when subscribed", () => {
  beforeEach(() => {
    mockListMonitors.mockResolvedValue([]);
    mockGetMonitorUsage.mockResolvedValue({ count: 1, limit: 20 });
    mockGetCurrentSubscription.mockResolvedValue({
      status: "active", interval: "year", amountOre: 9500,
      planName: "Monitor Plus", currentPeriodEnd: "2027-01-01T00:00:00Z", cancelAtPeriodEnd: false,
    });
  });

  it("PAY1B-AC30a: shows 'Administrér abonnement' link to /monitor/billing when subscribed", async () => {
    render(await DashboardPage());
    const link = screen.getByRole("link", { name: "Administrér abonnement" });
    expect(link).toHaveAttribute("href", "/monitor/billing");
  });

  it("PAY1B-AC30b: no upgradeLink 'Opgradér for flere' when subscribed", async () => {
    render(await DashboardPage());
    expect(screen.queryByRole("link", { name: "Opgradér for flere" })).not.toBeInTheDocument();
  });
});

describe("PAY1B-AC31: dashboard — at the usage cap, limitReached stays and the billing link follows it", () => {
  it("PAY1B-AC31a: no subscription → limitReached, then the 'Opgradér for flere' link", async () => {
    mockListMonitors.mockResolvedValue([]);
    mockGetMonitorUsage.mockResolvedValue({ count: 5, limit: 5 });
    render(await DashboardPage());
    const limitReached = screen.getByText(Monitor.dashboard.limitReached);
    const link = screen.getByRole("link", { name: "Opgradér for flere" });
    // The link comes after the limitReached text in document order.
    expect(limitReached.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("PAY1B-AC31b: with a subscription → limitReached, then 'Administrér abonnement'; no upgrade link", async () => {
    mockListMonitors.mockResolvedValue([]);
    mockGetMonitorUsage.mockResolvedValue({ count: 20, limit: 20 });
    mockGetCurrentSubscription.mockResolvedValue({
      status: "active", interval: "year", amountOre: 9500,
      planName: "Monitor Plus", currentPeriodEnd: "2027-01-01T00:00:00Z", cancelAtPeriodEnd: false,
    });
    render(await DashboardPage());
    const limitReached = screen.getByText(Monitor.dashboard.limitReached);
    const link = screen.getByRole("link", { name: "Administrér abonnement" });
    expect(link).toHaveAttribute("href", "/monitor/billing");
    expect(limitReached.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.queryByRole("link", { name: "Opgradér for flere" })).not.toBeInTheDocument();
  });
});

describe("PAY1B-AC29: dashboard — no billing link for an uncapped account", () => {
  it.each([
    ["without a subscription", null],
    [
      "with a subscription",
      {
        status: "active", interval: "year", amountOre: 9500,
        planName: "Monitor Plus", currentPeriodEnd: "2027-01-01T00:00:00Z", cancelAtPeriodEnd: false,
      },
    ],
  ])("PAY1B-AC29c: limit null %s → neither 'Opgradér for flere' nor 'Administrér abonnement'", async (_label, subscription) => {
    mockRequireMonitor.mockResolvedValue({ userId: "u1", email: "owner@test.local", role: "owner" });
    mockListMonitors.mockResolvedValue([]);
    mockGetMonitorUsage.mockResolvedValue({ count: 3, limit: null });
    mockGetCurrentSubscription.mockResolvedValue(subscription);
    render(await DashboardPage());
    expect(screen.getByText("3 overvågninger")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Opgradér for flere" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Administrér abonnement" })).not.toBeInTheDocument();
    // The shell's "Abonnement" tab stays; nothing in the page itself links to the billing page.
    const billingLinks = within(screen.getByRole("main"))
      .queryAllByRole("link")
      .filter((link) => link.getAttribute("href") === "/monitor/billing");
    expect(billingLinks).toEqual([]);
  });
});

describe("PAY1B-AC46: Monitor.dashboard.upgradeNote absent from both locale message files", () => {
  it("PAY1B-AC46a: upgradeNote key absent from da messages", () => {
    const daMsg = loadMessages("da") as unknown as { Monitor: { dashboard: Record<string, unknown> } };
    expect(daMsg.Monitor.dashboard).not.toHaveProperty("upgradeNote");
  });

  it("PAY1B-AC46b: upgradeNote key absent from en messages", () => {
    const enMsg = loadMessages("en") as unknown as { Monitor: { dashboard: Record<string, unknown> } };
    expect(enMsg.Monitor.dashboard).not.toHaveProperty("upgradeNote");
  });
});
