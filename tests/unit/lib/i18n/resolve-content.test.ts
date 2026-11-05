// Tests for AC-I18N-15 through AC-I18N-18
import { describe, it, expect } from "vitest";

import { resolveContent } from "@/lib/i18n/resolve-content";

// Minimal shape used in tests — mirrors a DB translation row with string fields.
interface TranslationRow {
  title: string;
  lead: string;
  body: string;
}

const daRow: TranslationRow = {
  title: "Forside",
  lead: "Velkommen til Alnyron",
  body: "Her kan du læse om vores ydelser.",
};

const enRowFull: TranslationRow = {
  title: "Home",
  lead: "Welcome to Alnyron",
  body: "Here you can read about our services.",
};

const enRowPartial: TranslationRow = {
  title: "Home",
  lead: "",   // blank — must fall back to DA
  body: "",   // blank — must fall back to DA
};

describe("resolveContent — AC-I18N-15: DA locale returns DA row unchanged", () => {
  it("returns the DA row as value when locale is 'da'", () => {
    const { value } = resolveContent(daRow, enRowFull, "da");
    expect(value).toEqual(daRow);
  });

  it("reports no fallback keys when locale is 'da'", () => {
    const { fallbackKeys } = resolveContent(daRow, enRowFull, "da");
    expect(fallbackKeys).toHaveLength(0);
  });

  it("returns DA row even when enRow is null", () => {
    const { value, fallbackKeys } = resolveContent(daRow, null, "da");
    expect(value).toEqual(daRow);
    expect(fallbackKeys).toHaveLength(0);
  });
});

describe("resolveContent — AC-I18N-16: EN locale with non-blank EN field uses EN value", () => {
  it("uses enRow.title when it is a non-blank string", () => {
    const { value } = resolveContent(daRow, enRowFull, "en");
    expect(value.title).toBe("Home");
  });

  it("does not include 'title' in fallbackKeys when EN title is non-blank", () => {
    const { fallbackKeys } = resolveContent(daRow, enRowFull, "en");
    expect(fallbackKeys).not.toContain("title");
  });

  it("uses all EN values when every EN field is non-blank", () => {
    const { value } = resolveContent(daRow, enRowFull, "en");
    expect(value).toEqual(enRowFull);
  });
});

describe("resolveContent — AC-I18N-17: EN locale with blank EN field falls back to DA", () => {
  it("uses daRow.lead when enRow.lead is blank", () => {
    const { value } = resolveContent(daRow, enRowPartial, "en");
    expect(value.lead).toBe(daRow.lead);
  });

  it("includes 'lead' in fallbackKeys when EN lead is blank", () => {
    const { fallbackKeys } = resolveContent(daRow, enRowPartial, "en");
    expect(fallbackKeys).toContain("lead");
  });

  it("includes 'body' in fallbackKeys when EN body is blank", () => {
    const { fallbackKeys } = resolveContent(daRow, enRowPartial, "en");
    expect(fallbackKeys).toContain("body");
  });

  it("uses EN title when non-blank alongside falling back on lead/body", () => {
    const { value } = resolveContent(daRow, enRowPartial, "en");
    expect(value.title).toBe("Home");
  });
});

describe("resolveContent — AC-I18N-18: null/undefined enRow falls back entirely to DA", () => {
  it("uses all DA values when enRow is null", () => {
    const { value } = resolveContent(daRow, null, "en");
    expect(value).toEqual(daRow);
  });

  it("reports every key in fallbackKeys when enRow is null", () => {
    const { fallbackKeys } = resolveContent(daRow, null, "en");
    const daKeys = Object.keys(daRow) as (keyof TranslationRow)[];
    for (const key of daKeys) {
      expect(fallbackKeys).toContain(key);
    }
  });

  it("uses all DA values when enRow is undefined", () => {
    const { value } = resolveContent(daRow, undefined, "en");
    expect(value).toEqual(daRow);
  });
});
