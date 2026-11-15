/**
 * Unit tests: workers/payments/webhook.ts dispatch fork + workers/payments/orders/webhook.ts
 * (goods events, amendments A1/A2: the Checkout only authorizes the payment)
 * Journey: payments-s2-3d-purchase
 * Criteria: S2-WH-1..14 (S2-T-WH-01..17), S2-CAP-14 (S2-T-WH-18)
 *
 * Coverage:
 *   - checkout.session.completed goods (payment_status unpaid): GET payment intent with its latest
 *     charge → recorded authorized (capture_state requires_capture, authorization_expires_at from
 *     capture_before) → confirmation (the invoice) + owner emails, each stamped
 *   - payment intent succeeded / session paid → captured at Checkout (+ anomaly); processing →
 *     ignored awaiting_payment; GET failure → 500
 *   - duplicate → 200, no emails; invalid_session → 200 ignored; writer failure → 500, refusal →
 *     rejected; the account rule (exists / gone / Auth failure / user_unverified)
 *   - orders env invalid → recorded, emails deferred (orders_env_unavailable)
 *   - regression both ways (goods never calls a subscription writer, a subscription never
 *     records an order); invoice.paid of a goods invoice ignored; async_payment_succeeded of a
 *     non-goods session ignored not_goods_order
 *   - charge.refunded → payments_sync_order_refund; unknown_order ignored
 *   - payment_intent.canceled → payments_order_authorization_canceled; a lapsed authorization
 *     emails the owner (order-expired) and stamps expired_alert; withdrawn/ignored/duplicate/
 *     unknown send nothing; a writer failure → 500
 *
 * The session normalizer is the real one (src/lib/payments/orders/session.ts); only the signature
 * check is mocked. The goods clients are fakes of OrderWebhookDeps.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/payments/stripe-signature", () => ({
  verifyStripeSignature: vi.fn().mockResolvedValue({ ok: true, timestamp: 1_800_000_000 }),
}));

import { handleStripeWebhook, type WebhookDeps } from "../../../../workers/payments/webhook";
import type { StripeApi } from "../../../../workers/payments/stripe-api";
import type { PaymentsRpc } from "../../../../workers/payments/rpc";
import type { OrderMailer } from "../../../../workers/payments/orders/mail";
import { OrderRpcError } from "../../../../workers/payments/orders/rpc";
import { PaymentsRpcError } from "../../../../workers/payments/rpc";
import { MailError } from "../../../../workers/payments/mail";
import { GOODS_ORDER_KIND } from "@/config/payments";
import { GOODS_TEXT_VERSION } from "@/config/legal/goods-texts";

const CS_ID = "cs_test_wh00000000000001";
const PI_ID = "pi_wh000000000000000001";
const EVT_ID = "evt_wh0000000000000001";
const ORDER_ID = "00000000-0000-0000-0000-000000000010";
const USER_ID = "00000000-0000-0000-0000-000000000005";
const CREATED = 1_800_000_000;
/** The card authorization lapses 7 days after Checkout (spike: capture_before = created + 604800). */
const CAPTURE_BEFORE = CREATED + 604_800;

/** A completed goods session as Stripe sends it with manual capture: payment_status unpaid. */
const GOODS_SESSION = {
  id: CS_ID,
  object: "checkout.session",
  mode: "payment",
  status: "complete",
  payment_status: "unpaid",
  payment_intent: PI_ID,
  invoice: null,
  customer: null,
  client_reference_id: null,
  locale: "da",
  consent: { terms_of_service: "accepted", promotions: null },
  collected_information: {
    shipping_details: {
      name: "Lars Andersen",
      address: { line1: "Testvej 1", line2: null, postal_code: "7860", city: "Spøttrup", country: "DK", state: "" },
    },
  },
  customer_details: { email: "delivered+s2@resend.dev", name: "Lars Andersen", phone: "+4520123456" },
  currency: "dkk",
  amount_total: 24995,
  amount_subtotal: 24995,
  total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 4999 },
  metadata: {
    kind: GOODS_ORDER_KIND,
    item_id: "00000000-0000-0000-0000-000000000001",
    offer_kind: "physical",
    unit_amount_ore: "24995",
    quantity: "1",
    title: "Testfigur",
    locale: "da",
    terms_version: GOODS_TEXT_VERSION,
  },
};

