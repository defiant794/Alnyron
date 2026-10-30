// Unit tests for F0.5 home-page — getNavItems (DB rows → header nav items)
// Acceptance IDs: AC-HOME-04, AC-HOME-05, AC-HOME-06, AC-HOME-13, AC-HOME-02 (lang="da")
//
// Ordering is covered by nav.test.ts (buildNavItems). These tests cover the
// mapping: system pages get fixed UI labels and routes, custom pages and
// categories get their DB title (Danish fallback marked with lang="da"), and
// a custom page without a slug in the locale is left out.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPagesQuery } = vi.hoisted(() => ({ mockPagesQuery: vi.fn() }));

vi.mock("next-intl/server", async () =>
  (await import("../../../helpers/next-intl-server")).nextIntlServerMock(),
);
// Chain: .from("pages").select(...).eq("status", ...).eq("show_in_nav", ...)
vi.mock("@/lib/supabase/public", () => ({
  getPublicClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ eq: mockPagesQuery }) }) }),
  }),
}));
vi.mock("@/services/content/categories", () => ({ getPublicCategories: vi.fn() }));

import { getPublicCategories, type PublicCategory } from "@/services/content/categories";
import { getNavItems } from "@/services/content/nav";

const homeRow = {
  id: "page-home-uuid",
  system_key: "home",
  nav_order: 0,
  page_translations: [],
  routes: [],
};
const contactRow = {
  id: "page-contact-uuid",
  system_key: "contact",
  nav_order: 1000,
  page_translations: [],
  routes: [],
};
const aboutRow = {
  id: "page-about-uuid",
  system_key: null,
  nav_order: 500,
  page_translations: [
    { locale: "da", title: "Om os" },
    { locale: "en", title: "" },
  ],
  routes: [
    { locale: "da", slug: "om-os" },
    { locale: "en", slug: "about" },
  ],
};

const appsCategory: PublicCategory = {
  id: "cat-apps-uuid",
  kind: "apps",
  navOrder: 10,
  title: "Apps",
  description: "",
  href: "/apps",
  fallbackKeys: [],
};

beforeEach(() => {
  mockPagesQuery.mockResolvedValue({ data: [contactRow, aboutRow, homeRow], error: null });
  vi.mocked(getPublicCategories).mockResolvedValue([appsCategory]);
});

describe("AC-HOME-04/13: getNavItems — system pages use fixed labels and locale routes", () => {
  it("DA: Forside at / first, Kontakt at /kontakt", async () => {
    const items = await getNavItems("da");
    expect(items[0]).toMatchObject({ key: "system-home", label: "Forside", href: "/", isHome: true });
    expect(items.find((item) => item.key === "system-contact")).toMatchObject({
      label: "Kontakt",
      href: "/kontakt",
    });
  });

  it("EN: Home at /en, Contact at /en/contact", async () => {
    const items = await getNavItems("en");
    expect(items[0]).toMatchObject({ label: "Home", href: "/en", isHome: true });
    expect(items.find((item) => item.key === "system-contact")).toMatchObject({
      label: "Contact",
      href: "/en/contact",
    });
  });

  it("system page labels carry no lang override", async () => {
    const items = await getNavItems("en");
    expect(items.find((item) => item.isHome)?.lang).toBeUndefined();
  });
});

describe("AC-HOME-06/08: getNavItems — custom pages and categories in nav_order", () => {
  it("merges pages and public categories: home, apps(10), about(500), contact(1000)", async () => {
    const items = await getNavItems("da");
    expect(items.map((item) => item.key)).toEqual([
      "system-home",
      "category-cat-apps-uuid",
      "page-page-about-uuid",
      "system-contact",
    ]);
  });

  it("asks for the public categories of the same locale", async () => {
    await getNavItems("en");
    expect(getPublicCategories).toHaveBeenCalledWith("en");
  });

  it("custom page: DB title as label and its slug in the locale as href", async () => {
    const items = await getNavItems("da");
    expect(items.find((item) => item.key === "page-page-about-uuid")).toMatchObject({
      label: "Om os",
      href: "/om-os",
    });
  });

  it("leaves out a custom page without a slug in the locale (slugs never fall back)", async () => {
    mockPagesQuery.mockResolvedValue({
      data: [homeRow, { ...aboutRow, routes: [{ locale: "da", slug: "om-os" }] }],
      error: null,
    });
    const items = await getNavItems("en");
    expect(items.some((item) => item.key === "page-page-about-uuid")).toBe(false);
  });
});

describe('AC-HOME-02: getNavItems — DA-fallback labels get lang="da"', () => {
  it("EN: blank EN page title falls back to the DA title with lang da, EN slug kept", async () => {
    const items = await getNavItems("en");
    expect(items.find((item) => item.key === "page-page-about-uuid")).toMatchObject({
      label: "Om os",
      href: "/en/about",
      lang: "da",
    });
  });

  it("EN: a category whose title fell back to DA gets lang da", async () => {
    vi.mocked(getPublicCategories).mockResolvedValue([
      { ...appsCategory, href: "/en/apps", fallbackKeys: ["title"] },
    ]);
    const items = await getNavItems("en");
    expect(items.find((item) => item.key === "category-cat-apps-uuid")?.lang).toBe("da");
  });

  it("DA: no label carries a lang override", async () => {
    const items = await getNavItems("da");
    expect(items.every((item) => item.lang === undefined)).toBe(true);
  });
});

describe("getNavItems — failures are loud", () => {
  it("throws when the pages query fails (never caches an empty nav)", async () => {
    mockPagesQuery.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(getNavItems("da")).rejects.toThrow(/boom/);
  });
});
