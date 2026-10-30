// Unit tests for F0.5 home-page — content service with mocked public client
// Acceptance IDs: AC-HOME-01 (content shape), AC-HOME-02, AC-HOME-03 (fallback keys)
//
// The service calls getPublicClient() internally; we mock the module so no
// real Supabase connection is needed in unit tests.
//
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock the public Supabase client module ────────────────────────────────────
// Mocked before the import that calls getPublicClient at module level (if any).

const mockFrom = vi.fn();

vi.mock("@/lib/supabase/public", () => ({
  getPublicClient: () => ({ from: mockFrom }),
}));

import { getHomePage } from "@/services/content/pages";

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** DA home translation row (matches the seed migration content). */
const daTranslation = {
  locale: "da",
  title: "Moderne apps, hjemmesider og digitale ydelser.",
  lead: "Alnyron bygger gennemtænkte digitale produkter, der er enkle, hurtige og tilgængelige. Fortæl om dit projekt, så finder vi den rette løsning.",
  content: {
    whatWeDo: {
      eyebrow: "Hvad vi laver",
      title: "Én samarbejdspartner, flere muligheder",
      intro: "Vi arbejder blandt andet med:",
      note: "Offentlige områder vises automatisk, når de har indhold. Tomme områder skjules, og der kan altid komme flere til.",
    },
    ctaBand: {
      title: "Klar til at tale om dit projekt?",
      text: "Skriv til {email}, så vender vi hurtigt tilbage.",
    },
  },
};

/** EN translation with all blank fields (realistic: owner hasn't added EN copy yet). */
const enTranslationBlank = {
  locale: "en",
  title: "",
  lead: "",
  content: {},
};

/** EN translation with a non-blank title and blank lead. */
const enTranslationPartialTitle = {
  locale: "en",
  title: "Modern apps, websites and digital services.",
  lead: "",
  content: {},
};

