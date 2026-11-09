/**
 * E2E tests — monitor chrome changes (MCH-AC1..MCH-AC5)
 * Journey: monitor-chrome
 *
 * Covers:
 *   MCH-AC1 — landing header: ALNYRON lockup linked to the main site (absolute URL),
 *             no "Monitor" suffix, 320px viewport fits without horizontal scroll
 *   MCH-AC2 — landing footer: SiteFooter (copyright, CVR if set, mailto, Privatliv → absolute main-site URL)
 *   MCH-AC3 — signed-in dashboard: ALNYRON lockup → /monitor/dashboard, SiteFooter present
 *   MCH-AC4 — auth-card pages (login, signup): ALNYRON lockup → main-site absolute URL, no footer
 *   MCH-AC5 — lead copy "2 sider", fresh signup default cap 2 (MCH-E10 skips
 *             on a target without migration 20261107000300)
 *
 * Requires dev server at http://monitor.localhost:3000 (the Monitor subdomain).
 * DB_AVAILABLE guards pg-dependent tests.
 */
import { test, expect, type Page } from "@playwright/test";
import {
  DB_AVAILABLE,
  E2E_MONITOR_EMAIL,
  E2E_MONITOR_CAP2_EMAIL,
  seedE2eMonitorUser,
  cleanupE2eMonitorUser,
  seedE2eMonitorCap2User,
  cleanupE2eMonitorCap2User,
  randomE2ePassword,
} from "./fixtures/monitor-seed";
import { endPool, getClient, type PoolClient } from "../integration/rls/helpers/db";
import { FREE_LIMIT_SKIP_REASON, freeLimitApplied } from "../integration/rls/helpers/monitor-limit";
import messages from "../../messages/da.json";


const { Footer, Monitor, Nav } = messages;
// Canonical Monitor host for this spec
const MONITOR = "http://monitor.localhost:3000";
// Main-site origin (used for lockup href assertions)
const MAIN = "http://localhost:3000";


test.afterAll(async () => {
  await endPool();
});

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Signs in on /monitor/login and waits until the page navigates away. */
async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto(`${MONITOR}/login`);
  await page.getByLabel(/e-mail/i).fill(email);
  await page.getByLabel(/adgangskode/i).fill(password);
  await page.getByRole("button", { name: messages.Auth.login.submit }).click();
  await page.waitForURL((url) => url.pathname !== "/monitor/login");
}

/** The year in Copenhagen, as SiteFooter prints it (the copyright rolls over at local midnight). */
const copenhagenYear = new Intl.DateTimeFormat("da-DK", { year: "numeric", timeZone: "Europe/Copenhagen" });

/** The `site_settings` singleton's company name and CVR, read as postgres (what SiteFooter renders). */
async function readFooterSettings(): Promise<{ companyName: string; cvr: string | null }> {
  const client = await getClient();
  try {
    const { rows } = await client.query<{ company_name: string; cvr: string | null }>(
      "SELECT company_name, cvr FROM public.site_settings",
    );
    expect(rows).toHaveLength(1);
    return { companyName: rows[0]!.company_name, cvr: rows[0]!.cvr };
  } finally {
    client.release();
  }
}

// ── MCH-AC1: landing header ───────────────────────────────────────────────────

