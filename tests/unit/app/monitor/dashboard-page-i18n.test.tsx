// @vitest-environment jsdom
/**
 * Unit tests: src/app/monitor/(panel)/dashboard/page.tsx — locale follows
 * getMonitorLocale(), not AUTH_LOCALE
 * Journey: monitor-i18n  AC-I18N-MON-20, 21
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type * as NextNavigation from "next/navigation";

// ── vi.hoisted ─────────────────────────────────────────────────────────────────

/** What the dashboard page asks `getTranslations` for (its body and its metadata). */
type DashboardTranslationsOptions = { locale: "da" | "en"; namespace?: "Monitor" | "Monitor.dashboard" };

const { mockGetMonitorLocale, mockRequireMonitor, mockListMonitors, mockGetMonitorUsage, mockGetTranslations } =
  vi.hoisted(() => ({
    mockGetMonitorLocale: vi.fn(),
    mockRequireMonitor: vi.fn(),
    mockListMonitors: vi.fn(),
    mockGetMonitorUsage: vi.fn(),
    mockGetTranslations: vi.fn<(options: DashboardTranslationsOptions) => Promise<unknown>>(),
  }));

// ── Mocks ──────────────────────────────────────────────────────────────────────

// The visitor's Monitor language, chosen per test.
vi.mock("@/i18n/monitor-locale", () => ({
  getMonitorLocale: mockGetMonitorLocale,
  MONITOR_LOCALE_COOKIE: "monitor-locale",
  MONITOR_LOCALES: ["da", "en"],
}));

// Real translations for the locale the page actually passes to getTranslations;
// we spy on getTranslations to capture the locale argument.
vi.mock("next-intl/server", async () => {
  // dynamic-import: Vitest hoists vi.mock above static imports; factory must load lazily
  const { createTranslator } = await import("next-intl");
  const { loadMessages } = await import("@/i18n/messages");
  return {
    getTranslations: mockGetTranslations.mockImplementation(
      async ({ locale, namespace }: DashboardTranslationsOptions) =>
        createTranslator({
          locale,
          messages: loadMessages(locale),
          namespace,
          onError: (error) => { throw error; },
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

vi.mock("@/services/auth/require-role", () => ({
  requireMonitor: mockRequireMonitor,
}));

vi.mock("@/services/monitor/monitors", () => ({
  listMonitors: mockListMonitors,
  getMonitorUsage: mockGetMonitorUsage,
}));

// The footer's subscription link reads the user's subscription (payments slice 1b): none here.
vi.mock("@/services/payments/billing", () => ({ getCurrentSubscription: vi.fn(async () => null) }));

vi.mock("@/app/monitor/(auth)/actions", () => ({ signOut: vi.fn() }));

vi.mock("@/config/env", async (importOriginal) => ({
  // dynamic-import: importOriginal requires async factory per Vitest's API
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

vi.mock("@/components/site/SiteMenu", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// The switcher records the locale MonitorShell hands it.
vi.mock("@/components/monitor/MonitorLocaleSwitcher", () => ({
  default: ({ locale }: { locale: string }) => (
    <div data-testid="locale-switcher" data-locale={locale} />
  ),
}));

// ── Import ─────────────────────────────────────────────────────────────────────

import DashboardPage from "@/app/monitor/(panel)/dashboard/page";
import { loadMessages } from "@/i18n/messages";

// The dashboard heading in each language ("Dine overvågninger" in Danish).
const DA_DASHBOARD_TITLE = loadMessages("da").Monitor.dashboard.title;
const EN_DASHBOARD_TITLE = loadMessages("en").Monitor.dashboard.title;

// ── Fixtures ───────────────────────────────────────────────────────────────────

afterEach(cleanup);

beforeEach(() => {
  mockRequireMonitor.mockResolvedValue({
    userId: "u1",
    email: "mon@test.local",
    role: "monitor_user",
  });
  mockListMonitors.mockResolvedValue([]);
  mockGetMonitorUsage.mockResolvedValue({ count: 0, limit: 5 });
  mockGetMonitorLocale.mockResolvedValue("da");
  mockGetTranslations.mockClear();
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("AC-I18N-MON-20: dashboard page calls getMonitorLocale()", () => {
  it("AC-I18N-MON-20a: getMonitorLocale is called once per render", async () => {
    render(await DashboardPage());
    expect(mockGetMonitorLocale).toHaveBeenCalledTimes(1);
  });

  it("AC-I18N-MON-20b: when getMonitorLocale returns 'en', ALL getTranslations calls use locale='en'", async () => {
    mockGetMonitorLocale.mockResolvedValue("en");
    render(await DashboardPage());
    const localesRequested = mockGetTranslations.mock.calls.map(
      ([opts]: [{ locale: string; namespace?: string }]) => opts.locale,
    );
    // Guard: empty array would vacuously pass every(); require at least one call.
    expect(localesRequested.length).toBeGreaterThan(0);
    // Every call must use "en" — switching only metadata leaves body Danish → fails here too.
    expect(localesRequested.every((l: string) => l === "en")).toBe(true);
  });

  it("AC-I18N-MON-20c: when getMonitorLocale returns 'en', the h1 heading is the EN title", async () => {
    mockGetMonitorLocale.mockResolvedValue("en");
    render(await DashboardPage());
    // getByRole throws if the heading is absent — a dropped heading won't silently pass.
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent(EN_DASHBOARD_TITLE);
    expect(heading).not.toHaveTextContent(DA_DASHBOARD_TITLE);
  });

  it("AC-I18N-MON-20d: when getMonitorLocale returns 'en', MonitorShell receives locale='en'", async () => {
    mockGetMonitorLocale.mockResolvedValue("en");
    render(await DashboardPage());
    // The stubbed MonitorLocaleSwitcher records the locale prop on data-locale.
    const switcher = document.querySelector('[data-testid="locale-switcher"]');
    expect(switcher).not.toBeNull();
    expect(switcher!.getAttribute("data-locale")).toBe("en");
  });
});

describe("AC-I18N-MON-21: default DA behaviour preserved", () => {
  it("AC-I18N-MON-21a: when getMonitorLocale returns 'da', page passes locale='da' to getTranslations", async () => {
    mockGetMonitorLocale.mockResolvedValue("da");
    render(await DashboardPage());
    const localesRequested = mockGetTranslations.mock.calls.map(
      ([opts]: [{ locale: string; namespace?: string }]) => opts.locale,
    );
    expect(localesRequested.length).toBeGreaterThan(0);
    expect(localesRequested.every((l: string) => l === "da")).toBe(true);
  });

  it("AC-I18N-MON-21b: when getMonitorLocale returns 'da', the h1 heading is the DA title", async () => {
    render(await DashboardPage());
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent(DA_DASHBOARD_TITLE);
  });
});
