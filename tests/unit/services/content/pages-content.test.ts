// Unit tests for F0.5 home-page — getHomePage content parsing and failures
// Acceptance IDs: AC-HOME-01, AC-HOME-03 (fallback inside content)
//
// Fallback basics live in pages.test.ts. Here: the stored `content` JSON is
// parsed (missing blocks/fields read as blank, a wrong shape is an error), the
// EN query asks for both locales, and broken reads throw instead of rendering
// an empty home page.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockIn } = vi.hoisted(() => ({ mockIn: vi.fn() }));

// Chain: .from("page_translations").select(...).eq(...).in("locale", [...])
vi.mock("@/lib/supabase/public", () => ({
  getPublicClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ in: mockIn }) }) }) }),
}));

import { getHomePage } from "@/services/content/pages";

const daRow = { locale: "da", title: "Titel", lead: "Lead", content: {} };

beforeEach(() => {
  mockIn.mockResolvedValue({ data: [daRow], error: null });
});

describe("getHomePage — content parsing", () => {
  it("missing content blocks and fields read as blank strings", async () => {
    const { value } = await getHomePage("da");
    expect(value.content).toEqual({
      whatWeDo: { eyebrow: "", title: "", intro: "", note: "" },
      ctaBand: { title: "", text: "" },
    });
  });

  it("EN: a content leaf filled in EN wins, the rest falls back with dotted keys", async () => {
    mockIn.mockResolvedValue({
      data: [
        { ...daRow, content: { ctaBand: { title: "Klar?", text: "Skriv til {email}." } } },
        { locale: "en", title: "", lead: "", content: { ctaBand: { title: "Ready?" } } },
      ],
      error: null,
    });
    const { value, fallbackKeys } = await getHomePage("en");
    expect(value.content.ctaBand).toEqual({ title: "Ready?", text: "Skriv til {email}." });
    expect(fallbackKeys).toContain("content.ctaBand.text");
    expect(fallbackKeys).not.toContain("content.ctaBand.title");
  });

  it("throws when content has the wrong shape", async () => {
    mockIn.mockResolvedValue({ data: [{ ...daRow, content: { whatWeDo: { title: 42 } } }], error: null });
    await expect(getHomePage("da")).rejects.toThrow();
  });
});

describe("getHomePage — query", () => {
  it("DA asks for the Danish row only", async () => {
    await getHomePage("da");
    expect(mockIn).toHaveBeenCalledWith("locale", ["da"]);
  });

  it("EN asks for both rows (Danish is the fallback source)", async () => {
    await getHomePage("en");
    expect(mockIn).toHaveBeenCalledWith("locale", ["da", "en"]);
  });
});

describe("getHomePage — failures are loud", () => {
  it("throws when the Danish row is missing", async () => {
    mockIn.mockResolvedValue({ data: [], error: null });
    await expect(getHomePage("en")).rejects.toThrow(/no Danish translation/);
  });

  it("throws when the query fails", async () => {
    mockIn.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(getHomePage("da")).rejects.toThrow(/boom/);
  });
});