/** The payment intent with its expanded latest charge (spike: requires_capture, capture_before). */
function paymentIntent(status: string): unknown {
  return {
    id: PI_ID,
    object: "payment_intent",
    status,
    amount_capturable: status === "requires_capture" ? 24995 : 0,
    latest_charge: { id: "ch_wh0000000000000001", payment_method_details: { type: "card", card: { capture_before: CAPTURE_BEFORE } } },
  };
}

function eventBody(type: string, object: unknown, id = EVT_ID): string {
  return JSON.stringify({ id, type, created: CREATED, livemode: false, data: { object } });
}

function request(body: string): Request {
  return new Request("https://pay.alnyron.dk/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": "t=1800000000,v1=fakesig" },
    body,
  });
}

// Subscription writers: a goods event must never call them.
const syncSubscription = vi.fn();
const recordSubscriptionInvoice = vi.fn();
const paymentsRecordCheckoutConsent = vi.fn();

type GoodsFakes = {
  stripe: { retrievePaymentIntent: Mock };
  rpc: { recordOrder: Mock; orderMailSent: Mock; syncOrderRefund: Mock; authorizationCanceled: Mock };
  accountExists: Mock;
  mail: { [K in keyof OrderMailer]: Mock } | null;
};

function fakeMailer(): { [K in keyof OrderMailer]: Mock } {
  const sent = (id: string) => vi.fn().mockResolvedValue({ id });
  return {
    sendConfirmation: sent("em-confirm"),
    sendOwnerNewOrder: sent("em-owner"),
    sendShipped: sent("em-shipped"),
    sendCaptureWarning: sent("em-warn"),
    sendAuthorizationExpired: sent("em-expired"),
    sendCaptureFailed: sent("em-capture-failed"),
    sendWithdrawalAck: sent("em-ack"),
    sendWithdrawalAlert: sent("em-alert"),
    sendWithdrawalReceipt: sent("em-receipt"),
    sendRefundReminder: sent("em-remind"),
    sendManualAlert: sent("em-manual"),
  };
}

function fakeGoods(): GoodsFakes {
  return {
    stripe: { retrievePaymentIntent: vi.fn().mockResolvedValue({ ok: true, data: paymentIntent("requires_capture") }) },
    rpc: {
      recordOrder: vi.fn().mockResolvedValue({ outcome: "recorded", orderId: ORDER_ID, orderNumber: 1001 }),
      orderMailSent: vi.fn().mockResolvedValue("stamped"),
      syncOrderRefund: vi.fn().mockResolvedValue({ outcome: "synced", orderId: ORDER_ID, amountRefundedOre: 24995, status: "refunded" }),
      authorizationCanceled: vi.fn(),
    },
    accountExists: vi.fn().mockResolvedValue(true),
    mail: fakeMailer(),
  };
}

function deps(goods: GoodsFakes = fakeGoods(), stripe: Partial<StripeApi> = {}): WebhookDeps & { log: Mock } {
  const rpc: PaymentsRpc = {
    syncSubscription,
    recordSubscriptionInvoice,
    otherEntitlingSubscriptionIds: vi.fn().mockResolvedValue([]),
    accountExists: vi.fn().mockResolvedValue(true),
    paymentsRecordCheckoutConsent,
    paymentsMarkConsentInfoSent: vi.fn().mockResolvedValue({ outcome: "stamped" }),
    getUserEmail: vi.fn().mockResolvedValue("delivered+s2@resend.dev"),
  };
  return {
    webhookSecret: "whsec_unittest1234",
    livemode: false,
    stripe: {
      retrieveSubscription: vi.fn().mockResolvedValue({ ok: true, data: {} }),
      markDuplicateSubscription: vi.fn(),
      cancelSubscription: vi.fn(),
      listInvoicePayments: vi.fn(),
      createRefund: vi.fn(),
      ...stripe,
    },
    rpc,
    mail: { sendConfirmationEmail: vi.fn().mockResolvedValue({ id: "em-sub" }) },
    now: () => CREATED * 1000,
    log: vi.fn(),
    orders: goods,
  };
}

