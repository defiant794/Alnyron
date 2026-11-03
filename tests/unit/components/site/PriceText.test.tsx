// @vitest-environment jsdom
/**
 * Unit tests: catalog price with its VAT note (src/components/site/PriceText.tsx),
 * fed by the real formatPrice and the Danish `Catalog.price` messages.
 * Journey: catalog-public
 * Acceptance IDs: AC-CATPUB-03
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import PriceText from "@/components/site/PriceText";
import { formatPrice, type PriceLabels } from "@/lib/format-price";
import da from "../../../../messages/da.json";

const DA_LABELS: PriceLabels = da.Catalog.price;

afterEach(cleanup);

function renderPrice(type: "fixed" | "from" | "contact", amount: number | null, className?: string) {
  const price = formatPrice({ type, amount, currency: "DKK" }, "da", DA_LABELS);
  if (!price) throw new Error("expected a price");
  return render(<PriceText price={price} className={className} />).container.querySelector("p");
}

describe("AC-CATPUB-03: PriceText: price label with inkl. moms", () => {
  it("fixed 12000 reads '12.000 kr. inkl. moms'", () => {
    expect(renderPrice("fixed", 12000)).toHaveTextContent(/^12\.000 kr\. inkl\. moms$/);
  });

  it("from 12000 reads 'fra 12.000 kr. inkl. moms'", () => {
    expect(renderPrice("from", 12000)).toHaveTextContent(/^fra 12\.000 kr\. inkl\. moms$/);
  });

  it("contact reads 'Kontakt' with no VAT note", () => {
    const paragraph = renderPrice("contact", null);
    expect(paragraph).toHaveTextContent(/^Kontakt$/);
    expect(paragraph?.querySelector("span")).toBeNull();
  });

  it("sets the VAT note apart in its own small, regular, muted span", () => {
    const note = renderPrice("fixed", 950)?.querySelector("span");
    expect(note).toHaveTextContent(/^inkl\. moms$/);
    expect(note).toHaveClass("text-small", "font-normal", "text-muted");
  });

  it("applies the size and weight classes to the price itself", () => {
    expect(renderPrice("fixed", 950, "text-h3 font-bold")).toHaveClass("text-h3", "font-bold");
  });
});
