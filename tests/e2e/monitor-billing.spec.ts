/**
 * E2E tests — monitor billing page (payments-slice1b-billing E2E scenarios)
 * Journey: payments-slice1b-billing
 *
 * Covers:
 *   E2E-PAY1B-01  DA page matches the mock: h1, plan name, year/month options (prices, year
 *                 preselected, "Spar ~21%" on the year option), "Opgradér", fine print
 *   E2E-PAY1B-02  DA usage pill "N / L overvågninger brugt"
 *   E2E-PAY1B-04  EN page with monitor-locale=en cookie shows "Upgrade"
 *   E2E-PAY1B-05  Upgrade (year) → hosted Checkout URL for a cs_test_ session (see B17 below)
 *   E2E-PAY1B-06  Upgrade (month) → hosted Checkout URL for a cs_test_ session (see B17 below)
 *   E2E-PAY1B-07  cancel_url verified via Stripe API; navigate to it lands on billing page
 *   E2E-PAY1B-08  ?checkout=done without subscription → pending notice, no form
 *   E2E-PAY1B-09  ?error=checkout → error alert
 *   E2E-PAY1B-10  Subscribed (seeded row + real Stripe TEST customer): plan, price,
 *                 "Fornyes <date>", Administrér → billing.stripe.com portal
 *   E2E-PAY1B-11  Dashboard upgradeLink → /monitor/billing
 *   E2E-PAY1B-12  Abonnement nav tab aria-current="page"
 *   E2E-PAY1B-13  CSP form-action: Stripe's Checkout + Billing Portal on the billing page only
 *                 (/monitor/billing, Monitor-host /billing), 'self' elsewhere (amendment B13)
 *   E2E-PAY1B-14  At 320×568 (DA + EN, /monitor/billing + /monitor/settings) the three app-bar
 *                 tabs share one row, none clipped by the tab list or the window, no page
 *                 overflow, each ≥ 44px tall and fully in view when Tab-focused (PAY1B-AC51)
 *   E2E-PAY1B-15  At 320×568 with 2× text (DA + EN; upgrade, ?checkout=done, ?error=portal) no
 *                 page overflow, no heading, paragraph or notice wider than its own box, and every
 *                 text run, option row and radio inside the card's content box (PAY1B-AC52, D-5)
 *
 * Not here: J5 "no plans" ("Monitor Plus er ikke tilgængeligt endnu."). Plans are global (no
 * per-user visibility), so it would need every active plan on the shared e2e project
 * deactivated, under the other billing tests; it is covered by the unit tests (PAY1B-AC23).
 *
 * Checkout URL shape (decision B17): Stripe does not document the hosted Checkout path, and it
 * varies (`/c/pay/cs_test_…`, `/g/pay/cs_test_…`). E2E-PAY1B-05..07 assert only the exact
 * origin https://checkout.stripe.com and a `/pay/cs_test_…` path segment
 * (`expectCheckoutTestUrl`); the segment before `/pay/` is free. The product itself guards just
 * the https://checkout.stripe.com/ prefix + a `cs_` session id.
 *
 * Guards:
 *   DB_AVAILABLE + SUPABASE_E2E_REF: all DB-writing tests (auth.users, billing_customers,
 *     subscriptions rows). The default DB target is the production project; writes MUST
 *     only reach the isolated e2e project.
 *   STRIPE_KEY_AVAILABLE: checkout/portal tests additionally require a Stripe TEST key.
 *
 * Requires dev server at http://monitor.localhost:3000.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  DB_AVAILABLE,
  E2E_EMAIL_DOMAIN,
  insertUser,
  deleteUser,
  randomE2ePassword,
} from "./fixtures/monitor-seed";
import { firstResponse } from "./fixtures/first-response";
import { endPool, getClient, type PoolClient } from "../integration/rls/helpers/db";

const MONITOR = "http://monitor.localhost:3000";

/** True only when the e2e project is the DB target — never write to production. */
const E2E_PROJECT = DB_AVAILABLE && Boolean(process.env.SUPABASE_E2E_REF);

const STRIPE_KEY_AVAILABLE =
  typeof process.env.STRIPE_CHECKOUT_KEY === "string" &&
  /^(sk|rk)_test_/.test(process.env.STRIPE_CHECKOUT_KEY);

// ── Per-describe unique email+UUID pairs (prefix 0b11 = pay1b-billing) ────────
// Each describe gets its own pair so parallel seeding cannot collide on email
// or id uniqueness constraints.
const E2E_PAY1B_VIEW_UUID    = "00000000-0000-0000-0b11-000000000001";
const E2E_PAY1B_VIEW_EMAIL   = `e2e-pay1b-view@${E2E_EMAIL_DOMAIN}`;

const E2E_PAY1B_EN_UUID      = "00000000-0000-0000-0b11-000000000002";
const E2E_PAY1B_EN_EMAIL     = `e2e-pay1b-en@${E2E_EMAIL_DOMAIN}`;

const E2E_PAY1B_UPG_UUID     = "00000000-0000-0000-0b11-000000000003";
const E2E_PAY1B_UPG_EMAIL    = `e2e-pay1b-upg@${E2E_EMAIL_DOMAIN}`;

const E2E_PAY1B_PEND_UUID    = "00000000-0000-0000-0b11-000000000004";
const E2E_PAY1B_PEND_EMAIL   = `e2e-pay1b-pend@${E2E_EMAIL_DOMAIN}`;

const E2E_PAY1B_ERR_UUID     = "00000000-0000-0000-0b11-000000000005";
const E2E_PAY1B_ERR_EMAIL    = `e2e-pay1b-err@${E2E_EMAIL_DOMAIN}`;

