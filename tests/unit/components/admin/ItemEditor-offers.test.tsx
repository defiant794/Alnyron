// @vitest-environment jsdom
/**
 * Unit tests: src/components/admin/ItemEditor.tsx — 'Salg' section (S2 addition)
 * Journey: payments-s2-3d-purchase
 * Criteria: contract §1.2, §3 (ItemEditor offers for models3d only)
 *
 * Test IDs: S2-T-IE-OFR-01..11
 *
 * Contract §1.2:
 *   - 'Salg' section heading shown for models3d items only
 *   - Physical toggle: activates the physical offer row
 *   - Kr price input: parsed via parseKronerToOre
 *   - Digital price input: disabled live toggle + note 'kan ikke købes endnu'
 *   - saveItemSchema gains optional `offers`
 *   - catalogActionError maps: offers_invalid → "offers-invalid",
 *                              offers_not_allowed → "offers-not-allowed",
 *                              item_has_offers → "item-has-offers"
 *   - CatalogActionError type gains these three codes
 *   - getItemForEdit returns offers: {kind, priceOre, active}[]
 *
 * `catalogActionError` lives in the server-only catalog service; its Supabase
 * server client (which imports `server-only`) is mocked here, as the service
 * unit tests do: this file only calls the pure error mapping.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

const { mockReplace, mockMaybeSingle } = vi.hoisted(() => ({ mockReplace: vi.fn(), mockMaybeSingle: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mockReplace }) }));
// getItemForEdit's chain: from("items").select(…).eq("id", id).maybeSingle() → the next mockMaybeSingle value.
vi.mock("@/lib/supabase/server", () => ({
  createServerClient: vi.fn(async () => ({
    from: vi.fn(() => ({ select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockMaybeSingle })) })) })),
  })),
}));

import ItemEditor, { type ItemEditorProps } from "@/components/admin/ItemEditor";
import da from "../../../../messages/da.json";
import { catalogActionError } from "@/services/admin/catalog";
import { getItemForEdit } from "@/services/admin/catalog-read";

const CAT_ID = "550e8400-e29b-41d4-a716-446655440001";
const ITEM_ID = "550e8400-e29b-41d4-a716-446655440002";
const m = da.Admin.catalog;

const itemFields = (code: string) => ({
  title: `Titel (${code})`,
  slug: `URL-slug (${code})`,
  summary: `Resumé (${code})`,
  body: `Brødtekst (${code})`,
  seoTitle: `SEO-titel (${code})`,
  seoDescription: `SEO-beskrivelse (${code})`,
});

/** The item editor's labels as the page builds them from da.json, with test-local offer error messages. */
const ITEM_LABELS: ItemEditorProps["labels"] = {
  languages: m.languages,
  locales: m.locales,
  contentHeading: m.item.contentHeading,
  sideHeading: m.item.sideHeading,
  fields: { da: itemFields("DA"), en: itemFields("EN") },
  slugHint: m.item.fields.slugHint,
  bodyHint: m.item.fields.bodyHint,
  seoTitleHint: m.item.fields.seoTitleHint,
  seoDescriptionHint: m.item.fields.seoDescriptionHint,
  enHint: m.item.enHint,
  section: m.item.fields.section,
  sectionHint: m.item.fields.sectionHint,
  priceType: m.item.fields.priceType,
  priceTypes: m.item.fields.priceTypes,
  amount: m.item.fields.amount,
  amountHint: m.item.fields.amountHint,
  links: m.item.fields.links,
  linkKeys: m.item.fields.linkKeys,
  featured: m.item.fields.featured,
  featuredHint: m.item.fields.featuredHint,
  save: m.item.save,
  saveDraft: m.item.saveDraft,
  publish: m.item.publish,
  publishHint: m.item.publishHint,
  hide: m.item.hide,
  preview: m.item.preview,
  previewHint: m.item.previewHint,
  newTab: m.newTab,
  delete: m.item.delete,
  confirmDelete: m.item.confirmDelete,
  saved: m.item.saved,
  savedDraft: m.item.savedDraft,
  published: m.item.published,
  hidden: m.item.hidden,
  // The three offer error keys of CatalogActionError (test-local copy, not da.json's)
  errors: {
    ...m.errors,
    "offers-invalid": "Ugyldig salgskonfiguration",
    "offers-not-allowed": "Salg er ikke tilladt for denne kategori",
    "item-has-offers": "Fjern salgspriserne, inden du skifter kategori",
  },
  media: {
    heading: m.media.heading,
    saveFirst: m.media.saveFirst,
    empty: m.media.empty,
    addImage: m.media.addImage,
    uploading: m.media.uploading,
    busy: m.media.busy,
    altDaLabel: m.media.altDa,
    altEnLabel: m.media.altEn,
    image: m.media.image,
    remove: m.media.remove,
    confirmRemove: m.media.confirmRemove,
    errors: m.media.errors,
    moveUp: m.media.moveUp,
    moveDown: m.media.moveDown,
    counts: Array.from({ length: 9 }, (_, count) => `${count} af 8`),
  },
  offers: m.item.offers,
};