/** The delivery's one log line. */
function logLine(d: { log: Mock }): Record<string, unknown> {
  expect(d.log).toHaveBeenCalledOnce();
  return JSON.parse(String(d.log.mock.calls[0]![0])) as Record<string, unknown>;
}

function stamps(goods: GoodsFakes): unknown[] {
  return goods.rpc.orderMailSent.mock.calls;
}

beforeEach(() => {
  vi.clearAllMocks();
  syncSubscription.mockResolvedValue({ outcome: "applied", paused: 0 });
  paymentsRecordCheckoutConsent.mockResolvedValue({ outcome: "recorded", mail: null });
});

describe("S2-WH-1 (S2-T-WH-01): a completed goods session → recorded authorized, invoice + owner emails stamped", () => {
  it("reads the payment intent, records requires_capture with the card's capture_before, sends and stamps both emails", async () => {
    const goods = fakeGoods();
    const d = deps(goods);
    const response = await handleStripeWebhook(request(eventBody("checkout.session.completed", GOODS_SESSION)), d);
    expect(response.status).toBe(200);

    expect(goods.stripe.retrievePaymentIntent).toHaveBeenCalledExactlyOnceWith(PI_ID);
    expect(goods.rpc.recordOrder).toHaveBeenCalledExactlyOnceWith(
      { id: EVT_ID, type: "checkout.session.completed", created: "2027-01-15T08:00:00.000Z", livemode: false },
      expect.objectContaining({
        stripe_checkout_session_id: CS_ID,
        stripe_payment_intent_id: PI_ID,
        user_id: null,
        email: "delivered+s2@resend.dev",
        amount_total_ore: 24995,
        anomaly: null,
        capture_state: "requires_capture",
        authorization_expires_at: "2027-01-22T08:00:00.000Z",
      }),
    );
    const snapshot = expect.objectContaining({
      id: ORDER_ID,
      order_number: 1001,
      status: "authorized",
      email: "delivered+s2@resend.dev",
      authorization_expires_at: "2027-01-22T08:00:00.000Z",
      captured_at: null,
      line: { title: "Testfigur", quantity: 1 },
    });
    expect(goods.mail!.sendConfirmation).toHaveBeenCalledExactlyOnceWith(snapshot);
    expect(goods.mail!.sendOwnerNewOrder).toHaveBeenCalledExactlyOnceWith(snapshot);
    expect(stamps(goods)).toEqual([
      [ORDER_ID, "confirmation", "em-confirm"],
      [ORDER_ID, "owner", "em-owner"],
    ]);
    expect(logLine(d)).toEqual({
      msg: "payments webhook",
      event: EVT_ID,
      type: "checkout.session.completed",
      outcome: "recorded",
      code: null,
      paused: null,
      order: ORDER_ID,
      confirmation: "sent",
      owner: "sent",
    });
  });

  it("a failed confirmation send counts 'failed' (the sweep resends it); the owner email still goes; 200", async () => {
    const goods = fakeGoods();
    goods.mail!.sendConfirmation.mockRejectedValue(new MailError("transient"));
    const d = deps(goods);
    const response = await handleStripeWebhook(request(eventBody("checkout.session.completed", GOODS_SESSION)), d);
    expect(response.status).toBe(200);
    expect(stamps(goods)).toEqual([
      [ORDER_ID, "failed", ""],
      [ORDER_ID, "owner", "em-owner"],
    ]);
    expect(logLine(d)).toMatchObject({ outcome: "recorded", confirmation: "mail_transient", owner: "sent" });
  });
});

describe("S2-WH-2 (S2-T-WH-02): a duplicate → 200, no emails", () => {
  it("record_order answers duplicate → nothing sent or stamped", async () => {
    const goods = fakeGoods();
    goods.rpc.recordOrder.mockResolvedValue({ outcome: "duplicate" });
    const d = deps(goods);
    const response = await handleStripeWebhook(request(eventBody("checkout.session.completed", GOODS_SESSION)), d);
    expect(response.status).toBe(200);
    expect(goods.rpc.recordOrder).toHaveBeenCalledOnce();
    expect(goods.mail!.sendConfirmation).not.toHaveBeenCalled();
    expect(goods.mail!.sendOwnerNewOrder).not.toHaveBeenCalled();
    expect(goods.rpc.orderMailSent).not.toHaveBeenCalled();
    expect(logLine(d)).toMatchObject({ outcome: "duplicate", code: null });
  });
});

