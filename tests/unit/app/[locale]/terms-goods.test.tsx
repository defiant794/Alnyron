// @vitest-environment jsdom
/**
 * Unit tests: src/app/[locale]/terms/page.tsx — goods sections (S2 addition)
 * Journey: payments-s2-3d-purchase
 * Criteria: S2-LEGAL-1..9 (web layer, /terms goods sections)
 *
 * Test IDs: S2-T-TERMS-G-01..09, S2-T-TERMS-G-D2
 *
 * The subscription part above repeats the seller's address, CVR, a notice and a
 * model form, so every goods check is scoped to the goods part: the nearest
 * block holding both the "Køb af 3D-figurer" heading and the goods withdraw link.
 *
 * Copy pinned from s2-terms-goods.html mock and goods-texts.ts (no em-dash):
 *   DA goods section:  "Køb af 3D-figurer" (h2)
 *   seller:            "Nyvej 4, 7860 Spøttrup, Danmark", "CVR 46887433"
 *   dispatch fact:     "Varen sendes inden for 3 hverdage" (S2-LEGAL-5)
 *   return shipping:   buyer pays (S2-LEGAL-6)
 *   notice:            "Fortrydelsesvejledning" (h3) with the goods notice
 *   model form:        "Standardfortrydelsesformular" (h3) with the goods lines
 *   reservation:       "Beløbet reserveres ved bestillingen og trækkes først, når varen sendes."
 *   version:           "Version goods-2026-11-14.1."
 *   withdrawal link:   "Fortryd køb af varer" → /order/withdraw?lang=da (DA)
 *                      "Withdraw a purchase of goods" → /order/withdraw?lang=en (EN)
 *   no em-dash:        S2-LEGAL-3
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("next-intl/server", async () =>
  // Exception: vi.mock factory is hoisted; must dynamically import the helper.
  (await import("../../../helpers/next-intl-server")).nextIntlServerMock(),
);
vi.mock("@/services/content/pages", () => ({
  getTermsPage: vi.fn(),
  getPageMetadata: vi.fn(),
}));
vi.mock("@/components/site/SiteFooter", () => ({ default: () => <footer /> }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useRouter: () => ({ push: vi.fn() }),
}));

import TermsPage from "@/app/[locale]/terms/page";
import { getTermsPage, getPageMetadata } from "@/services/content/pages";

afterEach(cleanup);

// getTermsPage resolves the terms system page as ResolvedContent (value + fallbackKeys),
// the same shape tests/unit/app/monitor/terms-page.test.tsx uses.
const DA_PAGE = {
  value: { title: "Handelsbetingelser", lead: "", content: { eyebrow: "" } },
  fallbackKeys: [] as string[],
};

const EN_PAGE = {
  value: { title: "Terms and conditions", lead: "", content: { eyebrow: "" } },
  fallbackKeys: [] as string[],
};

const DA_SEO = { title: "Handelsbetingelser", description: "" };

beforeEach(() => {
  vi.mocked(getTermsPage).mockResolvedValue(DA_PAGE);
  vi.mocked(getPageMetadata).mockResolvedValue(DA_SEO);
});

async function renderTerms(locale: string) {
  render(await TermsPage({ params: Promise.resolve({ locale }) }));
}

/** The goods part of /terms: the nearest block holding both its heading and its withdraw link. */
function goodsPart(headingName: string, linkName: string): HTMLElement {
  const heading = screen.getByRole("heading", { level: 2, name: headingName });
  const link = screen.getByRole("link", { name: linkName });
  let part = heading.parentElement;
  while (part !== null && !part.contains(link)) part = part.parentElement;
  if (part === null) throw new Error("The goods heading and link share no block");
  return part;
}

const danishGoods = () => goodsPart("Køb af 3D-figurer", "Fortryd køb af varer");

// ── S2-T-TERMS-G-01: goods section heading ───────────────────────────────