/** Helper: makes mockFrom chain return translation rows for both locales. */
function mockPageTranslations(rows: { locale: string; title: string; lead: string; content: object }[]) {
  // Chain: .from("page_translations").select("...").eq("...").in("...")
  mockFrom.mockReturnValue({
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        in: vi.fn().mockResolvedValue({ data: rows, error: null }),
      }),
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── AC-HOME-01: DA locale returns DA row without fallback ─────────────────────

describe("AC-HOME-01: getHomePage('da') — returns DA content as-is", () => {
  it("returns the DA title unchanged", async () => {
    mockPageTranslations([daTranslation, enTranslationBlank]);
    const result = await getHomePage("da");
    expect(result.value.title).toBe(daTranslation.title);
  });

  it("returns the DA lead unchanged", async () => {
    mockPageTranslations([daTranslation, enTranslationBlank]);
    const result = await getHomePage("da");
    expect(result.value.lead).toBe(daTranslation.lead);
  });

  it("reports no fallbackKeys for the DA locale", async () => {
    mockPageTranslations([daTranslation, enTranslationBlank]);
    const result = await getHomePage("da");
    expect(result.fallbackKeys).toEqual([]);
  });

  it("returns whatWeDo eyebrow from DA content", async () => {
    mockPageTranslations([daTranslation, enTranslationBlank]);
    const result = await getHomePage("da");
    expect(result.value.content.whatWeDo.eyebrow).toBe("Hvad vi laver");
  });
});

// ── AC-HOME-02/03: EN locale, all-blank EN translation falls back to DA ───────

describe("AC-HOME-02/03: getHomePage('en') with blank EN translation — DA fallback", () => {
  it("returns the DA title when EN title is blank", async () => {
    mockPageTranslations([daTranslation, enTranslationBlank]);
    const result = await getHomePage("en");
    expect(result.value.title).toBe(daTranslation.title);
  });

  it("includes 'title' in fallbackKeys when EN title is blank", async () => {
    mockPageTranslations([daTranslation, enTranslationBlank]);
    const result = await getHomePage("en");
    expect(result.fallbackKeys).toContain("title");
  });

  it("returns the DA lead when EN lead is blank", async () => {
    mockPageTranslations([daTranslation, enTranslationBlank]);
    const result = await getHomePage("en");
    expect(result.value.lead).toBe(daTranslation.lead);
  });

  it("includes 'lead' in fallbackKeys when EN lead is blank", async () => {
    mockPageTranslations([daTranslation, enTranslationBlank]);
    const result = await getHomePage("en");
    expect(result.fallbackKeys).toContain("lead");
  });

  it("falls back whatWeDo.eyebrow to DA when EN content is empty", async () => {
    mockPageTranslations([daTranslation, enTranslationBlank]);
    const result = await getHomePage("en");
    expect(result.value.content.whatWeDo.eyebrow).toBe("Hvad vi laver");
  });

  it("includes 'content.whatWeDo.eyebrow' in fallbackKeys when EN content is empty", async () => {
    mockPageTranslations([daTranslation, enTranslationBlank]);
    const result = await getHomePage("en");
    expect(result.fallbackKeys).toContain("content.whatWeDo.eyebrow");
  });

  it("fallbackKeys is non-empty when all EN fields are blank", async () => {
    mockPageTranslations([daTranslation, enTranslationBlank]);
    const result = await getHomePage("en");
    expect(result.fallbackKeys.length).toBeGreaterThan(0);
  });
});

// ── AC-HOME-02b: EN locale, partial EN translation (non-blank title) ──────────

describe("AC-HOME-02b: getHomePage('en') with non-blank EN title — uses EN value", () => {
  it("returns the EN title when it is non-blank", async () => {
    mockPageTranslations([daTranslation, enTranslationPartialTitle]);
    const result = await getHomePage("en");
    expect(result.value.title).toBe(enTranslationPartialTitle.title);
  });

  it("does not include 'title' in fallbackKeys when EN title is non-blank", async () => {
    mockPageTranslations([daTranslation, enTranslationPartialTitle]);
    const result = await getHomePage("en");
    expect(result.fallbackKeys).not.toContain("title");
  });

  it("still falls back lead to DA (EN lead is blank)", async () => {
    mockPageTranslations([daTranslation, enTranslationPartialTitle]);
    const result = await getHomePage("en");
    expect(result.value.lead).toBe(daTranslation.lead);
    expect(result.fallbackKeys).toContain("lead");
  });
});

// ── AC-HOME-03b: null EN translation falls back entirely ──────────────────────

describe("AC-HOME-03b: getHomePage('en') — null/missing EN row falls back entirely to DA", () => {
  it("returns DA title when only the DA row is present", async () => {
    mockPageTranslations([daTranslation]); // no EN row
    const result = await getHomePage("en");
    expect(result.value.title).toBe(daTranslation.title);
  });

  it("includes 'title' in fallbackKeys", async () => {
    mockPageTranslations([daTranslation]);
    const result = await getHomePage("en");
    expect(result.fallbackKeys).toContain("title");
  });

  it("includes 'lead' in fallbackKeys", async () => {
    mockPageTranslations([daTranslation]);
    const result = await getHomePage("en");
    expect(result.fallbackKeys).toContain("lead");
  });
});

// ── Return shape contract ──────────────────────────────────────────────────────

describe("getHomePage — return shape contract", () => {
  it("returns an object with 'value' and 'fallbackKeys' fields", async () => {
    mockPageTranslations([daTranslation, enTranslationBlank]);
    const result = await getHomePage("da");
    expect(result).toHaveProperty("value");
    expect(result).toHaveProperty("fallbackKeys");
  });

  it("value has title, lead, and content fields", async () => {
    mockPageTranslations([daTranslation, enTranslationBlank]);
    const result = await getHomePage("da");
    expect(result.value).toHaveProperty("title");
    expect(result.value).toHaveProperty("lead");
    expect(result.value).toHaveProperty("content");
  });

  it("content has whatWeDo and ctaBand fields", async () => {
    mockPageTranslations([daTranslation, enTranslationBlank]);
    const result = await getHomePage("da");
    expect(result.value.content).toHaveProperty("whatWeDo");
    expect(result.value.content).toHaveProperty("ctaBand");
  });

  it("fallbackKeys is always an array", async () => {
    mockPageTranslations([daTranslation, enTranslationBlank]);
    const result = await getHomePage("da");
    expect(Array.isArray(result.fallbackKeys)).toBe(true);
  });
});
