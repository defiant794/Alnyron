/**
 * S2 goods checkout + full order lifecycle E2E (amendments A1/A2: the amount
 * is reserved at Checkout and captured at "Markér afsendt").
 *
 * Serial flow:
 *   1. Item page shows 249,95 kr, the reservation fact and Køb (S2-CHK-1, S2-LEGAL-9)
 *   2. CSP form-action: item page "'self' https://checkout.stripe.com", admin without Stripe (S2-CSP-1, S2-CSP-3)
 *   3. Køb → Stripe TEST Checkout (DK only, phone, ToS consent, reservation submit line) → pay 4242
 *      → /order/thanks with the reservation sentence; the PaymentIntent is requires_capture (S2-CHK-4, S2-CAP-1)
 *      → signed replay of the real checkout.session.completed to the local payments Worker → order
 *      Reserveret in admin (S2-WH-1) → "Markér afsendt og træk betalingen" → PI captured → Afsendt
 *      (S2-ADM-1, S2-CAP-13) → withdrawal via the personal link (S2-WD-7) → approve "returned" with a
 *      49,95 kr deduction → Stripe refund of 20000 øre on the PI → Refunderet (S2-ADM-7, S2-ADM-14)
 *   4. A second order withdrawn before dispatch (order number + email) → approve "ikke afsendt"
 *      (no deduction field) → PI canceled → Annulleret (S2-CAP-4, S2-ADM-16)
 *   5. Refusals: wrong link token, wrong email → one generic refusal (S2-WD-3, S2-WD-4)
 *
 * Gates (never a silent pass: each test skips with the missing prerequisite named):
 *   E2E_PROJECT:     DB credentials + SUPABASE_E2E_REF.
 *   STRIPE_TEST_KEY: STRIPE_PAYMENTS_KEY test-mode key (environment or workers/payments/.dev.vars).
 *   WORKER secrets:  STRIPE_WEBHOOK_SECRET + ORDER_LINK_SECRET in workers/payments/.dev.vars, the
 *                    payments Worker running at PAYMENTS_WORKER_URL and bound to the app as ORDERS.
 */

import { expect, test, type FrameLocator, type Locator, type Page } from "@playwright/test";
import { orderLinkToken } from "@/lib/payments/orders/link-token";
import { loginAs } from "./fixtures/admin-login";
import {
  DB_AVAILABLE,
  S2_PASSWORD,
  S2_PRICE_ORE,
  STRIPE_TEST_KEY,
  cleanupS2,
  createAuthorizedPaymentIntent,
  endPool,
  getClient,
  newEventId,
  newS2Scope,
  postSignedEvent,
  seedAdmin,
  seedAuthorizedOrder,
  seedGoodsItem,
  stripeRequest,
  workerDevVar,
  type S2Scope,
  type StripePaymentIntent,
} from "./fixtures/payments-s2-seed";

const E2E_PROJECT = DB_AVAILABLE && Boolean(process.env.SUPABASE_E2E_REF);
const WEBHOOK_SECRET = workerDevVar("STRIPE_WEBHOOK_SECRET");
const LINK_SECRET = workerDevVar("ORDER_LINK_SECRET");
const WORKER_AVAILABLE = WEBHOOK_SECRET !== null && LINK_SECRET !== null;

/** The payments Worker's HTTPS-only SITE_URL; intercept its order returns before they reach production. */
const CHECKOUT_SITE_ORIGIN = "https://alnyron.dk";

/** A2-1: the method-neutral reservation sentence on the item page, in Checkout, on /order/thanks. */
const RESERVATION = "Beløbet reserveres ved bestillingen og trækkes først, når varen sendes.";

const scope: S2Scope = newS2Scope("chk", "s2-chk-3d", "s2-chk-drage");
const BUYER_EMAIL = scope.buyerEmail(1);
const RELEASE_EMAIL = scope.buyerEmail(2);

/** Public item URL uses the EN slug (URL_SLUG_LOCALE = "en"). */
const ITEM_PATH = `/${scope.sectionSlug}/${scope.itemSlug}`;

interface StripeSession {
  id: string;
  status: string;
  payment_status: string;
  invoice: string | null;
  payment_intent: string | null;
  metadata?: Record<string, string>;
  shipping_address_collection?: { allowed_countries: string[] } | null;
  phone_number_collection?: { enabled: boolean } | null;
  consent_collection?: { terms_of_service?: string | null } | null;
}

