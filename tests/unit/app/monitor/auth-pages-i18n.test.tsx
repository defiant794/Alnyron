// @vitest-environment jsdom
/**
 * Unit tests: the Monitor pages outside the panel in the visitor's Monitor
 * language: the landing page and the forgot-password, reset and no-access
 * cards. With monitor-locale=en each renders its English copy, a DA | EN
 * switcher labelled in English that posts locale=da and returns to that same
 * page, and the ALNYRON lockup linked to the English frontpage (`/en`).
 * Journey: monitor-i18n  AC-I18N-MON-15/16 (the switcher returns to the page),
 * Monitor UI in the chosen language. The login page has its own switcher tests
 * (login-page.test.tsx).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { Locale } from "next-intl";
import type * as MonitorLocaleModule from "@/i18n/monitor-locale";

const { mockGetMonitorLocale } = vi.hoisted(() => ({
  mockGetMonitorLocale: vi.fn<() => Promise<Locale>>(),
}));

// The visitor's Monitor language, chosen per test.
vi.mock("@/i18n/monitor-locale", async (importOriginal) => ({
  ...(await importOriginal<typeof MonitorLocaleModule>()),
  getMonitorLocale: mockGetMonitorLocale,
}));

vi.mock("next-intl/server", async () => {
  // dynamic-import: Vitest hoists vi.mock above static imports; factory must load lazily
  const { nextIntlServerMock } = await import("../../../helpers/next-intl-server");
  return nextIntlServerMock();
});

vi.mock("@/config/env", () => ({
  parseSiteEnv: vi.fn(() => ({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" })),
}));

// Server actions: the tests only read the forms that post to them.
vi.mock("@/app/monitor/actions", () => ({ setMonitorLocale: vi.fn() }));
vi.mock("@/app/monitor/(auth)/actions", () => ({
  requestPasswordReset: vi.fn(),
  updatePassword: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("@/services/auth/require-role", () => ({
  requireMonitor: vi.fn(async () => ({ userId: "u1", email: "mon@test.local", role: "monitor_user" })),
  getMonitorAccess: vi.fn(async () => ({ status: "forbidden", email: "admin@test.local" })),
}));

// The landing page's footer is an async server component with its own tests.
vi.mock("@/components/site/SiteFooter", () => ({
  default: ({ locale }: { locale: string }) => <footer data-testid="site-footer" data-locale={locale} />,
}));

vi.mock("next/image", () => ({
  default: ({ alt, className }: { alt: string; className?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img alt={alt} className={className ?? ""} />
  ),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className ?? ""}>
      {children}
    </a>
  ),
}));

import MonitorForgotPasswordPage from "@/app/monitor/(auth)/forgot-password/page";
import MonitorResetPage from "@/app/monitor/(auth)/reset/page";
import MonitorNoAccessPage from "@/app/monitor/(panel)/no-access/page";
import MonitorLandingPage from "@/app/monitor/page";
import {
  MONITOR_FORGOT_PASSWORD_PATH,
  MONITOR_LOGIN_PATH,
  MONITOR_NO_ACCESS_PATH,
  MONITOR_SET_PASSWORD_PATH,
} from "@/config/monitor";
import { loadMessages } from "@/i18n/messages";

const da = loadMessages("da");
const en = loadMessages("en");

afterEach(cleanup);
beforeEach(() => {
  mockGetMonitorLocale.mockResolvedValue("en");
});

/** The switcher's form: the language it posts and the page it returns to. */
function switcherForm(label: string) {
  const nav = screen.getByRole("navigation", { name: label });
  return {
    locale: nav.querySelector<HTMLInputElement>('input[name="locale"]')?.value,
    next: nav.querySelector<HTMLInputElement>('input[name="next"]')?.value,
  };
}

/** Each page in English: its heading, the switcher's return path and one more line of its own copy. */
const PAGES = [
  {
    name: "landing",
    render: MonitorLandingPage,
    path: "/",
    title: en.Monitor.landing.title,
    daTitle: da.Monitor.landing.title,
    copy: en.Monitor.landing.note,
  },
  {
    name: "forgot-password",
    render: MonitorForgotPasswordPage,
    path: MONITOR_FORGOT_PASSWORD_PATH,
    title: en.Auth.forgotPassword.title,
    daTitle: da.Auth.forgotPassword.title,
    copy: en.Auth.forgotPassword.backToLogin,
  },
  {
    name: "reset",
    render: MonitorResetPage,
    path: MONITOR_SET_PASSWORD_PATH,
    title: en.Auth.setPassword.title,
    daTitle: da.Auth.setPassword.title,
    copy: en.Auth.setPassword.lead,
  },
  {
    name: "no-access",
    render: MonitorNoAccessPage,
    path: MONITOR_NO_ACCESS_PATH,
    title: en.Auth.noAccess.title,
    daTitle: da.Auth.noAccess.title,
    copy: en.Auth.noAccess.switchAccount,
  },
] as const;

describe.each(PAGES)("Monitor $name page in English", ({ render: Page, path, title, daTitle, copy }) => {
  it("renders the English heading and copy, not the Danish heading", async () => {
    render(await Page());
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent(title);
    expect(heading).not.toHaveTextContent(daTitle);
    expect(screen.getByText(copy)).toBeInTheDocument();
  });

  it("the switcher is labelled in English, posts locale=da and returns to this page", async () => {
    render(await Page());
    expect(switcherForm(en.LanguageSwitcher.label)).toEqual({ locale: "da", next: path });
  });

  it("the ALNYRON lockup links the English frontpage", async () => {
    render(await Page());
    expect(screen.getByRole("link", { name: "Alnyron" })).toHaveAttribute("href", "http://localhost:3000/en");
  });
});

describe("Monitor pages in Danish (no cookie)", () => {
  beforeEach(() => {
    mockGetMonitorLocale.mockResolvedValue("da");
  });

  it("forgot-password: Danish switcher posts locale=en back to this page; the lockup links the Danish frontpage", async () => {
    render(await MonitorForgotPasswordPage());
    expect(switcherForm(da.LanguageSwitcher.label)).toEqual({ locale: "en", next: MONITOR_FORGOT_PASSWORD_PATH });
    expect(screen.getByRole("link", { name: "Alnyron" })).toHaveAttribute("href", "http://localhost:3000");
    expect(screen.getByRole("link", { name: da.Auth.forgotPassword.backToLogin })).toHaveAttribute(
      "href",
      MONITOR_LOGIN_PATH,
    );
  });
});
