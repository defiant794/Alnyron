import { createTranslator, type Locale } from "next-intl";
import { GOODS_TEXTS } from "@/config/legal/goods-texts";
import { loadMessages } from "@/i18n/messages";
import type { FormattedPrice } from "@/lib/format-price";
import { formatKroner } from "@/lib/payments/money";

/**
 * An item's active offer price as the public catalog shows it, the same on
 * the item page's purchase block and on the item's card: "249,95 kr." /
 * "250 kr." (`formatKroner` through `Catalog.offer.price`) with the goods
 * texts' price note ("inkl. moms og levering i Danmark") as its VAT note.
 * The offer, not the item's display price, is what the item costs.
 */
export function formatOfferPrice(priceOre: number, locale: Locale): FormattedPrice {
  const t = createTranslator({ locale, messages: loadMessages(locale), namespace: "Catalog.offer" });
  return {
    text: t("price", { amount: formatKroner(priceOre, locale) }),
    vat: GOODS_TEXTS[locale].itemPage.priceNote,
  };
}