const MODELS3D_SECTION = { id: CAT_ID, title: "3D-modeller", kind: "models3d" as const };
const SERVICES_SECTION = { id: "other-id", title: "Ydelser", kind: "services" as const };

function models3dItem(overrides: Partial<ItemEditorProps["item"]> = {}): ItemEditorProps["item"] {
  return {
    categoryId: CAT_ID,
    status: "draft",
    featured: false,
    priceType: null,
    priceAmount: null,
    externalLinks: {},
    translations: { da: null, en: null },
    media: [],
    offers: [],
    ...overrides,
  };
}

const save = vi.fn();
const setStatus = vi.fn();
const remove = vi.fn();
const createUpload = vi.fn();
const attach = vi.fn();
const detach = vi.fn();

function renderItem(item: ItemEditorProps["item"], sections: ItemEditorProps["sections"] = [MODELS3D_SECTION]) {
  return render(
    <ItemEditor
      item={item}
      sections={sections}
      previewHref={null}
      sectionHref="/admin/catalog"
      save={save}
      setStatus={setStatus}
      remove={remove}
      createUpload={createUpload}
      attach={attach}
      detach={detach}
      labels={ITEM_LABELS}
    />,
  );
}

afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); });

// ── S2-T-IE-OFR-01: 'Salg' section heading for models3d ──────────────────

