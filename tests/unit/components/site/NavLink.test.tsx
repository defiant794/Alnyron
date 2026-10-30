// @vitest-environment jsdom
// Tests for the header/footer NavLink (AC-HOME-04/05: the current page's nav
// link carries aria-current="page"). SiteHeader builds every href on the
// server in the locale-aware form ("/", "/kontakt", "/en/apps"); NavLink
// compares it with the current page in the same form, so these pin:
// - exactly the link to the current page is marked, on fixed routes, the
//   DB-slug route and both home pages ("/" must not match "/apps");
// - a link into the other locale is never current;
// - `lang` (set on labels shown from Danish) and other props pass through.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { NextIntlClientProvider, type Locale } from "next-intl";

// ── Mock the Next router hooks ───────────────────────────────────────────────
// As in LanguageSwitcher.test.tsx: `usePathname` returns the browser path and
// `useParams` the route params; next-intl maps them through the real routing
// table in src/i18n/routing.ts.
const route = vi.hoisted(() => ({
  pathname: "/",
  params: {} as Record<string, string>,
}));

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => route.pathname,
  useParams: () => route.params,
}));

import NavLink from "@/components/site/NavLink";

afterEach(cleanup);

type Item = { href: string; label: string; lang?: string };

/** Header nav per locale, as SiteHeader builds it (EN "Apps" label falls back to Danish). */
const NAV: Record<Locale, Item[]> = {
  da: [
    { href: "/", label: "Forside" },
    { href: "/apps", label: "Apps" },
    { href: "/kontakt", label: "Kontakt" },
  ],
  en: [
    { href: "/en", label: "Home" },
    { href: "/en/apps", label: "Apps", lang: "da" },
    { href: "/en/contact", label: "Contact" },
  ],
};

/** Renders `items` as the header nav on `pathname` (route `params` without the locale). */
function renderNav(
  locale: Locale,
  pathname: string,
  params: Record<string, string> = {},
  items: Item[] = NAV[locale],
) {
  route.pathname = pathname;
  route.params = { locale, ...params };
  render(
    <NextIntlClientProvider locale={locale}>
      <nav aria-label="Navigation">
        <ul>
          {items.map((item) => (
            <li key={item.href}>
              <NavLink href={item.href} lang={item.lang} className="text-muted">
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </NextIntlClientProvider>,
  );
}

/** Links currently marked as the current page. */
function currentLinks() {
  return screen.getAllByRole("link").filter((link) => link.hasAttribute("aria-current"));
}

// ── AC-HOME-04/05: aria-current="page" on the current page's link ────────────

describe('AC-HOME-04/05: NavLink marks only the current page with aria-current="page"', () => {
  it.each([
    ["da", "/", {}, "Forside"],
    ["da", "/kontakt", {}, "Kontakt"],
    ["da", "/apps", { slug: "apps" }, "Apps"],
    ["en", "/en", {}, "Home"],
    ["en", "/en/contact", {}, "Contact"],
    ["en", "/en/apps", { slug: "apps" }, "Apps"],
  ] as const)('%s %s: only "%s" is current', (locale, pathname, params, label) => {
    renderNav(locale, pathname, params);
    const current = currentLinks();
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent(label);
    expect(current[0]).toHaveAttribute("aria-current", "page");
  });

  it("marks no link on a page that is not in the nav (/privatliv)", () => {
    renderNav("da", "/privatliv");
    expect(currentLinks()).toHaveLength(0);
  });

  it("never marks a link into the other locale (/kontakt while on /en/contact)", () => {
    renderNav("en", "/en/contact", {}, [{ href: "/kontakt", label: "Kontakt" }]);
    expect(screen.getByRole("link", { name: "Kontakt" })).not.toHaveAttribute("aria-current");
  });
});

// ── Props pass through to the anchor ─────────────────────────────────────────

describe("NavLink passes its props through to the anchor", () => {
  it('keeps lang="da" on a label shown from Danish and adds no lang otherwise', () => {
    renderNav("en", "/en");
    expect(screen.getByRole("link", { name: "Apps" })).toHaveAttribute("lang", "da");
    expect(screen.getByRole("link", { name: "Home" })).not.toHaveAttribute("lang");
    expect(screen.getByRole("link", { name: "Contact" })).not.toHaveAttribute("lang");
  });

  it("renders the server-built href unchanged and keeps the caller's className", () => {
    renderNav("en", "/en");
    const link = screen.getByRole("link", { name: "Contact" });
    expect(link).toHaveAttribute("href", "/en/contact");
    expect(link).toHaveClass("text-muted");
  });
});
