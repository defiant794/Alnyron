import type { Locale } from "next-intl";
import type { PriceType } from "@/config/catalog";

/** An item's price columns (`items.price_type`, `price_amount`, `price_currency`). */
export interface Price {
  type: PriceType | null;
  amount: number | null;
  currency: string;
}

/** The translated words around a price (`Catalog.price` messages). */
export interface PriceLabels {
  from: string;
  vatIncluded: string;
  contact: string;
}

/** A price ready to render: the price itself and the VAT note shown next to it (`null`: none). */
export interface FormattedPrice {
  text: string;
  vat: string | null;
}

/**
 * Formats an item's price for `locale`: `null` when the item shows no price,
 * the contact label for `contact`, else the amount (whole amounts without
 * decimals, others with two; DA `12.000 kr.`), prefixed with the "from" label
 * and a no-break space for `from` (so the label never wraps away from the
 * amount, like Intl's own space before `kr.`), with the VAT-included note.
 * Both locales use Danish number conventions (`en-DK`): every price is in
 * Danish kroner. The copy comes from `labels`, never from this module. A
 * `fixed`/`from` price without an amount (which `items_price_consistent`
 * forbids) shows no price.
 */
export function formatPrice(price: Price, locale: Locale, labels: PriceLabels): FormattedPrice | null {
  if (price.type === null) return null;
  if (price.type === "contact") return { text: labels.contact, vat: null };
  if (price.amount === null) return null;

  const amount = new Intl.NumberFormat(locale === "da" ? "da-DK" : "en-DK", {
    style: "currency",
    currency: price.currency,
    minimumFractionDigits: Number.isInteger(price.amount) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(price.amount);
  return { text: price.type === "from" ? `${labels.from}\u00a0${amount}` : amount, vat: labels.vatIncluded };
}