test.describe("MCH-AC1: /monitor landing header — pure ALNYRON lockup", () => {
  test("MCH-E1: header link accessible name is 'Alnyron' (no 'Monitor' suffix)", async ({ page }) => {
    await page.goto(`${MONITOR}/`);
    const header = page.locator("header").first();
    const link = header.getByRole("link", { name: "Alnyron" });
    await expect(link).toBeVisible();
    await expect(link).not.toContainText("Monitor");
  });

  test("MCH-E2: clicking the ALNYRON lockup navigates to the main site frontpage", async ({ page }) => {
    await page.goto(`${MONITOR}/`);
    const header = page.locator("header").first();
    const link = header.getByRole("link", { name: "Alnyron" });
    // The lockup now links to the absolute main-site URL, not '/'
    await expect(link).toHaveAttribute("href", MAIN);
    await link.click();
    await expect(page).toHaveURL((url) => url.hostname === "localhost" && url.port === "3000");
  });

  test("MCH-E3: 320px viewport — page fits without horizontal scroll", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto(`${MONITOR}/`);
    const overflowing = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflowing).toBe(false);
    const header = page.locator("header").first();
    await expect(header.getByRole("link", { name: "Alnyron" })).toBeVisible();
    await expect(header.getByRole("link", { name: Monitor.landing.ctaLogin })).toBeVisible();
    await expect(header.getByRole("link", { name: Monitor.landing.ctaSignup })).toBeVisible();
  });
});


// ── MCH-AC2: landing footer ───────────────────────────────────────────────────

test.describe("MCH-AC2: /monitor landing footer — SiteFooter", () => {
  test("MCH-E4: footer is a contentinfo landmark with copyright year, company, CVR, mailto, and Privatliv link", async ({ page }) => {
    test.skip(!DB_AVAILABLE, "Requires DB credentials");
    const { companyName, cvr } = await readFooterSettings();
    await page.goto(`${MONITOR}/`);
    const footer = page.getByRole("contentinfo");
    await expect(footer).toBeVisible();
    // `© {year} {company}`, the year in Copenhagen like SiteFooter.
    await expect(footer).toContainText(`© ${copenhagenYear.format(new Date())} ${companyName}`);
    // `CVR {cvr}` while site_settings.cvr is set; left out entirely otherwise.
    if (cvr !== null) {
      await expect(footer).toContainText(Footer.cvr.replace("{cvr}", cvr));
    } else {
      await expect(footer).not.toContainText("CVR");
    }
    // Contact mailto link present (AC2 requirement).
    const mailtoLink = footer.locator('a[href^="mailto:"]');
    await expect(mailtoLink).toBeVisible();
    // Privacy link on Monitor subdomain points to main-site absolute URL
    const privacyLink = footer.getByRole("link", { name: Nav.privacy });
    await expect(privacyLink).toBeVisible();
    await expect(privacyLink).toHaveAttribute("href", /^https?:\/\/localhost/);
  });

  test("MCH-E5: exactly one contentinfo landmark (the SiteFooter)", async ({ page }) => {
    await page.goto(`${MONITOR}/`);
    await expect(page.getByRole("contentinfo")).toHaveCount(1);
  });
});

// ── MCH-AC4: auth-card pages ──────────────────────────────────────────────────

test.describe("MCH-AC4: auth-card pages — ALNYRON lockup → main-site URL, no footer", () => {
  for (const authPath of ["/login", "/signup"]) {
    test(`MCH-E6/E7: ${MONITOR}${authPath} card has 'Alnyron' link → main-site URL`, async ({ page }) => {
      await page.goto(`${MONITOR}${authPath}`);
      const link = page.getByRole("link", { name: "Alnyron" });
      await expect(link).toBeVisible();
      // Lockup links to the absolute main-site URL, not '/'
      await expect(link).toHaveAttribute("href", MAIN);
    });

    test(`MCH-E7: ${MONITOR}${authPath} has no contentinfo landmark (no footer)`, async ({ page }) => {
      await page.goto(`${MONITOR}${authPath}`);
      await expect(page.getByRole("contentinfo")).toHaveCount(0);
    });
  }
});

// ── MCH-AC3: signed-in dashboard ─────────────────────────────────────────────

