// @vitest-environment jsdom
// Tests for AC-I18N-01 (DA lang), AC-I18N-04 (EN lang), and the F0.3 locale
// layout tree which is where <html lang>, Inter, and SkipLink live after F0.3
// moves them out of the root layout (making root a passthrough).
//
// Root layout (src/app/layout.tsx) is a passthrough since F0.3; the
// AC-DS-07/08/09/10 checks it used to carry are asserted here instead.
import { describe, it, expect, vi, beforeAll } from "vitest";
import "@testing-library/jest-dom/vitest";
import { renderToStaticMarkup } from "react-dom/server";

// ── Mock next/font/google ─────────────────────────────────────────────────────
vi.mock("next/font/google", () => ({
  Inter: vi.fn(() => ({ variable: "--font-inter", className: "font-inter" })),
}));

// ── Mock next-intl/server ────────────────────────────────────────────────────
// setRequestLocale sets per-request async context — a no-op in unit tests.
// getTranslations resolves the real messages/*.json (with the DA fallback
// merge), so the copy asserted below is the copy users see.
vi.mock("next-intl/server", async () =>
  (await import("../../../helpers/next-intl-server")).nextIntlServerMock(),
);

// ── Mock next-intl (client provider) ────────────────────────────────────────
// Real `hasLocale`; the provider is a passthrough (no request config here).
vi.mock("next-intl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next-intl")>()),
  NextIntlClientProvider: ({ children }: { children: React.ReactNode }) =>
    children,
}));

// ── Mock SiteHeader / SiteFooter ─────────────────────────────────────────────
// Async server components that read the DB through the public Supabase client
// (renderToStaticMarkup cannot render them). Stand-ins mark their slots so the
// frame order is still asserted here. Their data comes from the content
// services (tests/unit/services/content/*), their client islands have their
// own tests (SiteMenu, NavLink, LanguageSwitcher in tests/unit/components/site/),
// and the rendered header and footer are covered by tests/e2e/home-page.spec.ts.
vi.mock("@/components/site/SiteHeader", () => ({
  default: ({ locale }: { locale: string }) => <header data-testid="site-header" data-locale={locale} />,
}));
vi.mock("@/components/site/SiteFooter", () => ({
  default: ({ locale }: { locale: string }) => <footer data-testid="site-footer" data-locale={locale} />,
}));

import { Inter } from "next/font/google";
import { setRequestLocale } from "next-intl/server";
import LocaleLayout, { dynamic, revalidate } from "@/app/[locale]/layout";

// Capture Inter call args before clearMocks can wipe them.
const interCallOptions: Record<string, unknown> =
  (vi.mocked(Inter).mock.calls[0]?.[0] as Record<string, unknown>) ?? {};

// ── Render both locales once ──────────────────────────────────────────────────
let docDa: Document;
let docEn: Document;

const childSlot = (
  <main id="main">
    <p>content</p>
  </main>
);

beforeAll(async () => {
  // Locale layout is an async server component (Next.js 15: params is a Promise).
  const elDa = await LocaleLayout({
    params: Promise.resolve({ locale: "da" }),
    children: childSlot,
  });
  const elEn = await LocaleLayout({
    params: Promise.resolve({ locale: "en" }),
    children: childSlot,
  });
  const parser = new DOMParser();
  docDa = parser.parseFromString(renderToStaticMarkup(elDa), "text/html");
  docEn = parser.parseFromString(renderToStaticMarkup(elEn), "text/html");
});

// ── AC-I18N-01: DA locale → <html lang="da"> ─────────────────────────────────

describe("AC-I18N-01: [locale]/layout renders <html lang=\"da\"> for DA locale", () => {
  it('documentElement lang is "da" when locale param is "da"', () => {
    expect(docDa.documentElement.getAttribute("lang")).toBe("da");
  });
});

// ── AC-I18N-04: EN locale → <html lang="en"> ─────────────────────────────────

describe("AC-I18N-04: [locale]/layout renders <html lang=\"en\"> for EN locale", () => {
  it('documentElement lang is "en" when locale param is "en"', () => {
    expect(docEn.documentElement.getAttribute("lang")).toBe("en");
  });
});

// ── AC-I18N-01/04: static rendering contract ─────────────────────────────────
// Without setRequestLocale the layout still renders (getTranslations gets the
// locale explicitly), but Next would render every page dynamically. Vitest 5
// clears mock calls before each test, so each test renders in its own body.

describe("AC-I18N-01/04: [locale]/layout hands the route locale to setRequestLocale", () => {
  it('calls setRequestLocale("da") for the DA locale', async () => {
    await LocaleLayout({ params: Promise.resolve({ locale: "da" }), children: childSlot });
    expect(setRequestLocale).toHaveBeenCalledWith("da");
  });

  it('calls setRequestLocale("en") for the EN locale', async () => {
    await LocaleLayout({ params: Promise.resolve({ locale: "en" }), children: childSlot });
    expect(setRequestLocale).toHaveBeenCalledWith("en");
  });
});

