// Unit tests for F0.5 home-page — public categories content service
// Acceptance IDs: AC-HOME-06, AC-HOME-07, AC-HOME-11
//
// RLS ensures anon only sees categories where private.category_is_public()=true
// (published + ≥1 published item). The service tests verify the mapping and
// ordering contract on top of RLS-filtered data.
//
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock the public Supabase client ───────────────────────────────────────────

const mockOrder = vi.fn();
const mockSelect = vi.fn(() => ({ order: mockOrder }));
const mockFrom = vi.fn(() => ({ select: mockSelect }));

vi.mock("@/lib/supabase/public", () => ({
  getPublicClient: () => ({ from: mockFrom }),
}));

import { getPublicCategories } from "@/services/content/categories";

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Rows already RLS-filtered (only public categories reach the service). */
const appsRow = {
  id: "cat-apps-uuid",
  kind: "apps",
  nav_order: 10,
  category_translations: [{ locale: "da", title: "Apps" }],
  // The same slug in both locales.
  routes: [{ locale: "da", slug: "apps" }, { locale: "en", slug: "apps" }],
};

const servicesRow = {
  id: "cat-services-uuid",
  kind: "services",
  nav_order: 30,
  category_translations: [{ locale: "da", title: "Ydelser" }],
  // DA and EN route slugs differ: only the EN one (URL_SLUG_LOCALE) forms the href.
  routes: [{ locale: "da", slug: "ydelser" }, { locale: "en", slug: "services" }],
};

const appsRowEn = {
  id: "cat-apps-uuid",
  kind: "apps",
  nav_order: 10,
  category_translations: [{ locale: "en", title: "Apps" }],
  routes: [{ locale: "en", slug: "apps" }],
};

function mockCategoryRows(rows: typeof appsRow[]) {
  // Chain: .from("categories").select("...").order("nav_order")
  mockOrder.mockResolvedValue({ data: rows, error: null });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── AC-HOME-06: public categories returned and mapped ─────────────────────────

describe("AC-HOME-06: getPublicCategories — maps DB rows to PublicCategory", () => {
  it("returns one item per RLS-visible category row", async () => {
    mockCategoryRows([appsRow, servicesRow]);
    const result = await getPublicCategories("da");
    expect(result).toHaveLength(2);
  });

  it("maps id correctly", async () => {
    mockCategoryRows([appsRow]);
    const [cat] = await getPublicCategories("da");
    expect(cat!.id).toBe("cat-apps-uuid");
  });

  it("maps kind correctly", async () => {
    mockCategoryRows([appsRow]);
    const [cat] = await getPublicCategories("da");
    expect(cat!.kind).toBe("apps");
  });

  it("maps navOrder from nav_order", async () => {
    mockCategoryRows([appsRow]);
    const [cat] = await getPublicCategories("da");
    expect(cat!.navOrder).toBe(10);
  });

  it("maps title from the correct locale's category_translations row", async () => {
    mockCategoryRows([appsRow]);
    const [cat] = await getPublicCategories("da");
    expect(cat!.title).toBe("Apps");
  });

  it("maps href as a locale-aware slug path for DA (no /en prefix)", async () => {
    mockCategoryRows([appsRow]);
    const [cat] = await getPublicCategories("da");
    expect(cat!.href).toBe("/apps");
  });

  it("maps href as a /en-prefixed slug path for EN locale", async () => {
    mockCategoryRows([appsRowEn]);
    const [cat] = await getPublicCategories("en");
    expect(cat!.href).toBe("/en/apps");
  });

  it("AC-ENSLUG-08: DA category href uses the English route slug (URL_SLUG_LOCALE), not the DA one", async () => {
    mockCategoryRows([servicesRow]);
    const [cat] = await getPublicCategories("da");
    expect(cat!.href).toBe("/services");
  });

  it("AC-ENSLUG-08: EN category href uses the same English route slug", async () => {
    const servicesRowEn = { ...servicesRow, category_translations: [{ locale: "en", title: "Services" }] };
    mockCategoryRows([servicesRowEn]);
    const [cat] = await getPublicCategories("en");
    expect(cat!.href).toBe("/en/services");
  });
});

// ── AC-HOME-07: empty list when no public categories ─────────────────────────

describe("AC-HOME-07: getPublicCategories — returns empty array when no public categories", () => {
  it("returns [] when RLS returns no rows", async () => {
    mockCategoryRows([]);
    const result = await getPublicCategories("da");
    expect(result).toHaveLength(0);
  });

  it("returns an array (never null/undefined)", async () => {
    mockCategoryRows([]);
    const result = await getPublicCategories("da");
    expect(Array.isArray(result)).toBe(true);
  });
});

// ── Ordering: nav_order ascending ─────────────────────────────────────────────

describe("getPublicCategories — preserves DB-ordered nav_order sequence", () => {
  it("queries categories ordered by nav_order ascending", async () => {
    mockCategoryRows([appsRow, servicesRow]);
    await getPublicCategories("da");
    expect(mockFrom).toHaveBeenCalledWith("categories");
    // The .order() call should be on nav_order
    const orderArg: string = mockOrder.mock.calls[0]![0] as string;
    expect(orderArg).toMatch(/nav_order/);
  });

  it("returns items in the order provided by the DB query", async () => {
    // DB already returns them ordered; service must not re-sort
    mockCategoryRows([appsRow, servicesRow]);
    const result = await getPublicCategories("da");
    expect(result[0]!.kind).toBe("apps");
    expect(result[1]!.kind).toBe("services");
  });
});

// ── Return shape contract ──────────────────────────────────────────────────────

describe("getPublicCategories — return shape contract", () => {
  it("each item has id, kind, navOrder, title, href", async () => {
    mockCategoryRows([appsRow]);
    const [cat] = await getPublicCategories("da");
    expect(cat).toHaveProperty("id");
    expect(cat).toHaveProperty("kind");
    expect(cat).toHaveProperty("navOrder");
    expect(cat).toHaveProperty("title");
    expect(cat).toHaveProperty("href");
  });
});