describe("S2-T-TERMS-G-01: /terms (DA) — goods section 'Køb af 3D-figurer'", () => {
  it("renders the level-2 heading 'Køb af 3D-figurer' in main, apart from the subscription part", async () => {
    await renderTerms("da");
    const part = danishGoods();
    const main = screen.getByRole("main");
    expect(within(main).getByRole("heading", { level: 2, name: "Køb af 3D-figurer" })).toBeInTheDocument();
    // The two model forms remain separate regions with distinct accessible names.
    expect(within(main).getByRole("region", { name: "Standardfortrydelsesformular, abonnement" })).toBeInTheDocument();
    const goodsForm = within(main).getByRole("region", { name: "Standardfortrydelsesformular, 3D-figurer" });
    expect(within(part).getByRole("region", { name: "Standardfortrydelsesformular, 3D-figurer" })).toBe(goodsForm);
  });
});

describe("S2-T-TERMS-G-D2 (S2-LEGAL-7): model forms have unique localized landmark names", () => {
  it.each([
    {
      locale: "da",
      page: DA_PAGE,
      heading: "Standardfortrydelsesformular",
      subscriptionLabel: "Standardfortrydelsesformular, abonnement",
      goodsLabel: "Standardfortrydelsesformular, 3D-figurer",
    },
    {
      locale: "en",
      page: EN_PAGE,
      heading: "Model withdrawal form",
      subscriptionLabel: "Model withdrawal form, subscription",
      goodsLabel: "Model withdrawal form, 3D figures",
    },
  ])("$locale distinguishes the subscription and goods regions without changing their headings", async ({
    locale, page, heading, subscriptionLabel, goodsLabel,
  }) => {
    vi.mocked(getTermsPage).mockResolvedValue(page);
    await renderTerms(locale);
    const subscriptionForm = screen.getByRole("region", { name: subscriptionLabel });
    const goodsForm = screen.getByRole("region", { name: goodsLabel });
    expect(subscriptionForm).not.toBe(goodsForm);
    expect(within(subscriptionForm).getByRole("heading", { level: 3, name: heading })).toBeInTheDocument();
    expect(within(goodsForm).getByRole("heading", { level: 3, name: heading })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: heading })).not.toBeInTheDocument();
  });
});

// ── S2-T-TERMS-G-02: seller with CVR and return address ──────────────────

describe("S2-T-TERMS-G-02: /terms (DA) — the goods part names the seller: Nyvej 4 + CVR 46887433", () => {
  it("the goods 'Sælger' section and the return address", async () => {
    await renderTerms("da");
    const part = danishGoods();
    expect(within(part).getByRole("heading", { level: 3, name: "Sælger" })).toBeInTheDocument();
    expect(part.textContent).toContain("Nyvej 4, 7860 Spøttrup, Danmark");
    expect(part.textContent).toContain("CVR 46887433");
    expect(within(part).getByRole("heading", { level: 3, name: "Returadresse" })).toBeInTheDocument();
    expect(part.textContent).toContain("Alnyron, Nyvej 4, 7860 Spøttrup, Danmark, CVR 46887433");
  });
});

// ── S2-T-TERMS-G-03: dispatch fact '3 hverdage' (S2-LEGAL-5) ─────────────

describe("S2-T-TERMS-G-03: /terms (DA) — dispatch '3 hverdage' in the goods part (S2-LEGAL-5)", () => {
  it("contains 'Varen sendes inden for 3 hverdage' in the goods part", async () => {
    await renderTerms("da");
    expect(danishGoods().textContent).toContain("Varen sendes inden for 3 hverdage");
  });
});

// ── S2-T-TERMS-G-04: buyer pays return shipping (S2-LEGAL-6) ─────────────

describe("S2-T-TERMS-G-04: /terms (DA) — buyer pays return shipping in the goods part (S2-LEGAL-6)", () => {
  it("says the buyer pays the return shipping", async () => {
    await renderTerms("da");
    expect(danishGoods().textContent).toContain("Fortryder du, efter at varen er sendt, betaler du selv returfragten.");
  });
});

// ── S2-T-TERMS-G-05: 'Fortryd køb af varer' link ─────────────────────────

