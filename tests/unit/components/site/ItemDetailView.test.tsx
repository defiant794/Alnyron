// @vitest-environment jsdom
/**
 * Unit tests: item page body (src/components/site/ItemDetailView.tsx),
 * rendered from resolved catalog data with the real `Catalog` messages and
 * the real sanitizeMarkdown.
 * Journey: catalog-public
 * Acceptance IDs: AC-CATPUB-03, AC-CATPUB-10, AC-CATPUB-11, AC-CATPUB-20
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import ItemDetailView from "@/components/site/ItemDetailView";
import type { PublicCatalogItem, PublicCatalogSection } from "@/services/content/catalog";
import { catalogImage, catalogItem, catalogSection } from "../../../helpers/catalog-fixtures";

afterEach(cleanup);

function renderItem(
  item: PublicCatalogItem = catalogItem(),
  locale: "da" | "en" = "da",
  section: PublicCatalogSection = catalogSection({ items: [item] }),
) {
  return render(<ItemDetailView locale={locale} section={section} item={item} />).container;
}

describe("AC-CATPUB-10: item page shows the item", () => {
  it("renders the title as the page heading, with the summary", () => {
    renderItem();
    expect(screen.getByRole("heading", { level: 1, name: "Webudvikling" })).toBeInTheDocument();
    expect(screen.getByText("Moderne og hurtige websites.")).toBeInTheDocument();
  });

  it("renders the main landmark as the skip-link target", () => {
    renderItem();
    expect(screen.getByRole("main")).toHaveAttribute("id", "main");
  });

  it("renders a breadcrumb: the section linked, then the item as the current page", () => {
    renderItem();
    const breadcrumb = screen.getByRole("navigation", { name: "Brødkrummesti" });
    expect(within(breadcrumb).getByRole("link", { name: "Ydelser" })).toHaveAttribute("href", "/services");
    expect(within(breadcrumb).getByText("Webudvikling")).toHaveAttribute("aria-current", "page");
  });

  it("renders the markdown body as HTML", () => {
    renderItem();
    expect(screen.getByRole("heading", { level: 2, name: "Hvad du får" })).toBeInTheDocument();
    expect(screen.getByText("Et skræddersyet website.")).toBeInTheDocument();
  });

  it("sizes each body heading level with its DESIGN.md token (h1 36/44, h2 28/36, h3 20/28)", () => {
    renderItem();
    expect(screen.getByRole("heading", { level: 2, name: "Hvad du får" }).parentElement).toHaveClass(
      "[&_h1]:text-h1",
      "[&_h2]:text-h2",
      "[&_h3]:text-h3",
    );
  });

  it("renders raw HTML and script links in the body as text, never as elements", () => {
    const container = renderItem(
      catalogItem({ bodyMd: '<script>alert(1)</script>\n\n[klik](javascript:alert(1)) <img src=x onerror="alert(1)">' }),
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img[onerror]")).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeInTheDocument();
  });

  it("leaves out a blank body", () => {
    renderItem(catalogItem({ bodyMd: "  " }));
    expect(screen.queryByRole("heading", { level: 2, name: "Hvad du får" })).toBeNull();
  });

  it("leaves out a blank summary", () => {
    renderItem(catalogItem({ summary: "" }));
    expect(screen.queryByText("Moderne og hurtige websites.")).toBeNull();
  });

  it("labels each gallery thumbnail with its position", () => {
    renderItem(catalogItem({ media: [catalogImage(), catalogImage({ id: "media-2", alt: "Mobilvisning" })] }));
    expect(screen.getByRole("list", { name: "Billeder" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Vis billede 1 af 2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Vis billede 2 af 2" })).toBeInTheDocument();
  });
});

describe("AC-CATPUB-10: link buttons", () => {
  const links = { website: "https://kunde.example", demo: "https://demo.kunde.example", app_store: "https://apps.apple.com/app/id1" };

  it("lists the item's links, demo first, labelled from the messages", () => {
    renderItem(catalogItem({ externalLinks: links }));
    const list = screen.getByRole("list", { name: "Links" });
    expect(within(list).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Se demo", "https://demo.kunde.example"],
      ["Hjemmeside", "https://kunde.example"],
      ["App Store", "https://apps.apple.com/app/id1"],
    ]);
  });

  it("styles only the first link as the primary button", () => {
    renderItem(catalogItem({ externalLinks: links }));
    const [first, ...rest] = within(screen.getByRole("list", { name: "Links" })).getAllByRole("link");
    expect(first).toHaveClass("bg-accent");
    for (const link of rest) expect(link).not.toHaveClass("bg-accent");
  });

  it("opens the links in the same tab", () => {
    renderItem(catalogItem({ externalLinks: links }));
    for (const link of within(screen.getByRole("list", { name: "Links" })).getAllByRole("link")) {
      expect(link).not.toHaveAttribute("target");
    }
  });

  it("shows no link list for an item without links", () => {
    renderItem(catalogItem({ externalLinks: {} }));
    expect(screen.queryByRole("list", { name: "Links" })).toBeNull();
  });
});

describe("AC-CATPUB-03: item price", () => {
  it("shows the price with its VAT note", () => {
    renderItem();
    expect(screen.getByText(/^fra 12\.000 kr\./)).toHaveTextContent(/^fra 12\.000 kr\. inkl\. moms$/);
  });

  it("shows 'Kontakt' without a VAT note", () => {
    renderItem(catalogItem({ price: { text: "Kontakt", vat: null } }));
    expect(screen.getByText("Kontakt")).toBeInTheDocument();
    expect(screen.queryByText("inkl. moms")).toBeNull();
  });

  it("shows no price for an item without one", () => {
    renderItem(catalogItem({ price: null }));
    expect(screen.queryByText(/kr\./)).toBeNull();
  });
});

describe("AC-CATPUB-11: contact call to action", () => {
  it("AC-ENSLUG-08: links 'Kontakt os' to /contact on the Danish page", () => {
    renderItem();
    const cta = screen.getByRole("region", { name: "Interesseret?" });
    expect(within(cta).getByRole("link", { name: "Kontakt os" })).toHaveAttribute("href", "/contact");
  });

  it("links 'Contact us' to /en/contact on the English page", () => {
    renderItem(catalogItem(), "en");
    const cta = screen.getByRole("region", { name: "Interested?" });
    expect(within(cta).getByRole("link", { name: "Contact us" })).toHaveAttribute("href", "/en/contact");
  });

  it("titles the call to action with a level-2 heading at the DESIGN.md h2 size", () => {
    renderItem();
    expect(screen.getByRole("heading", { level: 2, name: "Interesseret?" })).toHaveClass("text-h2");
  });
});

describe("AC-CATPUB-20: Danish fallback text is marked lang='da'", () => {
  it("marks a fallback summary and body on the English page", () => {
    const container = renderItem(catalogItem({ fallbackKeys: ["summary", "bodyMd"] }), "en");
    expect(screen.getByText("Moderne og hurtige websites.")).toHaveAttribute("lang", "da");
    expect(screen.getByRole("heading", { level: 2, name: "Hvad du får" }).parentElement).toHaveAttribute("lang", "da");
    expect(container.querySelector("h1")).not.toHaveAttribute("lang");
  });

  it("marks a fallback title in the heading and the breadcrumb", () => {
    renderItem(catalogItem({ fallbackKeys: ["title"] }), "en");
    expect(screen.getByRole("heading", { level: 1 })).toHaveAttribute("lang", "da");
    expect(screen.getByText("Webudvikling", { selector: "[aria-current]" })).toHaveAttribute("lang", "da");
  });

  it("marks a fallback section title in the breadcrumb link", () => {
    const item = catalogItem();
    renderItem(item, "en", catalogSection({ items: [item], fallbackKeys: ["title"] }));
    expect(screen.getByRole("link", { name: "Ydelser" })).toHaveAttribute("lang", "da");
  });

  it("sets no lang on text in the page's own locale", () => {
    renderItem();
    expect(screen.getByRole("heading", { level: 1 })).not.toHaveAttribute("lang");
    expect(screen.getByText("Moderne og hurtige websites.")).not.toHaveAttribute("lang");
    expect(screen.getByRole("link", { name: "Ydelser" })).not.toHaveAttribute("lang");
  });
});
