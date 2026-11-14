/**
 * E2E tests: payments-slice1d design-review fixes
 * Journey: payments-slice1d-withdrawal-design-addendum (J9)
 *
 * E2E-WD-J9-01  WD-J9-C01  /terms (DA) at 320×568: no horizontal scroll; the h1 "Handelsbetingelser"
 *                          (breaking inside the word) stays inside main's content box
 * E2E-WD-J9-02  WD-J9-C02  /monitor/billing/withdraw at 1280×720, EN and DA: the back link's box ≥ 44×44
 * E2E-WD-J9-03  WD-J9-C03  ?error=invalid_input with the form shown: the name input has aria-invalid="true"
 *                          and aria-describedby = the hint, then the alert's id; without the error neither
 * E2E-WD-J9-04  WD-J9-C04  the seeded subscription has no consent record: the estimate shows, the timing
 *                          disclaimer does not
 *
 * Measurements use the layout viewport (`document.documentElement.clientWidth`, scrollbar
 * excluded); Playwright's headless Chromium hides scrollbars, so it is the whole window (asserted).
 *
 * Guards: E2E_PROJECT (DB_AVAILABLE + SUPABASE_E2E_REF) for the seeded Monitor user and its
 * subscription (started now: the withdrawal window is open, so the form shows).
 * Run with --retries=0 (CI=true in shell).
 */
import { test, expect, type Page } from "@playwright/test";
import { DB_AVAILABLE, E2E_EMAIL_DOMAIN, insertUser, deleteUser, randomE2ePassword } from "./fixtures/monitor-seed";
import { endPool, getClient, type PoolClient } from "../integration/rls/helpers/db";

const MONITOR = "http://monitor.localhost:3000";
const SITE = "http://localhost:3000";

/** True only when the e2e project is the DB target — never write to production. */
const E2E_PROJECT = DB_AVAILABLE && Boolean(process.env.SUPABASE_E2E_REF);

// Prefix 0d1d = withdrawal-1d e2e (monitor-withdrawal.spec.ts uses …0020-…0022).
const WD_J9_UUID = "00000000-0000-0000-0d1d-000000000030";
const WD_J9_EMAIL = `e2e-wd-j9@${E2E_EMAIL_DOMAIN}`;
const WD_J9_SUB = "sub_e2ewdj9001";
const WD_J9_INVOICE = "in_e2ewdj9001";
/** The monthly plan of the e2e seed (as in monitor-withdrawal.spec.ts). */
const MONTHLY_PRICE_ID = "price_1Ub3CoFIgZG2PjS1sJ7VtPSS";

const WITHDRAW_PATH = "/monitor/billing/withdraw";

test.afterAll(async () => {
  await endPool();
});

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto(`${MONITOR}/login`);
  await page.getByLabel(/e-mail/i).fill(email);
  await page.getByLabel(/adgangskode/i).fill(password);
  await page.getByRole("button", { name: /log ind/i }).click();
  await page.waitForURL((url) => !url.pathname.includes("/login"));
}

// ── WD-J9-C01: /terms reflows at 320px (no auth) ─────────────────────────────