interface StripeRefund {
  id: string;
  amount: number;
  status: string;
  metadata?: Record<string, string>;
}

let itemId: string | null = null;

test.describe.configure({ mode: "serial" });

/** The form-action directive of a response's CSP. */
function formAction(csp: string): string | undefined {
  return csp
    .split(";")
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith("form-action"));
}

/** The admin page of order `orderNumber`, signed in. */
async function openOrder(page: Page, orderNumber: number): Promise<void> {
  await loginAs(page, scope.adminEmail, S2_PASSWORD, `/admin/orders/${orderNumber}`);
  await expect(page.getByRole("main").getByRole("heading", { level: 1, name: `Ordre #${orderNumber}` })).toBeVisible();
}

/** The order's status and withdrawal straight from the DB. */
async function orderState(orderNumber: number): Promise<{ status: string; cancel_reason: string | null; amount_refunded_ore: number; w_status: string | null }> {
  const client = await getClient();
  try {
    const { rows } = await client.query<{ status: string; cancel_reason: string | null; amount_refunded_ore: string; w_status: string | null }>(
      `SELECT o.status, o.cancel_reason, o.amount_refunded_ore::text, w.status AS w_status
         FROM public.orders o LEFT JOIN public.order_withdrawals w ON w.order_id = o.id
        WHERE o.order_number = $1`,
      [orderNumber],
    );
    const row = rows[0];
    if (!row) throw new Error(`order ${orderNumber} not found`);
    return { ...row, amount_refunded_ore: Number(row.amount_refunded_ore) };
  } finally {
    client.release();
  }
}

/** Which of the order's emails are stamped as sent (S2-DOC-1..4, S2-WD-7), straight from the DB. */
async function mailStamps(orderNumber: number): Promise<Record<string, boolean>> {
  const client = await getClient();
  try {
    const { rows } = await client.query<Record<string, boolean>>(
      `SELECT o.confirmation_sent_at IS NOT NULL AS confirmation,
              o.owner_notified_at IS NOT NULL AS owner,
              o.shipped_email_sent_at IS NOT NULL AS shipped,
              w.ack_sent_at IS NOT NULL AS ack,
              w.owner_alerted_at IS NOT NULL AS owner_alert,
              w.receipt_sent_at IS NOT NULL AS receipt
         FROM public.orders o LEFT JOIN public.order_withdrawals w ON w.order_id = o.id
        WHERE o.order_number = $1`,
      [orderNumber],
    );
    const row = rows[0];
    if (!row) throw new Error(`order ${orderNumber} not found`);
    return row;
  } finally {
    client.release();
  }
}

/** Fills Stripe's hosted Checkout (all fields live in the one elements form iframe) and pays with 4242. */
async function payWithTestCard(form: FrameLocator): Promise<void> {
  await form.getByLabel("E-mail", { exact: true }).fill(BUYER_EMAIL);
  await form.getByLabel("Fulde navn", { exact: true }).fill("E2E Køber");
  await form.getByLabel("Adresselinje 1", { exact: true }).fill("Testvej 1");
  await form.getByLabel("Postnummer", { exact: true }).fill("7860");
  await form.getByLabel("By", { exact: true }).fill("Spøttrup");
  await form.getByRole("combobox", { name: "Land eller område for telefonnummer", exact: true }).selectOption("DK");
  const phone = form.getByRole("textbox", { name: "Telefonnummer", exact: true });
  await phone.fill("23456789");
  await phone.press("Tab");
  await expect(phone).toHaveAttribute("aria-invalid", "false");
  await form.getByRole("button", { name: "Kort", exact: true }).click();
  await form.getByRole("textbox", { name: "Kortnummer", exact: true }).fill("4242 4242 4242 4242");
  await form.getByRole("textbox", { name: "Udløbsdato (MM/ÅÅ)", exact: true }).fill("12 / 34");
  await form.getByRole("textbox", { name: "Sikkerhedskode", exact: true }).fill("123");
  const consent = form.getByRole("checkbox", {
    name: "Jeg accepterer Alnyrons handelsbetingelser for køb af varer, herunder 14 dages fortrydelsesret, hvor jeg selv betaler returfragten.",
    exact: true,
  });
  await consent.focus();
  await consent.press("Space");
  await expect(consent).toBeChecked();
  const submit = form.getByRole("button", { name: "Betal", exact: true });
  await submit.focus();
  await submit.press("Enter");
}

