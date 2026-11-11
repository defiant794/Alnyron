// @vitest-environment jsdom
/**
 * Unit tests: src/app/monitor/layout.tsx — <html lang> follows getMonitorLocale();
 * the admin and MyLife document roots stay Danish whatever the Monitor language.
 * Journey: monitor-i18n  AC-I18N-MON-18, 19, 27
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type * as NextIntl from "next-intl";

// ── vi.hoisted ─────────────────────────────────────────────────────────────────

const { mockGetMonitorLocale } = vi.hoisted(() => ({
  mockGetMonitorLocale: vi.fn(),
}));

// ── Mocks ──────────────────────────────────────────────────────────────────────

// The visitor's Monitor language, chosen per test.
vi.mock("@/i18n/monitor-locale", () => ({
  getMonitorLocale: mockGetMonitorLocale,
  MONITOR_LOCALE_COOKIE: "monitor-locale",
  MONITOR_LOCALES: ["da", "en"],
}));

// The request carries monitor-locale=en, so a layout that read the cookie
// itself (instead of AUTH_LOCALE) would render English.
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (name === "monitor-locale" ? { name, value: "en" } : undefined),
  })),
}));

// next/font/google has no entry outside Next's compiler.
vi.mock("next/font/google", () => ({
  Inter: vi.fn(() => ({ variable: "--font-inter", className: "font-inter" })),
}));

// vi.mock factory: dynamic import required because vi.mock is hoisted above
// static imports by Vitest's transform.
vi.mock("next-intl/server", async () => {
  // dynamic-import: Vitest hoists vi.mock above static imports; factory must load lazily
  const { nextIntlServerMock } = await import("../../../helpers/next-intl-server");
  return nextIntlServerMock();
});

// The client provider records the locale it hands the client islands.
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof NextIntl>();
  return {
    ...actual,
    NextIntlClientProvider: ({ locale, children }: { locale: string; children: React.ReactNode }) => (
      <div data-intl-locale={locale}>{children}</div>
    ),
  };
});

// ── Imports ────────────────────────────────────────────────────────────────────

import AdminRootLayout from "@/app/admin/layout";
import MonitorRootLayout from "@/app/monitor/layout";
import MyLifeRootLayout from "@/app/mylife/layout";
import { loadMessages } from "@/i18n/messages";

const da = loadMessages("da");
const en = loadMessages("en");

/** Renders a document-root layout around a placeholder page. */
async function renderLayout(Layout: typeof MonitorRootLayout): Promise<Document> {
  const markup = renderToStaticMarkup(await Layout({ children: <p>content</p> }));
  return new DOMParser().parseFromString(markup, "text/html");
}

beforeEach(() => {
  mockGetMonitorLocale.mockReset();
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('AC-I18N-MON-18: getMonitorLocale()="en" → <html lang="en">', () => {
  it('renders <html lang="en"> when getMonitorLocale resolves to "en"', async () => {
    mockGetMonitorLocale.mockResolvedValue("en");
    const doc = await renderLayout(MonitorRootLayout);
    expect(doc.documentElement.getAttribute("lang")).toBe("en");
  });
});

describe('AC-I18N-MON-19: getMonitorLocale()="da" → <html lang="da">', () => {
  it('renders <html lang="da"> when getMonitorLocale resolves to "da" (default)', async () => {
    mockGetMonitorLocale.mockResolvedValue("da");
    const doc = await renderLayout(MonitorRootLayout);
    expect(doc.documentElement.getAttribute("lang")).toBe("da");
  });
});

describe("AC-I18N-MON-27: admin and MyLife render Danish while the Monitor language is English", () => {
  it.each([
    ["admin", AdminRootLayout],
    ["MyLife", MyLifeRootLayout],
  ])('%s layout: <html lang="da">, the Danish skip link and Danish client copy', async (_area, Layout) => {
    mockGetMonitorLocale.mockResolvedValue("en");
    const doc = await renderLayout(Layout);

    expect(doc.documentElement.getAttribute("lang")).toBe("da");
    // DOMParser documents have no window, so plain DOM reads instead of jest-dom matchers.
    expect(doc.querySelector('a[href="#main"]')?.textContent).toBe(da.SkipLink.label);
    expect(doc.body.textContent).not.toContain(en.SkipLink.label);
    expect(doc.querySelector("[data-intl-locale]")?.getAttribute("data-intl-locale")).toBe("da");
  });
});