const E2E_PAY1B_SUB_UUID     = "00000000-0000-0000-0b11-000000000006";
const E2E_PAY1B_SUB_EMAIL    = `e2e-pay1b-sub@${E2E_EMAIL_DOMAIN}`;
/** The seeded subscription's current_period_end: 12:00 on 1 June 2030 in Copenhagen ("Fornyes 1. juni 2030"). */
const SUB_PERIOD_END = "2030-06-01T10:00:00Z";

const E2E_PAY1B_DASH_UUID    = "00000000-0000-0000-0b11-000000000007";
const E2E_PAY1B_DASH_EMAIL   = `e2e-pay1b-dash@${E2E_EMAIL_DOMAIN}`;

const E2E_PAY1B_NAV_UUID     = "00000000-0000-0000-0b11-000000000008";
const E2E_PAY1B_NAV_EMAIL    = `e2e-pay1b-nav@${E2E_EMAIL_DOMAIN}`;

const E2E_PAY1B_CSP_UUID     = "00000000-0000-0000-0b11-000000000009";
const E2E_PAY1B_CSP_EMAIL    = `e2e-pay1b-csp@${E2E_EMAIL_DOMAIN}`;

const E2E_PAY1B_ROW_UUID     = "00000000-0000-0000-0b11-000000000010";
const E2E_PAY1B_ROW_EMAIL    = `e2e-pay1b-row@${E2E_EMAIL_DOMAIN}`;

const E2E_PAY1B_ZOOM_UUID    = "00000000-0000-0000-0b11-000000000011";
const E2E_PAY1B_ZOOM_EMAIL   = `e2e-pay1b-zoom@${E2E_EMAIL_DOMAIN}`;

test.afterAll(async () => {
  await endPool();
});

/** Sign in on /monitor/login and wait for redirect away from /login. */
async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto(`${MONITOR}/login`);
  await page.getByLabel(/e-mail/i).fill(email);
  await page.getByLabel(/adgangskode/i).fill(password);
  await page.getByRole("button", { name: /log ind/i }).click();
  await page.waitForURL((url) => !url.pathname.includes("/login"));
}

/** Origin of Stripe's hosted Checkout pages. */
const STRIPE_CHECKOUT_ORIGIN = "https://checkout.stripe.com";
/** A TEST Checkout session in a hosted Checkout path; the segment before `/pay/` is free (B17). */
const CHECKOUT_TEST_SESSION_PATH = /\/pay\/(cs_test_[A-Za-z0-9]+)/;

/**
 * Asserts `url` is a hosted Stripe Checkout page for a TEST session — origin exactly
 * {@link STRIPE_CHECKOUT_ORIGIN}, pathname matching {@link CHECKOUT_TEST_SESSION_PATH}, whatever
 * the segment before `/pay/` (B17) — and returns the session id (`cs_test_…`). Query and
 * fragment are ignored.
 */
function expectCheckoutTestUrl(url: string): string {
  const { origin, pathname } = new URL(url);
  expect(origin).toBe(STRIPE_CHECKOUT_ORIGIN);
  const sessionId = CHECKOUT_TEST_SESSION_PATH.exec(pathname)?.[1];
  if (sessionId === undefined) {
    throw new Error(`Checkout pathname ${pathname} does not match ${CHECKOUT_TEST_SESSION_PATH}`);
  }
  return sessionId;
}

// ── DA page render (E2E-PAY1B-01..02) ─────────────────────────────────────────

test.describe("DA billing page render", () => {
  test.describe.configure({ mode: "serial" });
  let pwd: string;
  let client: PoolClient;

  test.beforeAll(async () => {
    test.skip(!E2E_PROJECT, "Requires SUPABASE_E2E_REF + DB credentials");
    client = await getClient();
    pwd = randomE2ePassword();
    await insertUser(client, E2E_PAY1B_VIEW_UUID, E2E_PAY1B_VIEW_EMAIL, "monitor_user", pwd);
  });

  test.afterAll(async () => {
    if (client) {
      await deleteUser(client, E2E_PAY1B_VIEW_UUID, E2E_PAY1B_VIEW_EMAIL);
      client.release();
    }
  });

  test(
    "E2E-PAY1B-01: DA page has h1, plan name, year/month options with prices and the Spar tag, " +
    "'Opgradér' and the fine print",
    async ({ page }) => {
      test.skip(!E2E_PROJECT, "Requires SUPABASE_E2E_REF + DB credentials");
      await signIn(page, E2E_PAY1B_VIEW_EMAIL, pwd);
      await page.goto(`${MONITOR}/monitor/billing`);
      const main = page.locator("main").first();
      await expect(main.getByRole("heading", { level: 1 })).toHaveText("Abonnement");
      await expect(main.getByRole("button", { name: "Opgradér" })).toBeVisible();
      // exact: the lead "Kør mere end … med Monitor Plus." also contains the name (substring match).
      await expect(main.getByText("Monitor Plus", { exact: true })).toBeVisible();

      // The seeded plans: year (9500 øre) first and preselected, month (1000 øre) second.
      const radios = main.getByRole("radio");
      await expect(radios).toHaveCount(2);
      await expect(radios.nth(0)).toHaveAttribute("value", "year");
      await expect(radios.nth(1)).toHaveAttribute("value", "month");
      const yearOption = main.locator("label").filter({ has: page.locator('input[value="year"]') });
      const monthOption = main.locator("label").filter({ has: page.locator('input[value="month"]') });
      await expect(yearOption.getByRole("radio")).toBeChecked();
      await expect(monthOption.getByRole("radio")).not.toBeChecked();
      await expect(yearOption).toContainText("95 kr / år");
      await expect(monthOption).toContainText("10 kr / måned");
      await expect(yearOption.getByText("Spar ~21%", { exact: true })).toBeVisible();
      await expect(monthOption).not.toContainText("Spar");

      await expect(
        main.getByText(
          "Priser inkl. moms. Betaling via Stripe – du sendes til Stripes sikre betalingsside. " +
            "Opsig eller skift mellem månedlig og årlig betaling når som helst under “Administrér abonnement”.",
          { exact: true },
        ),
      ).toBeVisible();
    },
  );

  test("E2E-PAY1B-02: DA page shows usage pill with count / limit format", async ({ page }) => {
    test.skip(!E2E_PROJECT, "Requires SUPABASE_E2E_REF + DB credentials");
    await signIn(page, E2E_PAY1B_VIEW_EMAIL, pwd);
    await page.goto(`${MONITOR}/monitor/billing`);
    // A fresh user with no monitors: "0 / <cap> overvågninger brugt", the whole pill text.
    await expect(page.locator("main").first().getByText(/^0 \/ \d+ overvågninger brugt$/)).toBeVisible();
  });
});

