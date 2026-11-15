// @vitest-environment jsdom
/**
 * Unit tests: an item card with an active offer (src/components/site/ItemCard.tsx,
 * CatalogIndexView.tsx, the shared src/components/site/offer-price.ts).
 * Journey: payments-s2-3d-purchase
 * Criterion: S2-OFFER-14
 *
 * Test IDs: S2-T-CARD-OFR-01..03
 *
 * An item for sale shows its active offer's price on its section-page card,
 * formatted as on its item page ("249,95 kr." + "inkl. moms og levering i
 * Danmark"), never its display price; an item without an offer keeps its
 * display price.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import CatalogIndexView from "@/components/site/CatalogIndexView";
import ItemCard from "@/components/site/ItemCard";
import ItemOfferBlock from "@/components/site/ItemOfferBlock";
import { catalogItem, catalogSection, NBSP } from "../../../helpers/catalog-fixtures";

afterEach(cleanup);

/** A models3d item with an active physical offer and a (stale) display price. */
const offered = catalogItem({
  id: "item-dragon",
  title: "Drage, 12 cm",
  href: "/3d-models/dragon",
  offer: { priceOre: 24995 },
  price: { text: `fra${NBSP}199${NBSP}kr.`, vat: "inkl. moms" },
});

/** The card's price line (the last paragraph of the card). */
function cardPrice(): HTMLElement {
  const article = screen.getByRole("article");
  const paragraphs = article.querySelectorAll("p");
  const last = paragraphs[paragraphs.length - 1];
  if (!last) throw new Error("card has no price line");
  return last;
}

describe("S2-T-CARD-OFR-01: ItemCard — an item for sale shows its offer price, not the display price", () => {
  it("Danish: '249,95 kr.' with the goods price note", () => {
    render(<ItemCard item={offered} locale="da" kind="models3d" featuredLabel="Udvalgt" priority={false} />);
    expect(cardPrice()).toHaveTextContent("249,95 kr. inkl. moms og levering i Danmark");
    expect(screen.getByRole("article")).not.toHaveTextContent("fra");
  });

  it("English: '249.95 kr.' with the English note; a whole amount has no decimals", () => {
    render(<ItemCard item={offered} locale="en" kind="models3d" featuredLabel="Featured" priority={false} />);
    expect(cardPrice()).toHaveTextContent("249.95 kr. incl. VAT and delivery in Denmark");
    cleanup();
    render(
      <ItemCard item={{ ...offered, offer: { priceOre: 25000 } }} locale="da" kind="models3d" featuredLabel="Udvalgt" priority={false} />,
    );
    expect(cardPrice()).toHaveTextContent("250 kr. inkl. moms og levering i Danmark");
  });

  it("formats the price exactly as the item page's purchase block does", () => {
    render(<ItemOfferBlock offer={{ itemId: offered.id, priceOre: 24995 }} locale="da" />);
    const blockPrice = screen.getByText("249,95 kr.").textContent;
    cleanup();
    render(<ItemCard item={offered} locale="da" kind="models3d" featuredLabel="Udvalgt" priority={false} />);
    expect(cardPrice().textContent?.startsWith(`${blockPrice} `)).toBe(true);
  });
});

describe("S2-T-CARD-OFR-02: ItemCard — an item without an offer keeps its display price", () => {
  it("shows the formatted display price", () => {
    render(
      <ItemCard item={{ ...offered, offer: null }} locale="da" kind="models3d" featuredLabel="Udvalgt" priority={false} />,
    );
    // toHaveTextContent collapses the no-break spaces of the element's text to plain spaces.
    expect(cardPrice()).toHaveTextContent("fra 199 kr. inkl. moms");
    expect(screen.getByRole("article")).not.toHaveTextContent("249,95");
  });
});

describe("S2-T-CARD-OFR-03: CatalogIndexView — the section page's cards get the page language", () => {
  it.each([
    ["da", "249,95 kr."],
    ["en", "249.95 kr."],
  ] as const)("%s section page: the offered item's card shows %s", (locale, price) => {
    render(<CatalogIndexView locale={locale} section={catalogSection({ kind: "models3d", items: [offered] })} />);
    expect(cardPrice()).toHaveTextContent(price);
  });
});