test("WD-J9-C01 (E2E-WD-J9-01): /terms (DA) at 320×568 has no horizontal scroll; the h1 stays inside main's content box", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto(`${SITE}/terms`);
  const heading = page.locator("main").first().getByRole("heading", { level: 1, name: "Handelsbetingelser" });
  await expect(heading).toBeVisible();
  // Measure with Inter, not the swap fallback.
  await page.evaluate(async () => {
    await document.fonts.ready;
  });

  const metrics = await heading.evaluate((h1) => {
    const main = h1.closest("main");
    if (main === null) throw new Error("the h1 is not inside <main>");
    const mainBox = main.getBoundingClientRect();
    const mainStyle = getComputedStyle(main);
    const h1Box = h1.getBoundingClientRect();
    // The glyphs themselves (one rect per line): an element's own box never grows with its overflow.
    const range = document.createRange();
    range.selectNodeContents(h1);
    const glyphs = [...range.getClientRects()];
    return {
      pageClientWidth: document.documentElement.clientWidth,
      pageScrollWidth: document.documentElement.scrollWidth,
      contentLeft: mainBox.left + parseFloat(mainStyle.paddingLeft),
      contentRight: mainBox.right - parseFloat(mainStyle.paddingRight),
      h1Left: h1Box.left,
      h1Right: h1Box.right,
      h1ScrollWidth: h1.scrollWidth,
      h1ClientWidth: h1.clientWidth,
      glyphsLeft: Math.min(...glyphs.map((rect) => rect.left)),
      glyphsRight: Math.max(...glyphs.map((rect) => rect.right)),
    };
  });

  expect(metrics.pageClientWidth).toBe(320);
  expect(metrics.pageScrollWidth).toBeLessThanOrEqual(metrics.pageClientWidth);
  expect(metrics.h1ScrollWidth).toBeLessThanOrEqual(metrics.h1ClientWidth);
  // Half a pixel for subpixel layout.
  expect(metrics.h1Left).toBeGreaterThanOrEqual(metrics.contentLeft - 0.5);
  expect(metrics.h1Right).toBeLessThanOrEqual(metrics.contentRight + 0.5);
  expect(metrics.glyphsLeft).toBeGreaterThanOrEqual(metrics.contentLeft - 0.5);
  expect(metrics.glyphsRight).toBeLessThanOrEqual(metrics.contentRight + 0.5);
});

// ── WD-J9-C02..C04: the withdraw page (seeded subscription, window open) ─────

