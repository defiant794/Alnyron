/**
 * Unit tests: src/app/monitor/actions.ts → setMonitorLocale
 * Journey: monitor-i18n  AC-I18N-MON-05, 06, 07, 08, 09, 10, 10b, 10c
 *
 * Contract:
 *  - `next` is the page the switcher was on (its `currentPath`); any path on
 *    this host, written as the browser requests it, is returned to unchanged.
 *  - An unsafe, unparsable, missing or non-string `next` → MONITOR_DASHBOARD_PATH.
 *  - Invalid locale → cookie NOT set; redirect to the given safe `next` unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── vi.hoisted ─────────────────────────────────────────────────────────────────

const { mockCookieSet, mockRedirect } = vi.hoisted(() => ({
  mockCookieSet: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ set: mockCookieSet })),
}));

vi.mock("next/navigation", () => ({
  redirect: mockRedirect,
}));

// ── Imports ────────────────────────────────────────────────────────────────────

import { setMonitorLocale } from "@/app/monitor/actions";
import { MONITOR_LOCALE_COOKIE } from "@/i18n/monitor-locale";
import { MONITOR_DASHBOARD_PATH } from "@/config/monitor";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeFormData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

function extractRedirectUrl(err: unknown): string {
  if (err instanceof Error && err.message.startsWith("NEXT_REDIRECT:")) {
    return err.message.slice("NEXT_REDIRECT:".length);
  }
  throw err;
}

/** The options the action set the locale cookie with (first call). */
function cookieOptions(): { secure?: boolean; maxAge?: number } | undefined {
  return mockCookieSet.mock.calls[0]?.[2] as { secure?: boolean; maxAge?: number } | undefined;
}