describe("S2-WH-3 (S2-T-WH-03): the payment intent decides (A1: an unpaid session is only authorized)", () => {
  it("succeeded → recorded as captured at Checkout (capture_state succeeded, no expiry, anomaly captured_at_checkout)", async () => {
    const goods = fakeGoods();
    goods.stripe.retrievePaymentIntent.mockResolvedValue({ ok: true, data: paymentIntent("succeeded") });
    const d = deps(goods);
    expect((await handleStripeWebhook(request(eventBody("checkout.session.completed", GOODS_SESSION)), d)).status).toBe(200);
    expect(goods.rpc.recordOrder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ capture_state: "succeeded", authorization_expires_at: null, anomaly: "captured_at_checkout" }),
    );
    expect(goods.mail!.sendConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({ captured_at: "2027-01-15T08:00:00.000Z", authorization_expires_at: null }),
    );
  });

  it.each(["processing", "requires_action", "requires_payment_method", "canceled"])(
    "%s → 200 ignored awaiting_payment, nothing recorded",
    async (status) => {
      const goods = fakeGoods();
      goods.stripe.retrievePaymentIntent.mockResolvedValue({ ok: true, data: paymentIntent(status) });
      const d = deps(goods);
      expect((await handleStripeWebhook(request(eventBody("checkout.session.completed", GOODS_SESSION)), d)).status).toBe(200);
      expect(goods.rpc.recordOrder).not.toHaveBeenCalled();
      expect(logLine(d)).toMatchObject({ outcome: "ignored", code: "awaiting_payment" });
    },
  );

  it.each([
    ["503", { ok: false, kind: "http", status: 503, code: null }, "payment_intent_stripe_http_503"],
    ["network", { ok: false, kind: "network" }, "payment_intent_stripe_network"],
    ["another payment intent", { ok: true, data: { id: "pi_other00000000000001", status: "requires_capture" } }, "invalid_payment_intent"],
  ])("the GET fails (%s) → 500, nothing recorded", async (_label, answer, code) => {
    const goods = fakeGoods();
    goods.stripe.retrievePaymentIntent.mockResolvedValue(answer);
    const d = deps(goods);
    const response = await handleStripeWebhook(request(eventBody("checkout.session.completed", GOODS_SESSION)), d);
    expect(response.status).toBe(500);
    expect(goods.rpc.recordOrder).not.toHaveBeenCalled();
    expect(logLine(d)).toMatchObject({ outcome: "error", code });
  });

  it("payment_status paid (should not happen with manual capture) → recorded as captured at Checkout without the GET", async () => {
    const goods = fakeGoods();
    const d = deps(goods);
    await handleStripeWebhook(request(eventBody("checkout.session.completed", { ...GOODS_SESSION, payment_status: "paid" })), d);
    expect(goods.stripe.retrievePaymentIntent).not.toHaveBeenCalled();
    expect(goods.rpc.recordOrder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ capture_state: "succeeded", anomaly: "captured_at_checkout" }),
    );
  });
});

describe("S2-WH-4 (S2-T-WH-04): async_payment_succeeded of a goods session → the same check, recorded", () => {
  it("records the order (the writer answers duplicate when completed ran first)", async () => {
    const goods = fakeGoods();
    const d = deps(goods);
    const response = await handleStripeWebhook(request(eventBody("checkout.session.async_payment_succeeded", GOODS_SESSION)), d);
    expect(response.status).toBe(200);
    expect(goods.stripe.retrievePaymentIntent).toHaveBeenCalledOnce();
    expect(goods.rpc.recordOrder).toHaveBeenCalledWith(
      expect.objectContaining({ type: "checkout.session.async_payment_succeeded" }),
      expect.objectContaining({ capture_state: "requires_capture" }),
    );
  });
});