test.describe("WD-J9 withdraw page: back link, name-field error, timing disclaimer (seeded subscription)", () => {
  test.describe.configure({ mode: "serial" });
  let pwd: string;
  let client: PoolClient;

  /** Removes the seeded rows (children first) and the user. */
  async function removeSeed(db: PoolClient): Promise<void> {
    await db.query("DELETE FROM public.subscription_withdrawals WHERE stripe_subscription_id = $1", [WD_J9_SUB]);
    await db.query("DELETE FROM public.subscription_invoices WHERE stripe_invoice_id = $1", [WD_J9_INVOICE]);
    await db.query("DELETE FROM public.subscriptions WHERE stripe_subscription_id = $1", [WD_J9_SUB]);
    await deleteUser(db, WD_J9_UUID, WD_J9_EMAIL);
  }

  test.beforeAll(async () => {
    test.skip(!E2E_PROJECT, "Requires SUPABASE_E2E_REF + DB credentials");
    client = await getClient();
    // A leftover of an aborted run would keep its old password (insertUser does nothing on conflict).
    await removeSeed(client);
    pwd = randomE2ePassword();
    await insertUser(client, WD_J9_UUID, WD_J9_EMAIL, "monitor_user", pwd);
    // Started now (the window is open), no consent record; plan by its Stripe price (there is no
    // stripe_price_id column); the invoice's period feeds the page's estimate.
    const subscription = await client.query(
      `INSERT INTO public.subscriptions
         (user_id, stripe_subscription_id, stripe_customer_id, plan_id, status, current_period_end,
          cancel_at_period_end, last_event_created, started_at)
       SELECT $1, $2, 'cus_e2ewdj9001', p.id, 'active', now() + interval '30 days', false, now(), now()
         FROM public.monitor_plans p WHERE p.stripe_price_id = $3`,
      [WD_J9_UUID, WD_J9_SUB, MONTHLY_PRICE_ID],
    );
    if (subscription.rowCount !== 1) throw new Error(`no e2e plan with price ${MONTHLY_PRICE_ID}`);
    await client.query(
      `INSERT INTO public.subscription_invoices
         (stripe_invoice_id, stripe_subscription_id, user_id, email, amount_total_ore, amount_tax_ore,
          amount_refunded_ore, period_start, period_end, paid_at)
       VALUES ($1, $2, $3, $4, 1000, 200, 0, now(), now() + interval '30 days', now())`,
      [WD_J9_INVOICE, WD_J9_SUB, WD_J9_UUID, WD_J9_EMAIL],
    );
  });

  test.afterAll(async () => {
    if (client) {
      await removeSeed(client);
      client.release();
    }
  });

  test("WD-J9-C02 (E2E-WD-J9-02): at 1280×720 the back link's box is at least 44×44 (EN and DA)", async ({ page }) => {
    test.skip(!E2E_PROJECT, "Requires SUPABASE_E2E_REF + DB credentials");
    await page.setViewportSize({ width: 1280, height: 720 });
    await signIn(page, WD_J9_EMAIL, pwd);

    for (const [locale, name] of [
      ["en", "Back"],
      ["da", "Tilbage"],
    ] as const) {
      await test.step(locale.toUpperCase(), async () => {
        await page.context().addCookies([{ name: "monitor-locale", value: locale, domain: "monitor.localhost", path: "/" }]);
        await page.goto(`${MONITOR}${WITHDRAW_PATH}`);
        // Measure with Inter, not the swap fallback.
        await page.evaluate(async () => {
          await document.fonts.ready;
        });
        const back = page.locator("main").first().getByRole("link", { name, exact: true });
        await expect(back).toHaveAttribute("href", "/monitor/billing");
        const box = await back.boundingBox();
        if (box === null) throw new Error(`the ${locale} back link is not rendered`);
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
      });
    }
  });

  test("WD-J9-C03 (E2E-WD-J9-03): ?error=invalid_input marks the name input invalid, described by the hint and the alert", async ({
    page,
  }) => {
    test.skip(!E2E_PROJECT, "Requires SUPABASE_E2E_REF + DB credentials");
    await signIn(page, WD_J9_EMAIL, pwd);
    const main = page.locator("main").first();
    const input = main.getByLabel("Dit navn", { exact: true });
    const hint = "Dit fulde navn, højst 200 tegn.";
    const error = "Skriv dit navn (højst 200 tegn), og prøv igen.";

    await page.goto(`${MONITOR}${WITHDRAW_PATH}?error=invalid_input`);
    const alert = main.getByRole("alert");
    await expect(alert).toHaveText(error);
    await expect(input).toHaveAttribute("aria-invalid", "true");
    const alertId = await alert.getAttribute("id");
    expect(alertId).toBeTruthy();
    const ids = (await input.getAttribute("aria-describedby"))?.split(" ") ?? [];
    expect(ids).toHaveLength(2);
    await expect(page.locator(`[id="${ids[0]}"]`)).toHaveText(hint);
    expect(ids[1]).toBe(alertId);
    await expect(input).toHaveAccessibleDescription(`${hint} ${error}`);

    // Without the error: the field is not invalid and is described by the hint alone.
    await page.goto(`${MONITOR}${WITHDRAW_PATH}`);
    await expect(input).toBeVisible();
    await expect(main.getByRole("alert")).toHaveCount(0);
    expect(await input.getAttribute("aria-invalid")).toBeNull();
    await expect(input).toHaveAccessibleDescription(hint);
  });

  test("WD-J9-C04 (E2E-WD-J9-04): without a consent record the estimate shows and the timing disclaimer does not", async ({
    page,
  }) => {
    test.skip(!E2E_PROJECT, "Requires SUPABASE_E2E_REF + DB credentials");
    await signIn(page, WD_J9_EMAIL, pwd);
    await page.goto(`${MONITOR}${WITHDRAW_PATH}`);
    const main = page.locator("main").first();
    // No consent: nothing is retained, the whole amount paid is refunded.
    await expect(main.getByText("Anslået tilbagebetaling: 10 kr af 10 kr", { exact: true })).toBeVisible();
    await expect(main).not.toContainText("Det endelige beløb beregnes ud fra tidspunktet");
  });
});
