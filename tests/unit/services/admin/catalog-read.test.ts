/**
 * Unit tests: catalog overview read (src/services/admin/catalog-read.ts:
 * listCatalogSections). Its `slug` is the section's URL slug: the admin
 * overview path and the item editor's preview link are built from it.
 * Journey: english-slugs
 * Acceptance ID: AC-ENSLUG-07c
 *
 * The Supabase server client is mocked: the
 * `.from().select().order().order()` chain resolves to the next `mockOrder`
 * value.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockOrder } = vi.hoisted(() => ({ mockOrder: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: vi.fn(async () => ({
    from: vi.fn(() => ({ select: vi.fn(() => ({ order: vi.fn(() => ({ order: mockOrder })) })) })),
  })),
}));

import { listCatalogSections } from "@/services/admin/catalog-read";

const servicesRow = {
  id: "cat-services-uuid",
  kind: "services",
  status: "published",
  category_translations: [
    { locale: "en", title: "Services" },
    { locale: "da", title: "Ydelser" },
  ],
  // DA and EN route slugs differ: only the EN one is the URL slug.
  routes: [
    { locale: "da", slug: "ydelser" },
    { locale: "en", slug: "services" },
  ],
  items: [{ status: "published" }, { status: "draft" }, { status: "published" }],
};

beforeEach(() => {
  mockOrder.mockResolvedValue({ data: [servicesRow], error: null });
});

describe("AC-ENSLUG-07c: listCatalogSections takes the URL slug from the EN route", () => {
  it("gives the EN route slug when the DA and EN route slugs differ", async () => {
    expect(await listCatalogSections()).toEqual([
      {
        id: "cat-services-uuid",
        kind: "services",
        status: "published",
        title: "Ydelser",
        slug: "services",
        publishedCount: 2,
        draftCount: 1,
      },
    ]);
  });

  it("gives no slug for a section without an EN route, never the DA one", async () => {
    mockOrder.mockResolvedValue({ data: [{ ...servicesRow, routes: [{ locale: "da", slug: "ydelser" }] }], error: null });
    expect((await listCatalogSections())[0]?.slug).toBeNull();
  });

  it("throws when the query fails", async () => {
    mockOrder.mockResolvedValue({ data: null, error: { message: "connection refused" } });
    await expect(listCatalogSections()).rejects.toThrow(/connection refused/);
  });
});
