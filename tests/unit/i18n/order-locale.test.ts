/**
 * Unit tests: src/i18n/order-locale.ts — orderLocale, ORDER_LOCALE_HEADER
 * Journey: payments-s2-3d-purchase
 * Criteria: S2-MW-1 (web) — the /order pages' language: a site locale exactly, else Danish
 *
 * Test IDs: S2-T-ORL-01..02
 */
import { describe, expect, it } from "vitest";
import { ORDER_LOCALE_HEADER, orderLocale } from "@/i18n/order-locale";

describe("S2-T-ORL-01: orderLocale — only an exact site locale passes, anything else is Danish", () => {
  it.each<[string, "da" | "en", unknown]>([
    ["da", "da", "da"],
    ["en", "en", "en"],
    ["missing (undefined)", "da", undefined],
    ["null (no header)", "da", null],
    ["empty string", "da", ""],
    ["upper case EN", "da", "EN"],
    ["en with a space", "da", "en "],
    ["unsupported de", "da", "de"],
    ["a region tag en-GB", "da", "en-GB"],
    ["a repeated query value (array)", "da", ["en", "en"]],
    ["a number", "da", 1],
    ["an object", "da", { name: "en" }],
  ])("%s → %s", (_label, expected, value) => {
    expect(orderLocale(value)).toBe(expected);
  });
});

describe("S2-T-ORL-02: ORDER_LOCALE_HEADER", () => {
  it("is the request header the middleware sets for the /order layout", () => {
    expect(ORDER_LOCALE_HEADER).toBe("x-order-locale");
  });
});
