// @vitest-environment jsdom
/**
 * Unit test — item editor screen (src/app/admin/(panel)/catalog/items/item-editor-screen.tsx)
 * Journeys: catalog-section-fix, english-slugs
 * Acceptance IDs: AC-CATSEC-3, AC-ENSLUG-07, AC-ENSLUG-07b, AC-ENSLUG-07c
 *
 * "+ Nyt element" of another section is the same route (`items/new`) with
 * another `?category`, so a client-side navigation between two of them
 * renders the next screen into the mounted one. The section select is
 * uncontrolled: only a remount, from the new-item editor's key naming its
 * section, gives it the next section as its value. The async server
 * component is awaited directly and rerendered in place, as the App Router
 * renders the next page.
 *
 * The preview link and the URL-slug hints follow the english-slugs contract:
 * the EN item slug is the public address on both locales.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type * as NextNavigation from "next/navigation";
import type { ItemEditorItem } from "@/components/admin/ItemEditor";
import type { AdminCatalogSection } from "@/services/admin/catalog-read";
import da from "../../../../messages/da.json";

// vi.mock is hoisted above the imports, so the shared factory is loaded lazily.
vi.mock("next-intl/server", async () =>
  (await import("../../../helpers/next-intl-server")).nextIntlServerMock(),
);
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock("@/app/admin/(panel)/catalog/items/actions", () => ({
  saveItemAction: vi.fn(),
  setItemStatusAction: vi.fn(),
  deleteItemAction: vi.fn(),
}));
vi.mock("@/app/admin/(panel)/catalog/items/[id]/media-actions", () => ({
  attachMediaAction: vi.fn(),
  createMediaUploadAction: vi.fn(),
  detachMediaAction: vi.fn(),
}));

import ItemEditorScreen from "@/app/admin/(panel)/catalog/items/item-editor-screen";

const m = da.Admin.catalog;
const APPS_ID = "550e8400-e29b-41d4-a716-446655440010";
const WEBSITES_ID = "550e8400-e29b-41d4-a716-446655440020";

const SECTIONS: AdminCatalogSection[] = [
  { id: APPS_ID, kind: "apps", status: "published", title: "Apps", slug: "apps", publishedCount: 0, draftCount: 0 },
  { id: WEBSITES_ID, kind: "websites", status: "published", title: "Hjemmesider", slug: "websites", publishedCount: 0, draftCount: 0 },
];

/** A published Apps item whose DA slug ("puls") differs from its EN slug ("pulse"). */
const PUBLISHED_ITEM: ItemEditorItem = {
  id: "550e8400-e29b-41d4-a716-446655440099",
  categoryId: APPS_ID,
  status: "published",
  featured: false,
  priceType: null,
  priceAmount: null,
  externalLinks: {},
  translations: {
    da: { slug: "puls", title: "Puls", summary: "", body_md: "", seo_title: "", seo_description: "" },
    en: { slug: "pulse", title: "Pulse", summary: "", body_md: "", seo_title: "", seo_description: "" },
  },
  media: [],
};

/** The item `/admin/catalog/items/new?category=<categoryId>` edits. */
function newItem(categoryId: string): ItemEditorItem {
  return {
    categoryId,
    status: "draft",
    featured: false,
    priceType: null,
    priceAmount: null,
    externalLinks: {},
    translations: { da: null, en: null },
    media: [],
  };
}

afterEach(cleanup);

describe("AC-CATSEC-3: the new-item editor of another section shows that section", () => {
  it("AC-CATSEC-3u: rerendered in place with a new item of Hjemmesider, the Apps new-item screen's section select and breadcrumb show Hjemmesider", async () => {
    const { rerender } = render(await ItemEditorScreen({ item: newItem(APPS_ID), sections: SECTIONS }));
    expect(screen.getByRole("combobox", { name: m.item.fields.section })).toHaveDisplayValue("Apps");

    rerender(await ItemEditorScreen({ item: newItem(WEBSITES_ID), sections: SECTIONS }));

    const select = screen.getByRole("combobox", { name: m.item.fields.section });
    expect(select).toHaveValue(WEBSITES_ID);
    expect(select).toHaveDisplayValue("Hjemmesider");
    const breadcrumb = screen.getByRole("navigation", { name: m.breadcrumb });
    expect(breadcrumb).toHaveTextContent("Hjemmesider");
    expect(breadcrumb).not.toHaveTextContent("Apps");
  });
});

describe("AC-ENSLUG-07c: the preview link uses the EN item slug", () => {
  it("AC-ENSLUG-07c: 'Forhåndsvis' links to /apps/pulse, not the DA slug /apps/puls", async () => {
    render(await ItemEditorScreen({ item: PUBLISHED_ITEM, sections: SECTIONS }));
    expect(screen.getByRole("link", { name: /Forhåndsvis/ })).toHaveAttribute("href", "/apps/pulse");
  });
});

// ItemEditorScreen builds its labels from the real messages; the hints are read
// as the accessible descriptions of the two URL-slug fields (both tab panels
// are in the DOM), so neither locale's field can match the other's copy.
describe("AC-ENSLUG-07/07b: URL-slug field hints reflect the English-slug contract", () => {
  it("AC-ENSLUG-07: the DA URL-slug hint says the Danish slug is not part of the address", async () => {
    render(await ItemEditorScreen({ item: PUBLISHED_ITEM, sections: SECTIONS }));
    expect(screen.getByLabelText("URL-slug (DA)")).toHaveAccessibleDescription(
      /engelske URL-slug på begge sprog, så den danske er ikke en del af adressen/,
    );
  });

  it("AC-ENSLUG-07b: the EN URL-slug hint says it forms the address on both languages, without an em-dash", async () => {
    render(await ItemEditorScreen({ item: PUBLISHED_ITEM, sections: SECTIONS }));
    const enField = screen.getByLabelText("URL-slug (EN)");
    expect(enField).toHaveAccessibleDescription(/offentlige adresse på begge sprog/);
    expect(enField).not.toHaveAccessibleDescription(/—/);
  });
});