// ── EN locale render (E2E-PAY1B-04) ───────────────────────────────────────────

test.describe("EN billing page render via monitor-locale cookie", () => {
  test.describe.configure({ mode: "serial" });
  let pwd: string;
  let client: PoolClient;

  test.beforeAll(async () => {
    test.skip(!E2E_PROJECT, "Requires SUPABASE_E2E_REF + DB credentials");
    client = await getClient();
    pwd = randomE2ePassword();
    await insertUser(client, E2E_PAY1B_EN_UUID, E2E_PAY1B_EN_EMAIL, "monitor_user", pwd);
  });

  test.afterAll(async () => {
    if (client) {
      await deleteUser(client, E2E_PAY1B_EN_UUID, E2E_PAY1B_EN_EMAIL);
      client.release();
    }
  });

  test("E2E-PAY1B-04: monitor-locale=en cookie → English 'Upgrade' button", async ({ page }) => {
    test.skip(!E2E_PROJECT, "Requires SUPABASE_E2E_REF + DB credentials");
    await signIn(page, E2E_PAY1B_EN_EMAIL, pwd);
    await page.context().addCookies([
      { name: "monitor-locale", value: "en", domain: "monitor.localhost", path: "/" },
    ]);
    await page.goto(`${MONITOR}/monitor/billing`);
    await expect(page.locator("main").first().getByRole("button", { name: "Upgrade" })).toBeVisible();
  });
});

// ── Upgrade → checkout redirect + cancel_url verification ─────────────────────

test.describe("Upgrade checkout redirect and cancel_url (year + month)", () => {
  test.describe.configure({ mode: "serial" });
  let pwd: string;
  let client: PoolClient;

  test.beforeAll(async () => {
    test.skip(
      !E2E_PROJECT || !STRIPE_KEY_AVAILABLE,
      "Requires SUPABASE_E2E_REF + DB credentials + Stripe TEST key",
    );
    client = await getClient();
    pwd = randomE2ePassword();
    await insertUser(client, E2E_PAY1B_UPG_UUID, E2E_PAY1B_UPG_EMAIL, "monitor_user", pwd);
  });

  test.afterAll(async () => {
    if (client) {
      await deleteUser(client, E2E_PAY1B_UPG_UUID, E2E_PAY1B_UPG_EMAIL);
      client.release();
    }
  });

  test("E2E-PAY1B-05: Opgradér (year default) → hosted Checkout with a cs_test_ session", async ({ page }) => {
    test.skip(!E2E_PROJECT || !STRIPE_KEY_AVAILABLE, "Requires e2e project + Stripe TEST key");
    await signIn(page, E2E_PAY1B_UPG_EMAIL, pwd);
    await page.goto(`${MONITOR}/monitor/billing`);
    await page.getByRole("button", { name: "Opgradér" }).click();
    await page.waitForURL(/checkout\.stripe\.com/);
    expectCheckoutTestUrl(page.url());
  });

  test("E2E-PAY1B-06: Opgradér (month selected) → hosted Checkout with a cs_test_ session", async ({ page }) => {
    test.skip(!E2E_PROJECT || !STRIPE_KEY_AVAILABLE, "Requires e2e project + Stripe TEST key");
    await signIn(page, E2E_PAY1B_UPG_EMAIL, pwd);
    await page.goto(`${MONITOR}/monitor/billing`);
    await page.getByRole("radio").nth(1).check();
    await page.getByRole("button", { name: "Opgradér" }).click();
    await page.waitForURL(/checkout\.stripe\.com/);
    expectCheckoutTestUrl(page.url());
  });

  test(
    "E2E-PAY1B-07: cancel_url and success_url verified via Stripe API; " +
    "navigating to cancel_url lands on /monitor/billing",
    async ({ page }) => {
      test.skip(!E2E_PROJECT || !STRIPE_KEY_AVAILABLE, "Requires e2e project + Stripe TEST key");
      await signIn(page, E2E_PAY1B_UPG_EMAIL, pwd);
      await page.goto(`${MONITOR}/monitor/billing`);
      await page.getByRole("button", { name: "Opgradér" }).click();
      await page.waitForURL(/checkout\.stripe\.com/);

      // Origin + `/pay/cs_test_…` path asserted; the segment before `/pay/` is free (B17).
      const sessionId = expectCheckoutTestUrl(page.url());

      // Fetch the session from Stripe API and assert cancel_url + success_url
      const stripeKey = process.env.STRIPE_CHECKOUT_KEY!;
      const resp = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
        headers: { Authorization: `Bearer ${stripeKey}` },
      });
      expect(resp.status).toBe(200);
      const session = await resp.json() as { cancel_url: string; success_url: string };
      expect(session.cancel_url).toBe(`${MONITOR}/monitor/billing`);
      expect(session.success_url).toBe(`${MONITOR}/monitor/billing?checkout=done`);

      // Navigate to the cancel_url and verify the billing page loads
      await page.goto(session.cancel_url);
      await expect(page).toHaveURL(`${MONITOR}/monitor/billing`);
      await expect(page.locator("main").first().getByRole("button", { name: "Opgradér" })).toBeVisible();
    },
  );
});

