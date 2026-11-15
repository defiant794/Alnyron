/**
 * S2 public pages + admin access guard E2E.
 *
 * Tests that need no order, Stripe or payments Worker. Tests requiring the DB
 * (unauthenticated redirect) are gated on E2E_PROJECT.
 *
 * Neutral E2E ids (S2-E2E-*); the journey criteria each covers are in parentheses.
 *
 * Covers:
 *   - /admin/orders and an order page require login (unauthenticated → /admin/login)
 *   - /order/error each reason: exact copy from unit-test literals (S2-T-ERROR web)
 *   - /terms goods sections, DA and EN: heading, and within the goods part (the subscription part
 *     repeats the address and CVR) the return address with CVR, the notice heading, the
 *     reservation sentence and the withdraw link (S2-LEGAL-1..9 web)
 *   - /order/withdraw: 'Fortryd aftale' heading, robots noindex, link form fields (S2-WD-7 web)
 */

import { expect, test, type Page } from "@playwright/test";
import { DB_AVAILABLE } from "./fixtures/payments-s2-seed";

const E2E_PROJECT = DB_AVAILABLE && Boolean(process.env.SUPABASE_E2E_REF);

// ── Admin access guard ────────────────────────────────────────────────────

test.describe("S2 admin access guard", () => {
  test.skip(!E2E_PROJECT, "Requires SUPABASE_E2E_REF");

  test("S2-E2E-GUARD-1: unauthenticated GET /admin/orders redirects to /admin/login", async ({
    page,
  }) => {
    await page.goto("/admin/orders");
    await expect(page).toHaveURL(/\/admin\/login/);
  });

  test("S2-E2E-GUARD-2: unauthenticated GET /admin/orders/1001 redirects to /admin/login", async ({
    page,
  }) => {
    await page.goto("/admin/orders/1001");
    await expect(page).toHaveURL(/\/admin\/login/);
  });
});

// ── /order/error reasons ──────────────────────────────────────────────────

test.describe("S2-ERR: /order/error page reasons", () => {
  test("S2-ERR-1: reason=busy contains contract §3 fragment 'for mange forsøg, prøv igen om lidt'", async ({
    page,
  }) => {
    await page.goto("/order/error?lang=da&reason=busy");
    await expect(
      page.getByRole("main").getByText(/for mange forsøg, prøv igen om lidt/),
    ).toBeVisible();
  });

  test("S2-ERR-2: reason=not_purchasable shows 'Varen kan ikke købes lige nu.'", async ({
    page,
  }) => {
    await page.goto("/order/error?lang=da&reason=not_purchasable");
    await expect(
      page.getByRole("main").getByText("Varen kan ikke købes lige nu."),
    ).toBeVisible();
  });

  test("S2-ERR-3: unknown reason shows generic copy, no heading reflects the reason value", async ({
    page,
  }) => {
    await page.goto("/order/error?lang=da&reason=unknown_reason_xyz");
    const main = page.getByRole("main");
    await expect(
      main.getByText("Der skete en fejl, og du er ikke blevet opkrævet."),
    ).toBeVisible();
    await expect(main).not.toContainText("unknown_reason_xyz");
  });

  test("S2-ERR-4: lang=en heading is 'Payment could not be started', not Danish", async ({
    page,
  }) => {
    await page.goto("/order/error?lang=en");
    const h1 = page.getByRole("main").getByRole("heading", { level: 1 });
    await expect(h1).toHaveText("Payment could not be started");
  });

  test("S2-ERR-5: /order/error DA heading 'Betalingen kunne ikke startes'", async ({ page }) => {
    await page.goto("/order/error?lang=da");
    await expect(
      page.getByRole("main").getByRole("heading", { level: 1 }),
    ).toHaveText("Betalingen kunne ikke startes");
  });
});

// ── /terms goods sections ─────────────────────────────────────────────────