describe("S2-T-IE-OFR-01: ItemEditor — 'Salg' section shown for models3d item", () => {
  it("renders a 'Salg' section heading when category is models3d", () => {
    renderItem(models3dItem());
    expect(screen.getByRole("heading", { name: "Salg" })).toBeInTheDocument();
  });

  it("does NOT render the 'Salg' section for a non-models3d category", () => {
    renderItem(
      { ...models3dItem(), categoryId: "other-id" },
      [SERVICES_SECTION],
    );
    expect(screen.queryByRole("heading", { name: "Salg" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Sælg som 3D-print" })).toBeNull();
  });
});

// ── S2-T-IE-OFR-02: physical offer toggle ────────────────────────────────

describe("S2-T-IE-OFR-02: ItemEditor — physical offer toggle + kr price input", () => {
  it("an inactive offer set: the 'Sælg som 3D-print' toggle is unchecked and the price empty", () => {
    renderItem(models3dItem());
    expect(screen.getByRole("checkbox", { name: "Sælg som 3D-print" })).not.toBeChecked();
    expect(screen.getByLabelText("Pris inkl. moms og levering i DK (kr.)")).toHaveValue("");
  });

  it("a live physical offer of 24995 øre: the toggle is checked and the price reads '249,95' kroner", () => {
    renderItem(models3dItem({ offers: [{ kind: "physical", priceOre: 24995, active: true }] }));
    expect(screen.getByRole("checkbox", { name: "Sælg som 3D-print" })).toBeChecked();
    expect(screen.getByLabelText("Pris inkl. moms og levering i DK (kr.)")).toHaveValue("249,95");
  });
});

// ── S2-T-IE-OFR-03: digital price note ───────────────────────────────────

describe("S2-T-IE-OFR-03: ItemEditor — digital price input disabled with note 'kan ikke købes endnu'", () => {
  it("the disabled digital switch is described by the 'kan ikke købes endnu' note", () => {
    renderItem(models3dItem());
    const digital = screen.getByRole("checkbox", { name: "Sælg den digitale fil" });
    expect(digital).toBeDisabled();
    expect(digital).toHaveAccessibleDescription("Den digitale fil kan ikke købes endnu. Prisen gemmes til senere.");
  });
});

// ── S2-T-IE-OFR-04: the Danish messages of the offer errors ──────────────

describe("S2-T-IE-OFR-04: da.json — the Danish message of each offer error code", () => {
  it.each([
    [
      "offers-invalid",
      "Salget kunne ikke gemmes. Prisen skal være mellem {min} og {max} kr., og den digitale udgave kan ikke sælges endnu.",
    ],
    [
      "offers-not-allowed",
      "Kun elementer i en 3D-sektion kan sælges. Fjern salgsprisen, eller flyt elementet til en 3D-sektion.",
    ],
    [
      "item-has-offers",
      "Elementet har salgspriser. Fjern dem, før du flytter det til en sektion, der ikke er til 3D-figurer.",
    ],
  ] as const)("%s reads %j (the price range comes from config, never written out)", (code, message) => {
    expect(m.errors[code]).toBe(message);
  });
});

// ── S2-T-IE-OFR-05: catalogActionError maps new offer error codes ─────────

describe("S2-T-IE-OFR-05: catalogActionError — maps new offer RPC error codes", () => {
  it("{code:'22023', message:'offers_invalid'} → 'offers-invalid'", () => {
    expect(catalogActionError({ code: "22023", message: "offers_invalid" })).toBe("offers-invalid");
  });

  it("{code:'P0001', message:'offers_not_allowed'} → 'offers-not-allowed'", () => {
    expect(catalogActionError({ code: "P0001", message: "offers_not_allowed" })).toBe("offers-not-allowed");
  });

  it("{code:'P0001', message:'item_has_offers'} → 'item-has-offers'", () => {
    expect(catalogActionError({ code: "P0001", message: "item_has_offers" })).toBe("item-has-offers");
  });

  // Regression: existing codes must not change
  it("plain {code:'22023', message:'other'} stays 'invalid'", () => {
    expect(catalogActionError({ code: "22023", message: "other" })).toBe("invalid");
  });

  it("unrelated {code:'P0001', message:'missing_slugs'} stays 'missing-slugs'", () => {
    expect(catalogActionError({ code: "P0001", message: "missing_slugs" })).toBe("missing-slugs");
  });

  it("unrelated {code:'P0001', message:'unknown'} stays 'failed'", () => {
    expect(catalogActionError({ code: "P0001", message: "unknown" })).toBe("failed");
  });
});

// ── S2-T-IE-OFR-06: getItemForEdit returns offers ─────────────────────────

describe("S2-T-IE-OFR-06: getItemForEdit — returns offers: {kind, priceOre, active}[]", () => {
  const itemRow = (itemOffers: { kind: string; price_ore: number; active: boolean }[]) => ({
    id: ITEM_ID,
    category_id: CAT_ID,
    status: "draft",
    featured: false,
    price_type: null,
    price_amount: null,
    external_links: {},
    item_translations: [],
    media: [],
    item_offers: itemOffers,
  });

  it("maps the item's item_offers rows to {kind, priceOre, active}, physical before digital", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: itemRow([
        { kind: "digital", price_ore: 4950, active: false },
        { kind: "physical", price_ore: 24995, active: true },
      ]),
      error: null,
    });
    expect((await getItemForEdit(ITEM_ID))?.offers).toEqual([
      { kind: "physical", priceOre: 24995, active: true },
      { kind: "digital", priceOre: 4950, active: false },
    ]);
  });

  it("an item without offers → offers: []", async () => {
    mockMaybeSingle.mockResolvedValue({ data: itemRow([]), error: null });
    expect((await getItemForEdit(ITEM_ID))?.offers).toEqual([]);
  });
});

// ── S2-T-IE-OFR-07: physical price submitted as parseKronerToOre ──────────