describe("S2-WH-5 (S2-T-WH-05): an invalid session → 200 ignored, nothing read or recorded", () => {
  it.each([
    ["no buyer email", { ...GOODS_SESSION, customer_details: { email: null } }],
    ["a malformed payment intent", { ...GOODS_SESSION, payment_intent: "pi_bad-id" }],
    ["no item title", { ...GOODS_SESSION, metadata: { ...GOODS_SESSION.metadata, title: " " } }],
  ])("%s", async (_label, session) => {
    const goods = fakeGoods();
    const d = deps(goods);
    expect((await handleStripeWebhook(request(eventBody("checkout.session.completed", session)), d)).status).toBe(200);
    expect(goods.stripe.retrievePaymentIntent).not.toHaveBeenCalled();
    expect(goods.rpc.recordOrder).not.toHaveBeenCalled();
    expect(logLine(d)).toMatchObject({ outcome: "ignored", code: "invalid_session" });
  });
});

describe("S2-WH-6 (S2-T-WH-06): the order writer fails → 500 (Stripe retries); a refusal is rejected", () => {
  it("a failure a retry may fix → 500, no emails", async () => {
    const goods = fakeGoods();
    goods.rpc.recordOrder.mockRejectedValue(new OrderRpcError("rpc_failed", "unknown", 503));
    const d = deps(goods);
    expect((await handleStripeWebhook(request(eventBody("checkout.session.completed", GOODS_SESSION)), d)).status).toBe(500);
    expect(goods.mail!.sendConfirmation).not.toHaveBeenCalled();
    expect(logLine(d)).toMatchObject({ outcome: "error", code: "record_rpc_unknown" });
  });

  it("22023 invalid_payload (the writer refuses the payload for good) → 200 rejected", async () => {
    const goods = fakeGoods();
    goods.rpc.recordOrder.mockRejectedValue(new OrderRpcError("invalid_payload", "22023", 400));
    const d = deps(goods);
    expect((await handleStripeWebhook(request(eventBody("checkout.session.completed", GOODS_SESSION)), d)).status).toBe(200);
    expect(logLine(d)).toMatchObject({ outcome: "rejected", code: "order_invalid_payload" });
  });
});

describe("S2-WH-7 (S2-T-WH-07..09, 07b): the buyer's account", () => {
  const signedIn = {
    ...GOODS_SESSION,
    client_reference_id: USER_ID,
    metadata: { ...GOODS_SESSION.metadata, user_id: USER_ID },
  };

  it("S2-T-WH-07: metadata.user_id = client_reference_id and the account exists → user_id recorded", async () => {
    const goods = fakeGoods();
    const d = deps(goods);
    await handleStripeWebhook(request(eventBody("checkout.session.completed", signedIn)), d);
    expect(goods.accountExists).toHaveBeenCalledExactlyOnceWith(USER_ID);
    expect(goods.rpc.recordOrder).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ user_id: USER_ID, anomaly: null }));
  });

  it("S2-T-WH-08: the account is gone (Auth 404) → a guest order", async () => {
    const goods = fakeGoods();
    goods.accountExists.mockResolvedValue(false);
    const d = deps(goods);
    expect((await handleStripeWebhook(request(eventBody("checkout.session.completed", signedIn)), d)).status).toBe(200);
    expect(goods.rpc.recordOrder).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ user_id: null }));
  });

  it("S2-T-WH-09: the Auth lookup fails (5xx) → 500, nothing recorded", async () => {
    const goods = fakeGoods();
    goods.accountExists.mockRejectedValue(new PaymentsRpcError("rpc_failed", "unexpected_failure", 503));
    const d = deps(goods);
    expect((await handleStripeWebhook(request(eventBody("checkout.session.completed", signedIn)), d)).status).toBe(500);
    expect(goods.rpc.recordOrder).not.toHaveBeenCalled();
    expect(logLine(d)).toMatchObject({ outcome: "error", code: "account_rpc_unexpected_failure_503" });
  });

  it("S2-T-WH-07b: metadata.user_id ≠ client_reference_id → guest + user_unverified, no lookup", async () => {
    const goods = fakeGoods();
    const d = deps(goods);
    const mismatch = { ...signedIn, client_reference_id: "00000000-0000-0000-0000-000000000099" };
    await handleStripeWebhook(request(eventBody("checkout.session.completed", mismatch)), d);
    expect(goods.accountExists).not.toHaveBeenCalled();
    expect(goods.rpc.recordOrder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ user_id: null, anomaly: "user_unverified" }),
    );
  });
});