// ── AC-DS-07 (moved): Inter font configured in locale layout ─────────────────

describe("AC-DS-07: Inter font configured with correct options in locale layout", () => {
  it('Inter is called with variable "--font-inter"', () => {
    expect(interCallOptions).toMatchObject({ variable: "--font-inter" });
  });

  it('Inter is called with display "swap"', () => {
    expect(interCallOptions).toMatchObject({ display: "swap" });
  });

  it("Inter is called with latin subset", () => {
    expect(interCallOptions["subsets"]).toEqual(
      expect.arrayContaining(["latin"]),
    );
  });
});

// ── AC-DS-08 (moved): Inter variable class on <html> or <body> ───────────────

describe("AC-DS-08: Inter variable class applied to <html> or <body> in locale layout", () => {
  it("DA locale: <html> or <body> classList contains font-inter variable", () => {
    const onHtml = docDa.documentElement.className.includes("font-inter") ||
      docDa.documentElement.className.includes("--font-inter");
    const onBody = docDa.body.className.includes("font-inter") ||
      docDa.body.className.includes("--font-inter");
    expect(onHtml || onBody).toBe(true);
  });
});

// ── AC-DS-10 (moved): SkipLink rendered before #main ─────────────────────────

describe("AC-DS-10: SkipLink is present and correctly configured in locale layout", () => {
  it('a[href="#main"] element exists in the DA locale rendered document', () => {
    expect(docDa.querySelector('a[href="#main"]')).not.toBeNull();
  });

  it('SkipLink text is "Spring til indhold"', () => {
    const link = docDa.querySelector('a[href="#main"]');
    expect(link?.textContent?.trim()).toBe("Spring til indhold");
  });

  it("SkipLink text contains no em-dash (writing-style.md hard rule)", () => {
    const link = docDa.querySelector('a[href="#main"]');
    expect(link?.textContent).not.toContain("\u2014");
  });

  it("SkipLink appears before #main in DOM order", () => {
    const skipLink = docDa.querySelector('a[href="#main"]');
    const main = docDa.getElementById("main");
    expect(skipLink).not.toBeNull();
    expect(main).not.toBeNull();
    // DOCUMENT_POSITION_FOLLOWING (4): main comes after skipLink
    const position = skipLink!.compareDocumentPosition(main!);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('AC-I18N-04: EN locale SkipLink text is "Skip to content"', () => {
    const link = docEn.querySelector('a[href="#main"]');
    expect(link?.textContent?.trim()).toBe("Skip to content");
  });
});

// ── F0.5 home-page: header and footer frame every page ───────────────────────

describe("AC-HOME-04/09: [locale]/layout frames the page with SiteHeader and SiteFooter", () => {
  it("renders SiteHeader before #main and SiteFooter after it, both for the route locale", () => {
    const header = docDa.querySelector('[data-testid="site-header"]');
    const main = docDa.getElementById("main");
    const footer = docDa.querySelector('[data-testid="site-footer"]');
    expect(header?.getAttribute("data-locale")).toBe("da");
    expect(footer?.getAttribute("data-locale")).toBe("da");
    expect(header!.compareDocumentPosition(main!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(main!.compareDocumentPosition(footer!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("passes the EN locale to SiteHeader and SiteFooter on /en", () => {
    expect(docEn.querySelector('[data-testid="site-header"]')?.getAttribute("data-locale")).toBe("en");
    expect(docEn.querySelector('[data-testid="site-footer"]')?.getAttribute("data-locale")).toBe("en");
  });

  it("AC-CACHE-41: exports revalidate = 3600 (hourly ISR safety fallback; publishes are instant via D1 tag cache)", () => {
    expect(revalidate).toBe(3600);
  });

  it('exports dynamic = "error" (a request-time API fails the build instead of making a route dynamic, AC-HOME-12)', () => {
    expect(dynamic).toBe("error");
  });
});

// ── generateStaticParams produces both locales ────────────────────────────────

describe("AC-I18N-01/04: generateStaticParams returns da and en", () => {
  it("exports generateStaticParams that includes both locales", async () => {
    // Static import resolves the named export on the same module.
    const mod = await import("@/app/[locale]/layout");
    expect(typeof mod.generateStaticParams).toBe("function");
    const params = await (mod.generateStaticParams as () => Promise<{ locale: string }[]>)();
    const locales = params.map((p) => p.locale);
    expect(locales).toContain("da");
    expect(locales).toContain("en");
  });
});