/** The Danish goods part of /terms: the block (under main) holding both its heading and its withdraw link. */
function goodsPart(page: Page) {
  return page
    .getByRole("main")
    .locator("div")
    .filter({ has: page.getByRole("heading", { level: 2, name: "Køb af 3D-figurer" }) })
    .filter({ has: page.getByRole("link", { name: "Fortryd køb af varer" }) });
}

test.describe("S2-E2E-TERMS: /terms goods sections (S2-LEGAL-1..9 web)", () => {
  test("S2-E2E-TERMS-1: /terms shows the 'Køb af 3D-figurer' section heading", async ({ page }) => {
    await page.goto("/terms");
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: "Køb af 3D-figurer" })).toBeVisible();
  });

  test("S2-E2E-TERMS-2: the goods part's 'Returadresse' is Nyvej 4, 7860 Spøttrup with CVR 46887433", async ({
    page,
  }) => {
    await page.goto("/terms");
    const goods = goodsPart(page);
    await expect(goods).toHaveCount(1);
    await expect(goods.getByRole("region", { name: "Returadresse" })).toContainText(
      "Alnyron, Nyvej 4, 7860 Spøttrup, Danmark, CVR 46887433",
    );
  });

  test("S2-E2E-TERMS-3: the goods part has the notice 'Fortrydelsesvejledning' and the reservation sentence", async ({
    page,
  }) => {
    await page.goto("/terms");
    const goods = goodsPart(page);
    await expect(goods.getByRole("heading", { level: 3, name: "Fortrydelsesvejledning" })).toBeVisible();
    await expect(goods).toContainText("Beløbet reserveres ved bestillingen og trækkes først, når varen sendes.");
  });

  test("S2-E2E-TERMS-4: /terms 'Fortryd køb af varer' link href='/order/withdraw?lang=da'", async ({
    page,
  }) => {
    await page.goto("/terms");
    const link = page.getByRole("main").getByRole("link", { name: "Fortryd køb af varer" });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "/order/withdraw?lang=da");
  });

  test("S2-E2E-TERMS-5: /terms goods section contains no em-dash (U+2014)", async ({ page }) => {
    await page.goto("/terms");
    await expect(page.getByRole("main")).not.toContainText("\u2014");
  });

  test("S2-E2E-TERMS-6: /en/terms shows 'Purchase of 3D figures' and the EN withdraw link", async ({ page }) => {
    await page.goto("/en/terms");
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: "Purchase of 3D figures" })).toBeVisible();
    await expect(main).not.toContainText("Køb af 3D-figurer");
    const link = main.getByRole("link", { name: "Withdraw a purchase of goods" });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "/order/withdraw?lang=en");
  });
});

// ── /order/withdraw public page ───────────────────────────────────────────

test.describe("S2-E2E-WD: /order/withdraw public page, no DB (S2-WD-7 web)", () => {
  test("S2-E2E-WD-1: /order/withdraw shows 'Fortryd aftale' heading", async ({ page }) => {
    await page.goto("/order/withdraw?lang=da");
    await expect(
      page.getByRole("main").getByRole("heading", { level: 1 }),
    ).toHaveText("Fortryd aftale");
  });

  test("S2-E2E-WD-2: /order/withdraw is noindex (robots meta from generateMetadata)", async ({ page }) => {
    await page.goto("/order/withdraw?lang=da");
    await expect(page.locator('head meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
  });

  test("S2-E2E-WD-3: /order/withdraw with a personal link (o + t) asks only for the consumer's name", async ({
    page,
  }) => {
    // The token is checked by the payments Worker when the form is sent, so the page renders the
    // link form for any well-formed order id and token.
    await page.goto(
      "/order/withdraw?o=00000000-0000-0000-0000-000000000001&t=fake-token&lang=da",
    );
    const main = page.getByRole("main");
    await expect(main.locator("input[name='consumer_name']")).toBeVisible();
    await expect(main.locator("input[name='order_number']")).toHaveCount(0);
    await expect(main.locator("input[name='email']")).toHaveCount(0);
  });
});
