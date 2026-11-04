// @vitest-environment jsdom
/**
 * Unit tests — ItemEditor + CategoryEditor submit payloads (F2.3 catalog-admin)
 * Journey: catalog-admin
 * Acceptance IDs: AC-CATADM-10, AC-CATADM-14, AC-CATADM-20, AC-CATADM-21,
 *                 AC-CATADM-22, AC-CATADM-23, AC-CATADM-24, AC-CATADM-25,
 *                 AC-CATADM-28, AC-CATADM-49
 *
 * Pins what the editors send to the Server Actions (the F2.1 write schemas):
 * slug prefill, the local DA-title check, price type/amount, links, media
 * alt + order, save-then-publish and save-then-visibility.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

const { mockReplace } = vi.hoisted(() => ({ mockReplace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mockReplace }) }));

import CategoryEditor, { type CategoryEditorProps } from "@/components/admin/CategoryEditor";
import ItemEditor, { type ItemEditorProps } from "@/components/admin/ItemEditor";
import da from "../../../../messages/da.json";

const CAT_ID = "550e8400-e29b-41d4-a716-446655440001";
const ITEM_ID = "550e8400-e29b-41d4-a716-446655440002";
const MEDIA_ID = "550e8400-e29b-41d4-a716-446655440003";
const m = da.Admin.catalog;

const itemFields = (code: string) => ({
  title: `Titel (${code})`,
  slug: `URL-slug (${code})`,
  summary: `Resumé (${code})`,
  body: `Brødtekst (${code})`,
  seoTitle: `SEO-titel (${code})`,
  seoDescription: `SEO-beskrivelse (${code})`,
});

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
  errors: m.errors,
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
};

const NEW_ITEM: ItemEditorProps["item"] = {
  categoryId: CAT_ID,
  status: "draft",
  featured: false,
  priceType: null,
  priceAmount: null,
  externalLinks: {},
  translations: { da: null, en: null },
  media: [],
};

const translation = (slug: string, title: string) => ({
  slug,
  title,
  summary: "",
  body_md: "",
  seo_title: "",
  seo_description: "",
});

const SAVED_DRAFT: ItemEditorProps["item"] = {
  ...NEW_ITEM,
  id: ITEM_ID,
  priceType: "from",
  priceAmount: 149,
  translations: { da: translation("puls", "Puls"), en: translation("pulse", "Pulse") },
  media: [
    { id: MEDIA_ID, src: "https://e2e.supabase.co/a.webp", path: "a", altDa: "Forside", altEn: "", position: 1 },
    { id: CAT_ID, src: "https://e2e.supabase.co/b.webp", path: "b", altDa: "Bagside", altEn: "Back", position: 2 },
  ],
};

const save = vi.fn();
const setStatus = vi.fn();

function renderItem(item: ItemEditorProps["item"]) {
  return render(
    <ItemEditor
      item={item}
      sections={[{ id: CAT_ID, title: "Apps" }]}
      previewHref={null}
      sectionHref={`/admin/catalog/categories/${CAT_ID}`}
      save={save}
      setStatus={setStatus}
      remove={vi.fn()}
      createUpload={vi.fn()}
      attach={vi.fn()}
      detach={vi.fn()}
      labels={ITEM_LABELS}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("AC-CATADM-20/23: ItemEditor — new item", () => {
  it("AC-CATADM-23a: a blank DA title is reported without calling saveItem", async () => {
    const user = userEvent.setup();
    renderItem(NEW_ITEM);

    await user.click(screen.getByRole("button", { name: "Gem kladde" }));

    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(m.errors["da-title-required"]);
  });

  it("AC-CATADM-20a: Udgiv is disabled and MediaManager asks to save first", () => {
    renderItem(NEW_ITEM);

    expect(screen.getByRole("button", { name: "Udgiv" })).toBeDisabled();
    expect(screen.getByText(m.media.saveFirst)).toBeInTheDocument();
  });
});

describe("AC-CATADM-21/25: ItemEditor — slug prefill and price payload", () => {
  it("AC-CATADM-21a: leaving the DA title prefills an empty DA slug", async () => {
    const user = userEvent.setup();
    renderItem(NEW_ITEM);

    await user.type(screen.getByLabelText("Titel (DA)"), "Ærø Æbler");
    await user.tab();

    expect(screen.getByLabelText("URL-slug (DA)")).toHaveValue("aeroe-aebler");
  });

  it("AC-CATADM-25a: fixed price without amount is sent as fixed + null and the error shows at the amount", async () => {
    const user = userEvent.setup();
    save.mockResolvedValue({ ok: false, error: "price-invalid" });
    renderItem(NEW_ITEM);

    await user.type(screen.getByLabelText("Titel (DA)"), "E2E Price Test");
    await user.click(screen.getByRole("radio", { name: "Fast" }));
    await user.type(screen.getByLabelText(m.item.fields.linkKeys.website), "https://alnyron.dk");
    await user.click(screen.getByRole("button", { name: "Gem kladde" }));

    expect(save).toHaveBeenCalledExactlyOnceWith({
      category_id: CAT_ID,
      featured: false,
      price_type: "fixed",
      price_amount: null,
      external_links: { website: "https://alnyron.dk" },
      translations: { da: translation("e2e-price-test", "E2E Price Test") },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(m.errors["price-invalid"]);
  });
});

describe("AC-CATADM-22: ItemEditor — saving a new item opens its editor", () => {
  it("AC-CATADM-22a: router.replace to /admin/catalog/items/<id>", async () => {
    const user = userEvent.setup();
    save.mockResolvedValue({ ok: true, id: ITEM_ID });
    renderItem(NEW_ITEM);

    await user.type(screen.getByLabelText("Titel (DA)"), "Komplet");
    await user.click(screen.getByRole("button", { name: "Gem kladde" }));

    await vi.waitFor(() => expect(mockReplace).toHaveBeenCalledExactlyOnceWith(`/admin/catalog/items/${ITEM_ID}`));
  });
});

describe("AC-CATADM-28/49: ItemEditor — saved draft", () => {
  it("AC-CATADM-49a: a moved image is saved with its new sort_order and alt texts", async () => {
    const user = userEvent.setup();
    save.mockResolvedValue({ ok: true, id: ITEM_ID });
    renderItem(SAVED_DRAFT);

    await user.click(screen.getByRole("button", { name: "Flyt op: 2" }));
    await user.click(screen.getByRole("button", { name: "Gem kladde" }));

    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0]![0]).toMatchObject({
      id: ITEM_ID,
      price_type: "from",
      price_amount: 149,
      media: [
        { id: CAT_ID, alt_da: "Bagside", alt_en: "Back", sort_order: 10 },
        { id: MEDIA_ID, alt_da: "Forside", alt_en: "", sort_order: 20 },
      ],
    });
    expect(setStatus).not.toHaveBeenCalled();
    expect(await screen.findByRole("status")).toHaveTextContent(m.item.savedDraft);
  });

  it("AC-CATADM-28a: Udgiv saves (with the EN translation) and then publishes", async () => {
    const user = userEvent.setup();
    save.mockResolvedValue({ ok: true, id: ITEM_ID });
    setStatus.mockResolvedValue({ ok: true });
    renderItem(SAVED_DRAFT);

    await user.click(screen.getByRole("button", { name: "Udgiv" }));

    await vi.waitFor(() => expect(setStatus).toHaveBeenCalledExactlyOnceWith(ITEM_ID, "published"));
    expect(save.mock.calls[0]![0]).toMatchObject({
      translations: { da: translation("puls", "Puls"), en: translation("pulse", "Pulse") },
    });
    expect(await screen.findByRole("status")).toHaveTextContent(m.item.published);
  });

  it("AC-CATADM-28b: a failed save never changes the status", async () => {
    const user = userEvent.setup();
    save.mockResolvedValue({ ok: false, error: "slug-taken" });
    renderItem(SAVED_DRAFT);

    await user.click(screen.getByRole("button", { name: "Udgiv" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(m.errors["slug-taken"]);
    expect(setStatus).not.toHaveBeenCalled();
  });
});

describe("AC-CATADM-24: ItemEditor, a slug error shows under the URL-slug of its language", () => {
  it("AC-CATADM-24a: an EN slug-taken opens the Engelsk tab and marks URL-slug (EN), no form-level alert", async () => {
    const user = userEvent.setup();
    save.mockResolvedValue({ ok: false, error: "slug-taken", locale: "en" });
    renderItem(SAVED_DRAFT);

    await user.click(screen.getByRole("button", { name: "Gem kladde" }));

    await vi.waitFor(() => expect(screen.getByRole("tab", { name: m.locales.en })).toHaveAttribute("aria-selected", "true"));
    const enSlug = screen.getByLabelText("URL-slug (EN)");
    expect(enSlug).toBeVisible();
    expect(enSlug).toHaveAttribute("aria-invalid", "true");
    expect(enSlug).toHaveAccessibleDescription(expect.stringContaining(m.errors["slug-taken"]));
    // The focus moves in a passive effect, which can run after the tab change is visible.
    await vi.waitFor(() => expect(enSlug).toHaveFocus());
    expect(screen.getByLabelText("URL-slug (DA)")).not.toHaveAttribute("aria-invalid");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("AC-CATADM-24b: a DA slug-invalid stays on Dansk and marks URL-slug (DA) only", async () => {
    const user = userEvent.setup();
    save.mockResolvedValue({ ok: false, error: "slug-invalid", locale: "da" });
    renderItem(SAVED_DRAFT);

    await user.click(screen.getByRole("button", { name: "Gem kladde" }));

    const daSlug = await screen.findByRole("textbox", { name: "URL-slug (DA)" });
    await vi.waitFor(() => expect(daSlug).toHaveAttribute("aria-invalid", "true"));
    expect(screen.getByRole("tab", { name: m.locales.da })).toHaveAttribute("aria-selected", "true");
    expect(daSlug).toHaveAccessibleDescription(expect.stringContaining(m.errors["slug-invalid"]));
    expect(screen.getByLabelText("URL-slug (EN)")).not.toHaveAttribute("aria-invalid");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("AC-CATADM-24c: a slug error without a named language falls back to the form-level alert", async () => {
    const user = userEvent.setup();
    save.mockResolvedValue({ ok: false, error: "slug-taken" });
    renderItem(SAVED_DRAFT);

    await user.click(screen.getByRole("button", { name: "Gem kladde" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(m.errors["slug-taken"]);
    expect(screen.getByLabelText("URL-slug (DA)")).not.toHaveAttribute("aria-invalid");
    expect(screen.getByLabelText("URL-slug (EN)")).not.toHaveAttribute("aria-invalid");
  });
});

const sectionText = { title: "Apps", description: "", seo_title: "", seo_description: "" };

const CATEGORY_LABELS: CategoryEditorProps["labels"] = {
  languages: m.languages,
  locales: m.locales,
  fields: {
    da: { title: "Titel (DA)", description: "Beskrivelse (DA)", slug: "URL-slug (DA)", seoTitle: "SEO-titel (DA)", seoDescription: "SEO-beskrivelse (DA)" },
    en: { title: "Titel (EN)", description: "Beskrivelse (EN)", slug: "URL-slug (EN)", seoTitle: "SEO-titel (EN)", seoDescription: "SEO-beskrivelse (EN)" },
  },
  slugHint: m.section.fields.slugHint,
  seoTitleHint: m.section.fields.seoTitleHint,
  seoDescriptionHint: m.section.fields.seoDescriptionHint,
  enHint: m.section.enHint,
  visible: m.section.fields.visible,
  visibleHint: m.section.fields.visibleHint,
  cancel: m.section.cancel,
  save: m.section.save,
  saved: m.section.saved,
  errors: m.errors,
};

function renderCategory() {
  return render(
    <CategoryEditor
      category={{
        id: CAT_ID,
        status: "published",
        translations: { da: { ...sectionText, slug: "apps" }, en: { ...sectionText, slug: "apps" } },
      }}
      save={save}
      setStatus={setStatus}
      labels={CATEGORY_LABELS}
    />,
  );
}

describe("AC-CATADM-10/14: CategoryEditor", () => {
  it("AC-CATADM-10a: the slug is read-only and never sent", async () => {
    const user = userEvent.setup();
    save.mockResolvedValue({ ok: true, id: CAT_ID });
    renderCategory();

    expect(screen.getByLabelText("URL-slug (DA)")).toHaveAttribute("readonly");
    await user.click(screen.getByRole("button", { name: "Gem" }));

    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0]![0]).toEqual({ id: CAT_ID, translations: { da: sectionText, en: sectionText } });
    expect(setStatus).not.toHaveBeenCalled();
    expect(await screen.findByRole("status")).toHaveTextContent(m.section.saved);
  });

  it("AC-CATADM-14a: switching Synlig off saves the text, then hides the section", async () => {
    const user = userEvent.setup();
    save.mockResolvedValue({ ok: true, id: CAT_ID });
    setStatus.mockResolvedValue({ ok: true });
    renderCategory();

    await user.click(screen.getByRole("checkbox", { name: m.section.fields.visible }));
    await user.click(screen.getByRole("button", { name: "Gem" }));

    await vi.waitFor(() => expect(setStatus).toHaveBeenCalledExactlyOnceWith(CAT_ID, "draft"));
    expect(save).toHaveBeenCalledOnce();
  });
});