describe("S2-T-TERMS-G-05: /terms (DA) — 'Fortryd køb af varer' link to /order/withdraw?lang=da", () => {
  it("the link named 'Fortryd køb af varer' points to /order/withdraw?lang=da", async () => {
    await renderTerms("da");
    expect(screen.getByRole("link", { name: "Fortryd køb af varer" })).toHaveAttribute("href", "/order/withdraw?lang=da");
  });
});

// ── S2-T-TERMS-G-05b: EN terms goods withdrawal link ─────────────────────

describe("S2-T-TERMS-G-05b: /en/terms (EN) — goods withdrawal link uses lang=en", () => {
  it("the link named 'Withdraw a purchase of goods' points to /order/withdraw?lang=en", async () => {
    vi.mocked(getTermsPage).mockResolvedValue(EN_PAGE);
    await renderTerms("en");
    expect(screen.getByRole("link", { name: "Withdraw a purchase of goods" })).toHaveAttribute(
      "href",
      "/order/withdraw?lang=en",
    );
    const part = goodsPart("Purchase of 3D figures", "Withdraw a purchase of goods");
    expect(within(part).getByRole("heading", { level: 3, name: "Withdrawal information" })).toBeInTheDocument();
    expect(part.textContent).toContain("Version goods-2026-11-14.1.");
  });
});

// ── S2-T-TERMS-G-06: no em-dash in goods sections (S2-LEGAL-3) ───────────

describe("S2-T-TERMS-G-06: /terms — no em-dash (U+2014) in goods copy (S2-LEGAL-3)", () => {
  it("DA terms page contains no em-dash character", async () => {
    await renderTerms("da");
    expect(screen.getByRole("main").textContent).not.toContain("\u2014");
  });
});

// ── S2-T-TERMS-G-07: the goods withdrawal notice ─────────────────────────

describe("S2-T-TERMS-G-07: /terms (DA) — the goods notice 'Fortrydelsesvejledning' (S2-LEGAL-7)", () => {
  it("the notice heading with the goods notice's first and return paragraphs", async () => {
    await renderTerms("da");
    const part = danishGoods();
    const notice = within(part).getByRole("region", { name: "Fortrydelsesvejledning" });
    expect(notice.textContent).toContain(
      "Fortrydelsesfristen udløber 14 dage efter den dag, hvor du eller en tredjemand, bortset fra transportøren, angivet af dig, får varen i fysisk besiddelse.",
    );
    expect(notice.textContent).toContain("Du betaler altså selv returfragten.");
  });
});

// ── S2-T-TERMS-G-08: the goods model form ────────────────────────────────

describe("S2-T-TERMS-G-08: /terms (DA) — the goods model withdrawal form (S2-LEGAL-7)", () => {
  it("'Standardfortrydelsesformular' in the goods part with the goods lines", async () => {
    await renderTerms("da");
    const form = within(danishGoods()).getByRole("region", { name: "Standardfortrydelsesformular, 3D-figurer" });
    const lines = within(form).getAllByRole("listitem").map((item) => item.textContent);
    expect(lines).toEqual([
      "Til Alnyron, Nyvej 4, 7860 Spøttrup, Danmark, info@alnyron.dk:",
      "Jeg meddeler herved, at jeg ønsker at gøre fortrydelsesretten gældende i forbindelse med min købsaftale om følgende vare: ______",
      "Ordrenummer: ______",
      "Bestilt den: ______ / modtaget den: ______",
      "Forbrugerens navn: ______",
      "Forbrugerens adresse: ______",
      "Forbrugerens underskrift (kun hvis formularens indhold meddeles på papir): ______",
      "Dato: ______",
    ]);
  });
});

// ── S2-T-TERMS-G-09: the reservation sentence and the goods version line ──

describe("S2-T-TERMS-G-09: /terms (DA) — the reservation sentence (S2-LEGAL-9) and the goods text version (S2-LEGAL-1)", () => {
  it("the goods part has the reservation sentence and 'Version goods-2026-11-14.1.'", async () => {
    await renderTerms("da");
    const text = danishGoods().textContent ?? "";
    expect(text).toContain("Beløbet reserveres ved bestillingen og trækkes først, når varen sendes.");
    expect(text).toContain("Version goods-2026-11-14.1.");
  });
});