describe("S2-WH-8 (S2-T-WH-10): orders env invalid → recorded, emails deferred to the sweep, 200", () => {
  it("no mailer → the order is recorded, nothing sent, logged orders_env_unavailable", async () => {
    const goods = { ...fakeGoods(), mail: null };
    const d = deps(goods);
    expect((await handleStripeWebhook(request(eventBody("checkout.session.completed", GOODS_SESSION)), d)).status).toBe(200);
    expect(goods.rpc.recordOrder).toHaveBeenCalledOnce();
    expect(goods.rpc.orderMailSent).not.toHaveBeenCalled();
    expect(logLine(d)).toMatchObject({
      outcome: "recorded",
      code: "orders_env_unavailable",
      order: ORDER_ID,
      confirmation: "deferred",
      owner: "deferred",
    });
  });

  it("a Worker built without the goods clients answers a goods event 500 (orders_unavailable)", async () => {
    const d = deps();
    delete d.orders;
    expect((await handleStripeWebhook(request(eventBody("checkout.session.completed", GOODS_SESSION)), d)).status).toBe(500);
    expect(logLine(d)).toMatchObject({ outcome: "error", code: "orders_unavailable" });
  });
});

describe("S2-WH-9 (S2-T-WH-11): regression — a goods session never calls a subscription writer", () => {
  it.each(["checkout.session.completed", "checkout.session.async_payment_succeeded"])("%s", async (type) => {
    const d = deps();
    await handleStripeWebhook(request(eventBody(type, GOODS_SESSION)), d);
    expect(syncSubscription).not.toHaveBeenCalled();
    expect(recordSubscriptionInvoice).not.toHaveBeenCalled();
    expect(paymentsRecordCheckoutConsent).not.toHaveBeenCalled();
    expect(d.stripe.retrieveSubscription).not.toHaveBeenCalled();
  });
});

describe("S2-WH-10 (S2-T-WH-12): regression — a subscription session never records an order", () => {
  it("mode=subscription runs the subscription branch only", async () => {
    const userId = "00000000-0000-0000-0000-000000000001";
    const subscription = {
      id: "sub_test001",
      customer: "cus_test001",
      status: "active",
      cancel_at_period_end: false,
      created: 1_700_000_000,
      start_date: 1_700_000_000,
      metadata: { kind: "monitor_subscription", user_id: userId },
      items: { data: [{ price: { id: "price_test001" }, current_period_end: 1_732_000_000 }] },
      latest_invoice: "in_test001",
    };
    const goods = fakeGoods();
    const d = deps(goods, { retrieveSubscription: vi.fn().mockResolvedValue({ ok: true, data: subscription }) });
    const session = {
      id: "cs_test_sub",
      mode: "subscription",
      subscription: "sub_test001",
      client_reference_id: userId,
      metadata: { kind: "monitor_subscription", user_id: userId },
    };
    expect((await handleStripeWebhook(request(eventBody("checkout.session.completed", session)), d)).status).toBe(200);
    expect(syncSubscription).toHaveBeenCalledOnce();
    expect(goods.rpc.recordOrder).not.toHaveBeenCalled();
    expect(goods.stripe.retrievePaymentIntent).not.toHaveBeenCalled();
  });
});

