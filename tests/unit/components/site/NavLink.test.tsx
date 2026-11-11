// @vitest-environment jsdom
// Tests for the header/footer NavLink (AC-HOME-04/05: the current page's nav
// link carries aria-current="page"). SiteHeader builds every href on the
// server in the locale-aware form ("/", "/contact", "/en/apps"); NavLink
// compares it with the current page in the same form, so these pin:
// - exactly the link to the current page is marked, on fixed routes, the
//   DB-slug route and both home pages ("/" must not match "/apps"), in the
//   prerendered HTML too;
// - a link into the other locale is never current;
// - on a catalog item page its section link is marked "true", never "page"
//   (the item, in the breadcrumb, is the current page);
// - `lang` (set on labels shown from Danish) and other props pass through.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { NextIntlClientProvider, type Locale } from "next-intl";

// ── Mock the Next router hooks ───────────────────────────────────────────────
// As in LanguageSwitcher.test.tsx: `useSelectedLayoutSegments` returns the
// internal segments below the `[locale]` layout and `useParams` the route
// params; `getPathname` maps them through the real routing table in
// src/i18n/routing.ts. `usePathname` is the browser path unless a case sets
// the prerender value (the rewrite target).
const route = vi.hoisted(() => ({
  segments: [] as string[],
  params: {} as Record<string, string>,
  pathname: "/",
}));

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useSelectedLayoutSegments: () => route.segments,
  useParams: () => route.params,
  usePathname: () => route.pathname,
}));

import NavLink from "@/components/site/NavLink";

afterEach(cleanup);

type Item = { href: string; label: string; lang?: string };

/** Header nav per locale, as SiteHeader builds it (EN "Apps" label falls back to Danish). */
const NAV: Record<Locale, Item[]> = {
  da: [
    { href: "/", label: "Forside" },
    { href: "/apps", label: "Apps" },
    { href: "/contact", label: "Kontakt" },
  ],
  en: [
    { href: "/en", label: "Home" },
    { href: "/en/apps", label: "Apps", lang: "da" },
    { href: "/en/contact", label: "Contact" },
  ],
};

type RenderOptions = { params?: Record<string, string>; pathname?: string; items?: Item[] };

/**
 * Renders `items` as the header nav on the page with the internal `segments`
 * (route `params` without the locale); `pathname` is what `usePathname` reports.
 */
function renderNav(
  locale: Locale,
  segments: string[],
  { params = {}, pathname = "/", items = NAV[locale] }: RenderOptions = {},
) {
  route.segments = segments;
  route.params = { locale, ...params };
  route.pathname = pathname;
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

/** Links that carry an aria-current mark (either value). */
function currentLinks() {
  return screen.getAllByRole("link").filter((link) => link.hasAttribute("aria-current"));
}

// ── AC-HOME-04/05: aria-current="page" on the current page's link ────────────

describe('AC-HOME-04/05: NavLink marks only the current page with aria-current="page"', () => {
  it.each([
    ["da", [], {}, "Forside"],
    ["da", ["contact"], {}, "Kontakt"],
    ["da", ["apps"], { slug: "apps" }, "Apps"],
    ["en", [], {}, "Home"],
    ["en", ["contact"], {}, "Contact"],
    ["en", ["apps"], { slug: "apps" }, "Apps"],
  ] as const)('%s %j: only "%s" is current', (locale, segments, params, label) => {
    renderNav(locale, [...segments], { params });
    const current = currentLinks();
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent(label);
    expect(current[0]).toHaveAttribute("aria-current", "page");
  });

  it.each([
    ["da", "services", { href: "/services", label: "Ydelser" }],
    ["en", "services", { href: "/en/services", label: "Services" }],
  ] as const)('%s section page /%s: the section link is the current page (aria-current="page")', (locale, slug, link) => {
    renderNav(locale, [slug], { params: { slug }, items: [...NAV[locale], link] });
    const current = currentLinks();
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent(link.label);
    expect(current[0]).toHaveAttribute("aria-current", "page");
  });

  it("marks Kontakt on the prerendered /contact, where usePathname is the rewrite target /da/contact", () => {
    renderNav("da", ["contact"], { pathname: "/da/contact" });
    const current = currentLinks();
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent("Kontakt");
  });

  it("marks no link on a page that is not in the nav (/privacy)", () => {
    renderNav("da", ["privacy"]);
    expect(currentLinks()).toHaveLength(0);
  });

  it("never marks a link into the other locale (/contact while on /en/contact)", () => {
    renderNav("en", ["contact"], { items: [{ href: "/contact", label: "Kontakt" }] });
    expect(screen.getByRole("link", { name: "Kontakt" })).not.toHaveAttribute("aria-current");
  });
});

// ── Catalog item pages mark their section (approved item detail mock) ────────

describe('NavLink marks the section of a catalog item page with aria-current="true"', () => {
  it.each([
    ["da", "some-app", "Apps"],
    ["en", "some-app", "Apps"],
  ] as const)("%s item %s: only the section link %s is marked, and as the section", (locale, item, label) => {
    renderNav(locale, ["apps", item], { params: { slug: "apps", item } });
    const current = currentLinks();
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent(label);
    expect(current[0]).toHaveAttribute("aria-current", "true");
  });

  it('never marks a nav link "page" on an item page: the item itself is the current page (breadcrumb)', () => {
    renderNav("da", ["services", "web-development"], {
      params: { slug: "services", item: "web-development" },
      items: [...NAV.da, { href: "/services", label: "Ydelser" }],
    });
    expect(screen.getByRole("link", { name: "Ydelser" })).toHaveAttribute("aria-current", "true");
    expect(currentLinks().filter((link) => link.getAttribute("aria-current") === "page")).toHaveLength(0);
  });

  it("never marks the home link as a section (every EN path lies below /en)", () => {
    renderNav("en", ["apps", "some-app"], { params: { slug: "apps", item: "some-app" } });
    expect(screen.getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current");
  });

  it("does not mark a link whose path is only a prefix of the segment (/apps vs /apps-pro)", () => {
    renderNav("da", ["apps-pro"], { params: { slug: "apps-pro" } });
    expect(currentLinks()).toHaveLength(0);
  });
});

// ── Props pass through to the anchor ─────────────────────────────────────────

describe("NavLink passes its props through to the anchor", () => {
  it('keeps lang="da" on a label shown from Danish and adds no lang otherwise', () => {
    renderNav("en", []);
    expect(screen.getByRole("link", { name: "Apps" })).toHaveAttribute("lang", "da");
    expect(screen.getByRole("link", { name: "Home" })).not.toHaveAttribute("lang");
    expect(screen.getByRole("link", { name: "Contact" })).not.toHaveAttribute("lang");
  });

  it("renders the server-built href unchanged and keeps the caller's className", () => {
    renderNav("en", []);
    const link = screen.getByRole("link", { name: "Contact" });
    expect(link).toHaveAttribute("href", "/en/contact");
    expect(link).toHaveClass("text-muted");
  });
});
