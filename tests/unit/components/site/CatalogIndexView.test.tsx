// @vitest-environment jsdom
/**
 * Unit tests: section page body (src/components/site/CatalogIndexView.tsx)
 * with its item cards, rendered from resolved catalog data and the real
 * `Catalog` messages.
 * Journey: catalog-public
 * Acceptance IDs: AC-CATPUB-01, AC-CATPUB-02, AC-CATPUB-03, AC-CATPUB-20
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import CatalogIndexView from "@/components/site/CatalogIndexView";
import type { PublicCatalogSection } from "@/services/content/catalog";
import { catalogImage, catalogItem, catalogSection } from "../../../helpers/catalog-fixtures";

afterEach(cleanup);

const featured = catalogItem({ id: "item-web", title: "Webudvikling", featured: true });
const plain = catalogItem({
  id: "item-advice",
  slug: "consulting",
  href: "/services/consulting",
  title: "Teknisk rådgivning",
  summary: "Arkitektur og kodegennemgang.",
  price: { text: "Kontakt", vat: null },
});

function renderSection(section: PublicCatalogSection, locale: "da" | "en" = "da") {
  return render(<CatalogIndexView locale={locale} section={section} />);
}

/** The card (`<article>`) of the item whose title link is `title`. */
function card(title: string): HTMLElement {
  const article = screen.getByRole("link", { name: title }).closest("article");
  if (!article) throw new Error(`no card for ${title}`);
  return article;
}

describe("AC-CATPUB-01: section page shows the section and its published items", () => {
  it("renders the section title as the page heading, with its lead", () => {
    renderSection(catalogSection({ items: [featured, plain] }));
    expect(screen.getByRole("heading", { level: 1, name: "Ydelser" })).toBeInTheDocument();
    expect(screen.getByText("Udvikling, rådgivning og vedligehold.")).toBeInTheDocument();
  });

  it("renders the main landmark as the skip-link target", () => {
    renderSection(catalogSection());
    expect(screen.getByRole("main")).toHaveAttribute("id", "main");
  });

  it("renders one card per item, each titled and linking to its item page", () => {
    renderSection(catalogSection({ items: [featured, plain] }));
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(within(card("Webudvikling")).getByRole("heading", { level: 3 })).toHaveTextContent("Webudvikling");
    expect(screen.getByRole("link", { name: "Teknisk rådgivning" })).toHaveAttribute("href", "/services/consulting");
    expect(within(card("Teknisk rådgivning")).getByText("Arkitektur og kodegennemgang.")).toBeInTheDocument();
  });

  it("leaves out a blank lead", () => {
    const { container } = renderSection(catalogSection({ description: "  " }));
    expect(container.querySelector("header p")).toBeNull();
  });

  it("names the card list with a visually hidden level-2 heading, so no heading level is skipped", () => {
    const { container } = renderSection(catalogSection({ items: [featured, plain] }));
    expect(screen.getByRole("heading", { level: 2, name: "Oversigt" })).toHaveClass("sr-only");
    expect([...container.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((heading) => heading.tagName)).toEqual([
      "H1",
      "H2",
      "H3",
      "H3",
    ]);
  });

  it("uses the English list heading on the English page", () => {
    renderSection(catalogSection(), "en");
    expect(screen.getByRole("heading", { level: 2, name: "Overview" })).toBeInTheDocument();
  });
});

describe("AC-CATPUB-02: featured items first, with the Udvalgt badge", () => {
  it("keeps the service's order, featured first", () => {
    renderSection(catalogSection({ items: [featured, plain] }));
    expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
      "Webudvikling",
      "Teknisk rådgivning",
    ]);
  });

  it("badges only the featured card 'Udvalgt'", () => {
    renderSection(catalogSection({ items: [featured, plain] }));
    expect(within(card("Webudvikling")).getByText("Udvalgt")).toBeInTheDocument();
    expect(within(card("Teknisk rådgivning")).queryByText("Udvalgt")).toBeNull();
  });

  it("shows no badge when no item is featured", () => {
    renderSection(catalogSection({ items: [plain] }));
    expect(screen.queryByText("Udvalgt")).toBeNull();
  });

  it("uses the English badge text on the English page", () => {
    renderSection(catalogSection({ items: [featured] }), "en");
    expect(screen.getByText("Featured")).toBeInTheDocument();
  });
});

describe("AC-CATPUB-03: card prices", () => {
  it("shows a price with its VAT note", () => {
    renderSection(catalogSection({ items: [featured] }));
    expect(within(card("Webudvikling")).getByText(/^fra 12\.000 kr\./)).toHaveTextContent(/^fra 12\.000 kr\. inkl\. moms$/);
  });

  it("shows 'Kontakt' without a VAT note", () => {
    renderSection(catalogSection({ items: [plain] }));
    expect(within(card("Teknisk rådgivning")).getByText("Kontakt")).toBeInTheDocument();
    expect(within(card("Teknisk rådgivning")).queryByText("inkl. moms")).toBeNull();
  });

  it("shows no price element for an item without a price", () => {
    renderSection(catalogSection({ items: [catalogItem({ summary: "", price: null })] }));
    expect(card("Webudvikling").querySelectorAll("p")).toHaveLength(0);
  });
});

describe("AC-CATPUB-20: Danish fallback text is marked lang='da'", () => {
  it("marks a fallback title and lead on the English page", () => {
    renderSection(catalogSection({ fallbackKeys: ["title", "description"] }), "en");
    expect(screen.getByRole("heading", { level: 1 })).toHaveAttribute("lang", "da");
    expect(screen.getByText("Udvikling, rådgivning og vedligehold.")).toHaveAttribute("lang", "da");
  });

  it("marks a fallback item title and summary on its card", () => {
    renderSection(catalogSection({ items: [catalogItem({ fallbackKeys: ["title", "summary"] })] }), "en");
    expect(screen.getByRole("link", { name: "Webudvikling" })).toHaveAttribute("lang", "da");
    expect(screen.getByText("Moderne og hurtige websites.")).toHaveAttribute("lang", "da");
  });

  it("sets no lang on text in the page's own locale", () => {
    renderSection(catalogSection());
    expect(screen.getByRole("heading", { level: 1 })).not.toHaveAttribute("lang");
    expect(screen.getByRole("link", { name: "Webudvikling" })).not.toHaveAttribute("lang");
  });
});

describe("Card images: the first row loads eagerly", () => {
  it("loads the first three images eagerly (priority) and the rest lazily", () => {
    const items = [1, 2, 3, 4].map((n) =>
      catalogItem({
        id: `item-${n}`,
        title: `Projekt ${n}`,
        href: `/apps/projekt-${n}`,
        media: [catalogImage({ id: `media-${n}`, alt: `Skærmbillede ${n}` })],
      }),
    );
    renderSection(catalogSection({ items }));
    const images = screen.getAllByRole("img");
    expect(images.map((image) => image.getAttribute("alt"))).toEqual([
      "Skærmbillede 1",
      "Skærmbillede 2",
      "Skærmbillede 3",
      "Skærmbillede 4",
    ]);
    for (const image of images.slice(0, 3)) expect(image).not.toHaveAttribute("loading");
    expect(images[3]).toHaveAttribute("loading", "lazy");
  });
});