describe("S2-WH-11..12 (S2-T-WH-13..15): charge.refunded", () => {
  const charge = { id: "ch_wh0000000000000001", object: "charge", payment_intent: PI_ID, amount_refunded: 20000, refunded: false };

  it("S2-T-WH-13: syncs the cumulative amount_refunded of the charge's payment intent", async () => {
    const goods = fakeGoods();
    const d = deps(goods);
    expect((await handleStripeWebhook(request(eventBody("charge.refunded", charge)), d)).status).toBe(200);
    expect(goods.rpc.syncOrderRefund).toHaveBeenCalledExactlyOnceWith(
      { id: EVT_ID, type: "charge.refunded", created: "2027-01-15T08:00:00.000Z", livemode: false },
      PI_ID,
      20000,
    );
    expect(logLine(d)).toMatchObject({ outcome: "synced", code: null, order: ORDER_ID });
  });

  it("S2-T-WH-14/15: a charge of no goods order (a subscription's) → unknown_order, ignored; no subscription table touched", async () => {
    const goods = fakeGoods();
    goods.rpc.syncOrderRefund.mockResolvedValue({ outcome: "unknown_order" });
    const d = deps(goods);
    expect((await handleStripeWebhook(request(eventBody("charge.refunded", { ...charge, payment_intent: "pi_subcharge0000000001" })), d)).status).toBe(200);
    expect(goods.rpc.syncOrderRefund).toHaveBeenCalledOnce();
    expect(syncSubscription).not.toHaveBeenCalled();
    expect(recordSubscriptionInvoice).not.toHaveBeenCalled();
    expect(logLine(d)).toMatchObject({ outcome: "ignored", code: "unknown_order" });
  });

  it("a malformed charge is rejected without a write; a writer failure is a 500", async () => {
    const goods = fakeGoods();
    const bad = deps(goods);
    expect((await handleStripeWebhook(request(eventBody("charge.refunded", { ...charge, amount_refunded: -1 })), bad)).status).toBe(200);
    expect(goods.rpc.syncOrderRefund).not.toHaveBeenCalled();
    expect(logLine(bad)).toMatchObject({ outcome: "rejected", code: "invalid_charge" });

    goods.rpc.syncOrderRefund.mockRejectedValue(new OrderRpcError("rpc_failed", "unknown", 500));
    expect((await handleStripeWebhook(request(eventBody("charge.refunded", charge)), deps(goods))).status).toBe(500);
  });
});

describe("S2-WH-13 (S2-T-WH-16): invoice.paid of a goods invoice stays ignored", () => {
  it("an invoice without a subscription parent → ignored not_subscription_invoice, no goods writer", async () => {
    const goods = fakeGoods();
    const d = deps(goods);
    const invoice = { id: "in_wh000000000000000001", status: "paid", parent: { type: "invoice_item_details" }, metadata: { kind: "goods_order" } };
    expect((await handleStripeWebhook(request(eventBody("invoice.paid", invoice)), d)).status).toBe(200);
    expect(goods.rpc.recordOrder).not.toHaveBeenCalled();
    expect(goods.rpc.syncOrderRefund).not.toHaveBeenCalled();
    expect(logLine(d)).toMatchObject({ outcome: "ignored", code: "not_subscription_invoice" });
  });
});

describe("S2-WH-14 (S2-T-WH-17): async_payment_succeeded of a non-goods session → ignored not_goods_order", () => {
  it.each([
    ["kind other than goods_order", { ...GOODS_SESSION, metadata: { ...GOODS_SESSION.metadata, kind: "monitor_subscription" } }],
    ["a subscription session", { ...GOODS_SESSION, mode: "subscription" }],
  ])("%s", async (_label, session) => {
    const goods = fakeGoods();
    const d = deps(goods);
    expect((await handleStripeWebhook(request(eventBody("checkout.session.async_payment_succeeded", session)), d)).status).toBe(200);
    expect(goods.rpc.recordOrder).not.toHaveBeenCalled();
    expect(syncSubscription).not.toHaveBeenCalled();
    expect(logLine(d)).toMatchObject({ outcome: "ignored", code: "not_goods_order" });
  });
});

