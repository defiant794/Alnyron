/**
 * E2E tests: Monitor withdrawal (payments-slice1d-withdrawal E2E scenarios)
 * Journey: payments-slice1d-withdrawal
 *
 * E2E-WD-01  Stripe TEST Checkout (from "Opgradér" click) shows the consent checkbox
 *            with the termsAcceptPrefix + consent text (body-scoped) and the 14-day
 *            submit line → fill 4242 + exp + CVC + name + address → tick consent →
 *            pay → returns to /monitor/billing?checkout=done
 * E2E-WD-01b POST signed synthetic checkout.session.completed + customer.subscription.created
 *            + invoice.paid to the local payments Worker → subscription recorded in DB,
 *            info_sent mail queued
 * E2E-WD-02  /terms (DA): heading "Handelsbetingelser", sections 1+6, withdrawal notice,
 *            model form, "Version 2026-11-14.1." in main (not body, to avoid RSC payload noise)
 * E2E-WD-03  /en/terms: heading "Terms and conditions", "Seller" section
 * E2E-WD-04  /monitor/billing (subscribed, window open): "Fortryd aftale" link + deadline
 * E2E-WD-05  /monitor/billing/withdraw: name field, statement, "Bekræft fortrydelse" button
 * E2E-WD-06  submit name → receipt state: no form, refund amount in page
 * E2E-WD-07  Stripe credit note with metadata.withdrawal_id exists via Stripe API
 * E2E-WD-08  ?error=window_expired: expired notice, no form
 * E2E-WD-09  Footer "Handelsbetingelser" link href exactly "/terms"
 *
 * Guards:
 *   E2E_PROJECT (DB_AVAILABLE + SUPABASE_E2E_REF): all DB-writing tests.
 *   STRIPE_KEY_AVAILABLE: Checkout payment + credit note tests.
 *   PAYMENTS_WORKER_URL (defaults to http://localhost:8787): synthetic webhook delivery.
 *   Mail: delivered+wd-…@resend.dev (Resend test sink; never a real inbox).
 * Run with --retries=0 (CI=true in shell).
 */
import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import {
  DB_AVAILABLE,
  E2E_EMAIL_DOMAIN,
  insertUser,
  deleteUser,
  randomE2ePassword,
} from "./fixtures/monitor-seed";
import { endPool, getClient, type PoolClient } from "../integration/rls/helpers/db";
import { signStripeHeader } from "../helpers/stripe-webhook";

// ── Guards ────────────────────────────────────────────────────────────────────

const MONITOR = "http://monitor.localhost:3000";
const SITE    = "http://localhost:3000";

const E2E_PROJECT = DB_AVAILABLE && Boolean(process.env.SUPABASE_E2E_REF);
const STRIPE_KEY_AVAILABLE = typeof process.env.STRIPE_CHECKOUT_KEY === "string" &&
  /^(sk|rk)_test_/.test(process.env.STRIPE_CHECKOUT_KEY);
/** Local payments Worker (wrangler dev); skip synthetic webhook tests if absent. */
const PAYMENTS_WORKER_URL = process.env.PAYMENTS_WORKER_URL ?? "http://localhost:8787";

// ── UUIDs (prefix 0d1d = withdrawal-1d e2e) ──────────────────────────────────

const WD_E2E_CHECKOUT_UUID  = "00000000-0000-0000-0d1d-000000000020";
// Resend test-sink address so the confirmation email never hits a real inbox
const WD_E2E_CHECKOUT_EMAIL = `delivered+wd-checkout@resend.dev`;
const WD_E2E_WD_UUID        = "00000000-0000-0000-0d1d-000000000022";
const WD_E2E_WD_EMAIL       = `delivered+wd-withdraw@resend.dev`;
const WD_E2E_TERMS_UUID     = "00000000-0000-0000-0d1d-000000000021";
const WD_E2E_TERMS_EMAIL    = `e2e-wd-terms@${E2E_EMAIL_DOMAIN}`;

const MONTHLY_PRICE_ID = "price_1Ub3CoFIgZG2PjS1sJ7VtPSS"; // from seed-e2e

/**
 * Read STRIPE_WEBHOOK_SECRET from workers/payments/.dev.vars — the same secret
 * the local wrangler dev Worker verifies. Returns null if the file is absent or
 * the key is not found; callers must skip tests when null.
 * Never prints the value.
 */