test.describe("MCH-AC3: signed-in dashboard — lockup and footer", () => {
  let client: PoolClient;
  const password = randomE2ePassword();

  test.beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    client = await getClient();
    await cleanupE2eMonitorUser(client);
    await seedE2eMonitorUser(client, password);
  });

  test.afterAll(async () => {
    if (!DB_AVAILABLE) return;
    await cleanupE2eMonitorUser(client);
    client.release();
  });

  test("MCH-E8a: header ALNYRON link points to /monitor/dashboard", async ({ page }) => {
    test.skip(!DB_AVAILABLE, "Requires DB credentials");
    await signIn(page, E2E_MONITOR_EMAIL, password);
    await expect(page).toHaveURL(/\/monitor\/dashboard/);
    const header = page.locator("header").first();
    const link = header.getByRole("link", { name: "Alnyron" });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "/monitor/dashboard");
  });

  test("MCH-E8b: contentinfo landmark is rendered after main on the dashboard", async ({ page }) => {
    test.skip(!DB_AVAILABLE, "Requires DB credentials");
    await signIn(page, E2E_MONITOR_EMAIL, password);
    await expect(page).toHaveURL(/\/monitor\/dashboard/);
    // The site footer is the page's only contentinfo landmark: the dashboard's
    // usage <footer> sits inside <main>, so it maps to no landmark role.
    const contentinfo = page.getByRole("contentinfo");
    await expect(contentinfo).toHaveCount(1);
    await expect(contentinfo).toBeVisible();
    const position = await contentinfo.evaluate((footer) => {
      const main = document.querySelector("main");
      return {
        hasMain: main !== null,
        insideMain: main?.contains(footer) ?? false,
        followsMain: main !== null && !!(main.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING),
      };
    });
    expect(position).toEqual({ hasMain: true, insideMain: false, followsMain: true });
  });

});

// ── MCH-AC5: landing lead copy ────────────────────────────────────────────────

test.describe("MCH-AC5: free tier — lead reads '2 sider'", () => {
  test("MCH-E9: landing lead contains 'Gratis for op til 2 sider.'", async ({ page }) => {
    await page.goto(`${MONITOR}/`);
    // The hero lead inside <main>, with {limit} = 2.
    const lead = page.getByRole("main").getByText(Monitor.landing.lead.replace("{limit}", "2"), { exact: true });
    await expect(lead).toBeVisible();
    await expect(lead).toContainText("Gratis for op til 2 sider.");
  });
});

// ── MCH-E10: cap-2 fresh user ─────────────────────────────────────────────────

test.describe("MCH-AC5/MCH-E10: fresh monitor_user (column-default cap) usage pill = 2", () => {
  test.describe.configure({ mode: "serial" });
  let cap2Client: PoolClient;
  let freeLimitOnTarget = false;
  const cap2Password = randomE2ePassword();

  test.beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    cap2Client = await getClient();
    // Without tests/.env.e2e-project Playwright targets the prod project, whose
    // column default stays 5 until 20261107000300 is pushed there: probe first
    // and only seed the fresh user where the default cap of 2 applies.
    freeLimitOnTarget = await freeLimitApplied(cap2Client);
    await cleanupE2eMonitorCap2User(cap2Client);
    if (freeLimitOnTarget) await seedE2eMonitorCap2User(cap2Client, cap2Password);
  });

  test.afterAll(async () => {
    if (!DB_AVAILABLE) return;
    await cleanupE2eMonitorCap2User(cap2Client);
    cap2Client.release();
  });

  test("MCH-E10: dashboard usage pill shows cap 2 for a fresh monitor_user", async ({ page }) => {
    test.skip(!DB_AVAILABLE, "Requires DB credentials");
    test.skip(!freeLimitOnTarget, FREE_LIMIT_SKIP_REASON);
    // seedE2eMonitorCap2User passes explicitLimit=false to insertUser, so the
    // trigger-created profile keeps the column default (2, set by migration
    // 20261107000300). With no monitors created the pill must read "0 / 2 …".
    const usageText = Monitor.dashboard.usage
      .replace("{count}", "0")
      .replace("{limit}", "2");
    await signIn(page, E2E_MONITOR_CAP2_EMAIL, cap2Password);
    await expect(page).toHaveURL(/\/monitor\/dashboard/);
    await expect(page.getByText(usageText, { exact: true })).toBeVisible();
  });
});
