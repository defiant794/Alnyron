// @vitest-environment jsdom
/**
 * Unit tests — /admin/catalog/items/new page (src/app/admin/(panel)/catalog/items/new/page.tsx)
 * Journey: catalog-section-fix
 * Acceptance ID: AC-CATSEC-4
 *
 * The page MUST redirect to /admin/catalog when ?category is missing, not a
 * single value, or an unknown UUID, instead of preselecting a section (the
 * first one, "Apps") for the new item.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import "@testing-library/jest-dom/vitest";

const { mockListCatalogSections } = vi.hoisted(() => ({
  mockListCatalogSections: vi.fn(),
}));

// dynamic import required: vi.mock factories are hoisted above static imports by Vitest
vi.mock("next-intl/server", async () =>
  (await import("../../../helpers/next-intl-server")).nextIntlServerMock(),
);
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  usePathname: () => "/admin/catalog/items/new",
}));
vi.mock("@/services/auth/require-admin", () => ({
  requireAdmin: vi.fn(async () => ({
    userId: "u-1",
    email: "ejer@example.com",
    role: "owner",
  })),
}));
vi.mock("@/services/admin/catalog-read", () => ({
  listCatalogSections: mockListCatalogSections,
}));
// ItemEditorScreen is a heavy server component; stub it out for this unit test
vi.mock("@/app/admin/(panel)/catalog/items/item-editor-screen", () => ({
  default: vi.fn(() => null),
}));

import { redirect } from "next/navigation";
import NewItemPage from "@/app/admin/(panel)/catalog/items/new/page";
import type { AdminCatalogSection } from "@/services/admin/catalog-read";

const APPS_ID = "550e8400-e29b-41d4-a716-446655440010";
const WEBSITES_ID = "550e8400-e29b-41d4-a716-446655440020";

function makeSection(id: string, kind: AdminCatalogSection["kind"]): AdminCatalogSection {
  return {
    id,
    kind,
    status: "published",
    title: kind === "apps" ? "Apps" : "Hjemmesider",
    // The URL slug: the English route slug.
    slug: kind === "apps" ? "apps" : "websites",
    publishedCount: 0,
    draftCount: 0,
  };
}

const sections: AdminCatalogSection[] = [makeSection(APPS_ID, "apps"), makeSection(WEBSITES_ID, "websites")];

beforeEach(() => {
  mockListCatalogSections.mockResolvedValue(sections);
  vi.mocked(redirect).mockClear();
});

describe("AC-CATSEC-4: /admin/catalog/items/new with missing or unknown ?category redirects to /admin/catalog", () => {
  it("AC-CATSEC-4a: no ?category parameter → redirect('/admin/catalog')", async () => {
    await expect(
      NewItemPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow("NEXT_REDIRECT:/admin/catalog");

    expect(redirect).toHaveBeenCalledWith("/admin/catalog");
  });

  it("AC-CATSEC-4b: unknown uuid ?category → redirect('/admin/catalog')", async () => {
    const unknownId = "00000000-0000-0000-0000-000000000000";
    await expect(
      NewItemPage({ searchParams: Promise.resolve({ category: unknownId }) }),
    ).rejects.toThrow("NEXT_REDIRECT:/admin/catalog");

    expect(redirect).toHaveBeenCalledWith("/admin/catalog");
  });

  it("AC-CATSEC-4c: valid ?category renders without redirect and uses that category", async () => {
    // A known category id must NOT redirect, and the rendered item must have the
    // requested categoryId: guards against an "always redirect" or an
    // "always sections[0]" page.
    const el = await NewItemPage({ searchParams: Promise.resolve({ category: WEBSITES_ID }) });
    // el is the JSX element returned by the page; its item prop carries categoryId
    expect((el as React.ReactElement<{ item: { categoryId: string } }>).props.item.categoryId).toBe(WEBSITES_ID);
    expect(redirect).not.toHaveBeenCalled();
  });

  it("AC-CATSEC-4d: ?category as string[] → redirect('/admin/catalog')", async () => {
    // The searchParam type allows string | string[]; an array must also redirect.
    await expect(
      NewItemPage({ searchParams: Promise.resolve({ category: [APPS_ID, WEBSITES_ID] }) }),
    ).rejects.toThrow("NEXT_REDIRECT:/admin/catalog");

    expect(redirect).toHaveBeenCalledWith("/admin/catalog");
  });
});
