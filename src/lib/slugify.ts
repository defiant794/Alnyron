import { SLUG_MAX_LENGTH } from "@/config/catalog";

/**
 * Lower-case letters that NFKD does not reduce to an ASCII base letter: no
 * decomposition (`ø`, `ß`, `ł`, …), or one that would lose the letter's
 * meaning (`å` → `a`). Danish letters use the Danish transliteration.
 */
const TRANSLITERATIONS: Readonly<Record<string, string>> = {
  æ: "ae",
  ø: "oe",
  å: "aa",
  ß: "ss",
  œ: "oe",
  ł: "l",
  đ: "d",
  ð: "d",
  þ: "th",
};
const TRANSLITERATED = /[æøåßœłđðþ]/g;

/**
 * A URL slug proposed from a title, in the format the `routes_slug_format`
 * and `item_translations` slug CHECKs accept: lower-case `a-z0-9` words
 * joined by single dashes, at most 80 characters, or `""` when the input has
 * no letter or digit.
 *
 * Danish letters are transliterated (`æ` → `ae`, `ø` → `oe`, `å` → `aa`,
 * either case), as are `ß`, `œ`, `ł`, `đ`/`ð` and `þ`; other accented or
 * compatibility letters keep their base letter (`é` → `e`, `ℂ` → `c`).
 * A cut at 80 characters never leaves a trailing dash.
 */
export function slugify(input: string): string {
  const ascii = input
    .normalize("NFC") // a decomposed `å` (a + ring) is matched as one letter below
    .toLowerCase()
    .replace(TRANSLITERATED, (letter) => TRANSLITERATIONS[letter] ?? letter)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase(); // NFKD can yield capitals from letters without a lower-case form (`ℂ` → `C`)
  const slug = ascii.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.slice(0, SLUG_MAX_LENGTH).replace(/-+$/, "");
}
