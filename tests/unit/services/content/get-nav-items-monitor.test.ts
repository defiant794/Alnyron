// Unit tests — getNavItems monitor-nav slice (Slice B)
// Journey: monitor-nav  AC-MONNAV-2, AC-MONNAV-3, AC-MONNAV-6
//
// Tests that:
//   - A monitor page row (system_key='monitor', show_in_nav=true) produces a NavItem
//   - The href is the Monitor host's root by its absolute URL ("http://monitor.localhost:3000/"
//     from NEXT_PUBLIC_SITE_URL=http://localhost:3000), the same on DA and EN (no locale
//     prefix, NOT getPathname)
//   - The monitor item names no link language on DA or EN: Monitor is bilingual and
//     opens in the visitor's own choice, so its language is not known from the page
//   - The monitor item sits after categories (nav_order < 1000) in the final list
//   - The monitor item key is "system-monitor"
//
// The query already filters show_in_nav=true before getNavItems receives data,
// so the hide case is not tested here (it is covered by RLS + AC2 E2E).
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── vi.hoisted ─────────────────────────────────────────────────────────────────
const { mockPagesQuery, mockParseSiteEnv } = vi.hoisted(() => ({
  mockPagesQuery: vi.fn(),
  mockParseSiteEnv: vi.fn(() => ({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" })),
}));

// ── Mocks ──────────────────────────────────────────────────────────────────────
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
vi.mock("@/config/env", () => ({
  parseSiteEnv: mockParseSiteEnv,
}));


import { getPublicCategories, type PublicCategory } from "@/services/content/categories";
import { getNavItems } from "@/services/content/nav";

// ── Fixtures ───────────────────────────────────────────────────────────────────

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

const monitorRow = {
  id: "page-monitor-uuid",
  system_key: "monitor",
  nav_order: 1100,
  page_translations: [], // Monitor has no body translations
  routes: [],
};

const servicesCategory: PublicCategory = {
  id: "cat-services-uuid",
  kind: "services",
  navOrder: 30,
  title: "Ydelser",
  description: "",
  href: "/services",
  fallbackKeys: [],
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
  vi.clearAllMocks();
  vi.mocked(getPublicCategories).mockResolvedValue([servicesCategory, appsCategory]);
  mockParseSiteEnv.mockReturnValue({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" });
});

// ── AC-MONNAV-2: monitor item included when show_in_nav=true ──────────────────

describe("AC-MONNAV-2: getNavItems — monitor page row produces a NavItem", () => {
  it("AC-MONNAV-2a: a monitor row in the pages query produces a NavItem with key 'system-monitor'", async () => {
    mockPagesQuery.mockResolvedValue({ data: [homeRow, monitorRow], error: null });
    const items = await getNavItems("da");
    expect(items.some((item) => item.key === "system-monitor")).toBe(true);
  });

  it("AC-MONNAV-2b: monitor NavItem has isHome=false", async () => {
    mockPagesQuery.mockResolvedValue({ data: [homeRow, monitorRow], error: null });
    const items = await getNavItems("da");
    const monitor = items.find((item) => item.key === "system-monitor");
    expect(monitor?.isHome).toBe(false);
  });
});

// ── AC-MONNAV-6: href is the absolute Monitor host root on DA and EN ──────────

describe("AC-MONNAV-6: getNavItems — monitor href is absolute Monitor subdomain URL (locale-agnostic)", () => {
  it("AC-MONNAV-6c: DA locale — monitor item href is 'http://monitor.localhost:3000/'", async () => {
    mockPagesQuery.mockResolvedValue({ data: [homeRow, monitorRow], error: null });
    const items = await getNavItems("da");
    const monitor = items.find((item) => item.key === "system-monitor");
    expect(monitor?.href).toBe("http://monitor.localhost:3000/");
  });

  it("AC-MONNAV-6d: EN locale — monitor item href is 'http://monitor.localhost:3000/' (same on every locale)", async () => {
    // Key AC6 test: the href must be the same on /en as on /. The absolute subdomain URL
    // is locale-independent and must never carry a locale prefix like '/en/monitor'.
    mockPagesQuery.mockResolvedValue({ data: [homeRow, monitorRow], error: null });
    const items = await getNavItems("en");
    const monitor = items.find((item) => item.key === "system-monitor");
    expect(monitor?.href).toBe("http://monitor.localhost:3000/");
  });
});

// ── AC-MONNAV-6e/f: the bilingual Monitor area's link names no language ──────

describe("AC-MONNAV-6e/f: getNavItems — the Monitor link names no language (it opens in the visitor's choice)", () => {
  it.each(["en", "da"] as const)("AC-MONNAV-6e/f: %s locale — no item, Monitor included, has hrefLang", async (locale) => {
    mockPagesQuery.mockResolvedValue({ data: [homeRow, contactRow, monitorRow], error: null });
    const items = await getNavItems(locale);
    expect(items.find((item) => item.key === "system-monitor")).toBeDefined();
    for (const item of items) expect(item).not.toHaveProperty("hrefLang");
  });
});

// ── AC-MONNAV-3: monitor sits after categories in the nav ──────────────────────

describe("AC-MONNAV-3: getNavItems — monitor (nav_order 1100) sits after categories (nav_order < 1000)", () => {
  it("AC-MONNAV-3a: monitor appears after all categories and before no-higher-order pages", async () => {
    // categories: apps(10), services(30) — both < 1000; monitor(1100) > 1000
    // expected order: home(0), apps(10), services(30), monitor(1100)
    mockPagesQuery.mockResolvedValue({ data: [homeRow, monitorRow], error: null });
    const items = await getNavItems("da");
    const keys = items.map((i) => i.key);
    const catAppsIdx = keys.indexOf("category-cat-apps-uuid");
    const catServIdx = keys.indexOf("category-cat-services-uuid");
    const monitorIdx = keys.indexOf("system-monitor");

    expect(catAppsIdx).toBeGreaterThanOrEqual(0);
    expect(catServIdx).toBeGreaterThanOrEqual(0);
    expect(monitorIdx).toBeGreaterThan(catAppsIdx);
    expect(monitorIdx).toBeGreaterThan(catServIdx);
  });

  it("AC-MONNAV-3b: monitor (1100) sits after contact (1000) when contact has lower nav_order", async () => {
    // monitor nav_order=1100 > contact nav_order=1000
    mockPagesQuery.mockResolvedValue({ data: [homeRow, contactRow, monitorRow], error: null });
    const items = await getNavItems("da");
    const keys = items.map((i) => i.key);
    const contactIdx = keys.indexOf("system-contact");
    const monitorIdx = keys.indexOf("system-monitor");
    expect(monitorIdx).toBeGreaterThan(contactIdx);
  });
});

// ── navOrder propagated ────────────────────────────────────────────────────────

describe("getNavItems — monitor navOrder from DB row", () => {
  it("monitor item navOrder matches the DB nav_order", async () => {
    mockPagesQuery.mockResolvedValue({ data: [homeRow, monitorRow], error: null });
    const items = await getNavItems("da");
    const monitor = items.find((item) => item.key === "system-monitor");
    expect(monitor?.navOrder).toBe(1100);
  });
});
