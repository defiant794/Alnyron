// @vitest-environment jsdom
/**
 * Unit test — the section editor page marks its section's kind in the admin
 * sidebar (F2.3 catalog-admin, AC-CATADM-06). The page is rendered inside the
 * admin shell, as the (panel) layout does for an admin: the shell's sidebar
 * only learns the kind from the page's <ActiveCatalogKind>, so this covers
 * the page → sidebar wiring. (The async shell is awaited directly; RTL cannot
 * render an async server component nested in the layout's element.)
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { CatalogKind } from "@/config/catalog";
import type { AdminCategoryDetail, AdminCategoryTranslation } from "@/services/admin/catalog-read";

const { SECTION_ID, USER, mockGetCategoryForEdit } = vi.hoisted(() => ({
  SECTION_ID: "550e8400-e29b-41d4-a716-446655440001",
  USER: { userId: "u-1", email: "ejer@example.com", role: "owner" } as const,
  mockGetCategoryForEdit: vi.fn(),
}));

// vi.mock is hoisted above the imports, so the shared factory is loaded lazily.
vi.mock("next-intl/server", async () =>
  (await import("../../../helpers/next-intl-server")).nextIntlServerMock(),
);
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  usePathname: () => `/admin/catalog/categories/${SECTION_ID}`,
}));
vi.mock("@/services/auth/require-admin", () => ({ requireAdmin: vi.fn(async () => USER) }));
vi.mock("@/services/admin/catalog-read", () => ({ getCategoryForEdit: mockGetCategoryForEdit }));
vi.mock("@/app/admin/(panel)/catalog/categories/[id]/actions", () => ({
  saveCategoryAction: vi.fn(),
  setCategoryStatusAction: vi.fn(),
  reorderItemsAction: vi.fn(),
}));
vi.mock("@/app/admin/(panel)/catalog/items/actions", () => ({ setItemStatusAction: vi.fn() }));
vi.mock("@/app/admin/(auth)/actions", () => ({ signOut: vi.fn() }));

import CategoryEditorPage from "@/app/admin/(panel)/catalog/categories/[id]/page";
import AdminShell from "@/components/admin/AdminShell";

const BLANK: AdminCategoryTranslation = { title: "", description: "", seo_title: "", seo_description: "", slug: null };

function section(kind: CatalogKind): AdminCategoryDetail {
  return { id: SECTION_ID, kind, status: "published", translations: { da: BLANK, en: BLANK }, items: [] };
}

afterEach(cleanup);

describe("AC-CATADM-06: the section editor page marks its section's kind in the sidebar", () => {
  it.each([
    ["apps", "Apps"],
    ["websites", "Hjemmesider"],
    ["services", "Ydelser"],
    ["models3d", "3D-modeller"],
  ] as const)(
    "AC-CATADM-06i: /admin/catalog/categories/<id> of a section of kind %s, rendered in the admin shell, marks only '%s' with aria-current='page'",
    async (kind, label) => {
      mockGetCategoryForEdit.mockResolvedValue(section(kind));
      render(
        await AdminShell({ user: USER, children: await CategoryEditorPage({ params: Promise.resolve({ id: SECTION_ID }) }) }),
      );

      expect(mockGetCategoryForEdit).toHaveBeenCalledWith(SECTION_ID);
      const nav = screen.getByRole("navigation", { name: "Administration" });
      const currentLinks = within(nav)
        .getAllByRole("link")
        .filter((l) => l.getAttribute("aria-current") === "page");
      expect(currentLinks.map((l) => l.textContent)).toEqual([label]);
    },
  );
});
