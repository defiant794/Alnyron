/**
 * Unit tests — getContactPage service (F1.2 pages editor)
 * Journey: pages-editor  AC-PAGES-19, 20
 *
 * Expected module: src/services/content/pages.ts  (new export alongside getHomePage)
 *
 * Seeded contact content (20261101000300_seed_system_content.sql, company row
 * from 20261106000300_site_cvr.sql):
 *   DA title:   "Lad os tale om dit projekt"
 *   DA lead:    "Skriv til os, så vender vi hurtigt tilbage. Du kan også sende en mail direkte."
 *   DA content: { eyebrow: "Kontakt", responseTime: "Typisk inden for 1-2 hverdage",
 *                 languages: "Dansk / English", company: "Alnyron · CVR {cvr}" }
 *   EN:         title="", lead="", content={}  (full DA fallback)
 *
 * getContactPage(locale) follows the same DA-fallback pattern as getHomePage:
 *  - DA locale → DA row as-is
 *  - EN locale, blank EN fields → DA value + fallbackKeys entry
 *  - EN locale, non-blank EN field → EN value, no fallbackKey
 *
 * Content-level fallback: individual nested keys in `content` also fall back
 * field-by-field (same mergeLocalizedWithFallbacks logic as getHomePage).
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// ── Mock the public Supabase client ───────────────────────────────────────────

const mockFrom = vi.fn();

vi.mock("@/lib/supabase/public", () => ({
  getPublicClient: () => ({ from: mockFrom }),
}));

// getContactPage replaces {cvr} with site_settings.cvr (AC-CVR-03).
vi.mock("@/services/content/settings", () => ({ getSiteSettings: vi.fn() }));

// ── Module under test ─────────────────────────────────────────────────────────

import { getContactPage } from "@/services/content/pages";
import { getSiteSettings } from "@/services/content/settings";

// ── Content type (mirrors the expected service shape) ─────────────────────────

interface ContactContent {
  eyebrow: string;
  responseTime: string;
  languages: string;
  company: string;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Seeded DA contact page row. */
const DA_CONTACT = {
  locale: "da",
  title: "Lad os tale om dit projekt",
  lead: "Skriv til os, så vender vi hurtigt tilbage. Du kan også sende en mail direkte.",
  content: {
    eyebrow: "Kontakt",
    responseTime: "Typisk inden for 1-2 hverdage",
    languages: "Dansk / English",
    company: "Alnyron · CVR {cvr}",
  } satisfies ContactContent,
  body_md: "",
  pages: { system_key: "contact" },
};

/** EN row from seed — all blank (full DA fallback). */
const EN_CONTACT_BLANK = {
  locale: "en",
  title: "",
  lead: "",
  content: {} as Partial<ContactContent>,
  body_md: "",
  pages: { system_key: "contact" },
};

/** EN row with non-blank title — partial DA fallback. */
const EN_CONTACT_TITLED = {
  ...EN_CONTACT_BLANK,
  title: "Contact us",
};

/** EN row with responseTime filled but other keys blank. */
const EN_CONTACT_PARTIAL_CONTENT = {
  ...EN_CONTACT_BLANK,
  content: { responseTime: "Within 1-2 business days" } as Partial<ContactContent>,
};

/** Row whose content has the wrong shape (not an object). */
const DA_CONTACT_BAD_CONTENT = {
  ...DA_CONTACT,
  content: "not an object" as unknown as ContactContent,
};

/**
 * Configures mockFrom so the query chain returns `rows`.
 * Mirrors the pattern in tests/unit/services/content/pages.test.ts.
 */
function mockPageTranslations(rows: Array<Omit<typeof DA_CONTACT, "content"> & { content: Partial<ContactContent> }>) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockResolvedValue({ data: rows, error: null }),
  };
  mockFrom.mockReturnValue(chain);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSiteSettings).mockResolvedValue({
    companyName: "Alnyron",
    contactEmail: "info@alnyron.dk",
    cvr: "46887433",
  });
});

// ── AC-PAGES-19: DA locale returns DA translation ─────────────────────────────

describe("AC-PAGES-19: getContactPage('da') — returns DA translation from page_translations", () => {
  it("AC-PAGES-19a: returns DA title and lead when locale is 'da'", async () => {
    mockPageTranslations([DA_CONTACT]);
    const result = await getContactPage("da");
    expect(result.value.title).toBe("Lad os tale om dit projekt");
    expect(result.value.lead).toBe(
      "Skriv til os, så vender vi hurtigt tilbage. Du kan også sende en mail direkte.",
    );
  });

  it("AC-PAGES-19b: queries page_translations filtered by system_key='contact'", async () => {
    mockPageTranslations([DA_CONTACT]);
    await getContactPage("da");
    // from() must target page_translations; the system_key='contact' filter is
    // applied via an inner join to pages (same pattern as getHomePage).
    expect(mockFrom).toHaveBeenCalledWith("page_translations");
    // The eq() call must filter on the contact system_key.
    const chain = mockFrom.mock.results[0]!.value as { eq: Mock };
    expect(chain.eq).toHaveBeenCalledWith(
      expect.stringMatching(/system_key/),
      "contact",
    );
  });

  it("AC-PAGES-19c: returns the seeded content object with all four keys", async () => {
    mockPageTranslations([DA_CONTACT]);
    const result = await getContactPage("da");
    expect(result.value.content).toEqual({
      eyebrow: "Kontakt",
      responseTime: "Typisk inden for 1-2 hverdage",
      languages: "Dansk / English",
      company: "Alnyron · CVR 46887433",
    });
  });

  it("AC-PAGES-19d: throws when DA translation is missing (broken seed)", async () => {
    mockPageTranslations([]); // no rows at all
    await expect(getContactPage("da")).rejects.toThrow();
  });

  it("AC-PAGES-19e: throws when content has wrong shape", async () => {
    mockPageTranslations([DA_CONTACT_BAD_CONTENT]);
    await expect(getContactPage("da")).rejects.toThrow();
  });
});

