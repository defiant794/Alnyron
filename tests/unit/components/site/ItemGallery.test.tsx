// @vitest-environment jsdom
/**
 * Unit tests: item page gallery (src/components/site/ItemGallery.tsx).
 * Journey: catalog-public
 * Acceptance IDs: AC-CATPUB-10, AC-CATPUB-20
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import ItemGallery from "@/components/site/ItemGallery";
import type { CatalogImage } from "@/services/content/catalog";
import { catalogImage } from "../../../helpers/catalog-fixtures";

afterEach(cleanup);

const GLYPH = "▣";
const desktop = catalogImage({ id: "media-1", alt: "Forsiden på desktop" });
const mobile = catalogImage({ id: "media-2", alt: "Forsiden på mobil", src: `${desktop.src}?v=2` });
const menu = catalogImage({ id: "media-3", alt: "Menuen åbnet", src: `${desktop.src}?v=3` });

function renderGallery(images: CatalogImage[]) {
  return render(
    <ItemGallery
      images={images}
      glyph={GLYPH}
      label="Billeder"
      thumbnailLabels={images.map((_, index) => `Vis billede ${index + 1} af ${images.length}`)}
    />,
  ).container;
}

describe("AC-CATPUB-10: ItemGallery without images", () => {
  it("shows the kind's glyph as decoration, with no image or thumbnails", () => {
    const container = renderGallery([]);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
    expect(container.firstElementChild).toHaveTextContent(GLYPH);
  });
});

describe("AC-CATPUB-10: ItemGallery with one image", () => {
  it("shows that image with its alt text and no thumbnail list", () => {
    renderGallery([desktop]);
    expect(screen.getByRole("img", { name: "Forsiden på desktop" })).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
  });
});

describe("AC-CATPUB-10: ItemGallery with several images", () => {
  it("shows the first image large, with a labelled list of thumbnail buttons", () => {
    renderGallery([desktop, mobile, menu]);
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(screen.getByRole("img", { name: "Forsiden på desktop" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Billeder" })).toBeInTheDocument();
    expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
      "Vis billede 1 af 3",
      "Vis billede 2 af 3",
      "Vis billede 3 af 3",
    ]);
  });

  it("marks the selected thumbnail pressed", () => {
    renderGallery([desktop, mobile, menu]);
    expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-pressed"))).toEqual([
      "true",
      "false",
      "false",
    ]);
  });

  it("switches the large image when another thumbnail is chosen", async () => {
    const user = userEvent.setup();
    renderGallery([desktop, mobile, menu]);
    await user.click(screen.getByRole("button", { name: "Vis billede 2 af 3" }));
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(screen.getByRole("img", { name: "Forsiden på mobil" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Vis billede 2 af 3" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Vis billede 1 af 3" })).toHaveAttribute("aria-pressed", "false");
  });

  it("can be operated with the keyboard", async () => {
    const user = userEvent.setup();
    renderGallery([desktop, mobile, menu]);
    await user.tab();
    await user.tab();
    await user.tab();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("img", { name: "Menuen åbnet" })).toBeInTheDocument();
  });
});

describe("AC-CATPUB-20: ItemGallery marks a Danish fallback alt text", () => {
  it("sets lang='da' on the large image when its alt text is the Danish fallback", () => {
    renderGallery([catalogImage({ lang: "da" })]);
    expect(screen.getByRole("img")).toHaveAttribute("lang", "da");
  });

  it("sets no lang on an alt text in the page's own locale", () => {
    renderGallery([desktop]);
    expect(screen.getByRole("img")).not.toHaveAttribute("lang");
  });
});