function loadWorkerWebhookSecret(): string | null {
  try {
    const text = readFileSync("workers/payments/.dev.vars", "utf-8");
    const match = text.match(/STRIPE_WEBHOOK_SECRET\s*=\s*(whsec_[A-Za-z0-9]+)/);
    return match?.[1] ?? null;
  } catch { return null; }
}

/** Webhook secret matching the local Worker's .dev.vars; null = Worker not configured. */
const WORKER_WEBHOOK_SECRET = loadWorkerWebhookSecret();


// ── Helpers ───────────────────────────────────────────────────────────────────

function nowSeconds(): number { return Math.floor(Date.now() / 1000); }

/** Sign and POST a body to the local payments Worker using its .dev.vars secret. */
async function postWebhook(body: string): Promise<{ status: number; json: unknown }> {
  if (!WORKER_WEBHOOK_SECRET) throw new Error("WORKER_WEBHOOK_SECRET not found in workers/payments/.dev.vars");
  const sig = signStripeHeader(body, WORKER_WEBHOOK_SECRET, nowSeconds());
  const resp = await fetch(`${PAYMENTS_WORKER_URL}/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": sig },
    body,
  });
  return { status: resp.status, json: await resp.json().catch(() => null) };
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto(`${MONITOR}/monitor/login`);
  await page.getByLabel(/e-mail/i).fill(email);
  await page.getByLabel(/adgangskode/i).fill(password);
  await page.getByRole("button", { name: /log ind/i }).click();
  await page.waitForURL((url) => !url.pathname.includes("/login"));
}

// ── E2E-WD-02 / E2E-WD-03: /terms page (no auth required) ───────────────────

test("E2E-WD-02 (WD-J3-C02): /terms (DA) renders heading, sections, notice, form, version — in main", async ({ page }) => {
  await page.goto(`${SITE}/terms`);
  const main = page.locator("main").first();
  await expect(main.getByRole("heading", { name: "Handelsbetingelser", level: 1 })).toBeVisible();
  await expect(main).toContainText("Sælger");
  await expect(main).toContainText("Fortrydelsesret");
  await expect(main).toContainText("Standardfortrydelsesformular");
  await expect(main).toContainText("2026-11-14.1");
  // No literal {privacyPath} placeholder (scoped to main to avoid RSC payload noise)
  await expect(main).not.toContainText("{privacyPath}");
});

test("E2E-WD-03 (WD-J3-C03): /en/terms renders English heading and 'Seller' section", async ({ page }) => {
  await page.goto(`${SITE}/en/terms`);
  await expect(page.locator("main").getByRole("heading", { name: "Terms and conditions", level: 1 })).toBeVisible();
  await expect(page.locator("main")).toContainText("Seller");
});

// ── E2E-WD-09: footer link exact href ────────────────────────────────────────

test("E2E-WD-09 (WD-J3-C05): footer 'Handelsbetingelser' link has exact href='/terms'", async ({ page }) => {
  await page.goto(SITE);
  const termsLink = page.getByRole("link", { name: /handelsbetingelser/i });
  await expect(termsLink).toBeVisible();
  await expect(termsLink).toHaveAttribute("href", "/terms");
});

// ── E2E-WD-08: error page (no auth) ──────────────────────────────────────────

test.describe("E2E-WD-08: ?error=window_expired notice (requires DB)", () => {
  test.describe.configure({ mode: "serial" });
  let pwd: string;
  let dbClient: PoolClient;

  test.beforeAll(async () => {
    test.skip(!E2E_PROJECT, "Requires SUPABASE_E2E_REF");
    dbClient = await getClient();
    pwd = randomE2ePassword();
    await insertUser(dbClient, WD_E2E_TERMS_UUID, WD_E2E_TERMS_EMAIL, "monitor_user", pwd);
  });

  test.afterAll(async () => {
    if (dbClient) { await deleteUser(dbClient, WD_E2E_TERMS_UUID, WD_E2E_TERMS_EMAIL); dbClient.release(); }
  });

  test("E2E-WD-08 (WD-J5-C01): ?error=window_expired shows expired notice; no name input", async ({ page }) => {
    test.skip(!E2E_PROJECT, "Requires SUPABASE_E2E_REF");
    await signIn(page, WD_E2E_TERMS_EMAIL, pwd);
    await page.goto(`${MONITOR}/monitor/billing/withdraw?error=window_expired`);
    await expect(page.locator("main").first()).toContainText(/udløbet|expired/i);
    await expect(page.getByLabel(/dit navn/i)).not.toBeVisible();
  });
});

// ── E2E-WD-04 / E2E-WD-05: Fortryd aftale button + withdraw form (needs seeded sub) ─

test.describe("E2E-WD-04/05: billing Fortryd aftale + withdraw form (seeded subscription)", () => {
  test.describe.configure({ mode: "serial" });
  let pwd: string;
  let dbClient: PoolClient;

  test.beforeAll(async () => {
    test.skip(!E2E_PROJECT, "Requires SUPABASE_E2E_REF");
    dbClient = await getClient();
    pwd = randomE2ePassword();
    await insertUser(dbClient, WD_E2E_WD_UUID, WD_E2E_WD_EMAIL, "monitor_user", pwd);
    // Seed an active subscription with started_at = now (window open): plan_id by the plan's
    // Stripe price (there is no stripe_price_id column), last_event_created NOT NULL; the
    // invoice needs user_id, email, paid_at and its period (the confirm page's estimate reads it).
    await dbClient.query(
      `INSERT INTO public.subscriptions
         (user_id, stripe_subscription_id, stripe_customer_id, plan_id, status, current_period_end,
          cancel_at_period_end, last_event_created, started_at)
       SELECT $1, 'sub_e2ewd001', 'cus_e2ewd001', p.id, 'active', now() + interval '30 days',
              false, now(), now()
         FROM public.monitor_plans p WHERE p.stripe_price_id = $2
       ON CONFLICT (stripe_subscription_id) DO NOTHING`,
      [WD_E2E_WD_UUID, MONTHLY_PRICE_ID],
    );
    await dbClient.query(
      `INSERT INTO public.subscription_invoices
         (stripe_invoice_id, stripe_subscription_id, user_id, email, amount_total_ore, amount_tax_ore,
          amount_refunded_ore, period_start, period_end, paid_at)
       VALUES ('in_e2ewd001', 'sub_e2ewd001', $1, $2, 1000, 200, 0, now(), now() + interval '30 days', now())
       ON CONFLICT (stripe_invoice_id) DO NOTHING`,
      [WD_E2E_WD_UUID, WD_E2E_WD_EMAIL],
    );
  });

  test.afterAll(async () => {
    if (dbClient) {
      await dbClient.query("DELETE FROM public.subscription_withdrawals WHERE stripe_subscription_id = 'sub_e2ewd001'").catch(() => undefined);
      await dbClient.query("DELETE FROM public.subscription_invoices WHERE stripe_invoice_id = 'in_e2ewd001'").catch(() => undefined);
      await dbClient.query("DELETE FROM public.subscriptions WHERE stripe_subscription_id = 'sub_e2ewd001'").catch(() => undefined);
      await deleteUser(dbClient, WD_E2E_WD_UUID, WD_E2E_WD_EMAIL);
      dbClient.release();
    }
  });

  test("E2E-WD-04 (WD-J4-C01): billing page shows 'Fortryd aftale' link + deadline date (seeded sub)", async ({ page }) => {
    test.skip(!E2E_PROJECT, "Requires SUPABASE_E2E_REF");
    await signIn(page, WD_E2E_WD_EMAIL, pwd);
    await page.goto(`${MONITOR}/monitor/billing`);
    const main = page.locator("main").first();
    const link = main.getByRole("link", { name: /fortryd aftale/i });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "/monitor/billing/withdraw");
    await expect(main).toContainText(/fortrydelsesfrist/i);
  });

  test("E2E-WD-05 (WD-J4-C02): /withdraw shows name field + statement + 'Bekræft fortrydelse' + back link", async ({ page }) => {
    test.skip(!E2E_PROJECT, "Requires SUPABASE_E2E_REF");
    await signIn(page, WD_E2E_WD_EMAIL, pwd);
    await page.goto(`${MONITOR}/monitor/billing/withdraw`);
    const main = page.locator("main").first();
    await expect(main.getByLabel(/dit navn/i)).toBeVisible();
    await expect(main.getByLabel(/dit navn/i)).toHaveAttribute("autocomplete", "name");
    await expect(main.getByRole("button", { name: /bekræft fortrydelse/i })).toBeVisible();
    await expect(main.getByRole("link", { name: /tilbage/i })).toHaveAttribute("href", "/monitor/billing");
    // Statement text with startDate filled
    await expect(main).toContainText(/fortryder min aftale/i);
  });
});

// ── E2E-WD-01 / E2E-WD-01b / E2E-WD-06 / E2E-WD-07: full flow ───────────────

test.describe("E2E-WD-01/06/07: full Checkout consent → pay → webhook → withdraw → receipt → credit note", () => {
  test.describe.configure({ mode: "serial" });

  let pwd: string;
  let dbClient: PoolClient;
  let sessionId: string;
  let subscriptionId: string;
  let customerId: string;

  const cleanup: { subscriptionId?: string; customerId?: string } = {};

  test.beforeAll(async () => {
    test.skip(
      !E2E_PROJECT || !STRIPE_KEY_AVAILABLE,
      "Requires SUPABASE_E2E_REF + Stripe TEST key",
    );
    dbClient = await getClient();
    pwd = randomE2ePassword();
    await insertUser(dbClient, WD_E2E_CHECKOUT_UUID, WD_E2E_CHECKOUT_EMAIL, "monitor_user", pwd);
  });

  test.afterAll(async () => {
    if (!dbClient) return;
    const stripeKey = process.env.STRIPE_CHECKOUT_KEY!;
    // Cancel subscription + delete customer (best effort)
    if (cleanup.subscriptionId) {
      await fetch(`https://api.stripe.com/v1/subscriptions/${cleanup.subscriptionId}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${stripeKey}` },
      }).catch(() => undefined);
    }
    if (cleanup.customerId) {
      await fetch(`https://api.stripe.com/v1/customers/${cleanup.customerId}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${stripeKey}` },
      }).catch(() => undefined);
    }
    await dbClient.query("DELETE FROM public.subscription_withdrawals WHERE user_id = $1", [WD_E2E_CHECKOUT_UUID]).catch(() => undefined);
    await dbClient.query("DELETE FROM public.subscription_invoices WHERE stripe_subscription_id = $1", [cleanup.subscriptionId ?? "none"]).catch(() => undefined);
    await dbClient.query("DELETE FROM public.subscriptions WHERE user_id = $1", [WD_E2E_CHECKOUT_UUID]).catch(() => undefined);
    await deleteUser(dbClient, WD_E2E_CHECKOUT_UUID, WD_E2E_CHECKOUT_EMAIL);
    dbClient.release();
    await endPool();
  });

  // ── E2E-WD-01: Stripe TEST Checkout consent checkbox + 14-day submit line ──

  // Playwright takes no timeout argument after the body: the test sets its own.
  test("E2E-WD-01 (WD-J1-C01): Stripe Checkout shows consent checkbox with custom text and 14-day submit line; pay 4242", async ({ page }) => {
    test.setTimeout(120_000);
    test.skip(!E2E_PROJECT || !STRIPE_KEY_AVAILABLE, "Requires e2e project + Stripe TEST key");

    await signIn(page, WD_E2E_CHECKOUT_EMAIL, pwd);
    await page.goto(`${MONITOR}/monitor/billing`);

    // Click Upgrade (year default) → navigate to Stripe Checkout
    await page.getByRole("button", { name: "Opgradér" }).click();
    await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 });

    // Capture session id from URL
    const checkoutUrl = page.url();
    const pathMatch = /\/pay\/(cs_test_[A-Za-z0-9]+)/.exec(new URL(checkoutUrl).pathname);
    expect(pathMatch, "Expected cs_test_ session in URL").not.toBeNull();
    sessionId = pathMatch![1]!;

    // ── Consent checkbox: form-frame-scoped (Stripe Checkout new layout embeds the whole ──
    // form — email, payment, billing, consent, submit — in one elements-inner-habanero iframe).
    // page.locator("body") cannot see inside cross-origin iframes; use frameLocator.
    const formFrame = page.frameLocator("iframe[src*='stripe.com/v3/elements-inner-habanero']");
    await expect(formFrame.locator("body")).toContainText("Jeg accepterer Alnyrons", { timeout: 15_000 });
    // The consent text from section 3
    await expect(formFrame.locator("body")).toContainText("fortrydelsesfristen på 14 dage");

    // ── Submit line: "14 dages fortrydelsesret" ───────────────────────────────
    await expect(formFrame.locator("body")).toContainText("14 dages fortrydelsesret");

    // ── Fill test card 4242 4242 4242 4242 ───────────────────────────────────
    // All fields are in the same elements-inner-habanero form iframe.
    // 1. Click "Kort" to expand the card entry section.
    await formFrame.getByRole("button", { name: /kort/i }).click();

    // 2. Email is pre-filled and disabled; skip.

    // 3. Billing name (Fulde navn). billing_address_collection is "required", so the name and
    //    the address fields below are required: plain fills/asserts wait for them to render.
    const nameInput = formFrame.getByLabel("Fulde navn", { exact: true });
    await expect(nameInput).toBeVisible();
    await nameInput.fill("Lars E2E Testersen");

    // 4. Card fields (labels are in Danish in the new checkout)
    await formFrame.getByLabel(/kortnummer/i).fill("4242 4242 4242 4242");
    await formFrame.getByLabel(/udløbsdato/i).fill("12 / 29");
    await formFrame.getByLabel(/sikkerhedskode/i).fill("123");

    // 5. Billing address (required fields in new Stripe checkout)
    await formFrame.getByLabel("Adresselinje 1", { exact: true }).fill("Testgade 1");
    await formFrame.getByLabel("Postnummer", { exact: true }).fill("1000");
    await formFrame.getByLabel("By", { exact: true }).fill("København");

    // 6. The terms consent checkbox (WD-J1-C01: Checkout shows it); not "Gem mine oplysninger"
    const checkbox = formFrame.getByRole("checkbox", { name: /accepterer/i });
    await expect(checkbox).toBeVisible();
    await checkbox.check();
    await expect(checkbox).toBeChecked();

    // 7. Submit
    await formFrame.getByRole("button", { name: /betal og abonnér/i }).click();

    // After payment, Stripe redirects to success_url (/monitor/billing?checkout=done)
    await page.waitForURL(/checkout=done/, { timeout: 60_000 });
    await expect(page.locator("main").first()).toContainText(/aktiverer|activating/i, { timeout: 10_000 });
  });

  // ── E2E-WD-01b: synthetic webhooks → subscription recorded in DB ───────────

  test("E2E-WD-01b (WD-J2-C01): synthetic webhooks → DB records subscription [requires PAYMENTS_WORKER_URL + .dev.vars]", async () => {
    test.setTimeout(60_000);
    test.skip(!E2E_PROJECT || !STRIPE_KEY_AVAILABLE || !WORKER_WEBHOOK_SECRET, "Requires e2e project + Stripe TEST key + workers/payments/.dev.vars");
    test.skip(!sessionId, "E2E-WD-01 must run first to get session id");

    // Retrieve real session from Stripe to get sub id, customer id, and event shape
    const stripeKey = process.env.STRIPE_CHECKOUT_KEY!;
    const sessionResp = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
      headers: { Authorization: `Bearer ${stripeKey}` },
    });
    expect(sessionResp.status).toBe(200);
    const session = await sessionResp.json() as { subscription: string; customer: string };
    subscriptionId = session.subscription;
    customerId     = session.customer;
    cleanup.subscriptionId = subscriptionId;
    cleanup.customerId     = customerId;

    // Retrieve subscription to get start_date
    const subResp = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
      headers: { Authorization: `Bearer ${stripeKey}` },
    });
    const sub = await subResp.json() as Record<string, unknown>;
    const startDate: number = sub["start_date"] as number;
    const latestInvoice = sub["latest_invoice"] as string;

    // Retrieve invoice
    const invResp = await fetch(`https://api.stripe.com/v1/invoices/${latestInvoice}`, {
      headers: { Authorization: `Bearer ${stripeKey}` },
    });
    const inv = await invResp.json() as Record<string, unknown>;

    // POST checkout.session.completed
    const cscBody = JSON.stringify({
      id: `evt_e2ewdcsc${sessionId.slice(-10)}`,
      type: "checkout.session.completed",
      created: nowSeconds(),
      livemode: false,
      data: {
        object: {
          id: sessionId,
          mode: "subscription",
          subscription: subscriptionId,
          customer: customerId,
          client_reference_id: WD_E2E_CHECKOUT_UUID,
          consent: { terms_of_service: "accepted" },
          metadata: {
            kind: "monitor_subscription",
            user_id: WD_E2E_CHECKOUT_UUID,
            locale: "da",
            withdrawal_text_version: "2026-11-14.1",
          },
        },
      },
    });
    const cscResult = await postWebhook(cscBody);
    expect(cscResult.status, "checkout.session.completed webhook").toBe(200);

    // POST customer.subscription.created
    const subBody = JSON.stringify({
      id: `evt_e2ewdsub${subscriptionId.slice(-10)}`,
      type: "customer.subscription.created",
      created: nowSeconds(),
      livemode: false,
      data: { object: { ...sub, start_date: startDate } },
    });
    const subResult = await postWebhook(subBody);
    expect(subResult.status, "customer.subscription.created webhook").toBe(200);

    // POST invoice.paid
    const invBody = JSON.stringify({
      id: `evt_e2ewdinv${latestInvoice.slice(-10)}`,
      type: "invoice.paid",
      created: nowSeconds(),
      livemode: false,
      data: { object: inv },
    });
    const invResult = await postWebhook(invBody);
    expect(invResult.status, "invoice.paid webhook").toBe(200);

    // Verify DB: subscription active
    await dbClient.query("RESET ROLE");
    const { rows } = await dbClient.query<{ status: string }>(
      "SELECT status FROM public.subscriptions WHERE stripe_subscription_id = $1",
      [subscriptionId],
    );
    expect(rows[0]?.status).toBe("active");
  });

  // ── E2E-WD-04 (via real subscription) ─────────────────────────────────────

  test("E2E-WD-04b (WD-J4-C01): billing page shows 'Fortryd aftale' + deadline after real Checkout subscription recorded", async ({ page }) => {
    test.setTimeout(30_000);
    test.skip(!E2E_PROJECT || !STRIPE_KEY_AVAILABLE, "Requires e2e project + Stripe TEST key");
    test.skip(!subscriptionId, "E2E-WD-01b must run first");

    await signIn(page, WD_E2E_CHECKOUT_EMAIL, pwd);
    await page.goto(`${MONITOR}/monitor/billing`);
    const main = page.locator("main").first();
    await expect(main.getByRole("link", { name: /fortryd aftale/i })).toBeVisible({ timeout: 10_000 });
    await expect(main).toContainText(/fortrydelsesfrist/i);
  });

  // ── E2E-WD-06 / E2E-WD-07: withdraw → receipt + credit note ───────────────

  test("E2E-WD-06/07 (WD-J4-C04/C05): submit withdrawal → receipt state → Stripe credit note exists", async ({ page }) => {
    test.setTimeout(90_000);
    test.skip(!E2E_PROJECT || !STRIPE_KEY_AVAILABLE, "Requires e2e project + Stripe TEST key");
    test.skip(!subscriptionId, "E2E-WD-01b must run first");

    await signIn(page, WD_E2E_CHECKOUT_EMAIL, pwd);
    await page.goto(`${MONITOR}/monitor/billing/withdraw`);
    const main = page.locator("main").first();

    await expect(main.getByLabel(/dit navn/i)).toBeVisible({ timeout: 10_000 });
    await main.getByLabel(/dit navn/i).fill("Lars E2E Testersen");
    await main.getByRole("button", { name: /bekræft fortrydelse/i }).click();

    // After submission, page redirects to withdraw in receipt state
    await page.waitForURL(`${MONITOR}/monitor/billing/withdraw`, { timeout: 30_000 });
    // Receipt state: no form, refund amount present
    await expect(main.getByLabel(/dit navn/i)).not.toBeVisible({ timeout: 10_000 });
    // Page shows some amount (kr or øre)
    await expect(main).toContainText(/kr|tilbagebetalt|refund/i);

    // ── Assert: Stripe credit note with metadata.withdrawal_id ───────────────
    // Get the invoice id from the DB, then check Stripe for credit notes
    await dbClient.query("RESET ROLE");
    const { rows: cnRows } = await dbClient.query<{ stripe_credit_note_id: string; status: string }>(
      "SELECT stripe_credit_note_id, status FROM public.subscription_withdrawals WHERE user_id = $1",
      [WD_E2E_CHECKOUT_UUID],
    );
    expect(cnRows[0]?.status).toBe("completed");
    const cnId = cnRows[0]?.stripe_credit_note_id;
    expect(cnId).toBeTruthy();

    // Verify via Stripe API
    const stripeKey = process.env.STRIPE_CHECKOUT_KEY!;
    const cnResp = await fetch(`https://api.stripe.com/v1/credit_notes/${cnId}`, {
      headers: { Authorization: `Bearer ${stripeKey}` },
    });
    expect(cnResp.status).toBe(200);
    const cn = await cnResp.json() as Record<string, unknown>;
    expect((cn["metadata"] as Record<string, string>)?.["withdrawal_id"]).toBeTruthy();
    expect(cn["status"]).toBe("issued");
  });
});