// ── ?checkout=done pending state (E2E-PAY1B-08) ───────────────────────────────

test.describe("Pending state ?checkout=done", () => {
  test.describe.configure({ mode: "serial" });
  let pwd: string;
  let client: PoolClient;

  test.beforeAll(async () => {
    test.skip(!E2E_PROJECT, "Requires SUPABASE_E2E_REF + DB credentials");
    client = await getClient();
    pwd = randomE2ePassword();
    await insertUser(client, E2E_PAY1B_PEND_UUID, E2E_PAY1B_PEND_EMAIL, "monitor_user", pwd);
  });

  test.afterAll(async () => {
    if (client) {
      await deleteUser(client, E2E_PAY1B_PEND_UUID, E2E_PAY1B_PEND_EMAIL);
      client.release();
    }
  });

  test("E2E-PAY1B-08: ?checkout=done without subscription → pending notice, no upgrade form", async ({ page }) => {
    test.skip(!E2E_PROJECT, "Requires SUPABASE_E2E_REF + DB credentials");
    await signIn(page, E2E_PAY1B_PEND_EMAIL, pwd);
    await page.goto(`${MONITOR}/monitor/billing?checkout=done`);
    const main = page.locator("main").first();
    await expect(main.getByRole("status")).toBeVisible();
    await expect(main.getByRole("status")).toContainText(/aktiverer/i);
    await expect(main.getByRole("button", { name: "Opgradér" })).not.toBeVisible();
  });
});

// ── ?error=checkout error notice (E2E-PAY1B-09) ───────────────────────────────

test.describe("Error notice ?error=checkout", () => {
  test.describe.configure({ mode: "serial" });
  let pwd: string;
  let client: PoolClient;

  test.beforeAll(async () => {
    test.skip(!E2E_PROJECT, "Requires SUPABASE_E2E_REF + DB credentials");
    client = await getClient();
    pwd = randomE2ePassword();
    await insertUser(client, E2E_PAY1B_ERR_UUID, E2E_PAY1B_ERR_EMAIL, "monitor_user", pwd);
  });

  test.afterAll(async () => {
    if (client) {
      await deleteUser(client, E2E_PAY1B_ERR_UUID, E2E_PAY1B_ERR_EMAIL);
      client.release();
    }
  });

  test("E2E-PAY1B-09: ?error=checkout shows role=alert with betalingssiden text", async ({ page }) => {
    test.skip(!E2E_PROJECT, "Requires SUPABASE_E2E_REF + DB credentials");
    await signIn(page, E2E_PAY1B_ERR_EMAIL, pwd);
    await page.goto(`${MONITOR}/monitor/billing?error=checkout`);
    const alert = page.locator("main").first().getByRole("alert");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/betalingssiden/i);
  });
});

// ── Subscribed state + portal (E2E-PAY1B-10) ─────────────────────────────────

test.describe("Subscribed state + Administrér portal", () => {
  test.describe.configure({ mode: "serial" });
  let pwd: string;
  let dbClient: PoolClient;
  let stripeCustomerId: string;

  test.beforeAll(async () => {
    test.skip(
      !E2E_PROJECT || !STRIPE_KEY_AVAILABLE,
      "Requires SUPABASE_E2E_REF + DB credentials + Stripe TEST key",
    );
    dbClient = await getClient();
    pwd = randomE2ePassword();
    await insertUser(dbClient, E2E_PAY1B_SUB_UUID, E2E_PAY1B_SUB_EMAIL, "monitor_user", pwd);

    // Create a real Stripe TEST customer
    const stripeKey = process.env.STRIPE_CHECKOUT_KEY!;
    const resp = await fetch("https://api.stripe.com/v1/customers", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        email: E2E_PAY1B_SUB_EMAIL,
        "metadata[e2e_test]": "pay1b_billing",
      }),
    });
    expect(resp.status).toBe(200);
    const customer = await resp.json() as { id: string };
    expect(customer.id).toMatch(/^cus_/);
    stripeCustomerId = customer.id;

    // Seed billing_customer row (bypasses RLS as postgres)
    await dbClient.query(
      `INSERT INTO public.billing_customers (user_id, stripe_customer_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET stripe_customer_id = $2`,
      [E2E_PAY1B_SUB_UUID, stripeCustomerId],
    );

    // Seed an active subscription on the yearly plan the page offers, renewing on SUB_PERIOD_END.
    const { rows: planRows } = await dbClient.query<{ id: string }>(
      `SELECT id FROM public.monitor_plans
        WHERE active = TRUE AND billing_interval = 'year'
        ORDER BY sort_order, id LIMIT 1`,
    );
    expect(planRows).toHaveLength(1);
    const subscriptionId = `sub_e2e_pay1b_${E2E_PAY1B_SUB_UUID}`;
    // A row left by an interrupted run would keep its old state: start from none.
    await dbClient.query(`DELETE FROM public.subscriptions WHERE stripe_subscription_id = $1`, [subscriptionId]);
    const inserted = await dbClient.query(
      `INSERT INTO public.subscriptions
         (stripe_subscription_id, user_id, stripe_customer_id, plan_id, status, current_period_end,
          cancel_at_period_end, last_event_created)
       VALUES ($1, $2, $3, $4, 'active', $5, FALSE, NOW())`,
      [subscriptionId, E2E_PAY1B_SUB_UUID, stripeCustomerId, planRows[0]!.id, SUB_PERIOD_END],
    );
    expect(inserted.rowCount).toBe(1);
  });

  test.afterAll(async () => {
    if (dbClient) {
      await dbClient.query(`DELETE FROM public.subscriptions WHERE user_id = $1`, [E2E_PAY1B_SUB_UUID]);
      await dbClient.query(`DELETE FROM public.billing_customers WHERE user_id = $1`, [E2E_PAY1B_SUB_UUID]);
      await dbClient.query(`DELETE FROM auth.users WHERE id = $1`, [E2E_PAY1B_SUB_UUID]);
      dbClient.release();
    }
    if (stripeCustomerId && STRIPE_KEY_AVAILABLE) {
      const deleted = await fetch(`https://api.stripe.com/v1/customers/${stripeCustomerId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${process.env.STRIPE_CHECKOUT_KEY!}` },
      });
      expect(deleted.status).toBe(200);
    }
  });

  test(
    "E2E-PAY1B-10: subscribed state shows plan, price, 'Fornyes <date>' and 'Administrér abonnement'; " +
    "clicking it redirects to billing.stripe.com portal",
    async ({ page }) => {
      test.skip(!E2E_PROJECT || !STRIPE_KEY_AVAILABLE, "Requires e2e project + Stripe TEST key");
      await signIn(page, E2E_PAY1B_SUB_EMAIL, pwd);
      await page.goto(`${MONITOR}/monitor/billing`);
      const main = page.locator("main").first();
      await expect(main.getByText("Monitor Plus", { exact: true })).toBeVisible();
      await expect(main.getByText("95 kr / år", { exact: true })).toBeVisible();
      // SUB_PERIOD_END in Copenhagen time, Danish long date.
      await expect(main.getByText("Fornyes 1. juni 2030", { exact: true })).toBeVisible();
      await expect(main.getByRole("button", { name: "Administrér abonnement" })).toBeVisible();
      await main.getByRole("button", { name: "Administrér abonnement" }).click();
      await page.waitForURL(/billing\.stripe\.com/);
      // API 2026-10-28.endive returns https://billing.stripe.com/p/session?secret=test_… (older: /p/session/test_…).
      expect(page.url()).toMatch(/^https:\/\/billing\.stripe\.com\/p\/session(\/|\?secret=)test_/);
    },
  );
});

