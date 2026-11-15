// @vitest-environment jsdom
/**
 * Unit tests: src/app/order/layout.tsx — the /order document root follows the
 * `x-order-locale` request header the middleware sets from `?lang=`
 * Journey: payments-s2-3d-purchase
 * Criteria: S2-MW-1 (web) — `<html lang>` (WCAG 3.1.1), the skip link, the
 *   frontpage link and the footer in the page's language; a missing or
 *   tampered header renders Danish
 *
 * Test IDs: S2-T-ORD-LAY-01..03
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type * as NextIntl from "next-intl";

// ── vi.hoisted ─────────────────────────────────────────────────────────────────

const { mockHeaders } = vi.hoisted(() => ({
  mockHeaders: vi.fn(),
}));

// ── Mocks ──────────────────────────────────────────────────────────────────────

// The request headers the middleware forwarded, chosen per test.
vi.mock("next/headers", () => ({ headers: mockHeaders }));

// next/font/google has no entry outside Next's compiler.
vi.mock("next/font/google", () => ({
  Inter: vi.fn(() => ({ variable: "--font-inter", className: "font-inter" })),
}));

vi.mock("next-intl/server", async () =>
  // Exception: vi.mock factory is hoisted; must dynamically import the helper.
  (await import("../../../helpers/next-intl-server")).nextIntlServerMock(),
);

// The client provider records the locale it hands the footer's links.
vi.mock("next-intl", async (importOriginal) => ({
  // Exception: vi.mock factory is hoisted; must dynamically import the original here.
  ...(await importOriginal<typeof NextIntl>()),
  NextIntlClientProvider: ({ locale, children }: { locale: string; children: React.ReactNode }) => (
    <div data-intl-locale={locale}>{children}</div>
  ),
}));

// An async server component reading site settings (renderToStaticMarkup cannot render it): a
// stand-in marks its slot and the locale it was given. Its own copy: SiteFooter.test.tsx.
vi.mock("@/components/site/SiteFooter", () => ({
  default: ({ locale }: { locale: string }) => <footer data-testid="site-footer" data-locale={locale} />,
}));

// ── Imports ────────────────────────────────────────────────────────────────────

import OrderLayout from "@/app/order/layout";
import { loadMessages } from "@/i18n/messages";

const da = loadMessages("da");
const en = loadMessages("en");

/** Renders the layout around a placeholder page for a request carrying `orderLocale` (or none). */
async function renderLayout(orderLocale: string | null): Promise<Document> {
  mockHeaders.mockResolvedValue(new Headers(orderLocale === null ? {} : { "x-order-locale": orderLocale }));
  const markup = renderToStaticMarkup(
    await OrderLayout({
      children: (
        <main id="main">
          <p>content</p>
        </main>
      ),
    }),
  );
  return new DOMParser().parseFromString(markup, "text/html");
}

beforeEach(() => {
  mockHeaders.mockReset();
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('S2-T-ORD-LAY-01: x-order-locale "en" → an English document', () => {
  it('<html lang="en">, the English skip link, the /en frontpage link and the English footer', async () => {
    const doc = await renderLayout("en");

    expect(doc.documentElement.getAttribute("lang")).toBe("en");
    // DOMParser documents have no window, so plain DOM reads instead of jest-dom matchers.
    expect(doc.querySelector('a[href="#main"]')?.textContent).toBe(en.SkipLink.label);
    expect(doc.querySelector("header a")?.getAttribute("href")).toBe("/en");
    expect(doc.querySelector('[data-testid="site-footer"]')?.getAttribute("data-locale")).toBe("en");
    expect(doc.querySelector("[data-intl-locale]")?.getAttribute("data-intl-locale")).toBe("en");
    expect(doc.querySelector("main#main")?.textContent).toBe("content");
  });
});

describe('S2-T-ORD-LAY-02: x-order-locale "da" or none → a Danish document', () => {
  it.each([["da"], [null]])('header %s: <html lang="da">, the Danish skip link, the / frontpage link and the Danish footer', async (header) => {
    const doc = await renderLayout(header);

    expect(doc.documentElement.getAttribute("lang")).toBe("da");
    expect(doc.querySelector('a[href="#main"]')?.textContent).toBe(da.SkipLink.label);
    expect(doc.body.textContent).not.toContain(en.SkipLink.label);
    expect(doc.querySelector("header a")?.getAttribute("href")).toBe("/");
    expect(doc.querySelector('[data-testid="site-footer"]')?.getAttribute("data-locale")).toBe("da");
  });
});

describe("S2-T-ORD-LAY-03: an unsupported x-order-locale value is whitelisted again → Danish", () => {
  it.each([["de"], ["EN"], ["en,da"], [""]])('header "%s" → <html lang="da"> and a Danish footer', async (header) => {
    const doc = await renderLayout(header);

    expect(doc.documentElement.getAttribute("lang")).toBe("da");
    expect(doc.querySelector('[data-testid="site-footer"]')?.getAttribute("data-locale")).toBe("da");
  });
});