describe("S2-T-IE-OFR-07: ItemEditor — physical price input is parsed via parseKronerToOre", () => {
  it("saves physical offer with price_ore=24995 when the admin types '249,95'", async () => {
    const user = userEvent.setup();
    save.mockResolvedValue({ ok: true, id: ITEM_ID });
    renderItem(models3dItem({ offers: [{ kind: "physical", priceOre: 0, active: true }] }));

    const priceInput = screen.getByLabelText("Pris inkl. moms og levering i DK (kr.)");
    expect(priceInput).toHaveValue("0");
    await user.clear(priceInput);
    await user.type(priceInput, "249,95");
    await user.type(screen.getByLabelText("Titel (DA)"), "Drage");
    await user.click(screen.getByRole("button", { name: m.item.saveDraft }));

    expect(save).toHaveBeenCalledOnce();
    const payload = save.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.offers).toEqual([{ kind: "physical", price_ore: 24995, active: true }]);
  });
});

// ── S2-T-IE-OFR-08: 'Salg' section only for models3d (not services) ───────

describe("S2-T-IE-OFR-08: ItemEditor — 'Salg' section not shown for non-models3d item on change", () => {
  it("switching category from models3d to services hides the Salg section", async () => {
    const user = userEvent.setup();
    renderItem(models3dItem(), [MODELS3D_SECTION, SERVICES_SECTION]);

    // Salg section present initially (models3d)
    expect(screen.getByRole("heading", { name: "Salg" })).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText(m.item.fields.section), "other-id");
    // After switching away from models3d, Salg is hidden
    expect(screen.queryByRole("heading", { name: "Salg" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Sælg som 3D-print" })).toBeNull();
    expect(screen.queryByLabelText("Pris inkl. moms og levering i DK (kr.)")).toBeNull();
  });
});

// ── S2-T-IE-OFR-09: client checks of the offer prices ────────────────────

describe("S2-T-IE-OFR-09: ItemEditor — offer prices are checked before saving", () => {
  it.each([
    ["1.234,50", false, "price-format"],
    ["2,49", false, "price-range"],
    ["50000,01", false, "price-range"],
    ["", true, "price-required"],
  ] as const)("physical price '%s' (live: %s) → %s at the field, focused, no save", async (price, live, error) => {
    const user = userEvent.setup();
    renderItem(models3dItem({ translations: { da: null, en: null } }));
    await user.type(screen.getByLabelText("Titel (DA)"), "Drage");
    if (price) await user.type(screen.getByLabelText("Pris inkl. moms og levering i DK (kr.)"), price);
    if (live) await user.click(screen.getByRole("checkbox", { name: "Sælg som 3D-print" }));
    await user.click(screen.getByRole("button", { name: m.item.saveDraft }));

    const input = screen.getByLabelText("Pris inkl. moms og levering i DK (kr.)");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(expect.stringContaining(m.item.offers.errors[error]));
    expect(input).toHaveFocus();
    expect(save).not.toHaveBeenCalled();
    // A field error, not a form-level alert
    expect(screen.queryByText("Ugyldig salgskonfiguration")).toBeNull();
  });
});

// ── S2-T-IE-OFR-10: offers sent only for a models3d item ─────────────────

describe("S2-T-IE-OFR-10: ItemEditor — the save payload's offers", () => {
  it("a services item sends no offers key (its offers, if any, are kept; moving one out is refused)", async () => {
    const user = userEvent.setup();
    save.mockResolvedValue({ ok: true, id: ITEM_ID });
    renderItem({ ...models3dItem(), categoryId: "other-id" }, [SERVICES_SECTION]);
    await user.type(screen.getByLabelText("Titel (DA)"), "Webdesign");
    await user.click(screen.getByRole("button", { name: m.item.saveDraft }));
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]?.[0]).not.toHaveProperty("offers");
  });

  it("a models3d item with blank prices sends offers: [] (clears the set)", async () => {
    const user = userEvent.setup();
    save.mockResolvedValue({ ok: true, id: ITEM_ID });
    renderItem(models3dItem());
    await user.type(screen.getByLabelText("Titel (DA)"), "Drage");
    await user.click(screen.getByRole("button", { name: m.item.saveDraft }));
    expect((save.mock.calls[0]?.[0] as Record<string, unknown>).offers).toEqual([]);
  });

  it("the digital price is saved as an inactive offer; saved prices are shown in kroner", async () => {
    const user = userEvent.setup();
    save.mockResolvedValue({ ok: true, id: ITEM_ID });
    renderItem(models3dItem({ offers: [{ kind: "physical", priceOre: 24900, active: false }] }));
    expect(screen.getByLabelText("Pris inkl. moms og levering i DK (kr.)")).toHaveValue("249");
    expect(screen.getByRole("checkbox", { name: "Sælg som 3D-print" })).not.toBeChecked();
    await user.type(screen.getByLabelText("Digital fil: pris (kr.)"), "49,5");
    await user.type(screen.getByLabelText("Titel (DA)"), "Drage");
    await user.click(screen.getByRole("button", { name: m.item.saveDraft }));
    expect((save.mock.calls[0]?.[0] as Record<string, unknown>).offers).toEqual([
      { kind: "physical", price_ore: 24900, active: false },
      { kind: "digital", price_ore: 4950, active: false },
    ]);
  });
});