describe("S2-CAP-14 (S2-T-WH-18): payment_intent.canceled", () => {
  const canceledIntent = { id: PI_ID, object: "payment_intent", status: "canceled", cancellation_reason: "automatic" };
  const lapsedOrder = {
    id: ORDER_ID,
    order_number: 1001,
    status: "canceled",
    email: "delivered+s2@resend.dev",
    customer_name: "Lars Andersen",
    phone: null,
    shipping_name: "Lars Andersen",
    shipping_address: null,
    locale: "da",
    amount_total_ore: 24995,
    amount_refunded_ore: 0,
    paid_at: "2026-11-14T10:00:00.000Z",
    authorization_expires_at: "2026-11-21T10:00:00.000Z",
    captured_at: null,
    cancel_reason: "authorization_expired",
    anomaly: null,
    tracking_ref: null,
    stripe_payment_intent_id: PI_ID,
    line: { title: "Testfigur", quantity: 1 },
  };

  it("a lapsed authorization → canceled, the owner's 'send ikke varen' email, stamped expired_alert", async () => {
    const goods = fakeGoods();
    goods.rpc.authorizationCanceled.mockResolvedValue({ outcome: "canceled", order: lapsedOrder });
    const d = deps(goods);
    expect((await handleStripeWebhook(request(eventBody("payment_intent.canceled", canceledIntent)), d)).status).toBe(200);
    expect(goods.rpc.authorizationCanceled).toHaveBeenCalledExactlyOnceWith(
      { id: EVT_ID, type: "payment_intent.canceled", created: "2027-01-15T08:00:00.000Z", livemode: false },
      PI_ID,
    );
    expect(goods.mail!.sendAuthorizationExpired).toHaveBeenCalledExactlyOnceWith(lapsedOrder);
    expect(stamps(goods)).toEqual([[ORDER_ID, "expired_alert", "em-expired"]]);
    expect(logLine(d)).toMatchObject({ outcome: "canceled", code: null, order: ORDER_ID, alert: "sent" });
  });

  it("a failed alert send counts 'failed' (the sweep resends it: A2-2), still 200", async () => {
    const goods = fakeGoods();
    goods.rpc.authorizationCanceled.mockResolvedValue({ outcome: "canceled", order: lapsedOrder });
    goods.mail!.sendAuthorizationExpired.mockRejectedValue(new MailError("quota"));
    const d = deps(goods);
    expect((await handleStripeWebhook(request(eventBody("payment_intent.canceled", canceledIntent)), d)).status).toBe(200);
    expect(stamps(goods)).toEqual([[ORDER_ID, "failed", ""]]);
    expect(logLine(d)).toMatchObject({ outcome: "canceled", alert: "mail_quota" });
  });

  it.each([
    ["withdrawn (the Worker's own release)", { outcome: "canceled", order: { ...lapsedOrder, cancel_reason: "withdrawn" } }, "canceled", null],
    ["ignored (captured or closed)", { outcome: "ignored", orderId: ORDER_ID }, "ignored", "order_not_authorized"],
    ["duplicate", { outcome: "duplicate" }, "duplicate", null],
    ["unknown_order", { outcome: "unknown_order" }, "ignored", "unknown_order"],
  ])("%s → 200 without email", async (_label, answer, outcome, code) => {
    const goods = fakeGoods();
    goods.rpc.authorizationCanceled.mockResolvedValue(answer);
    const d = deps(goods);
    expect((await handleStripeWebhook(request(eventBody("payment_intent.canceled", canceledIntent)), d)).status).toBe(200);
    expect(goods.mail!.sendAuthorizationExpired).not.toHaveBeenCalled();
    expect(goods.rpc.orderMailSent).not.toHaveBeenCalled();
    expect(logLine(d)).toMatchObject({ outcome, code });
  });

  it("a writer failure → 500", async () => {
    const goods = fakeGoods();
    goods.rpc.authorizationCanceled.mockRejectedValue(new OrderRpcError("rpc_failed", "unknown", 503));
    const d = deps(goods);
    expect((await handleStripeWebhook(request(eventBody("payment_intent.canceled", canceledIntent)), d)).status).toBe(500);
    expect(logLine(d)).toMatchObject({ outcome: "error", code: "cancel_rpc_unknown" });
  });

  it("without an orders env the lapsed order's alert is deferred to the sweep", async () => {
    const goods = { ...fakeGoods(), mail: null };
    goods.rpc.authorizationCanceled.mockResolvedValue({ outcome: "canceled", order: lapsedOrder });
    const d = deps(goods);
    expect((await handleStripeWebhook(request(eventBody("payment_intent.canceled", canceledIntent)), d)).status).toBe(200);
    expect(goods.rpc.orderMailSent).not.toHaveBeenCalled();
    expect(logLine(d)).toMatchObject({ outcome: "canceled", code: "orders_env_unavailable", alert: "deferred" });
  });
});