// ── Dashboard upgradeLink (E2E-PAY1B-11) ─────────────────────────────────────

test.describe("Dashboard upgradeLink → /monitor/billing", () => {
  test.describe.configure({ mode: "serial" });
  let pwd: string;
  let client: PoolClient;

  test.beforeAll(async () => {
    test.skip(!E2E_PROJECT, "Requires SUPABASE_E2E_REF + DB credentials");
    client = await getClient();
    pwd = randomE2ePassword();
    await insertUser(client, E2E_PAY1B_DASH_UUID, E2E_PAY1B_DASH_EMAIL, "monitor_user", pwd);
  });

  test.afterAll(async () => {
    if (client) {
      await deleteUser(client, E2E_PAY1B_DASH_UUID, E2E_PAY1B_DASH_EMAIL);
      client.release();
    }
  });

  test("E2E-PAY1B-11: dashboard shows 'Opgradér for flere' link with href='/monitor/billing'", async ({ page }) => {
    test.skip(!E2E_PROJECT, "Requires SUPABASE_E2E_REF + DB credentials");
    await signIn(page, E2E_PAY1B_DASH_EMAIL, pwd);
    await page.goto(`${MONITOR}/monitor/dashboard`);
    const link = page.locator("main").first().getByRole("link", { name: "Opgradér for flere" });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "/monitor/billing");
  });
});

// ── Abonnement nav tab aria-current (E2E-PAY1B-12) ───────────────────────────

test.describe("Abonnement nav tab aria-current on billing section", () => {
  test.describe.configure({ mode: "serial" });
  let pwd: string;
  let client: PoolClient;

  test.beforeAll(async () => {
    test.skip(!E2E_PROJECT, "Requires SUPABASE_E2E_REF + DB credentials");
    client = await getClient();
    pwd = randomE2ePassword();
    await insertUser(client, E2E_PAY1B_NAV_UUID, E2E_PAY1B_NAV_EMAIL, "monitor_user", pwd);
  });

  test.afterAll(async () => {
    if (client) {
      await deleteUser(client, E2E_PAY1B_NAV_UUID, E2E_PAY1B_NAV_EMAIL);
      client.release();
    }
  });

  test("E2E-PAY1B-12: 'Abonnement' link in panel nav has aria-current='page' on /monitor/billing", async ({ page }) => {
    test.skip(!E2E_PROJECT, "Requires SUPABASE_E2E_REF + DB credentials");
    await signIn(page, E2E_PAY1B_NAV_EMAIL, pwd);
    await page.goto(`${MONITOR}/monitor/billing`);
    const billingLink = page
      .getByRole("navigation", { name: "Monitor" })
      .getByRole("link", { name: "Abonnement" });
    await expect(billingLink).toHaveAttribute("aria-current", "page");
  });
});

// ── CSP form-action header (E2E-PAY1B-13) ────────────────────────────────────
// Amendment B13: only the billing page's CSP adds Stripe's Checkout and Billing Portal to
// form-action (its Server Actions answer the form POST with a redirect there); every other
// page keeps form-action 'self'.

const SELF_FORM_ACTION = "form-action 'self'";
const BILLING_FORM_ACTION = "form-action 'self' https://checkout.stripe.com https://billing.stripe.com";

/** The form-action directive of a response's Content-Security-Policy header. */
function formActionOf(headers: Record<string, string>): string | undefined {
  return (headers["content-security-policy"] ?? "")
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith("form-action"));
}

