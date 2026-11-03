/**
 * Unit tests — formatPrice utility (F2.1 catalog-model)
 * Journey: catalog-model  AC-CAT-65, AC-CAT-66, AC-CAT-67, AC-CAT-68, AC-CAT-69
 *
 * Module: src/lib/format-price.ts
 *
 * Intl.NumberFormat puts a no-break space (U+00A0) between the amount and
 * `kr.`, and formatPrice joins the "from" label to the amount with one too, so
 * neither ever wraps onto its own line. The assertions compare exact strings,
 * NBSPs included.
 */

import { describe, it, expect } from "vitest";
import { formatPrice } from "@/lib/format-price";

const NBSP = "\u00a0";

const DA_LABELS = { from: "fra", vatIncluded: "inkl. moms", contact: "Kontakt" };
const EN_LABELS = { from: "from", vatIncluded: "incl. VAT", contact: "Contact" };

// ── AC-CAT-65: null type returns null ────────────────────────────────────────

describe("AC-CAT-65: formatPrice returns null when type is null", () => {
  it("returns null for type=null (DA locale)", () => {
    expect(formatPrice({ type: null, amount: null, currency: "DKK" }, "da", DA_LABELS)).toBeNull();
  });

  it("returns null for type=null with an amount present (DA locale)", () => {
    expect(formatPrice({ type: null, amount: 1000, currency: "DKK" }, "da", DA_LABELS)).toBeNull();
  });

  it("returns null for type=null (EN locale)", () => {
    expect(formatPrice({ type: null, amount: null, currency: "DKK" }, "en", EN_LABELS)).toBeNull();
  });
});

// ── AC-CAT-66: contact type ───────────────────────────────────────────────────

describe("AC-CAT-66: formatPrice returns labels.contact with vat:null for contact type", () => {
  it("returns {text: labels.contact, vat: null} for DA locale", () => {
    const result = formatPrice({ type: "contact", amount: null, currency: "DKK" }, "da", DA_LABELS);
    expect(result).toEqual({ text: "Kontakt", vat: null });
  });

  it("returns {text: labels.contact, vat: null} for EN locale", () => {
    const result = formatPrice({ type: "contact", amount: null, currency: "DKK" }, "en", EN_LABELS);
    expect(result).toEqual({ text: "Contact", vat: null });
  });

  it("ignores any amount when type=contact", () => {
    const result = formatPrice({ type: "contact", amount: 500, currency: "DKK" }, "da", DA_LABELS);
    expect(result).toEqual({ text: "Kontakt", vat: null });
  });
});

// ── AC-CAT-67: fixed type DA locale ──────────────────────────────────────────

describe("AC-CAT-67: formatPrice formats fixed price in DA locale", () => {
  it("formats 12000 DKK as '12.000 kr.' (NBSP before kr.) with inkl. moms", () => {
    const result = formatPrice({ type: "fixed", amount: 12000, currency: "DKK" }, "da", DA_LABELS);
    expect(result).toEqual({ text: `12.000${NBSP}kr.`, vat: "inkl. moms" });
  });

  it("formats a round number without decimals", () => {
    const result = formatPrice({ type: "fixed", amount: 500, currency: "DKK" }, "da", DA_LABELS);
    expect(result).toEqual({ text: `500${NBSP}kr.`, vat: "inkl. moms" });
  });

  it("formats a decimal price with 2 fractional digits", () => {
    const result = formatPrice({ type: "fixed", amount: 999.99, currency: "DKK" }, "da", DA_LABELS);
    expect(result).toEqual({ text: `999,99${NBSP}kr.`, vat: "inkl. moms" });
  });

  it("AC-CAT-67: pads a fractional amount to 2 digits ('12,50 kr.', NBSP before kr.)", () => {
    const result = formatPrice({ type: "fixed", amount: 12.5, currency: "DKK" }, "da", DA_LABELS);
    expect(result).toEqual({ text: `12,50${NBSP}kr.`, vat: "inkl. moms" });
  });

  it("AC-CAT-65/67: returns null for a fixed price without an amount", () => {
    expect(formatPrice({ type: "fixed", amount: null, currency: "DKK" }, "da", DA_LABELS)).toBeNull();
  });

  it("returns vat label equal to labels.vatIncluded", () => {
    const result = formatPrice({ type: "fixed", amount: 12000, currency: "DKK" }, "da", DA_LABELS);
    expect(result?.vat).toBe(DA_LABELS.vatIncluded);
  });
});

// ── AC-CAT-68: from type DA locale ───────────────────────────────────────────

describe("AC-CAT-68: formatPrice formats from price in DA locale", () => {
  it("prefixes the amount with labels.from and a no-break space", () => {
    const result = formatPrice({ type: "from", amount: 12000, currency: "DKK" }, "da", DA_LABELS);
    expect(result).toEqual({ text: `fra${NBSP}12.000${NBSP}kr.`, vat: "inkl. moms" });
  });

  it("never puts a breaking space in the text", () => {
    const result = formatPrice({ type: "from", amount: 12000, currency: "DKK" }, "da", DA_LABELS);
    expect(result?.text).not.toMatch(/ /);
  });

  it("returns vat = labels.vatIncluded", () => {
    const result = formatPrice({ type: "from", amount: 500, currency: "DKK" }, "da", DA_LABELS);
    expect(result?.vat).toBe(DA_LABELS.vatIncluded);
  });

  it("AC-CAT-65/68: returns null for a from price without an amount", () => {
    expect(formatPrice({ type: "from", amount: null, currency: "DKK" }, "da", DA_LABELS)).toBeNull();
  });
});

// ── AC-CAT-69: EN locale ──────────────────────────────────────────────────────

describe("AC-CAT-69: formatPrice formats price in EN locale", () => {
  it("formats fixed 12000 DKK in EN locale (en-DK conventions)", () => {
    const result = formatPrice({ type: "fixed", amount: 12000, currency: "DKK" }, "en", EN_LABELS);
    // en-DK uses '.' as thousands separator and 'kr.' as symbol
    expect(result).toEqual({ text: `12.000${NBSP}kr.`, vat: EN_LABELS.vatIncluded });
  });

  it("formats a decimal price in EN locale with en-DK's decimal comma", () => {
    const result = formatPrice({ type: "fixed", amount: 999.99, currency: "DKK" }, "en", EN_LABELS);
    expect(result).toEqual({ text: `999,99${NBSP}kr.`, vat: EN_LABELS.vatIncluded });
  });

  it("formats from price in EN locale with labels.from prefix and a no-break space", () => {
    const result = formatPrice({ type: "from", amount: 12000, currency: "DKK" }, "en", EN_LABELS);
    expect(result).toEqual({ text: `from${NBSP}12.000${NBSP}kr.`, vat: EN_LABELS.vatIncluded });
  });

  it("returns {text: Contact, vat: null} for contact type in EN locale", () => {
    const result = formatPrice({ type: "contact", amount: null, currency: "DKK" }, "en", EN_LABELS);
    expect(result).toEqual({ text: "Contact", vat: null });
  });
});