// ── Fixtures ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockCookieSet.mockClear();
  mockRedirect.mockClear();
  mockRedirect.mockImplementation((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("AC-I18N-MON-05: valid locale + safe next → sets cookie and redirects", () => {
  it('sets locale cookie to "en" and redirects to safe next path', async () => {
    const fd = makeFormData({ locale: "en", next: "/dashboard" });
    const err = await setMonitorLocale(fd).catch((e: unknown) => e);
    expect(mockCookieSet).toHaveBeenCalledWith(
      MONITOR_LOCALE_COOKIE,
      "en",
      expect.objectContaining({ httpOnly: true }),
    );
    expect(extractRedirectUrl(err)).toBe("/dashboard");
  });
});

describe("AC-I18N-MON-06: locale=da + safe next → sets cookie and redirects", () => {
  it('sets locale cookie to "da" and redirects to safe next path', async () => {
    const fd = makeFormData({ locale: "da", next: "/login" });
    const err = await setMonitorLocale(fd).catch((e: unknown) => e);
    expect(mockCookieSet).toHaveBeenCalledWith(
      MONITOR_LOCALE_COOKIE,
      "da",
      expect.objectContaining({ httpOnly: true }),
    );
    expect(extractRedirectUrl(err)).toBe("/login");
  });
});

describe("AC-I18N-MON-07: cookie attributes — httpOnly, path, sameSite, maxAge, secure", () => {
  it("sets httpOnly=true", async () => {
    const fd = makeFormData({ locale: "en", next: "/dashboard" });
    await setMonitorLocale(fd).catch(() => {});
    expect(mockCookieSet).toHaveBeenCalledWith(
      MONITOR_LOCALE_COOKIE,
      "en",
      expect.objectContaining({ httpOnly: true }),
    );
  });

  it('sets path="/"', async () => {
    const fd = makeFormData({ locale: "en", next: "/dashboard" });
    await setMonitorLocale(fd).catch(() => {});
    expect(mockCookieSet).toHaveBeenCalledWith(
      MONITOR_LOCALE_COOKIE,
      "en",
      expect.objectContaining({ path: "/" }),
    );
  });

  it('sets sameSite="lax"', async () => {
    const fd = makeFormData({ locale: "en", next: "/dashboard" });
    await setMonitorLocale(fd).catch(() => {});
    expect(mockCookieSet).toHaveBeenCalledWith(
      MONITOR_LOCALE_COOKIE,
      "en",
      expect.objectContaining({ sameSite: "lax" }),
    );
  });

  it("sets maxAge >= 365 days (in seconds)", async () => {
    const fd = makeFormData({ locale: "en", next: "/dashboard" });
    await setMonitorLocale(fd).catch(() => {});
    expect(cookieOptions()?.maxAge).toBeGreaterThanOrEqual(365 * 24 * 60 * 60);
  });

  it("sets secure=true in production (HTTPS only)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await setMonitorLocale(makeFormData({ locale: "en", next: "/dashboard" })).catch(() => {});
    expect(cookieOptions()?.secure).toBe(true);
  });

  it.each(["development", "test"])("sets secure=false when NODE_ENV is %s (plain-HTTP localhost)", async (env) => {
    vi.stubEnv("NODE_ENV", env);
    await setMonitorLocale(makeFormData({ locale: "en", next: "/dashboard" })).catch(() => {});
    expect(cookieOptions()?.secure).toBe(false);
  });
});

describe("AC-I18N-MON-08: invalid locale → cookie NOT set; redirect to given safe next", () => {
  it.each(["fr", "de", "EN", "DA", "zh", ""] as const)(
    'does NOT set the locale cookie for invalid locale "%s"',
    async (bad) => {
      const fd = makeFormData({ locale: bad, next: "/dashboard" });
      await setMonitorLocale(fd).catch(() => {});
      expect(mockCookieSet).not.toHaveBeenCalled();
    },
  );

  it("still redirects to the given safe next even when locale is invalid", async () => {
    const fd = makeFormData({ locale: "fr", next: "/dashboard" });
    const err = await setMonitorLocale(fd).catch((e: unknown) => e);
    // "ignore invalid locale" means: no cookie, but the redirect still happens
    expect(extractRedirectUrl(err)).toBe("/dashboard");
  });
});

describe("AC-I18N-MON-09: protocol-relative and backslash next → dashboard", () => {
  // Browsers treat /\evil.com and \\evil.com as protocol-relative.
  // A tab or newline inside is stripped by the URL parser to //<host>.
  it.each([
    "//evil.com",
    "/\\evil.com",
    "\\/evil.com",
    "\\\\evil.com",
    "/\t/evil.com",
    "/\n/evil.com",
  ])("redirects to the dashboard when next is %j", async (bad) => {
    const fd = makeFormData({ locale: "en", next: bad });
    const err = await setMonitorLocale(fd).catch((e: unknown) => e);
    expect(extractRedirectUrl(err)).toBe(MONITOR_DASHBOARD_PATH);
  });

  // The URL parser throws on these (bad IPv6 host, port out of range); the
  // action must still fall back instead of failing into the error page.
  it.each(["//[", "/\\[", "//a:99999"])(
    "redirects to the dashboard (no throw) when next is the unparsable %j",
    async (bad) => {
      const fd = makeFormData({ locale: "en", next: bad });
      const err = await setMonitorLocale(fd).catch((e: unknown) => e);
      expect(extractRedirectUrl(err)).toBe(MONITOR_DASHBOARD_PATH);
      expect(mockCookieSet).toHaveBeenCalledWith(MONITOR_LOCALE_COOKIE, "en", expect.any(Object));
    },
  );
});

describe("AC-I18N-MON-10: absolute URL and dot-segment next → dashboard", () => {
  it.each([
    "https://evil.com/dashboard",
    "http://evil.com/login",
    "javascript:alert(1)",
    "data:text/html,evil",
    // Dot segments that resolve into another area after normalization
    "/dashboard/../../../admin/x",
    "/%2e%2e/admin/x",
  ])("redirects to the dashboard when next is %j", async (bad) => {
    const fd = makeFormData({ locale: "en", next: bad });
    const err = await setMonitorLocale(fd).catch((e: unknown) => e);
    expect(extractRedirectUrl(err)).toBe(MONITOR_DASHBOARD_PATH);
  });
});

describe("AC-I18N-MON-10b: missing or non-string next → dashboard", () => {
  it("redirects to the dashboard when next is absent from formData", async () => {
    const fd = makeFormData({ locale: "en" });
    const err = await setMonitorLocale(fd).catch((e: unknown) => e);
    expect(extractRedirectUrl(err)).toBe(MONITOR_DASHBOARD_PATH);
  });

  it("redirects to the dashboard when next is a file, not a string", async () => {
    const fd = makeFormData({ locale: "en" });
    fd.set("next", new Blob(["/dashboard"]), "next.txt");
    const err = await setMonitorLocale(fd).catch((e: unknown) => e);
    expect(extractRedirectUrl(err)).toBe(MONITOR_DASHBOARD_PATH);
  });
});

describe("AC-I18N-MON-10c: safe path variations that MUST pass through", () => {
  it.each([
    "/",
    "/dashboard",
    "/login",
    "/settings",
    "/monitors/new",
    MONITOR_DASHBOARD_PATH,
    "/monitor/login?next=%2Fmonitor%2Fsettings",
  ])("does NOT redirect to fallback for safe path %j", async (safe) => {
    const fd = makeFormData({ locale: "en", next: safe });
    const err = await setMonitorLocale(fd).catch((e: unknown) => e);
    expect(extractRedirectUrl(err)).toBe(safe);
  });
});
