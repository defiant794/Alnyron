// Unit tests for F0.5 home-page — getPublicCategories DA fallback + slug rules
// Acceptance IDs: AC-HOME-02/03 (lang="da" on DA fallback), AC-HOME-06
//
// Mapping/ordering basics live in categories.test.ts. Here: rows carrying both
// locales (as the real query returns them), field-level DA fallback reported in
// fallbackKeys, and categories without a usable route or title left out.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockOrder } = vi.hoisted(() => ({ mockOrder: vi.fn() }));

// Chain: .from("categories").select(...).order("nav_order")
vi.mock("@/lib/supabase/public", () => ({
  getPublicClient: () => ({ from: () => ({ select: () => ({ order: mockOrder }) }) }),
}));

import { getPublicCategories } from "@/services/content/categories";

const websitesRow = {
  id: "cat-websites-uuid",
  kind: "websites",
  nav_order: 20,
  category_translations: [
    { locale: "da", title: "Hjemmesider", description: "Hurtige, tilgængelige sider der konverterer." },
    { locale: "en", title: "Websites", description: "" },
  ],
  routes: [
    { locale: "da", slug: "hjemmesider" },
    { locale: "en", slug: "websites" },
  ],
};

beforeEach(() => {
  mockOrder.mockResolvedValue({ data: [websitesRow], error: null });
});

describe("getPublicCategories — field-level DA fallback", () => {
  it("EN: keeps the EN title, falls back to the DA description and reports it", async () => {
    const [category] = await getPublicCategories("en");
    expect(category).toMatchObject({
      title: "Websites",
      description: "Hurtige, tilgængelige sider der konverterer.",
      href: "/en/websites",
      fallbackKeys: ["description"],
    });
  });

  it("EN: a blank EN title falls back to the DA title", async () => {
    mockOrder.mockResolvedValue({
      data: [
        {
          ...websitesRow,
          category_translations: [websitesRow.category_translations[0], { locale: "en", title: " ", description: "" }],
        },
      ],
      error: null,
    });
    const [category] = await getPublicCategories("en");
    expect(category?.title).toBe("Hjemmesider");
    expect(category?.fallbackKeys).toContain("title");
  });

  it("AC-ENSLUG-08: DA: Danish values, no fallback keys, English URL slug", async () => {
    const [category] = await getPublicCategories("da");
    expect(category).toMatchObject({ title: "Hjemmesider", href: "/websites", fallbackKeys: [] });
  });
});

describe("getPublicCategories — categories that cannot be linked are left out", () => {
  it("no English route (the URL slug on every locale)", async () => {
    mockOrder.mockResolvedValue({
      data: [{ ...websitesRow, routes: [{ locale: "da", slug: "hjemmesider" }] }],
      error: null,
    });
    expect(await getPublicCategories("da")).toEqual([]);
    expect(await getPublicCategories("en")).toEqual([]);
  });

  it("no title in either locale", async () => {
    mockOrder.mockResolvedValue({
      data: [{ ...websitesRow, category_translations: [] }],
      error: null,
    });
    expect(await getPublicCategories("da")).toEqual([]);
  });
});

describe("getPublicCategories — failures are loud", () => {
  it("throws when the query fails (never caches an empty list)", async () => {
    mockOrder.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(getPublicCategories("da")).rejects.toThrow(/boom/);
  });
});
