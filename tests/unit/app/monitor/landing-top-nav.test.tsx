// @vitest-environment jsdom
// Journey: .omp/user-journeys/monitor-landing-top-nav.md
import type { ReactNode } from "react";
import type * as MonitorLocaleModule from "@/i18n/monitor-locale";
import type * as NavigationModule from "next/navigation";
import type * as MonitorMainNavModule from "@/components/monitor/MonitorMainNav";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import "@testing-library/jest-dom/vitest";

const mocks = vi.hoisted(() => ({
  getNavItems: vi.fn(),
  getMonitorLocale: vi.fn<() => Promise<"da" | "en">>(),
  nav: null as ReactNode,
  navProps: null as MonitorMainNavModule.MonitorMainNavProps | null,
}));

vi.mock("@/services/content/nav", () => ({ getNavItems: mocks.getNavItems }));
vi.mock("@/i18n/monitor-locale", async (importOriginal) => ({
  ...(await importOriginal<typeof MonitorLocaleModule>()),
  getMonitorLocale: mocks.getMonitorLocale,
}));
// The mock factory is hoisted, so its fixture helper must load after hoisting.
vi.mock("next-intl/server", async () =>
  (await import("../../../helpers/next-intl-server")).nextIntlServerMock(),
);
vi.mock("@/config/env", () => ({
  parseSiteEnv: vi.fn(() => ({ NEXT_PUBLIC_SITE_URL: "https://alnyron.dk" })),
}));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof NavigationModule>()),
  useSelectedLayoutSegments: () => [],
  useParams: () => ({ locale: "da" }),
}));
vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img alt={alt} />
  ),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
// As in the existing landing tests, keep the separately tested async footer out
// of React's client renderer; preserve its public landmark and passed locale.
vi.mock("@/components/site/SiteFooter", () => ({
  default: ({ locale, siteOrigin }: { locale: string; siteOrigin: string }) => (
    <footer aria-label="Site footer"><a href={`${siteOrigin}/${locale === "en" ? "en" : ""}`}>Footer home</a></footer>
  ),
}));
// React DOM cannot render nested async server components. Supply the awaited
// REAL MonitorMainNav output, not invented nav markup: only getNavItems is faked.
// The landing must still actually include this component to render its links.
vi.mock("@/components/monitor/MonitorMainNav", () => ({
  default: (props: MonitorMainNavModule.MonitorMainNavProps) => {
    mocks.navProps = props;
    return mocks.nav;
  },
}));

import MonitorLandingPage from "@/app/monitor/page";
import { MONITOR_HOME_PATH, MONITOR_LOGIN_PATH, MONITOR_SIGNUP_PATH } from "@/config/monitor";
import { loadMessages } from "@/i18n/messages";

const configuredItems = [
  { key: "page-admin-choice", label: "Administratorens valgte side", href: "/valgt-side", navOrder: 1, isHome: false },
  { key: "category-admin-choice", label: "Administratorens kategori", href: "https://catalog.example.org/", navOrder: 2, isHome: false },
] as const;

afterEach(cleanup);
beforeEach(() => {
  mocks.getNavItems.mockReset().mockResolvedValue(configuredItems);
  mocks.getMonitorLocale.mockReset().mockResolvedValue("da");
  mocks.nav = null;
  mocks.navProps = null;
});

async function renderLanding(locale: "da" | "en" = "da") {
  mocks.getMonitorLocale.mockResolvedValue(locale);
  const { default: MonitorMainNav } = await vi.importActual<typeof MonitorMainNavModule>(
    "@/components/monitor/MonitorMainNav",
  );
  mocks.nav = await MonitorMainNav({ locale });
  render(
    <NextIntlClientProvider locale={locale} messages={loadMessages(locale)}>
      {await MonitorLandingPage()}
    </NextIntlClientProvider>,
  );
  return within(screen.getByRole("banner"));
}

describe("monitor-landing-top-nav", () => {
  it.each(["da", "en"] as const)("AC1: renders configured main-site navigation in the %s landing header", async (locale) => {
    const header = await renderLanding(locale);
    expect(mocks.navProps?.locale).toBe(locale);
    expect(mocks.navProps?.currentHref).toBe("https://monitor.alnyron.dk/");
    expect(header.getByRole("link", { name: configuredItems[0].label })).toHaveAttribute("href", "https://alnyron.dk/valgt-side");
    expect(header.getByRole("link", { name: configuredItems[1].label })).toHaveAttribute("href", "https://catalog.example.org/");
  });

  it("AC1: reflects a changed admin navigation item instead of a hardcoded list", async () => {
    mocks.getNavItems.mockResolvedValue([
      { ...configuredItems[0], label: "Ny synlig side", href: "/ny-side" },
    ]);
    const header = await renderLanding();
    expect(header.getByRole("link", { name: "Ny synlig side" })).toHaveAttribute("href", "https://alnyron.dk/ny-side");
    expect(header.queryByRole("link", { name: configuredItems[0].label })).not.toBeInTheDocument();
    expect(header.queryByRole("link", { name: configuredItems[1].label })).not.toBeInTheDocument();
  });

  it("AC2: retains login, free signup and the DA/EN locale switcher in the header", async () => {
    const header = await renderLanding();
    expect(header.getByRole("link", { name: "Log ind" })).toHaveAttribute("href", MONITOR_LOGIN_PATH);
    expect(header.getByRole("link", { name: "Opret gratis" })).toHaveAttribute("href", MONITOR_SIGNUP_PATH);
    const switcher = within(header.getByRole("navigation", { name: loadMessages("da").LanguageSwitcher.label }));
    expect(switcher.getByText("DA")).toHaveAttribute("aria-current", "true");
    expect(switcher.getByRole("button", { name: /^EN/ })).toBeInTheDocument();
  });

  it.each(["da", "en"] as const)("AC2: returns to the Monitor landing when switching from %s", async (locale) => {
    const header = await renderLanding(locale);
    const switcher = header.getByRole("navigation", { name: loadMessages(locale).LanguageSwitcher.label });
    const nextInput = switcher.querySelector<HTMLInputElement>('form input[type="hidden"][name="next"]');
    expect(nextInput?.value).toBe(MONITOR_HOME_PATH);
  });

  // Match SiteMenu.test.tsx's disclosure contract. jsdom does not apply the
  // responsive stylesheet; the actual <768px breakpoint is an E2E scenario.
  it("AC3: exposes the main-site nav through the shared Menu disclosure and closes on Escape", async () => {
    const user = userEvent.setup();
    const header = await renderLanding();
    const toggle = header.getByRole("button", { name: "Menu" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    const panel = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    expect(panel).not.toBeNull();
    expect(panel).toContainElement(header.getByRole("link", { name: configuredItems[0].label }));
    expect(panel).not.toContainElement(header.getByRole("link", { name: "Log ind" }));
    expect(panel).not.toContainElement(header.getByRole("link", { name: "Opret gratis" }));
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    header.getByRole("link", { name: configuredItems[0].label }).focus();
    await user.keyboard("{Escape}");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveFocus();
  });

  it("AC4: retains the landing footer with the main-site origin", async () => {
    await renderLanding();
    const footer = within(screen.getByRole("contentinfo", { name: "Site footer" }));
    expect(footer.getByRole("link", { name: "Footer home" })).toHaveAttribute("href", "https://alnyron.dk/");
  });
});