// No DB: the header rules answer every request for these paths, the middleware's sign-in
// redirect included, so each path's first response — the redirect itself where the
// middleware redirects, not the page it leads to — is checked. It is read through the browser
// with `firstResponse`, which reads the first hop back after the browser follows any redirect,
// because Node cannot resolve `monitor.localhost` on every OS. Each test's fresh browser
// context carries no session.
test.describe("CSP form-action header per Monitor path (no session)", () => {
  for (const [path, expected] of [
    ["/monitor/billing", BILLING_FORM_ACTION],
    ["/billing", BILLING_FORM_ACTION],
    ["/monitor/dashboard", SELF_FORM_ACTION],
    ["/dashboard", SELF_FORM_ACTION],
    ["/", SELF_FORM_ACTION],
  ] as const) {
    test(`E2E-PAY1B-13a: ${MONITOR}${path} answers with "${expected}"`, async ({ page }) => {
      const response = await firstResponse(page, `${MONITOR}${path}`);
      expect(formActionOf(await response.allHeaders())).toBe(expected);
    });
  }
});

test.describe("CSP form-action on the signed-in billing page and dashboard", () => {
  test.describe.configure({ mode: "serial" });
  let pwd: string;
  let client: PoolClient;

  test.beforeAll(async () => {
    test.skip(!E2E_PROJECT, "Requires SUPABASE_E2E_REF + DB credentials");
    client = await getClient();
    pwd = randomE2ePassword();
    await insertUser(client, E2E_PAY1B_CSP_UUID, E2E_PAY1B_CSP_EMAIL, "monitor_user", pwd);
  });

  test.afterAll(async () => {
    if (client) {
      await deleteUser(client, E2E_PAY1B_CSP_UUID, E2E_PAY1B_CSP_EMAIL);
      client.release();
    }
  });

  test(
    "E2E-PAY1B-13b: the billing page document (/monitor/billing and /billing) carries the Stripe " +
      "form-action; the dashboard document form-action 'self'",
    async ({ page }) => {
      test.skip(!E2E_PROJECT, "Requires SUPABASE_E2E_REF + DB credentials");
      await signIn(page, E2E_PAY1B_CSP_EMAIL, pwd);
      for (const path of ["/monitor/billing", "/billing"]) {
        const response = await page.goto(`${MONITOR}${path}`);
        expect(response?.status()).toBe(200);
        await expect(page.locator("main").first().getByRole("heading", { level: 1 })).toHaveText("Abonnement");
        expect(formActionOf(response?.headers() ?? {})).toBe(BILLING_FORM_ACTION);
      }
      const dashboard = await page.goto(`${MONITOR}/monitor/dashboard`);
      expect(dashboard?.status()).toBe(200);
      expect(formActionOf(dashboard?.headers() ?? {})).toBe(SELF_FORM_ACTION);
    },
  );
});

// ── App-bar tab row at 320×568 (E2E-PAY1B-14, PAY1B-AC51) ────────────────────
// Design review D-4: below 360px the bar's inset drops to 12px and the tab gaps to 8px, so the
// three tabs share one row at 320px (DESIGN.md, the Monitor app-bar exception). The settings
// page is the widest Danish row (Indstillinger current, in semibold). Checks measure against
// the layout viewport, `document.documentElement.clientWidth`/`clientHeight`, which exclude a
// scrollbar (`window.innerWidth`/`innerHeight` include it). Playwright's headless Chromium hides
// scrollbars, so the layout viewport is the full 320px window; the test asserts that width.

/** The panel tabs in order, per UI language (messages `Monitor.shell`). */
const TAB_LABELS = {
  da: ["Overvågninger", "Indstillinger", "Abonnement"],
  en: ["Monitors", "Settings", "Subscription"],
} as const;

/** Presses Tab until `target` has the focus, as a keyboard user reaches it; fails after `maxPresses`. */
async function tabTo(page: Page, target: Locator, name: string, maxPresses = 20): Promise<void> {
  for (let press = 0; press < maxPresses; press += 1) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((el) => el === document.activeElement)) return;
  }
  throw new Error(`Tab did not reach "${name}" within ${maxPresses} presses`);
}

