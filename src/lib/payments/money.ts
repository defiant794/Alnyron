import type { Locale } from "next-intl";

type KronerFormats = { whole: Intl.NumberFormat; fractional: Intl.NumberFormat };

/** Whole kroner, and kroner with øre (2 decimals), in the number style of `tag`. */
function kronerFormats(tag: string): KronerFormats {
  return {
    whole: new Intl.NumberFormat(tag, { maximumFractionDigits: 0 }),
    fractional: new Intl.NumberFormat(tag, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  };
}

/** One set of formats per UI language, built once. */
const FORMATS: Record<Locale, KronerFormats> = {
  da: kronerFormats("da-DK"),
  en: kronerFormats("en-GB"),
};

/**
 * An amount in øre (the payments tables' integer money) as kroner in
 * `locale`, without the currency: whole kroner when it is a whole number
 * ("95"), else with 2 decimals and the locale's separators ("10,50",
 * "1.234,56" in Danish; "10.50", "1,234.56" in English). The caller adds
 * "kr" through its message.
 */
export function formatKroner(amountOre: number, locale: Locale): string {
  const { whole, fractional } = FORMATS[locale];
  return (amountOre % 100 === 0 ? whole : fractional).format(amountOre / 100);
}