// ── AC-PAGES-20: EN locale falls back to DA ───────────────────────────────────

describe("AC-PAGES-20: getContactPage('en') — DA fallback when EN translation is blank", () => {
  it("AC-PAGES-20a: EN locale, blank EN title → title from DA", async () => {
    mockPageTranslations([DA_CONTACT, EN_CONTACT_BLANK]);
    const result = await getContactPage("en");
    expect(result.value.title).toBe("Lad os tale om dit projekt");
  });

  it("AC-PAGES-20b: EN locale, blank EN title → fallbackKeys includes 'title'", async () => {
    mockPageTranslations([DA_CONTACT, EN_CONTACT_BLANK]);
    const result = await getContactPage("en");
    expect(result.fallbackKeys).toContain("title");
  });

  it("AC-PAGES-20c: EN locale, non-blank EN title → EN title used, no fallback for title", async () => {
    mockPageTranslations([DA_CONTACT, EN_CONTACT_TITLED]);
    const result = await getContactPage("en");
    expect(result.value.title).toBe("Contact us");
    expect(result.fallbackKeys).not.toContain("title");
  });

  it("AC-PAGES-20d: EN locale, no EN row at all → falls back entirely to DA", async () => {
    mockPageTranslations([DA_CONTACT]);
    const result = await getContactPage("en");
    expect(result.value.title).toBe("Lad os tale om dit projekt");
    expect(result.value.lead).toContain("Skriv til os");
  });

  it("AC-PAGES-20e: EN locale, EN content.responseTime filled → EN value used for that key", async () => {
    mockPageTranslations([DA_CONTACT, EN_CONTACT_PARTIAL_CONTENT]);
    const result = await getContactPage("en");
    const content = result.value.content as ContactContent;
    expect(content.responseTime).toBe("Within 1-2 business days");
  });

  it("AC-PAGES-20f: EN locale, EN content.responseTime filled but eyebrow blank → eyebrow from DA", async () => {
    mockPageTranslations([DA_CONTACT, EN_CONTACT_PARTIAL_CONTENT]);
    const result = await getContactPage("en");
    const content = result.value.content as ContactContent;
    // eyebrow not in EN content → falls back to DA "Kontakt"
    expect(content.eyebrow).toBe("Kontakt");
    expect(result.fallbackKeys).toContainEqual(expect.stringMatching(/content.*eyebrow|eyebrow/));
  });
});

// ── AC-CVR-03: {cvr} in the company row renders site_settings.cvr ─────────────

describe("AC-CVR-03: getContactPage — {cvr} in content.company renders site_settings.cvr", () => {
  it("AC-CVR-03a: DA company row shows the CVR from site_settings", async () => {
    mockPageTranslations([DA_CONTACT]);
    const result = await getContactPage("da");
    expect(result.value.content.company).toBe("Alnyron · CVR 46887433");
    expect(getSiteSettings).toHaveBeenCalled();
  });

  it("AC-CVR-03b: EN with a blank company row shows the Danish row with the CVR (marked as fallback)", async () => {
    mockPageTranslations([DA_CONTACT, EN_CONTACT_BLANK]);
    const result = await getContactPage("en");
    expect(result.value.content.company).toBe("Alnyron · CVR 46887433");
    expect(result.fallbackKeys).toContain("content.company");
  });

  it("AC-CVR-03c: EN's own company row gets the CVR too", async () => {
    mockPageTranslations([DA_CONTACT, { ...EN_CONTACT_BLANK, content: { company: "Alnyron (CVR {cvr})" } }]);
    const result = await getContactPage("en");
    expect(result.value.content.company).toBe("Alnyron (CVR 46887433)");
    expect(result.fallbackKeys).not.toContain("content.company");
  });

  it("AC-CVR-03d: follows site_settings.cvr, not a fixed number", async () => {
    vi.mocked(getSiteSettings).mockResolvedValue({
      companyName: "Alnyron",
      contactEmail: "info@alnyron.dk",
      cvr: "12345678",
    });
    mockPageTranslations([DA_CONTACT]);
    const result = await getContactPage("da");
    expect(result.value.content.company).toBe("Alnyron · CVR 12345678");
  });

  it("AC-CVR-03e: no raw {cvr} token reaches the page while the CVR is not set", async () => {
    vi.mocked(getSiteSettings).mockResolvedValue({
      companyName: "Alnyron",
      contactEmail: "info@alnyron.dk",
      cvr: null,
    });
    mockPageTranslations([DA_CONTACT]);
    const result = await getContactPage("da");
    expect(result.value.content.company).not.toContain("{cvr}");
  });
});