// ── S2-T-IE-OFR-11: server refusals of offers shown as form alerts ───────

describe("S2-T-IE-OFR-11: ItemEditor — offers-not-allowed / item-has-offers from the server", () => {
  it.each(["offers-not-allowed", "item-has-offers", "offers-invalid"] as const)(
    "%s → its message as a form-level alert",
    async (error) => {
      const user = userEvent.setup();
      save.mockResolvedValue({ ok: false, error });
      renderItem(models3dItem());
      await user.type(screen.getByLabelText("Titel (DA)"), "Drage");
      await user.click(screen.getByRole("button", { name: m.item.saveDraft }));
      expect(await screen.findByRole("alert")).toHaveTextContent(ITEM_LABELS.errors[error]);
    },
  );
});

describe("catalog-3d-price-field-cleanup: ItemEditor display pricing", () => {
  it("AC1: shows Pristype and Beløb for a 3D item with selling off", () => {
    renderItem(models3dItem({ offers: [{ kind: "physical", priceOre: 24900, active: false }] }));

    expect(screen.getByRole("checkbox", { name: "Sælg som 3D-print" })).not.toBeChecked();
    expect(screen.getByRole("group", { name: m.item.fields.priceType })).toBeVisible();
    expect(screen.getByRole("radio", { name: m.item.fields.priceTypes.fixed })).toBeVisible();
    expect(screen.getByLabelText(m.item.fields.amount)).toBeVisible();
  });

  it("AC2: hides Pristype and Beløb immediately when selling is toggled on without saving", async () => {
    const user = userEvent.setup();
    renderItem(models3dItem());

    await user.click(screen.getByRole("checkbox", { name: "Sælg som 3D-print" }));

    expect(screen.getByRole("checkbox", { name: "Sælg som 3D-print" })).toBeChecked();
    expect(screen.queryByRole("group", { name: m.item.fields.priceType })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(m.item.fields.amount)).not.toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });

  it("AC2: hides Pristype and Beløb when opening a 3D item already selling", () => {
    renderItem(models3dItem({
      priceType: "fixed",
      priceAmount: 100,
      offers: [{ kind: "physical", priceOre: 24900, active: true }],
    }));

    expect(screen.getByRole("checkbox", { name: "Sælg som 3D-print" })).toBeChecked();
    expect(screen.queryByRole("group", { name: m.item.fields.priceType })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(m.item.fields.amount)).not.toBeInTheDocument();
  });

  it("AC3: restores Pristype and Beløb when selling is toggled back off without saving", async () => {
    const user = userEvent.setup();
    renderItem(models3dItem());
    const selling = screen.getByRole("checkbox", { name: "Sælg som 3D-print" });

    await user.click(selling);
    expect(screen.queryByRole("group", { name: m.item.fields.priceType })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(m.item.fields.amount)).not.toBeInTheDocument();
    await user.click(selling);

    expect(selling).not.toBeChecked();
    expect(screen.getByRole("group", { name: m.item.fields.priceType })).toBeVisible();
    expect(screen.getByLabelText(m.item.fields.amount)).toBeVisible();
    expect(save).not.toHaveBeenCalled();
  });

  it("AC4: saves null display price type and amount after selecting Fast and enabling selling", async () => {
    const user = userEvent.setup();
    save.mockResolvedValue({ ok: true, id: ITEM_ID });
    renderItem(models3dItem());
    await user.type(screen.getByLabelText("Titel (DA)"), "Drage");
    await user.click(screen.getByRole("radio", { name: m.item.fields.priceTypes.fixed }));
    await user.type(screen.getByLabelText(m.item.fields.amount), "125");
    await user.click(screen.getByRole("checkbox", { name: "Sælg som 3D-print" }));
    await user.type(screen.getByLabelText("Pris inkl. moms og levering i DK (kr.)"), "249");

    await user.click(screen.getByRole("button", { name: m.item.saveDraft }));

    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      price_type: null,
      price_amount: null,
      offers: [{ kind: "physical", price_ore: 24900, active: true }],
    }));
  });

  it("AC4: resets display price to Ingen after saving while selling, so a later save does not re-send a stale price", async () => {
    const user = userEvent.setup();
    save.mockResolvedValue({ ok: true, id: ITEM_ID });
    renderItem(models3dItem({ id: ITEM_ID }));
    await user.type(screen.getByLabelText("Titel (DA)"), "Drage");
    await user.click(screen.getByRole("radio", { name: m.item.fields.priceTypes.fixed }));
    await user.type(screen.getByLabelText(m.item.fields.amount), "125");
    const selling = screen.getByRole("checkbox", { name: "Sælg som 3D-print" });

    await user.click(selling);
    await user.click(selling);
    expect(screen.getByRole("radio", { name: m.item.fields.priceTypes.fixed })).toBeChecked();
    expect(screen.getByLabelText(m.item.fields.amount)).toHaveValue(125);
    await user.click(selling);
    await user.type(screen.getByLabelText("Pris inkl. moms og levering i DK (kr.)"), "249");
    await user.click(screen.getByRole("button", { name: m.item.saveDraft }));
    expect(await screen.findByText(m.item.savedDraft)).toBeVisible();
    expect(save).toHaveBeenNthCalledWith(1, expect.objectContaining({
      price_type: null,
      price_amount: null,
    }));

    await user.click(selling);
    expect(screen.getByRole("radio", { name: m.item.fields.priceTypes.none })).toBeChecked();
    expect(screen.getByRole("radio", { name: m.item.fields.priceTypes.fixed })).not.toBeChecked();
    expect(screen.getByLabelText(m.item.fields.amount)).toHaveValue(null);
    await user.click(screen.getByRole("button", { name: m.item.saveDraft }));

    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenNthCalledWith(2, expect.objectContaining({
      price_type: null,
      price_amount: null,
    }));
  });

  it.each(["apps", "websites", "services"] as const)(
    "AC5 / AC6: keeps Pristype, Beløb, and Fast available for %s without selling controls",
    async (kind) => {
      const user = userEvent.setup();
      const section = { id: "other-id", title: kind, kind };
      renderItem(models3dItem({ categoryId: section.id }), [section]);

      expect(screen.getByRole("group", { name: m.item.fields.priceType })).toBeVisible();
      expect(screen.getByLabelText(m.item.fields.amount)).toBeVisible();
      const fixed = screen.getByRole("radio", { name: "Fast" });
      expect(fixed).toBeVisible();
      await user.click(fixed);
      await user.type(screen.getByLabelText(m.item.fields.amount), "125");

      expect(fixed).toBeChecked();
      expect(screen.getByRole("group", { name: m.item.fields.priceType })).toBeVisible();
      expect(screen.getByLabelText(m.item.fields.amount)).toBeVisible();
      expect(screen.getByLabelText(m.item.fields.amount)).toHaveValue(125);
      expect(screen.queryByRole("heading", { name: "Salg" })).not.toBeInTheDocument();
      expect(screen.queryByRole("checkbox", { name: "Sælg som 3D-print" })).not.toBeInTheDocument();
    },
  );
});
