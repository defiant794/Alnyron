import type { Locale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { PriceLabels } from "@/lib/format-price";

/** The words around a price in `locale` (`Catalog.price` messages), for `formatPrice`. */
export async function getPriceLabels(locale: Locale): Promise<PriceLabels> {
  const t = await getTranslations({ locale, namespace: "Catalog.price" });
  return { from: t("from"), vatIncluded: t("vatIncluded"), contact: t("contact") };
}
