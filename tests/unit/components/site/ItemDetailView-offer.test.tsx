// @vitest-environment jsdom
/**
 * Unit tests: src/components/site/ItemDetailView.tsx — offer block integration
 * Journey: payments-s2-3d-purchase
 * Criteria: S2-CHK-1..3 (web layer - display price ignored when offer present)
 *
 * Test IDs: S2-T-IDV-OFR-01..04
 *
 * Contract §3:
 *   - With offer: ItemOfferBlock rendered, formatKroner price shown,
 *     display price (item.price) ignored
 *   - Without offer: existing behavior unchanged, no offer block
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import ItemDetailView from "@/components/site/ItemDetailView";
import type { PublicCatalogItem, PublicCatalogSection } from "@/services/content/catalog";
import { catalogItem, catalogSection, NBSP } from "../../../helpers/catalog-fixtures";

afterEach(cleanup);

/** A models3d item with an active physical offer. */
const itemWithOffer = catalogItem({
  id: "item-dragon",
  title: "Drage, 12 cm",
  offer: { priceOre: 24995 },
  price: { text: `fra${NBSP}249,00${NBSP}kr.`, vat: "inkl. moms" },
});

/** An item without an offer (existing catalog behavior). */
const itemNoOffer = catalogItem({
  id: "item-web",
  offer: null,
});

const section = catalogSection({ items: [itemWithOffer] });

function render3d(item: PublicCatalogItem, s: PublicCatalogSection = section) {
  return render(<ItemDetailView locale="da" section={s} item={item} />).container;
}

// ── S2-T-IDV-OFR-01: with offer — ItemOfferBlock rendered ─────────────────

describe("S2-T-IDV-OFR-01: ItemDetailView with offer — ItemOfferBlock rendered", () => {
  it("renders a Buy form (method=post action=/api/checkout/item) when offer present", () => {
    const container = render3d(itemWithOffer);
    const form = container.querySelector("form[action='/api/checkout/item']");
    expect(form).toBeTruthy();
    expect(form!.getAttribute("method")?.toLowerCase()).toBe("post");
  });

  it("renders '249,95 kr.' from offer.priceOre (not from item.price.text)", () => {
    const container = render3d(itemWithOffer);
    expect(container.textContent).toContain("249,95 kr.");
  });
});

// ── S2-T-IDV-OFR-02: with offer — display price ignored ──────────────────

describe("S2-T-IDV-OFR-02: ItemDetailView with offer — display price text ignored", () => {
  it("does not show 'fra 249,00 kr.' (display price) when an offer is present", () => {
    const container = render3d(itemWithOffer);
    // The display price text from item.price.text must NOT be shown
    expect(container.textContent).not.toContain("249,00");
  });
});

// ── S2-T-IDV-OFR-03: without offer — existing behavior unchanged ──────────

describe("S2-T-IDV-OFR-03: ItemDetailView without offer — no offer block, existing price shown", () => {
  it("does not render a Buy form when offer is null", () => {
    const container = render3d(
      itemNoOffer,
      catalogSection({ items: [itemNoOffer] }),
    );
    expect(container.querySelector("form[action='/api/checkout/item']")).toBeNull();
  });

  it("shows the display price when no offer (existing behavior)", () => {
    const noOfferSection = catalogSection({ items: [itemNoOffer] });
    const container = render3d(itemNoOffer, noOfferSection);
    // item.price.text is shown for a non-offer item
    expect(container.textContent).toContain("12.000");
  });
});

// ── S2-T-IDV-OFR-04: public catalog offer mapping → catalog.test.ts ──────
// The database query shape and row-to-offer mapping (active physical only,
// digital/inactive → null, empty array → null) are tested in
// tests/unit/services/content/catalog.test.ts (S2-T-IDV-OFR-04a..f)
// where the Supabase client is mocked and the select string is asserted.
// No fixture-only self-proving test here.