test.describe("App-bar tab row at 320×568 on the billing and settings pages", () => {
  test.describe.configure({ mode: "serial" });
  let pwd: string;
  let client: PoolClient;

  test.beforeAll(async () => {
    test.skip(!E2E_PROJECT, "Requires SUPABASE_E2E_REF + DB credentials");
    client = await getClient();
    pwd = randomE2ePassword();
    await insertUser(client, E2E_PAY1B_ROW_UUID, E2E_PAY1B_ROW_EMAIL, "monitor_user", pwd);
  });

  test.afterAll(async () => {
    if (client) {
      await deleteUser(client, E2E_PAY1B_ROW_UUID, E2E_PAY1B_ROW_EMAIL);
      client.release();
    }
  });

  test(
    "E2E-PAY1B-14: at 320×568 (DA and EN, billing and settings) the three app-bar tabs share one row, " +
      "none clipped, no page overflow, each at least 44px tall and fully in view when Tab-focused",
    async ({ page }) => {
      test.skip(!E2E_PROJECT, "Requires SUPABASE_E2E_REF + DB credentials");
      await page.setViewportSize({ width: 320, height: 568 });
      await signIn(page, E2E_PAY1B_ROW_EMAIL, pwd);

      for (const locale of ["da", "en"] as const) {
        if (locale === "en") {
          await page.context().addCookies([
            { name: "monitor-locale", value: "en", domain: "monitor.localhost", path: "/" },
          ]);
        }
        for (const path of ["/monitor/billing", "/monitor/settings"]) {
          await test.step(`${locale.toUpperCase()} ${path}`, async () => {
            await page.goto(`${MONITOR}${path}`);
            // Measure with Inter, not the swap fallback.
            await page.evaluate(async () => {
              await document.fonts.ready;
            });
            const nav = page.getByRole("navigation", { name: "Monitor" });
            const tabs = nav.getByRole("link");
            await expect(tabs).toHaveText([...TAB_LABELS[locale]]);

            const metrics = await nav.getByRole("list").evaluate((list) => {
              const box = (el: Element) => {
                const { top, right, bottom, left, height } = el.getBoundingClientRect();
                return { top, right, bottom, left, height };
              };
              return {
                list: box(list),
                tabs: [...list.querySelectorAll("a")].map(box),
                pageClientWidth: document.documentElement.clientWidth,
                pageScrollWidth: document.documentElement.scrollWidth,
              };
            });
            expect(metrics.pageClientWidth).toBe(320);
            expect(metrics.tabs).toHaveLength(3);
            const rowTop = metrics.tabs[0]?.top ?? Number.NaN;
            for (const tab of metrics.tabs) {
              // One row: every tab starts on the first tab's line.
              expect(Math.abs(tab.top - rowTop)).toBeLessThan(1);
              // Not clipped by the tab list (a sideways-scrolling row would end inside it) nor the
              // layout viewport.
              expect(tab.left).toBeGreaterThanOrEqual(metrics.list.left);
              expect(tab.right).toBeLessThanOrEqual(metrics.list.right);
              expect(tab.left).toBeGreaterThanOrEqual(0);
              expect(tab.right).toBeLessThanOrEqual(metrics.pageClientWidth);
              expect(tab.height).toBeGreaterThanOrEqual(44);
            }
            expect(metrics.pageScrollWidth).toBeLessThanOrEqual(metrics.pageClientWidth);

            for (const [index, name] of TAB_LABELS[locale].entries()) {
              const tab = tabs.nth(index);
              await tabTo(page, tab, name);
              const focused = await tab.evaluate((el) => {
                const { top, right, bottom, left } = el.getBoundingClientRect();
                const { clientWidth, clientHeight } = document.documentElement;
                return { top, right, bottom, left, clientWidth, clientHeight };
              });
              expect(focused.left).toBeGreaterThanOrEqual(0);
              expect(focused.top).toBeGreaterThanOrEqual(0);
              expect(focused.right).toBeLessThanOrEqual(focused.clientWidth);
              expect(focused.bottom).toBeLessThanOrEqual(focused.clientHeight);
            }
          });
        }
      }
    },
  );
});

// ── 2× text at 320×568 (E2E-PAY1B-15, PAY1B-AC52) ────────────────────────────
// Design review D-5: with the text enlarged 2× at 320px the h1 "Abonnement", the pending card's
// heading and the portal error notice overflowed (one word wider than its line), and the
// unbreakable tag "Spar ~21%" pushed the option rows past the card. The Monitor type and spacing
// tokens are px, so a root `font-size: 200%` changes nothing; text-only enlargement is emulated
// by doubling every element's computed font size and line height once. Then, in one measuring
// call per state: the page has no horizontal overflow (`document.documentElement`, clientWidth =
// the full 320px window, as in E2E-PAY1B-14); every visible (not `.sr-only`) h1, h2, h3, p, alert
// and status has `scrollWidth ≤ clientWidth`; and in the card (`section` or `div[role=status]`)
// every visible text run's glyphs, and every option row and its radio, end at or before the right
// edge of the card's content box. The element and card checks catch a word that overflows its
// line or its card but stays inside the window, which the page overflow alone misses: unwrapped,
// the DA pending card's 2× heading ends at 292, past its card's content box (271) but inside 320.

/** The billing page states with enlarged text: query, the notice it shows, its option rows. */
const ENLARGED_TEXT_STATES = [
  { name: "upgrade", query: "", notice: null, optionRows: 2 },
  { name: "pending", query: "?checkout=done", notice: "status", optionRows: 0 },
  // The free user has no billing customer, so the portal error shows above the upgrade card.
  { name: "portal error", query: "?error=portal", notice: "alert", optionRows: 2 },
] as const;

/** The page's h1 per UI language (messages `Payments.billing.title`). */
const BILLING_TITLE = { da: "Abonnement", en: "Subscription" } as const;

/**
 * Doubles every element's computed font size and line height once (text-only 2× enlargement).
 * Every size is read before any is written, so a doubled parent never feeds a child's read.
 */
async function doubleTextSize(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const sizes = [...document.querySelectorAll<HTMLElement | SVGElement>("body, body *")].map((el) => {
      const { fontSize, lineHeight } = getComputedStyle(el);
      return { el, fontSize: parseFloat(fontSize), lineHeight: lineHeight === "normal" ? null : parseFloat(lineHeight) };
    });
    for (const { el, fontSize, lineHeight } of sizes) {
      el.style.fontSize = `${fontSize * 2}px`;
      if (lineHeight !== null) el.style.lineHeight = `${lineHeight * 2}px`;
    }
    await document.fonts.ready;
  });
}

