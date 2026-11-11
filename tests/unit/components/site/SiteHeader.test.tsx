// @vitest-environment jsdom
/**
 * Unit tests — SiteHeader nav links (src/components/site/SiteHeader.tsx)
 * Journey: monitor-nav  AC-MONNAV-6 (design review #6). Monitor is bilingual
 * (it opens in the visitor's own choice), so its link names no `hreflang`.
 *
 * The header is an async server component: it is awaited and its element
 * rendered. The nav items are mocked (getNavItems has its own tests); NavLink,
 * SiteMenu, LanguageSwitcher and Logo are client islands or images with their
 * own tests, so NavLink is a plain anchor that keeps every prop it is given and
 * the others are stand-ins. The small-screen menu (SiteMenu) wraps the same nav,
 * so one set of links serves both.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ComponentProps, ReactNode } from "react";

// vi.mock factories are hoisted above the imports, so the helper is loaded lazily.
vi.mock("next-intl/server", async () =>
  (await import("../../../helpers/next-intl-server")).nextIntlServerMock(),
);
vi.mock("@/services/content/nav", () => ({ getNavItems: vi.fn() }));
vi.mock("@/components/site/NavLink", () => ({
  default: ({ children, ...props }: ComponentProps<"a">) => <a {...props}>{children}</a>,
}));
vi.mock("@/components/site/SiteMenu", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/site/LanguageSwitcher", () => ({ default: () => null }));
vi.mock("@/components/brand/Logo", () => ({ default: () => null }));

import SiteHeader from "@/components/site/SiteHeader";
import { getNavItems, type NavItem } from "@/services/content/nav";

const EN_ITEMS: NavItem[] = [
  { key: "system-home", label: "Home", href: "/en", navOrder: 0, isHome: true },
  { key: "category-apps", label: "Apps", href: "/en/apps", navOrder: 10, isHome: false, lang: "da" },
  { key: "system-monitor", label: "Monitor", href: "http://monitor.localhost:3000/", navOrder: 1100, isHome: false },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getNavItems).mockResolvedValue(EN_ITEMS);
});

afterEach(cleanup);

describe("AC-MONNAV-6h: SiteHeader renders each nav item's link attributes", () => {
  it("AC-MONNAV-6h: each link keeps its item's href and lang; no link, Monitor included, has hreflang", async () => {
    render(await SiteHeader({ locale: "en" }));
    const nav = within(screen.getByRole("navigation", { name: "Main navigation" }));

    const monitor = nav.getByRole("link", { name: "Monitor" });
    expect(monitor).toHaveAttribute("href", "http://monitor.localhost:3000/");
    expect(monitor).not.toHaveAttribute("hreflang");
    expect(monitor).not.toHaveAttribute("lang");

    expect(nav.getByRole("link", { name: "Apps" })).toHaveAttribute("lang", "da");
    expect(nav.getByRole("link", { name: "Apps" })).not.toHaveAttribute("hreflang");
    expect(nav.getByRole("link", { name: "Home" })).not.toHaveAttribute("hreflang");
    expect(getNavItems).toHaveBeenCalledWith("en");
  });
});
