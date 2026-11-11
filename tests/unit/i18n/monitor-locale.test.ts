/**
 * Unit tests: src/i18n/monitor-locale.ts
 * Journey: monitor-i18n  AC-I18N-MON-01, 02, 03, 04
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── vi.hoisted ─────────────────────────────────────────────────────────────────

const { mockCookieGet } = vi.hoisted(() => ({
  mockCookieGet: vi.fn(),
}));

// ── Mocks ──────────────────────────────────────────────────────────────────────

// next/headers cookies() is async in Next.js 15.
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: mockCookieGet })),
}));

// Import after mocks are set up.
import { getMonitorLocale, MONITOR_LOCALE_COOKIE, MONITOR_LOCALES } from "@/i18n/monitor-locale";

// ── Helpers ────────────────────────────────────────────────────────────────────

function cookieReturns(value: string | undefined) {
  mockCookieGet.mockReturnValue(value !== undefined ? { value } : undefined);
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("MONITOR_LOCALE_COOKIE constant", () => {
  it('AC-I18N-MON-00a: MONITOR_LOCALE_COOKIE is "monitor-locale"', () => {
    expect(MONITOR_LOCALE_COOKIE).toBe("monitor-locale");
  });
});

describe("MONITOR_LOCALES constant", () => {
  it("AC-I18N-MON-00b: MONITOR_LOCALES includes 'da' and 'en'", () => {
    expect(MONITOR_LOCALES).toContain("da");
    expect(MONITOR_LOCALES).toContain("en");
  });
});

describe('AC-I18N-MON-01: cookie="en" → locale "en"', () => {
  beforeEach(() => cookieReturns("en"));

  it('returns "en" when the monitor-locale cookie is "en"', async () => {
    const locale = await getMonitorLocale();
    expect(locale).toBe("en");
  });

  it("reads the correct cookie name", async () => {
    await getMonitorLocale();
    expect(mockCookieGet).toHaveBeenCalledWith(MONITOR_LOCALE_COOKIE);
  });
});

describe('AC-I18N-MON-02: cookie="da" → locale "da"', () => {
  beforeEach(() => cookieReturns("da"));

  it('returns "da" when the monitor-locale cookie is "da"', async () => {
    const locale = await getMonitorLocale();
    expect(locale).toBe("da");
  });
});

describe('AC-I18N-MON-03: invalid cookie value → default "da"', () => {
  it.each(["fr", "de", "en-GB", "DA", "EN", "🇩🇰", ""])(
    'returns "da" for invalid cookie value "%s"',
    async (bad) => {
      cookieReturns(bad);
      const locale = await getMonitorLocale();
      expect(locale).toBe("da");
    },
  );
});

describe('AC-I18N-MON-04: missing cookie → default "da"', () => {
  beforeEach(() => cookieReturns(undefined));

  it('returns "da" when no monitor-locale cookie is set', async () => {
    const locale = await getMonitorLocale();
    expect(locale).toBe("da");
  });
});
