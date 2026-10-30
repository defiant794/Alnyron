// E2E tests for F0.3 i18n-routing
// Acceptance IDs: AC-I18N-01 through AC-I18N-06, AC-I18N-03
// Run with: npm run test:e2e
// Requires: app running at PLAYWRIGHT_BASE_URL (default http://localhost:3000)
// These specs FAIL (Red) until web-developer implements:
//   src/i18n/routing.ts, src/i18n/request.ts, src/middleware.ts,
//   messages/da.json, messages/en.json, src/app/[locale]/layout.tsx
import { test, expect } from "@playwright/test";

// ── AC-I18N-01: GET `/` serves Danish content ─────────────────────────────

test("AC-I18N-01: GET / responds with <html lang=\"da\">", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBeLessThan(400);

  const lang = await page.getAttribute("html", "lang");
  expect(lang).toBe("da");
});

// ── AC-I18N-04: GET `/en` serves English content ──────────────────────────

test("AC-I18N-04: GET /en responds with <html lang=\"en\">", async ({ page }) => {
  const response = await page.goto("/en");
  expect(response?.status()).toBeLessThan(400);

  const lang = await page.getAttribute("html", "lang");
  expect(lang).toBe("en");
});

// ── AC-I18N-02: `/da/kontakt` redirects to `/kontakt` ────────────────────

test("AC-I18N-02: GET /da/kontakt redirects to /kontakt (no DA prefix)", async ({
  page,
}) => {
  // Follow the redirect chain; final URL must be the unprefixed path.
  await page.goto("/da/kontakt");
  const finalUrl = new URL(page.url());
  expect(finalUrl.pathname).toBe("/kontakt");
});

test("AC-I18N-02b: GET /da/kontakt (no redirect follow) is a permanent 308 to /kontakt with no Set-Cookie", async ({
  request,
}) => {
  // Stop at the redirect response itself — this catches a cookie set on the
  // redirect leg (next-intl may write NEXT_LOCALE here if localeCookie is on).
  const response = await request.get("/da/kontakt", { maxRedirects: 0 });

  // AC-I18N-02: permanent redirect (301/308), so crawlers drop the /da/ URL.
  expect(response.status()).toBe(308);

  const location = response.headers()["location"] ?? "";
  // Location may be absolute or relative; the path must end with /kontakt.
  expect(location.endsWith("/kontakt")).toBe(true);

  const setCookie = response.headers()["set-cookie"] ?? "";
  expect(setCookie).toBe("");
});

// ── AC-I18N-03: No Set-Cookie on public responses ─────────────────────────

test("AC-I18N-03: GET / has no Set-Cookie header", async ({ request }) => {
  const response = await request.get("/");
  const setCookie = response.headers()["set-cookie"] ?? "";
  expect(setCookie).toBe("");
});

test("AC-I18N-03b: GET /kontakt has no Set-Cookie header", async ({ request }) => {
  const response = await request.get("/kontakt");
  const setCookie = response.headers()["set-cookie"] ?? "";
  expect(setCookie).toBe("");
});

test("AC-I18N-03c: GET /en has no Set-Cookie header", async ({ request }) => {
  const response = await request.get("/en");
  const setCookie = response.headers()["set-cookie"] ?? "";
  expect(setCookie).toBe("");
});

test("AC-I18N-03d: GET / with Accept-Language: en has no Set-Cookie (locale detection is off)", async ({
  request,
}) => {
  // This is the exact case that triggers NEXT_LOCALE cookie when
  // localeDetection is accidentally left on. Sending a non-DA Accept-Language
  // must not cause the middleware to write a locale cookie.
  const response = await request.get("/", {
    headers: { "accept-language": "en,en-US;q=0.9" },
  });
  const setCookie = response.headers()["set-cookie"] ?? "";
  expect(setCookie).toBe("");
});

// ── AC-I18N-05: Language switcher from /kontakt links to /en/contact ─────

test(
  "AC-I18N-05: language switcher on /kontakt href resolves to /en/contact",
  async ({ page }) => {
    await page.goto("/kontakt");

    // The LanguageSwitcher renders a plain <a> tag for the EN locale.
    const switcherLink = page.locator('a[hreflang="en"]').first();
    await expect(switcherLink).toBeVisible();

    const href = await switcherLink.getAttribute("href");
    const pathname = href
      ? href.startsWith("http")
        ? new URL(href).pathname
        : href
      : "";
    expect(pathname).toBe("/en/contact");
  },
);

// ── AC-I18N-06: Language switcher from /en/contact links to /kontakt ─────

test(
  "AC-I18N-06: language switcher on /en/contact href resolves to /kontakt",
  async ({ page }) => {
    await page.goto("/en/contact");

    const switcherLink = page.locator('a[hreflang="da"]').first();
    await expect(switcherLink).toBeVisible();

    const href = await switcherLink.getAttribute("href");
    const pathname = href
      ? href.startsWith("http")
        ? new URL(href).pathname
        : href
      : "";
    expect(pathname).toBe("/kontakt");
  },
);
