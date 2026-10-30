// Unit tests for F0.5 home-page — nav ordering and visibility builder
// Acceptance IDs: AC-HOME-04, AC-HOME-05, AC-HOME-06, AC-HOME-07, AC-HOME-08
import { describe, it, expect } from "vitest";
import { buildNavItems, type NavItem } from "@/services/content/nav";

// ── Test fixtures ─────────────────────────────────────────────────────────────

const homeItem: NavItem = {
  key: "system-home",
  label: "Forside",
  href: "/",
  navOrder: 0,
  isHome: true,
};

const contactItem: NavItem = {
  key: "page-contact",
  label: "Kontakt",
  href: "/kontakt",
  navOrder: 1000,
  isHome: false,
};

const appsCategory: NavItem = {
  key: "category-apps",
  label: "Apps",
  href: "/apps",
  navOrder: 10,
  isHome: false,
};

const servicesCategory: NavItem = {
  key: "category-services",
  label: "Ydelser",
  href: "/ydelser",
  navOrder: 30,
  isHome: false,
};

const customPage: NavItem = {
  key: "page-om-os",
  label: "Om os",
  href: "/om-os",
  navOrder: 500,
  isHome: false,
};

// ── AC-HOME-04: Forside is always first (pinned) ──────────────────────────────

describe("AC-HOME-04: buildNavItems — Forside is pinned as first item", () => {
  it("returns Forside first even when its navOrder is highest", () => {
    const items: NavItem[] = [
      { ...contactItem, navOrder: 10 },
      { ...appsCategory, navOrder: 20 },
      { ...homeItem, navOrder: 9999, isHome: true }, // high order, still pinned first
    ];
    const result = buildNavItems(items);
    expect(result[0]!.isHome).toBe(true);
  });

  it("returns Forside first when it has navOrder=0 (normal seed order)", () => {
    const items: NavItem[] = [homeItem, appsCategory, contactItem];
    const result = buildNavItems(items);
    expect(result[0]!.key).toBe("system-home");
  });

  it("returns Forside first even if it appears last in the input array", () => {
    const items: NavItem[] = [contactItem, appsCategory, homeItem];
    const result = buildNavItems(items);
    expect(result[0]!.key).toBe("system-home");
  });
});

// ── AC-HOME-08: Non-home items sorted by navOrder ─────────────────────────────

describe("AC-HOME-08: buildNavItems — non-home items ordered by navOrder ascending", () => {
  it("sorts pages and categories together by navOrder after Forside", () => {
    // apps(10) < services(30) < customPage(500) < contact(1000)
    const items: NavItem[] = [contactItem, customPage, homeItem, servicesCategory, appsCategory];
    const result = buildNavItems(items);
    expect(result.map((i) => i.navOrder)).toEqual([0, 10, 30, 500, 1000]);
  });

  it("preserves original order for items with identical navOrder", () => {
    const a: NavItem = { key: "a", label: "A", href: "/a", navOrder: 50, isHome: false };
    const b: NavItem = { key: "b", label: "B", href: "/b", navOrder: 50, isHome: false };
    const items: NavItem[] = [homeItem, a, b];
    const result = buildNavItems(items);
    // Both appear after home, order relative to each other is input order (stable sort)
    const non = result.slice(1);
    expect(non.map((i) => i.key)).toEqual(["a", "b"]);
  });

  it("handles a single-item list (only Forside)", () => {
    const result = buildNavItems([homeItem]);
    expect(result).toHaveLength(1);
    expect(result[0]!.key).toBe("system-home");
  });

  it("handles an empty list", () => {
    const result = buildNavItems([]);
    expect(result).toHaveLength(0);
  });
});

// ── AC-HOME-05: Nav excludes pages with show_in_nav = false ──────────────────
// Note: RLS + query already filter to show_in_nav=true before buildNavItems is
// called; this test confirms the builder does not re-add filtered items.
// The builder receives ONLY items that should appear; no extra filtering needed.

describe("AC-HOME-05: buildNavItems — passes through only provided items", () => {
  it("does not add extra items beyond the input", () => {
    // Only home and contact provided (privacy omitted by caller — show_in_nav=false)
    const items: NavItem[] = [homeItem, contactItem];
    const result = buildNavItems(items);
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.key)).toEqual(["system-home", "page-contact"]);
  });
});

// ── AC-HOME-06: Categories with published items are included ──────────────────
// The DB query (getNavItems) passes only categories visible to anon (RLS).
// buildNavItems receives them already filtered; this suite tests the ordering.

describe("AC-HOME-06/07: buildNavItems — categories merged with pages in nav_order position", () => {
  it("places a category at its navOrder position between pages", () => {
    // Seed: apps=10, contact=1000 → order: home(0), apps(10), contact(1000)
    const items: NavItem[] = [homeItem, contactItem, appsCategory];
    const result = buildNavItems(items);
    expect(result.map((i) => i.key)).toEqual([
      "system-home",
      "category-apps",
      "page-contact",
    ]);
  });

  it("interleaves multiple categories among pages by navOrder", () => {
    // apps=10, services=30, customPage=500, contact=1000
    const items: NavItem[] = [homeItem, contactItem, servicesCategory, customPage, appsCategory];
    const result = buildNavItems(items);
    expect(result.map((i) => i.key)).toEqual([
      "system-home",
      "category-apps",
      "category-services",
      "page-om-os",
      "page-contact",
    ]);
  });

  it("returns empty list (minus home) when no extra items are provided", () => {
    const result = buildNavItems([homeItem]);
    expect(result).toHaveLength(1);
  });
});

// ── Output shape contract ─────────────────────────────────────────────────────

describe("buildNavItems — output shape contract", () => {
  it("preserves all NavItem fields on each returned item", () => {
    const items: NavItem[] = [homeItem, appsCategory];
    const result = buildNavItems(items);
    const home = result.find((i) => i.isHome)!;
    expect(home).toMatchObject({
      key: "system-home",
      label: "Forside",
      href: "/",
      navOrder: 0,
      isHome: true,
    });
    const apps = result.find((i) => i.key === "category-apps")!;
    expect(apps).toMatchObject({
      key: "category-apps",
      label: "Apps",
      href: "/apps",
      navOrder: 10,
      isHome: false,
    });
  });

  it("does not mutate the input array", () => {
    const items: NavItem[] = [contactItem, homeItem, appsCategory];
    const original = [...items.map((i) => ({ ...i }))];
    buildNavItems(items);
    // Input order unchanged
    expect(items[0]!.key).toBe(original[0]!.key);
    expect(items[1]!.key).toBe(original[1]!.key);
  });
});
