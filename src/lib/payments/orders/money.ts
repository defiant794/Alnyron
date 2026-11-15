import { OFFER_PRICE_MAX_ORE, OFFER_PRICE_MIN_ORE } from "@/config/payments";

/**
 * Kroner typed by the admin (the item editor's offer price) to and from
 * integer øre. Integer arithmetic only: "249,95" is 249 × 100 + 95, never
 * `parseFloat("249.95") * 100` (24994.999…).
 */

/** Whole kroner (1 to 6 digits), optionally a comma or point and 1 or 2 øre digits. */
const KRONER_INPUT = /^(\d{1,6})(?:[.,](\d{1,2}))?$/;

/**
 * `input` (trimmed) as øre, or null unless it is 1 to 6 digits of kroner with
 * an optional decimal comma or point and 1 or 2 digits ("249" → 24900,
 * "249,9" → 24990, "249,95" and "249.95" → 24995). No sign, thousands
 * separator, inner space or exponent. The offer range is checked separately
 * ({@link isOfferPriceInRange}).
 */
export function parseKronerToOre(input: string): number | null {
  const match = KRONER_INPUT.exec(input.trim());
  if (!match) return null;
  const kroner = Number(match[1]);
  const fraction = match[2] ?? "";
  return kroner * 100 + Number(fraction.padEnd(2, "0"));
}

/**
 * `ore` as the editor's kroner text: whole kroner without decimals ("249"),
 * else a decimal comma and 2 digits ("249,95", "0,25"). No thousands
 * separator, so {@link parseKronerToOre} reads it back.
 */
export function formatOreAsKroner(ore: number): string {
  const kroner = Math.trunc(ore / 100);
  const rest = ore % 100;
  return rest === 0 ? String(kroner) : `${kroner},${String(rest).padStart(2, "0")}`;
}

/** Whether `priceOre` is a whole øre amount an offer may have (the `item_offers.price_ore` CHECK). */
export function isOfferPriceInRange(priceOre: number): boolean {
  return Number.isSafeInteger(priceOre) && priceOre >= OFFER_PRICE_MIN_ORE && priceOre <= OFFER_PRICE_MAX_ORE;
}
