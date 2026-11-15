// @vitest-environment jsdom
/**
 * Unit tests: src/app/[locale]/terms/page.tsx
 * Journey: payments-slice1d-withdrawal (+ its design addendum, J9)
 * Criteria: WD-J3-C02, WD-J3-C03, WD-J3-C04, WD-J9-C01
 *
 * Coverage:
 *   - DA /terms: DB title "Handelsbetingelser" in heading and metadata
 *   - EN /en/terms: DB title "Terms and conditions"
 *   - body: contains sections 1-6, withdrawal notice A, model form C, sections 7-11
 *   - version footer line "Version 2026-11-14.1."
 *   - {privacyPath} placeholder is filled (no literal {privacyPath} in output)
 *
 * The page reads the terms system page through getTermsPage (resolved content with
 * fallbackKeys, like privacy) and getPageMetadata (SEO) and calls setRequestLocale;
 * translations are the real messages (nextIntlServerMock); the real routing module is used
 * (the page builds the privacy path with getPathname).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type * as NextNavigation from "next/navigation";

// Dynamic import: vi.mock factories are hoisted above the static imports, so the helper is loaded lazily.
vi.mock("next-intl/server", async () =>
  (await import("../../../helpers/next-intl-server")).nextIntlServerMock(),
);
vi.mock("@/services/content/pages", () => ({ getTermsPage: vi.fn(), getPageMetadata: vi.fn() }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
}));

import { setRequestLocale } from "next-intl/server";
import TermsPage, { generateMetadata } from "@/app/[locale]/terms/page";
import { WITHDRAWAL_TEXT_VERSION } from "@/config/legal/withdrawal-texts";
import { getPageMetadata, getTermsPage } from "@/services/content/pages";

afterEach(cleanup);

// The seeded terms page rows (20261114000200_system_page_terms.sql): empty eyebrow and lead.
const DA_PAGE = {
  value: { title: "Handelsbetingelser", lead: "", content: { eyebrow: "" } },
  fallbackKeys: [] as string[],
};

const EN_PAGE = {
  value: { title: "Terms and conditions", lead: "", content: { eyebrow: "" } },
  fallbackKeys: [] as string[],
};

const DA_SEO = {
  title: "Handelsbetingelser",
  description: "Handelsbetingelser for Monitor-abonnementet hos Alnyron.",
};

beforeEach(() => {
  vi.mocked(getTermsPage).mockImplementation(async (locale) => (locale === "da" ? DA_PAGE : EN_PAGE));
  vi.mocked(getPageMetadata).mockResolvedValue(DA_SEO);
});

async function renderTerms(locale: string) {
  render(await TermsPage({ params: Promise.resolve({ locale }) }));
}

// ── WD-J3-C02: DA page heading ────────────────────────────────────────────────

describe("WD-J3-C02 (WD-T-TERMS-01): /terms DA — heading 'Handelsbetingelser'", () => {
  it("WD-T-TERMS-01: h1 reads 'Handelsbetingelser'", async () => {
    await renderTerms("da");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Handelsbetingelser");
    expect(getTermsPage).toHaveBeenCalledWith("da");
    expect(setRequestLocale).toHaveBeenCalledWith("da");
  });

  it("WD-T-TERMS-01b: generateMetadata returns DA title in title field", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ locale: "da" }) });
    expect(getPageMetadata).toHaveBeenCalledWith("terms", "da");
    expect(meta.title).toBe("Handelsbetingelser");
    expect(meta.description).toBe(DA_SEO.description);
  });
});

// ── WD-J3-C03: EN page heading ────────────────────────────────────────────────

describe("WD-J3-C03 (WD-T-TERMS-02): /en/terms EN — heading 'Terms and conditions'", () => {
  it("WD-T-TERMS-02: h1 reads 'Terms and conditions'", async () => {
    await renderTerms("en");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Terms and conditions");
  });
});

// ── WD-J3-C04: body sections ──────────────────────────────────────────────────

describe("WD-J3-C04 (WD-T-TERMS-03): /terms page — body contains legal sections and version footer", () => {
  it("WD-T-TERMS-03a: contains section heading 'Sælger' (section 1 DA)", async () => {
    await renderTerms("da");
    expect(document.body.textContent ?? "").toContain("Sælger");
  });

  it("WD-T-TERMS-03b: contains withdrawal notice text (fortrydelsesret)", async () => {
    await renderTerms("da");
    // The subscription notice's heading comes first; the goods part (S2) adds its own "Fortrydelsesret" clause later.
    expect(screen.getAllByRole("heading", { name: "Fortrydelsesret" })[0]).toBeInTheDocument();
    expect(document.body.textContent ?? "").toContain(
      "Du har ret til at fortryde din aftale om Monitor-abonnement uden begrundelse inden for 14 dage.",
    );
  });

  it("WD-T-TERMS-03c: contains the model form heading (Standardfortrydelsesformular)", async () => {
    await renderTerms("da");
    // The subscription's model form comes first; the goods part (S2) has its own one later.
    expect(screen.getAllByRole("heading", { name: "Standardfortrydelsesformular" })[0]).toBeInTheDocument();
  });

  it(`WD-T-TERMS-03d: version footer line contains '${WITHDRAWAL_TEXT_VERSION}'`, async () => {
    await renderTerms("da");
    expect(screen.getByText(`Version ${WITHDRAWAL_TEXT_VERSION}.`)).toBeInTheDocument();
  });

  it("WD-T-TERMS-03e: no literal {privacyPath} placeholder in rendered output", async () => {
    await renderTerms("da");
    expect(document.body.textContent).not.toContain("{privacyPath}");
  });

  it("WD-T-TERMS-03f: EN body contains 'Seller' (section 1 EN)", async () => {
    await renderTerms("en");
    expect(document.body.textContent).toContain("Seller");
  });
});

// ── WD-J9-C01 (design review D1): a word wider than its line breaks ──────────
// jsdom has no layout: the measured reflow at 320px is E2E WD-J9-C01
// (tests/e2e/monitor-withdrawal-design.spec.ts). Here: <main> sets the inherited overflow-wrap
// (Tailwind `wrap-break-word`) and nothing on the way down to the h1 resets it.

describe("WD-J9-C01 (D1): /terms — the h1 may break inside a word wider than its line", () => {
  it.each(["da", "en"])("%s: <main> carries wrap-break-word and no element down to the h1 resets wrapping", async (locale) => {
    await renderTerms(locale);
    const main = screen.getByRole("main");
    const heading = screen.getByRole("heading", { level: 1 });
    expect(main).toHaveClass("wrap-break-word");
    expect(main.contains(heading)).toBe(true);
    for (let el: HTMLElement | null = heading; el !== null && el !== main; el = el.parentElement) {
      expect(el.className).not.toMatch(/\b(wrap-normal|break-normal|break-keep|whitespace-nowrap|text-nowrap|truncate)\b/);
    }
  });
});
