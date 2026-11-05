// E2E tests for F0.3 i18n-routing
// Acceptance IDs: AC-I18N-01 through AC-I18N-06, AC-I18N-03
// Run with: npm run test:e2e
// Requires: app running at PLAYWRIGHT_BASE_URL (default http://localhost:3000)
// The old Danish slugs (/kontakt, /privatliv) are covered by english-slugs.spec.ts.
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

// ── AC-I18N-02: `/da/contact` redirects to `/contact` ────────────────────

test("AC-I18N-02: GET /da/contact redirects to /contact (no DA prefix)", async ({
  page,
}) => {
  await page.goto("/da/contact");
  const finalUrl = new URL(page.url());
  expect(finalUrl.pathname).toBe("/contact");
});

test("AC-I18N-02b: GET /da/contact (no redirect follow) is a permanent 308 to /contact with no Set-Cookie", async ({
  request,
}) => {
  const response = await request.get("/da/contact", { maxRedirects: 0 });
  expect(response.status()).toBe(308);
  const location = response.headers()["location"] ?? "";
  // Location may be absolute or relative; the path must end with /contact.
  expect(location.endsWith("/contact")).toBe(true);
  const setCookie = response.headers()["set-cookie"] ?? "";
  expect(setCookie).toBe("");
});

// ── AC-I18N-03: No Set-Cookie on public responses ─────────────────────────

test("AC-I18N-03: GET / has no Set-Cookie header", async ({ request }) => {
  const response = await request.get("/");
  const setCookie = response.headers()["set-cookie"] ?? "";
  expect(setCookie).toBe("");
});

test("AC-I18N-03b: GET /contact has no Set-Cookie header", async ({ request }) => {
  const response = await request.get("/contact");
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
  const response = await request.get("/", {
    headers: { "accept-language": "en,en-US;q=0.9" },
  });
  const setCookie = response.headers()["set-cookie"] ?? "";
  expect(setCookie).toBe("");
});

// ── AC-I18N-05: Language switcher from /contact links to /en/contact ──────

test(
  "AC-I18N-05: language switcher on /contact href resolves to /en/contact",
  async ({ page }) => {
    await page.goto("/contact");

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

// ── AC-I18N-06: Language switcher from /en/contact links to /contact ──────

test(
  "AC-I18N-06: language switcher on /en/contact href resolves to /contact",
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
    expect(pathname).toBe("/contact");
  },
);

// ── AC-I18N-05/06 without JavaScript: the prerendered HTML ────────────────
// The switcher is a client island, but its links must already be right in
// the static HTML: a click before hydration, or with JavaScript off, is a
// plain document load.

test.describe("Language switcher without JavaScript (prerendered HTML)", () => {
  test.use({ javaScriptEnabled: false });

  for (const [from, hreflang, to] of [
    ["/contact", "en", "/en/contact"],
    ["/en/contact", "da", "/contact"],
    ["/", "en", "/en"],
    ["/en", "da", "/"],
  ] as const) {
    test(`AC-I18N-05/06: ${from} links ${hreflang.toUpperCase()} to ${to}`, async ({ page }) => {
      await page.goto(from);
      await expect(page.locator(`a[hreflang="${hreflang}"]`).first()).toHaveAttribute("href", to);
    });
  }
});