/** Sends a withdrawal on /order/withdraw through both steps (`fill` enters step 1's fields). */
async function withdraw(page: Page, url: string, fill: (main: Locator) => Promise<void>): Promise<void> {
  await page.goto(url);
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { level: 1, name: "Fortryd aftale" })).toBeVisible();
  await fill(main);
  await main.getByRole("button", { name: "Fortryd aftale her" }).click();
  await main.getByRole("button", { name: "Bekræft fortrydelse" }).click();
}

test.describe("S2 goods checkout and order lifecycle", () => {
  test.skip(!E2E_PROJECT, "Requires SUPABASE_E2E_REF (e2e project credentials)");

  test.beforeAll(async () => {
    const client = await getClient();
    try {
      await cleanupS2(client, scope);
      await seedAdmin(client, scope, S2_PASSWORD);
      itemId = await seedGoodsItem(client, scope);
    } finally {
      client.release();
    }
  });

  test.afterAll(async () => {
    const client = await getClient();
    try {
      await cleanupS2(client, scope);
    } finally {
      client.release();
      await endPool();
    }
  });

  test("S2-CHK-1: item page shows '249,95 kr.', the reservation fact and a 'Køb' button", async ({ page }) => {
    const res = await page.goto(ITEM_PATH);
    expect(res?.status()).toBe(200);
    const main = page.getByRole("main");
    await expect(main.getByText("249,95 kr.", { exact: true })).toBeVisible();
    await expect(main.getByText(RESERVATION)).toBeVisible();
    await expect(main.getByRole("button", { name: "Køb" })).toBeVisible();
  });

  test("S2-CSP-1/S2-CSP-3: item page form-action allows Stripe Checkout; /admin/login does not", async ({ request }) => {
    const item = await request.get(ITEM_PATH);
    expect(formAction(item.headers()["content-security-policy"] ?? "")).toBe(
      "form-action 'self' https://checkout.stripe.com",
    );
    const admin = await request.get("/admin/login");
    expect(formAction(admin.headers()["content-security-policy"] ?? "")).toBe("form-action 'self'");
  });

  test("S2-CHK-2..S2-ADM-14: Køb → Checkout → reserved → shipped (captured) → withdrawn → refunded", async ({ page, baseURL }) => {
    test.skip(STRIPE_TEST_KEY === null, "Requires a test-mode STRIPE_PAYMENTS_KEY");
    test.skip(!WORKER_AVAILABLE, "Requires STRIPE_WEBHOOK_SECRET and ORDER_LINK_SECRET in workers/payments/.dev.vars");
    test.setTimeout(360_000);
    const key = STRIPE_TEST_KEY!;
    if (!baseURL) throw new Error("Requires a local Playwright baseURL");
    expect(["localhost", "127.0.0.1", "[::1]"], "Checkout returns only to the local web app").toContain(new URL(baseURL).hostname);
    await page.route(`${CHECKOUT_SITE_ORIGIN}/order/**`, (route) => {
      const url = new URL(route.request().url());
      return route.fulfill({
        status: 302,
        headers: { location: new URL(url.pathname + url.search, baseURL).toString() },
      });
    });

    // ── Køb → Stripe TEST Checkout ──────────────────────────────────────────
    await page.goto(ITEM_PATH);
    await page.getByRole("button", { name: "Køb" }).click();
    await page.waitForURL(/^https:\/\/checkout\.stripe\.com\//, { timeout: 60_000 });
    const sessionMatch = /(cs_test_[A-Za-z0-9]+)/.exec(new URL(page.url()).pathname);
    expect(sessionMatch, "Checkout URL names a cs_test_ session").not.toBeNull();
    const sessionId = sessionMatch![1]!;

    const created = await stripeRequest<StripeSession>(key, "GET", `checkout/sessions/${sessionId}`);
    expect(created.metadata?.kind).toBe("goods_order");
    expect(created.shipping_address_collection?.allowed_countries).toEqual(["DK"]);
    expect(created.phone_number_collection?.enabled).toBe(true);
    expect(created.consent_collection?.terms_of_service).toBe("required");

    const form = page.frameLocator("iframe[src*='stripe.com/v3/elements-inner-habanero']");
    const formBody = form.locator("body");
    await expect(formBody).toContainText(RESERVATION, { timeout: 20_000 });
    await expect(formBody).not.toContainText("på dit kort");
    await expect(formBody).toContainText("Danmark");
    await payWithTestCard(form);

    // ── /order/thanks ───────────────────────────────────────────────────────
    await expect(page).toHaveURL(new URL("/order/thanks?lang=da", baseURL).toString(), { timeout: 120_000 });
    const thanks = page.getByRole("main");
    await expect(thanks.getByRole("heading", { level: 1, name: "Tak for din bestilling" })).toBeVisible();
    await expect(thanks.getByText(RESERVATION)).toBeVisible();

    // ── Stripe: authorized, nothing charged, no invoice (A1) ────────────────
    const session = await stripeRequest<StripeSession & Record<string, unknown>>(key, "GET", `checkout/sessions/${sessionId}`);
    expect(session.status).toBe("complete");
    expect(session.payment_status).toBe("unpaid");
    expect(session.invoice).toBeNull();
    const paymentIntentId = session.payment_intent;
    expect(paymentIntentId).toMatch(/^pi_/);
    const authorized = await stripeRequest<StripePaymentIntent>(key, "GET", `payment_intents/${paymentIntentId}`);
    expect(authorized.status).toBe("requires_capture");
    expect(authorized.amount_capturable).toBe(S2_PRICE_ORE);
    expect(authorized.amount_received).toBe(0);

    // ── Signed replay of the real checkout.session.completed ────────────────
    const event = {
      id: newEventId(),
      object: "event",
      type: "checkout.session.completed",
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      data: { object: session },
    };
    expect((await postSignedEvent(event, WEBHOOK_SECRET!)).status, "first delivery").toBe(200);
    expect((await postSignedEvent(event, WEBHOOK_SECRET!)).status, "repeated delivery").toBe(200);

    const client = await getClient();
    let orderId: string;
    let orderNumber: number;
    try {
      const { rows } = await client.query<{
        id: string;
        order_number: string;
        status: string;
        stripe_invoice_id: string | null;
        authorization_expires_at: Date | null;
      }>(
        `SELECT id, order_number::text, status, stripe_invoice_id, authorization_expires_at
           FROM public.orders WHERE stripe_checkout_session_id = $1`,
        [sessionId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe("authorized");
      expect(rows[0]!.stripe_invoice_id).toBeNull();
      expect(rows[0]!.authorization_expires_at).not.toBeNull();
      orderId = rows[0]!.id;
      orderNumber = Number(rows[0]!.order_number);
    } finally {
      client.release();
    }
    // The order confirmation (the invoice) to the buyer and the new-order email to the owner (S2-DOC-1).
    await expect
      .poll(async () => mailStamps(orderNumber), { timeout: 30_000 })
      .toMatchObject({ confirmation: true, owner: true });

    // ── Admin list: Reserveret ──────────────────────────────────────────────
    await loginAs(page, scope.adminEmail, S2_PASSWORD, "/admin/orders");
    const list = page.getByRole("main");
    await expect(list.getByRole("heading", { level: 1, name: "Ordrer" })).toBeVisible();
    const row = list.getByRole("row").filter({ has: page.getByRole("link", { name: String(orderNumber), exact: true }) });
    await expect(row.getByText("Reserveret", { exact: true })).toBeVisible();
    await expect(row.getByText(BUYER_EMAIL)).toBeVisible();

    // ── Admin detail + Markér afsendt og træk betalingen ────────────────────
    await openOrder(page, orderNumber);
    const detail = page.getByRole("main");
    await expect(detail.getByText("Køber og levering")).toBeVisible();
    await expect(detail.getByText(BUYER_EMAIL)).toBeVisible();
    await expect(detail.getByText("249,95 kr.").first()).toBeVisible();
    await expect(detail.getByText(/^Betaling reserveret til /)).toBeVisible();
    await detail.getByLabel("Track & trace (valgfri)").fill("00370712345678");
    await detail.getByRole("button", { name: "Markér afsendt og træk betalingen" }).click();
    await expect(
      detail.getByText(`Træk 249,95 kr. og markér ordre #${orderNumber} som afsendt? Det kan ikke fortrydes.`),
    ).toBeVisible();
    await detail.getByRole("button", { name: "Træk 249,95 kr." }).click();
    await expect(detail.getByRole("status")).toContainText("Ordren er markeret som afsendt, og betalingen er trukket.", {
      timeout: 60_000,
    });
    await expect(detail.getByRole("button", { name: /Markér afsendt/ })).toHaveCount(0);
    await expect(detail.locator("header").getByText("Afsendt", { exact: true })).toBeVisible();
    const captured = await stripeRequest<StripePaymentIntent>(key, "GET", `payment_intents/${paymentIntentId}`);
    expect(captured.status).toBe("succeeded");
    expect(captured.amount_received).toBe(S2_PRICE_ORE);
    // The shipped email (S2-DOC-2).
    await expect.poll(async () => (await mailStamps(orderNumber)).shipped, { timeout: 30_000 }).toBe(true);

    // ── Withdrawal via the personal link ────────────────────────────────────
    const token = await orderLinkToken(LINK_SECRET!, orderId);
    await withdraw(page, `/order/withdraw?o=${orderId}&t=${encodeURIComponent(token)}&lang=da`, async (main) => {
      await main.getByLabel("Dit navn").fill("E2E Køber");
    });
    await expect(page.getByRole("main").getByText("Vi har modtaget din fortrydelse")).toBeVisible();
    // The withdrawal receipt to the buyer and the owner's alert (S2-WD-7).
    await expect
      .poll(async () => mailStamps(orderNumber), { timeout: 30_000 })
      .toMatchObject({ ack: true, owner_alert: true });

    // ── Approve "returned" with a 49,95 kr deduction ────────────────────────
    await openOrder(page, orderNumber);
    const refundMain = page.getByRole("main");
    await expect(refundMain.locator("header").getByText("Fortrydelse modtaget")).toBeVisible();
    await expect(refundMain.getByRole("radio", { name: "Varen er modtaget retur" })).toBeChecked();
    await refundMain.getByLabel("Fradrag for værdiforringelse (kr., valgfri)").fill("49,95");
    await refundMain.getByLabel("Begrundelse (kræves ved fradrag)").fill("Returfragt");
    await expect(refundMain.getByText("Refunderes: 200,00 kr. (249,95 kr. − 49,95 kr.)")).toBeVisible();
    await refundMain.getByRole("button", { name: "Bekræft retur" }).click();
    await expect(
      refundMain.getByText(`Refundér 200,00 kr. til ${BUYER_EMAIL}? Det kan ikke fortrydes.`),
    ).toBeVisible();
    await refundMain.getByRole("button", { name: "Refundér 200,00 kr." }).click();
    await expect(refundMain.getByRole("status")).toContainText("Refunderingen er gennemført.", { timeout: 60_000 });

    await expect.poll(async () => (await orderState(orderNumber)).status, { timeout: 30_000 }).toBe("refunded");
    const refundedState = await orderState(orderNumber);
    expect(refundedState.w_status).toBe("completed");
    expect(refundedState.amount_refunded_ore).toBe(20_000);
    // The credit note to the buyer (S2-DOC-3).
    await expect.poll(async () => (await mailStamps(orderNumber)).receipt, { timeout: 30_000 }).toBe(true);
    await page.reload();
    await expect(page.getByRole("main").locator("header").getByText("Refunderet", { exact: true })).toBeVisible();

    // ── Stripe: a 20000 øre refund on the PaymentIntent, no credit note (A1) ─
    const refunds = await stripeRequest<{ data: StripeRefund[] }>(key, "GET", `refunds?payment_intent=${paymentIntentId}&limit=5`);
    const refund = refunds.data.find((candidate) => candidate.amount === 20_000);
    expect(refund, "a refund of 20000 øre on the order's PaymentIntent").toBeDefined();
    expect(refund!.status).toBe("succeeded");
    expect(refund!.metadata?.order_withdrawal_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("S2-CAP-4/S2-ADM-16: withdrawn before dispatch → 'ikke afsendt' → reservation released → Annulleret", async ({ page }) => {
    test.skip(STRIPE_TEST_KEY === null, "Requires a test-mode STRIPE_PAYMENTS_KEY");
    test.skip(!WORKER_AVAILABLE, "Requires STRIPE_WEBHOOK_SECRET and ORDER_LINK_SECRET in workers/payments/.dev.vars");
    test.setTimeout(180_000);
    const key = STRIPE_TEST_KEY!;

    const paymentIntent = await createAuthorizedPaymentIntent(key);
    expect(paymentIntent.status).toBe("requires_capture");
    const client = await getClient();
    let orderNumber: number;
    try {
      ({ orderNumber } = await seedAuthorizedOrder(client, {
        itemId: itemId!,
        buyerEmail: RELEASE_EMAIL,
        checkoutSessionId: `cs_test_s2e2e${paymentIntent.id.slice(3)}`,
        paymentIntentId: paymentIntent.id,
      }));
    } finally {
      client.release();
    }

    // Withdrawal by order number + the order's email (no personal link).
    await withdraw(page, "/order/withdraw?lang=da", async (main) => {
      await main.getByLabel("Ordrenummer").fill(String(orderNumber));
      await main.getByLabel("E-mail brugt ved købet").fill(RELEASE_EMAIL);
      await main.getByLabel("Dit navn").fill("E2E Køber");
    });
    await expect(page.getByRole("main").getByText("Vi har modtaget din fortrydelse")).toBeVisible();
    await expect
      .poll(async () => mailStamps(orderNumber), { timeout: 30_000 })
      .toMatchObject({ ack: true, owner_alert: true });

    await openOrder(page, orderNumber);
    const main = page.getByRole("main");
    await expect(main.getByRole("button", { name: /Markér afsendt/ })).toHaveCount(0);
    await expect(main.getByRole("radio", { name: "Varen er ikke afsendt" })).toBeChecked();
    await expect(main.getByText("Reservationen frigives (intet trækkes).")).toBeVisible();
    await expect(main.getByLabel(/Fradrag/)).toHaveCount(0);
    await main.getByRole("button", { name: "Bekræft ikke afsendt" }).click();
    await expect(
      main.getByText(`Frigiv reservationen på 249,95 kr. for ${RELEASE_EMAIL}? Køberen trækkes ikke. Det kan ikke fortrydes.`),
    ).toBeVisible();
    await main.getByRole("button", { name: "Frigiv reservationen" }).click();
    await expect(main.getByRole("status")).toContainText("Reservationen er frigivet", { timeout: 60_000 });

    await expect.poll(async () => (await orderState(orderNumber)).status, { timeout: 30_000 }).toBe("canceled");
    const released = await orderState(orderNumber);
    expect(released.cancel_reason).toBe("withdrawn");
    expect(released.w_status).toBe("completed");
    // The cancellation credit note: nothing charged, the reservation released (S2-DOC-4).
    await expect.poll(async () => (await mailStamps(orderNumber)).receipt, { timeout: 30_000 }).toBe(true);
    const canceled = await stripeRequest<StripePaymentIntent>(key, "GET", `payment_intents/${paymentIntent.id}`);
    expect(canceled.status).toBe("canceled");
    expect(canceled.amount_received).toBe(0);
    await page.reload();
    await expect(page.getByRole("main").locator("header").getByText("Annulleret", { exact: true })).toBeVisible();
  });

  test("S2-WD-3/S2-WD-4: a wrong link token and a wrong email get the same generic refusal", async ({ page }) => {
    test.skip(!WORKER_AVAILABLE, "Requires the local payments Worker (.dev.vars secrets) bound as ORDERS");
    const client = await getClient();
    let order: { orderId: string; orderNumber: number };
    try {
      // Nothing reaches Stripe for a refused withdrawal: a well-formed PaymentIntent id suffices.
      const suffix = newEventId().slice(4);
      order = await seedAuthorizedOrder(client, {
        itemId: itemId!,
        buyerEmail: scope.buyerEmail(3),
        checkoutSessionId: `cs_test_${suffix}`,
        paymentIntentId: `pi_${suffix}`,
      });
    } finally {
      client.release();
    }
    const refused = "Vi kunne ikke finde en ordre med de oplysninger.";

    await withdraw(page, `/order/withdraw?o=${order.orderId}&t=wrong-token&lang=da`, async (main) => {
      await main.getByLabel("Dit navn").fill("E2E Køber");
    });
    await expect(page.getByRole("main").getByText(refused)).toBeVisible();

    await withdraw(page, "/order/withdraw?lang=da", async (main) => {
      await main.getByLabel("Ordrenummer").fill(String(order.orderNumber));
      await main.getByLabel("E-mail brugt ved købet").fill(scope.buyerEmail(99));
      await main.getByLabel("Dit navn").fill("E2E Køber");
    });
    await expect(page.getByRole("main").getByText(refused)).toBeVisible();
    expect((await orderState(order.orderNumber)).w_status).toBeNull();
  });
});
