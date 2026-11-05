// @vitest-environment jsdom
/**
 * Unit tests: one item card on a section page (src/components/site/ItemCard.tsx).
 * Journey: catalog-public
 * Acceptance IDs: AC-CATPUB-01, AC-CATPUB-02, AC-CATPUB-03, AC-CATPUB-20
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import ItemCard, { type ItemCardProps } from "@/components/site/ItemCard";
import { KIND_GLYPH } from "@/config/catalog";
import { catalogImage, catalogItem } from "../../../helpers/catalog-fixtures";

afterEach(cleanup);

function renderCard(overrides: Partial<ItemCardProps> = {}) {
  const props: ItemCardProps = {
    item: catalogItem(),
    kind: "services",
    featuredLabel: "Udvalgt",
    priority: false,
    ...overrides,
  };
  return render(<ItemCard {...props} />).container;
}

describe("AC-CATPUB-01: ItemCard shows the item and links to its page", () => {
  it("titles the card with a level-3 heading at the DESIGN.md h3 size, whose link goes to the item page", () => {
    renderCard();
    expect(screen.getByRole("heading", { level: 3, name: "Webudvikling" })).toHaveClass("text-h3");
    expect(screen.getByRole("link", { name: "Webudvikling" })).toHaveAttribute("href", "/services/web-development");
  });

  it("fades in the DESIGN.md card shadow on hover and keyboard focus (opacity of ::after only)", () => {
    renderCard();
    expect(screen.getByRole("article")).toHaveClass(
      "after:shadow-card",
      "after:opacity-0",
      "hover:after:opacity-100",
      "focus-within:after:opacity-100",
    );
  });

  it("shows the summary", () => {
    renderCard();
    expect(screen.getByText("Moderne og hurtige websites.")).toBeInTheDocument();
  });

  it("leaves out a blank summary", () => {
    const container = renderCard({ item: catalogItem({ summary: " ", price: null }) });
    expect(container.querySelector("p")).toBeNull();
  });

  it("shows the item's first image with its alt text", () => {
    renderCard({
      item: catalogItem({
        media: [catalogImage({ alt: "Første billede" }), catalogImage({ id: "media-2", alt: "Andet billede" })],
      }),
    });
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(screen.getByRole("img", { name: "Første billede" })).toBeInTheDocument();
  });

  it("shows the kind's decorative glyph instead when the item has no image", () => {
    const container = renderCard({ kind: "apps" });
    expect(screen.queryByRole("img")).toBeNull();
    const glyph = container.querySelector('[aria-hidden="true"]');
    expect(glyph).toHaveTextContent(KIND_GLYPH.apps);
  });

  it("loads the image eagerly when asked (first row) and lazily otherwise", () => {
    renderCard({ item: catalogItem({ media: [catalogImage()] }), priority: true });
    expect(screen.getByRole("img")).not.toHaveAttribute("loading");
    cleanup();
    renderCard({ item: catalogItem({ media: [catalogImage()] }), priority: false });
    expect(screen.getByRole("img")).toHaveAttribute("loading", "lazy");
  });
});

describe("AC-CATPUB-02: ItemCard featured badge", () => {
  it("shows the featured label on a featured item", () => {
    renderCard({ item: catalogItem({ featured: true }), featuredLabel: "Udvalgt" });
    expect(screen.getByText("Udvalgt")).toBeInTheDocument();
  });

  it("shows no badge on an item that is not featured", () => {
    renderCard({ item: catalogItem({ featured: false }) });
    expect(screen.queryByText("Udvalgt")).toBeNull();
  });
});

describe("AC-CATPUB-03: ItemCard price", () => {
  it("shows the price with its VAT note", () => {
    renderCard();
    expect(screen.getByText(/^fra 12\.000 kr\./)).toHaveTextContent(/^fra 12\.000 kr\. inkl\. moms$/);
  });

  it("shows no price for an item without one", () => {
    renderCard({ item: catalogItem({ price: null }) });
    expect(screen.queryByText(/kr\./)).toBeNull();
    expect(screen.queryByText("inkl. moms")).toBeNull();
  });
});

describe("AC-CATPUB-20: ItemCard marks Danish fallback text lang='da'", () => {
  it("marks a fallback title link and summary", () => {
    renderCard({ item: catalogItem({ fallbackKeys: ["title", "summary"] }) });
    expect(screen.getByRole("link", { name: "Webudvikling" })).toHaveAttribute("lang", "da");
    expect(screen.getByText("Moderne og hurtige websites.")).toHaveAttribute("lang", "da");
  });

  it("marks a fallback alt text on the image", () => {
    renderCard({ item: catalogItem({ media: [catalogImage({ lang: "da" })] }) });
    expect(screen.getByRole("img")).toHaveAttribute("lang", "da");
  });

  it("sets no lang on text in the page's own locale", () => {
    renderCard({ item: catalogItem({ media: [catalogImage()] }) });
    expect(screen.getByRole("link", { name: "Webudvikling" })).not.toHaveAttribute("lang");
    expect(screen.getByText("Moderne og hurtige websites.")).not.toHaveAttribute("lang");
    expect(screen.getByRole("img")).not.toHaveAttribute("lang");
  });
});
