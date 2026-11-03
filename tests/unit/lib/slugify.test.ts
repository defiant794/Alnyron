/**
 * Unit tests — slugify utility (F2.1 catalog-model)
 * Journey: catalog-model  AC-CAT-60, AC-CAT-61, AC-CAT-62, AC-CAT-63, AC-CAT-64
 * isValidSlug: journey catalog-public  AC-CATPUB-01, AC-CATPUB-10 (malformed route slugs 404 pre-DB)
 *
 * Module: src/lib/slugify.ts
 */

import { describe, it, expect } from "vitest";
import { isValidSlug, slugify } from "@/lib/slugify";
import { MALFORMED_SLUGS } from "../../helpers/catalog-fixtures";

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// ── AC-CAT-60: Danish letters ────────────────────────────────────────────────

describe("AC-CAT-60: slugify converts Danish letters", () => {
  it("converts æ to ae", () => {
    expect(slugify("æble")).toBe("aeble");
  });

  it("converts ø to oe", () => {
    expect(slugify("grøn")).toBe("groen");
  });

  it("converts å to aa", () => {
    expect(slugify("åbent")).toBe("aabent");
  });

  it("converts upper-case Æ to ae", () => {
    expect(slugify("Ærlig")).toBe("aerlig");
  });

  it("converts upper-case Ø to oe", () => {
    expect(slugify("Øvre")).toBe("oevre");
  });

  it("converts upper-case Å to aa", () => {
    expect(slugify("Åse")).toBe("aase");
  });

  it("handles a string with all three Danish pairs mixed case", () => {
    expect(slugify("ÆØÅæøå")).toBe("aeoeaaaeoeaa");
  });

  it("converts a decomposed (NFD) å, a + combining ring, to aa", () => {
    expect(slugify("a\u030Abent")).toBe("aabent");
    expect(slugify("A\u030Ase")).toBe("aase");
  });
});

// ── AC-CAT-61: Diacritics stripped ──────────────────────────────────────────

describe("AC-CAT-61: slugify strips non-Danish diacritics to base letter", () => {
  it("strips accent from é", () => {
    expect(slugify("été")).toBe("ete");
  });

  it("strips umlaut from ü", () => {
    expect(slugify("über")).toBe("uber");
  });

  it("strips tilde from ñ", () => {
    expect(slugify("niño")).toBe("nino");
  });

  it("strips cedilla from ç", () => {
    expect(slugify("façade")).toBe("facade");
  });
});

describe("AC-CAT-61: slugify transliterates letters without a decomposition", () => {
  it("converts ß (and capital ẞ) to ss", () => {
    expect(slugify("Straße")).toBe("strasse");
    expect(slugify("STRAẞE")).toBe("strasse");
  });

  it("converts œ/Œ to oe", () => {
    expect(slugify("Œuvre cœur")).toBe("oeuvre-coeur");
  });

  it("converts ł/Ł to l", () => {
    expect(slugify("Łódź")).toBe("lodz");
  });

  it("converts đ/Đ and ð/Ð to d", () => {
    expect(slugify("Đorđe")).toBe("dorde");
    expect(slugify("Ðað")).toBe("dad");
  });

  it("converts þ/Þ to th", () => {
    expect(slugify("Þórr")).toBe("thorr");
  });

  it("lower-cases the capitals NFKD yields from compatibility letters (ℂ, bold 𝐀)", () => {
    // ℂ and 𝐀 have no lower-case mapping of their own; NFKD turns them into C and A.
    expect(slugify("ℂafé 𝐀𝐁𝐂")).toBe("cafe-abc");
  });
});

// ── AC-CAT-62: Separator collapsing ──────────────────────────────────────────

describe("AC-CAT-62: slugify collapses separators", () => {
  it("replaces spaces with a single dash", () => {
    expect(slugify("hello world")).toBe("hello-world");
  });

  it("collapses multiple spaces into one dash", () => {
    expect(slugify("hello   world")).toBe("hello-world");
  });

  it("collapses mixed separators (space, underscore, dash)", () => {
    expect(slugify("hello - world_test")).toBe("hello-world-test");
  });

  it("trims leading and trailing dashes", () => {
    expect(slugify("  hello  ")).toBe("hello");
  });

  it("trims leading dash from separator-only start", () => {
    expect(slugify("-hello-")).toBe("hello");
  });

  it("collapses multiple consecutive dashes into one", () => {
    expect(slugify("hello--world")).toBe("hello-world");
  });

  it("returns empty string for an all-separator input", () => {
    expect(slugify("   ---   ")).toBe("");
  });
});

// ── AC-CAT-63: Length cap ────────────────────────────────────────────────────

describe("AC-CAT-63: slugify caps at 80 chars with no trailing dash", () => {
  it("does not truncate a 80-char-or-shorter slug", () => {
    const input = "a".repeat(80);
    const result = slugify(input);
    expect(result.length).toBeLessThanOrEqual(80);
    expect(result).toBe("a".repeat(80));
  });

  it("truncates a slug longer than 80 chars", () => {
    const input = "a".repeat(90);
    const result = slugify(input);
    expect(result.length).toBeLessThanOrEqual(80);
  });

  it("does not end with a dash after truncation", () => {
    // Construct a slug that would end with a dash at position 80
    const input = "a".repeat(79) + " b";
    const result = slugify(input);
    expect(result.length).toBeLessThanOrEqual(80);
    expect(result).not.toMatch(/-$/);
  });

  it("handles a word-boundary truncation: no trailing dash", () => {
    // 78 a's + space + longer word — dash would be at position 79
    const input = "a".repeat(78) + " " + "b".repeat(10);
    const result = slugify(input);
    expect(result.length).toBeLessThanOrEqual(80);
    expect(result).not.toMatch(/-$/);
  });
});

// ── AC-CAT-64: Output matches slug regex ─────────────────────────────────────

describe("AC-CAT-64: slugify output matches slug regex or is empty", () => {
  it("a normal string produces a slug-regex-matching output", () => {
    const result = slugify("My New App");
    expect(result).toMatch(SLUG_RE);
  });

  it("Danish word produces a slug-regex-matching output", () => {
    const result = slugify("Bæredygtig Løsning");
    expect(result).toMatch(SLUG_RE);
  });

  it("digits are preserved", () => {
    expect(slugify("app2024")).toBe("app2024");
  });

  it("all-separator input returns empty string (not a slug-regex match — valid edge case)", () => {
    expect(slugify("---")).toBe("");
  });

  it("an empty string returns empty string", () => {
    expect(slugify("")).toBe("");
  });

  it("a non-empty valid word never returns empty", () => {
    const result = slugify("hello");
    expect(result).toMatch(SLUG_RE);
  });
});

describe("AC-CATPUB-01/AC-CATPUB-10: isValidSlug accepts exactly the stored slug format", () => {
  it.each(["ydelser", "web-development", "app2024", "a", "a".repeat(80)])("accepts %s", (slug) => {
    expect(isValidSlug(slug)).toBe(true);
  });

  it.each(MALFORMED_SLUGS)("rejects a slug with %s", (_problem, slug) => {
    expect(isValidSlug(slug)).toBe(false);
  });

  it("accepts every non-empty slugify output", () => {
    for (const title of ["My New App", "Bæredygtig Løsning", "a".repeat(90), "a".repeat(79) + " b"]) {
      expect(isValidSlug(slugify(title))).toBe(true);
    }
  });
});