test.describe("Billing page with 2× text at 320×568", () => {
  test.describe.configure({ mode: "serial" });
  let pwd: string;
  let client: PoolClient;

  test.beforeAll(async () => {
    test.skip(!E2E_PROJECT, "Requires SUPABASE_E2E_REF + DB credentials");
    client = await getClient();
    pwd = randomE2ePassword();
    await insertUser(client, E2E_PAY1B_ZOOM_UUID, E2E_PAY1B_ZOOM_EMAIL, "monitor_user", pwd);
  });

  test.afterAll(async () => {
    if (client) {
      await deleteUser(client, E2E_PAY1B_ZOOM_UUID, E2E_PAY1B_ZOOM_EMAIL);
      client.release();
    }
  });

  test(
    "E2E-PAY1B-15: at 320×568 with 2× text (DA and EN; upgrade, pending, portal error) the page has no " +
      "horizontal overflow, no heading, paragraph or notice is wider than its box, and every text run, " +
      "option row and radio ends inside the card",
    async ({ page }) => {
      test.skip(!E2E_PROJECT, "Requires SUPABASE_E2E_REF + DB credentials");
      await page.setViewportSize({ width: 320, height: 568 });
      await signIn(page, E2E_PAY1B_ZOOM_EMAIL, pwd);

      for (const locale of ["da", "en"] as const) {
        if (locale === "en") {
          await page.context().addCookies([
            { name: "monitor-locale", value: "en", domain: "monitor.localhost", path: "/" },
          ]);
        }
        for (const state of ENLARGED_TEXT_STATES) {
          await test.step(`${locale.toUpperCase()} ${state.name}`, async () => {
            await page.goto(`${MONITOR}/monitor/billing${state.query}`);
            const main = page.locator("main").first();
            const title = main.getByRole("heading", { level: 1 });
            await expect(title).toHaveText(BILLING_TITLE[locale]);
            if (state.notice !== null) await expect(main.getByRole(state.notice)).toBeVisible();
            // Measure with Inter, not the swap fallback.
            await page.evaluate(async () => {
              await document.fonts.ready;
            });

            const titleSize = await title.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
            await doubleTextSize(page);

            const metrics = await main.evaluate((root) => {
              const h1 = root.querySelector("h1");
              if (h1 === null) throw new Error("no h1");
              /** An element's tag and the start of a text, to name it in a failure. */
              const label = (el: Element, text: string | null) =>
                `<${el.localName}> "${(text ?? "").replace(/\s+/g, " ").trim().slice(0, 40)}"`;
              /** The right edge of a box's content box: inside its border and padding. */
              const contentRight = (box: Element) => {
                const style = getComputedStyle(box);
                return box.getBoundingClientRect().right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight);
              };
              return {
                // Read with the layout: a re-render after the doubling would drop the inline sizes.
                titleFontSize: parseFloat(getComputedStyle(h1).fontSize),
                pageClientWidth: document.documentElement.clientWidth,
                pageScrollWidth: document.documentElement.scrollWidth,
                // Every visible heading, paragraph and notice (screen-reader-only text excluded).
                textBoxes: [...root.querySelectorAll("h1, h2, h3, p, [role=alert], [role=status]")]
                  .filter((el) => el.closest(".sr-only") === null && el.getClientRects().length > 0)
                  .map((el) => ({
                    tag: el.localName,
                    label: label(el, el.textContent),
                    scrollWidth: el.scrollWidth,
                    clientWidth: el.clientWidth,
                  })),
                cards: [...root.querySelectorAll("section, div[role=status]")].map((card) => {
                  // Each visible text run's glyphs (its Range rects): an element's own box never grows
                  // with text that overflows it, so the box edges alone would miss the overflow.
                  const texts: { label: string; right: number }[] = [];
                  const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
                  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
                    const parent = node.parentElement;
                    if (parent === null || parent.closest(".sr-only") !== null || !node.textContent?.trim()) continue;
                    const range = document.createRange();
                    range.selectNodeContents(node);
                    if (range.getClientRects().length === 0) continue;
                    texts.push({ label: label(parent, node.textContent), right: range.getBoundingClientRect().right });
                  }
                  return { tag: card.localName, contentRight: contentRight(card), texts };
                }),
                rows: [...root.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map((radio) => {
                  const row = radio.closest("label");
                  const card = radio.closest("section");
                  if (row === null || card === null) throw new Error(`the ${radio.value} radio has no row or card`);
                  return {
                    interval: radio.value,
                    rowRight: row.getBoundingClientRect().right,
                    radioRight: radio.getBoundingClientRect().right,
                    cardContentRight: contentRight(card),
                  };
                }),
              };
            });
            // Non-vacuous: measured with the text at twice its size, on the page and card headings.
            expect(metrics.titleFontSize).toBe(titleSize * 2);
            expect(metrics.textBoxes.map((box) => box.tag)).toContain("h1");
            expect(metrics.textBoxes.map((box) => box.tag)).toContain("h2");
            // One card per state: the upgrade card (section) or the pending card (div role=status).
            expect(metrics.cards).toHaveLength(1);
            for (const card of metrics.cards) expect(card.texts.length, `<${card.tag}> text runs`).toBeGreaterThan(0);
            expect(metrics.pageClientWidth).toBe(320);
            expect(metrics.pageScrollWidth).toBeLessThanOrEqual(metrics.pageClientWidth);
            // Every offender at once (tag + text), whether or not it reaches past the window.
            const offenders = [
              ...metrics.textBoxes
                .filter((box) => box.scrollWidth > box.clientWidth)
                .map((box) => `${box.label}: scrollWidth ${box.scrollWidth} > clientWidth ${box.clientWidth}`),
              ...metrics.cards.flatMap((card) =>
                card.texts
                  .filter((text) => text.right > card.contentRight)
                  .map((text) => `${text.label}: right ${text.right} > <${card.tag}> content right ${card.contentRight}`),
              ),
            ];
            expect(offenders, "text wider than its own box or past its card's content box").toEqual([]);
            expect(metrics.rows).toHaveLength(state.optionRows);
            for (const row of metrics.rows) {
              expect(row.rowRight, `${row.interval} row`).toBeLessThanOrEqual(row.cardContentRight);
              expect(row.radioRight, `${row.interval} radio`).toBeLessThanOrEqual(row.cardContentRight);
            }
          });
        }
      }
    },
  );
});
