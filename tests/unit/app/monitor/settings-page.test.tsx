// @vitest-environment jsdom
/**
 * Unit tests: /monitor/(panel)/settings/page.tsx
 * Journey: monitor-web-area  MON-AC42
 *
 * Verifies: notification address (read-only account email), change-password
 * form present, sign-out button present.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type * as NextNavigation from "next/navigation";
import type * as MonitorLocaleModule from "@/i18n/monitor-locale";

const { mockRequireMonitor } = vi.hoisted(() => ({
  mockRequireMonitor: vi.fn(),
}));

vi.mock("next-intl/server", async () => {
  const { nextIntlServerMock } = await import("../../../helpers/next-intl-server");
  return nextIntlServerMock();
});
// Partial: the locale-aware frontpage link builds on next-intl's navigation, which needs the real module.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  usePathname: () => "/monitor/settings",
}));
vi.mock("@/services/auth/require-role", () => ({ requireMonitor: mockRequireMonitor }));
// The change-password form posts to the area's updatePassword action (the
// SetPasswordForm pattern of /monitor/reset); "Log ud" posts to signOut.
vi.mock("@/app/monitor/(auth)/actions", () => ({ signOut: vi.fn(), updatePassword: vi.fn() }));
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

import SettingsPage from "@/app/monitor/(panel)/settings/page";
import { loadMessages } from "@/i18n/messages";

const { Monitor, Auth } = loadMessages("da");

afterEach(cleanup);

beforeEach(() => {
  mockRequireMonitor.mockResolvedValue({
    userId: "u1",
    email: "mon@alnyron-test.local",
    role: "monitor_user",
  });
});

describe("MON-AC42: /monitor/settings renders correctly", () => {
  it("MON-AC42a: gated by requireMonitor", async () => {
    render(await SettingsPage());
    expect(mockRequireMonitor).toHaveBeenCalledTimes(1);
  });

  it("MON-AC42b: shows notification address as the account email (read-only)", async () => {
    render(await SettingsPage());
    expect(document.body.textContent).toContain("mon@alnyron-test.local");
  });

  it("MON-AC42c: has a change-password form", async () => {
    render(await SettingsPage());
    // The SetPasswordForm pattern provides a password input
    const passwordInput = screen.getByLabelText(/adgangskode/i);
    expect(passwordInput).toHaveAttribute("type", "password");
  });

  it("MON-AC42d: has a sign-out button", async () => {
    render(await SettingsPage());
    const btn = screen.getByRole("button", { name: Auth.signOut });
    expect(btn).toBeInTheDocument();
  });

  it("MON-AC42e: requireMonitor redirect propagates", async () => {
    mockRequireMonitor.mockRejectedValue(new Error("NEXT_REDIRECT:/monitor/no-access"));
    await expect(SettingsPage()).rejects.toThrow("NEXT_REDIRECT:/monitor/no-access");
  });
});
