/**
 * Unit tests: workers/payments/orders/service.ts — OrderService and its handlers (A1/A2: the
 * capture at "Markér afsendt", the release or refund on approval); workers/payments/orders/env.ts
 * Journey: payments-s2-3d-purchase
 * Criteria: S2-SEC-7..9 (S2-T-SVC-01..05), S2-WD-3..8 (S2-T-WD-01..06), S2-CAP-13
 *   (S2-T-SVC-CAP-01, S2-T-SVC-CAP-03), S2-CAP-15 (S2-T-SVC-CAP-02), S2-CAP-12 (every answer parses
 *   with the service contract)
 *
 * The handlers run on fake goods clients (OrderDeps); the class is driven through the real input
 * parse and env parse with `createOrderDeps` mocked to hand it the same fakes.
 * processOrderRefund is mocked (its logic: orders-withdrawal.test.ts); orderRefundStatus is real.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type * as WithdrawalModule from "../../../../workers/payments/orders/withdrawal";

const { mockProcessOrderRefund, depsRef } = vi.hoisted(() => ({
  mockProcessOrderRefund: vi.fn(),
  depsRef: { current: undefined as unknown },
}));

vi.mock("../../../../workers/payments/orders/withdrawal", async (importOriginal) => ({
  ...(await importOriginal<typeof WithdrawalModule>()),
  processOrderRefund: (...args: unknown[]) => mockProcessOrderRefund(...args),
}));

vi.mock("../../../../workers/payments/orders/deps", () => ({
  createOrderDeps: () => depsRef.current,
}));

import {
  OrderService,
  approveRefund,
  markShipped,
  startCheckout,
  withdrawOrder,
} from "../../../../workers/payments/orders/service";
import { parseOrdersEnv } from "../../../../workers/payments/orders/env";
import type { OrderDeps } from "../../../../workers/payments/orders/deps";
import type { OrderMailer } from "../../../../workers/payments/orders/mail";
import { OrderRpcError, type OrderSnapshot, type OrderWithdrawalSnapshot } from "../../../../workers/payments/orders/rpc";
import { MailError } from "../../../../workers/payments/mail";
import { GOODS_TEXT_VERSION } from "@/config/legal/goods-texts";
import { orderLinkToken } from "@/lib/payments/orders/link-token";
import {
  parseOrderServiceResult,
  type OrderServiceInput,
  type OrderServiceMethod,
} from "@/lib/payments/orders/service-contract";

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Pre-commit secret scan: fixture names never end in secret/token/key before a quoted literal.
const LINK_FX = "order-link-unit-fixture-32-characters-long";
const ACCESS_FX = "valid_access_jwt_xyz";
const ITEM_ID = "00000000-0000-0000-0000-000000000001";
const ORDER_ID = "00000000-0000-0000-0000-000000000010";
const WD_ID = "00000000-0000-0000-0000-000000000020";
const OWNER_ID = "00000000-0000-0000-0000-00000000000f";
const PI_ID = "pi_svc000000000000001";
const NOW_MS = 1_800_000_000_000;

const FAKE_ENV = {
  SUPABASE_URL: "https://xmgpixhxecamtryohgmk.supabase.co",
  SUPABASE_SECRET_KEY: "sb_secret_unitorders1234",
  STRIPE_PAYMENTS_KEY: "sk_test_unitorders1234",
  STRIPE_WEBHOOK_SECRET: "whsec_unittest1234",
  STRIPE_LIVEMODE: "false",
  RESEND_API_KEY: "re_unittest1234",
  MAIL_FROM: "Alnyron <noreply@send.alnyron.dk>",
  WITHDRAWAL_ALERT_TO: "owner@alnyron.dk",
  SITE_URL: "https://alnyron.dk",
  ORDER_LINK_SECRET: LINK_FX,
  ORDER_NOTIFY_TO: "info@alnyron.dk",
  STRIPE_TAX_RATE_ID: "txr_1Ubdp4FBWtA5MNzbg2ZKznPw",
};

const OFFER = { item_id: ITEM_ID, price_ore: 24995, title: "Testfigur", section_slug: "figures", item_slug: "testfigur", locale: "da" as const };

const ORDER: OrderSnapshot = {
  id: ORDER_ID,
  order_number: 1001,
  status: "authorized",
  email: "delivered+s2@resend.dev",
  customer_name: "Lars Andersen",
  phone: "+4520123456",
  shipping_name: "Lars Andersen",
  shipping_address: { line1: "Testvej 1", line2: null, postal_code: "7860", city: "Spøttrup", country: "DK" },
  locale: "da",
  amount_total_ore: 24995,
  amount_refunded_ore: 0,
  paid_at: "2026-11-14T10:00:00.000Z",
  authorization_expires_at: "2026-11-21T10:00:00.000Z",
  captured_at: null,
  cancel_reason: null,
  anomaly: null,
  tracking_ref: "GLS123",
  stripe_payment_intent_id: PI_ID,
  line: { title: "Testfigur", quantity: 1 },
};

const SHIPPED: OrderSnapshot = { ...ORDER, status: "shipped", captured_at: "2026-11-15T10:00:00.000Z" };

const WITHDRAWAL: OrderWithdrawalSnapshot = {
  id: WD_ID,
  order_id: ORDER_ID,
  status: "received",
  consumer_name: "Lars Andersen",
  locale: "da",
  requested_at: "2026-11-16T10:00:00.000Z",
  refund_due_at: "2026-11-30T10:00:00.000Z",
  deadline_at: null,
  late: false,
  shipped_before_notice: false,
  action: null,
  refund_ore: null,
  deduction_ore: 0,
  deduction_reason: null,
  refunded_at: null,
  authorization_canceled_at: null,
  manual_reason: null,
  attempts: 0,
};

const APPROVED_RELEASE: OrderWithdrawalSnapshot = { ...WITHDRAWAL, status: "approved", action: "cancel_authorization" };

type Fakes = {
  stripe: { [K in keyof OrderDeps["stripe"]]: Mock };
  rpc: { [K in keyof OrderDeps["rpc"]]: Mock };
  auth: { getUser: Mock };
  mail: { [K in keyof OrderMailer]: Mock };
  log: Mock;
};

function fakeDeps(): Fakes & OrderDeps {
  const sent = (id: string) => vi.fn().mockResolvedValue({ id });
  return {
    stripe: {
      createGoodsCheckoutSession: vi.fn().mockResolvedValue({
        ok: true,
        data: { id: "cs_test_svc0001", url: "https://checkout.stripe.com/c/pay/cs_test_svc0001" },
      }),
      retrievePaymentIntent: vi.fn().mockResolvedValue({ ok: true, data: { id: PI_ID, status: "requires_capture" } }),
      capturePaymentIntent: vi.fn().mockResolvedValue({ ok: true, data: { id: PI_ID, status: "succeeded" } }),
      cancelPaymentIntent: vi.fn(),
      listPaymentIntentRefunds: vi.fn(),
      createOrderRefund: vi.fn(),
    },
    rpc: {
      goodsOffer: vi.fn().mockResolvedValue(OFFER),
      recordOrder: vi.fn(),
      orderMailSent: vi.fn().mockResolvedValue("stamped"),
      beginShip: vi.fn().mockResolvedValue({ outcome: "capture", order: ORDER }),
      orderCaptured: vi.fn().mockResolvedValue({ outcome: "shipped", order: SHIPPED }),
      captureFailed: vi.fn(),
      findOrder: vi.fn().mockResolvedValue(ORDER_ID),
      beginOrderWithdrawal: vi.fn().mockResolvedValue({ outcome: "created", withdrawal: WITHDRAWAL, order: ORDER }),
      approveOrderRefund: vi.fn().mockResolvedValue({ outcome: "approved", withdrawal: APPROVED_RELEASE, order: ORDER }),
      claimOrderWithdrawal: vi.fn(),
      orderWithdrawalStep: vi.fn().mockResolvedValue({ outcome: "applied", withdrawal: WITHDRAWAL }),
      pendingOrderWork: vi.fn(),
      syncOrderRefund: vi.fn(),
      authorizationCanceled: vi.fn(),
      readOrder: vi.fn(),
      readOrderWithdrawal: vi.fn(),
    },
    auth: { getUser: vi.fn().mockResolvedValue({ id: OWNER_ID, email: "owner@alnyron.dk" }) },
    mail: {
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
    },
    ordersEnv: { orderLinkSecret: LINK_FX, orderNotifyTo: "info@alnyron.dk", stripeTaxRateId: "txr_1Ubdp4FBWtA5MNzbg2ZKznPw" },
    siteOrigin: "https://alnyron.dk",
    now: () => NOW_MS,
    log: vi.fn(),
  };
}

/** The handler's result, checked against the web side's parser (S2-CAP-12: never unparsable). */
function contract<M extends OrderServiceMethod>(method: M, answer: { result: unknown }): unknown {
  expect(parseOrderServiceResult(method, answer.result), `${method} answer must parse`).not.toBeNull();
  return answer.result;
}

const LINK_INPUT: OrderServiceInput<"withdraw"> & { channel: "link" } = {
  channel: "link",
  orderId: ORDER_ID,
  token: "x".repeat(43),
  consumerName: "Lars Andersen",
  statementVersion: GOODS_TEXT_VERSION,
  locale: "da",
};

const FORM_INPUT: OrderServiceInput<"withdraw"> & { channel: "form" } = {
  channel: "form",
  orderNumber: 1001,
  email: "delivered+s2@resend.dev",
  consumerName: "Lars Andersen",
  statementVersion: GOODS_TEXT_VERSION,
  locale: "da",
};

let deps: Fakes & OrderDeps;

beforeEach(() => {
  vi.clearAllMocks();
  deps = fakeDeps();
  depsRef.current = deps;
  mockProcessOrderRefund.mockResolvedValue("canceled");
});

// ── startCheckout ─────────────────────────────────────────────────────────────

describe("S2-SEC-7 (S2-T-SVC-01): startCheckout — guest unless Auth confirms the token's user", () => {
  it("no access token → a guest Checkout: no reference, no customer email, no user in the metadata", async () => {
    const result = contract("startCheckout", await startCheckout(deps, { itemId: ITEM_ID, locale: "da" }));
    expect(result).toEqual({ ok: true, url: "https://checkout.stripe.com/c/pay/cs_test_svc0001" });
    expect(deps.auth.getUser).not.toHaveBeenCalled();
    expect(deps.rpc.goodsOffer).toHaveBeenCalledWith(ITEM_ID, "da");
    const params: unknown = deps.stripe.createGoodsCheckoutSession.mock.calls[0]?.[0];
    expect(params).not.toHaveProperty("client_reference_id");
    expect(params).not.toHaveProperty("customer_email");
    expect(params).not.toHaveProperty("metadata.user_id");
    expect(params).toMatchObject({
      mode: "payment",
      payment_intent_data: { capture_method: "manual" },
      line_items: [{ price_data: { unit_amount: 24995 }, tax_rates: ["txr_1Ubdp4FBWtA5MNzbg2ZKznPw"] }],
      success_url: "https://alnyron.dk/order/thanks?lang=da",
      cancel_url: "https://alnyron.dk/figures/testfigur",
      expires_at: NOW_MS / 1000 + 31 * 60,
    });
  });

  it.each([
    ["Auth refuses the token", () => deps.auth.getUser.mockResolvedValue(null)],
    ["Auth fails", () => deps.auth.getUser.mockRejectedValue(new Error("auth down"))],
    ["the account has no email", () => deps.auth.getUser.mockResolvedValue({ id: OWNER_ID, email: null })],
  ])("%s → still a guest Checkout, never an error", async (_label, arrange) => {
    arrange();
    const result = contract("startCheckout", await startCheckout(deps, { itemId: ITEM_ID, locale: "da", accessToken: ACCESS_FX }));
    expect(result).toMatchObject({ ok: true });
    const params: unknown = deps.stripe.createGoodsCheckoutSession.mock.calls[0]?.[0];
    expect(params).not.toHaveProperty("client_reference_id");
  });

  it("a signed-in buyer → client_reference_id, customer_email and metadata.user_id from Auth's answer", async () => {
    await startCheckout(deps, { itemId: ITEM_ID, locale: "en", accessToken: ACCESS_FX });
    expect(deps.auth.getUser).toHaveBeenCalledWith(ACCESS_FX);
    const params: unknown = deps.stripe.createGoodsCheckoutSession.mock.calls[0]?.[0];
    expect(params).toMatchObject({
      client_reference_id: OWNER_ID,
      customer_email: "owner@alnyron.dk",
      metadata: { user_id: OWNER_ID, locale: "en" },
      cancel_url: "https://alnyron.dk/en/figures/testfigur",
    });
  });

  it("no active offer → not_purchasable, no Stripe call", async () => {
    deps.rpc.goodsOffer.mockResolvedValue(null);
    const answer = await startCheckout(deps, { itemId: ITEM_ID, locale: "da" });
    expect(contract("startCheckout", answer)).toEqual({ ok: false, reason: "not_purchasable" });
    expect(deps.stripe.createGoodsCheckoutSession).not.toHaveBeenCalled();
  });

  it.each([
    ["the offer read fails", () => deps.rpc.goodsOffer.mockRejectedValue(new OrderRpcError("rpc_failed", "unknown", 503))],
    ["Stripe fails", () => deps.stripe.createGoodsCheckoutSession.mockResolvedValue({ ok: false, kind: "http", status: 403, code: null })],
    [
      "the session url is not on checkout.stripe.com",
      () => deps.stripe.createGoodsCheckoutSession.mockResolvedValue({ ok: true, data: { id: "cs_test_x1", url: "https://checkout.stripe.com.evil.example/pay" } }),
    ],
  ])("%s → unavailable", async (_label, arrange) => {
    arrange();
    expect(contract("startCheckout", await startCheckout(deps, { itemId: ITEM_ID, locale: "da" }))).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
});

// ── withdraw ──────────────────────────────────────────────────────────────────

describe("S2-WD-3 (S2-T-WD-01): link — a token that does not verify → refused", () => {
  it("a wrong token → refused, nothing recorded", async () => {
    const answer = await withdrawOrder(deps, LINK_INPUT);
    expect(contract("withdraw", answer)).toEqual({ ok: false, reason: "refused" });
    expect(deps.rpc.beginOrderWithdrawal).not.toHaveBeenCalled();
  });

  it("the order's own token (HMAC under ORDER_LINK_SECRET) → the notice is recorded for that order", async () => {
    const token = await orderLinkToken(LINK_FX, ORDER_ID);
    const answer = await withdrawOrder(deps, { ...LINK_INPUT, token });
    expect(contract("withdraw", answer)).toEqual({ ok: true, status: "received" });
    expect(deps.rpc.beginOrderWithdrawal).toHaveBeenCalledExactlyOnceWith({
      orderId: ORDER_ID,
      consumerName: "Lars Andersen",
      channel: "link",
      statementVersion: GOODS_TEXT_VERSION,
      locale: "da",
    });
  });

  it("another order's token → refused", async () => {
    const token = await orderLinkToken(LINK_FX, "00000000-0000-0000-0000-000000000099");
    expect((await withdrawOrder(deps, { ...LINK_INPUT, token })).result).toEqual({ ok: false, reason: "refused" });
  });
});

describe("S2-WD-4 (S2-T-WD-02): form — number + email that match no order → refused", () => {
  it("payments_find_order answers null → refused", async () => {
    deps.rpc.findOrder.mockResolvedValue(null);
    const answer = await withdrawOrder(deps, FORM_INPUT);
    expect(contract("withdraw", answer)).toEqual({ ok: false, reason: "refused" });
    expect(deps.rpc.findOrder).toHaveBeenCalledWith(1001, "delivered+s2@resend.dev");
    expect(deps.rpc.beginOrderWithdrawal).not.toHaveBeenCalled();
  });

  it("a matching order → recorded through the form channel", async () => {
    await withdrawOrder(deps, FORM_INPUT);
    expect(deps.rpc.beginOrderWithdrawal).toHaveBeenCalledWith(expect.objectContaining({ orderId: ORDER_ID, channel: "form" }));
  });
});

describe("S2-WD-5 (S2-T-WD-03): a statement version other than GOODS_TEXT_VERSION → invalid_input", () => {
  it.each([LINK_INPUT, FORM_INPUT])("channel %#", async (input) => {
    const result = await new OrderService({}, FAKE_ENV).withdraw({ ...input, statementVersion: "goods-wrong-version" });
    expect(result).toEqual({ ok: false, reason: "invalid_input" });
    expect(deps.rpc.beginOrderWithdrawal).not.toHaveBeenCalled();
  });
});

describe("S2-WD-6 (S2-T-WD-04): an order no longer withdrawable → the same refused", () => {
  it.each([
    ["not_withdrawable (refunded or canceled)", () => deps.rpc.beginOrderWithdrawal.mockResolvedValue({ outcome: "not_withdrawable" })],
    ["P0002 order_not_found", () => deps.rpc.beginOrderWithdrawal.mockRejectedValue(new OrderRpcError("order_not_found", "P0002", 404))],
  ])("%s", async (_label, arrange) => {
    arrange();
    expect(contract("withdraw", await withdrawOrder(deps, FORM_INPUT))).toEqual({ ok: false, reason: "refused" });
    expect(deps.mail.sendWithdrawalAck).not.toHaveBeenCalled();
  });
});

describe("S2-WD-7 (S2-T-WD-05): a new notice → received; the receipt to the order's email and the owner's alert", () => {
  it("sends both and records ack_sent and owner_alerted with their email ids", async () => {
    const answer = await withdrawOrder(deps, FORM_INPUT);
    expect(contract("withdraw", answer)).toEqual({ ok: true, status: "received" });
    expect(deps.mail.sendWithdrawalAck).toHaveBeenCalledExactlyOnceWith(ORDER, WITHDRAWAL);
    expect(deps.mail.sendWithdrawalAlert).toHaveBeenCalledExactlyOnceWith(ORDER, WITHDRAWAL);
    expect(deps.rpc.orderWithdrawalStep.mock.calls).toEqual([
      [WD_ID, "ack_sent", { email_id: "em-ack" }],
      [WD_ID, "owner_alerted", { email_id: "em-alert" }],
    ]);
  });

  it("a failed send is left to the sweep (mail_failed); the answer is still received", async () => {
    deps.mail.sendWithdrawalAck.mockRejectedValue(new MailError("transient"));
    expect((await withdrawOrder(deps, FORM_INPUT)).result).toEqual({ ok: true, status: "received" });
    expect(deps.rpc.orderWithdrawalStep.mock.calls).toEqual([
      [WD_ID, "mail_failed", {}],
      [WD_ID, "owner_alerted", { email_id: "em-alert" }],
    ]);
  });

  it("the database failing before the notice is recorded → unavailable", async () => {
    deps.rpc.beginOrderWithdrawal.mockRejectedValue(new OrderRpcError("rpc_failed", "unknown", 503));
    expect(contract("withdraw", await withdrawOrder(deps, FORM_INPUT))).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("S2-WD-8 (S2-T-WD-06): a repeated notice → received, no second emails", () => {
  it("outcome existing sends nothing", async () => {
    deps.rpc.beginOrderWithdrawal.mockResolvedValue({ outcome: "existing", withdrawal: WITHDRAWAL, order: ORDER });
    expect(contract("withdraw", await withdrawOrder(deps, FORM_INPUT))).toEqual({ ok: true, status: "received" });
    expect(deps.mail.sendWithdrawalAck).not.toHaveBeenCalled();
    expect(deps.mail.sendWithdrawalAlert).not.toHaveBeenCalled();
    expect(deps.rpc.orderWithdrawalStep).not.toHaveBeenCalled();
  });
});

// ── markShipped ───────────────────────────────────────────────────────────────

const SHIP_INPUT = { accessToken: ACCESS_FX, orderId: ORDER_ID, trackingRef: "GLS123" };

describe("S2-SEC-8 (S2-T-SVC-02): markShipped — Auth refuses the token → unauthenticated", () => {
  it("nothing is written or captured", async () => {
    deps.auth.getUser.mockResolvedValue(null);
    expect(contract("markShipped", await markShipped(deps, SHIP_INPUT))).toEqual({ ok: false, reason: "unauthenticated" });
    expect(deps.rpc.beginShip).not.toHaveBeenCalled();
    expect(deps.stripe.capturePaymentIntent).not.toHaveBeenCalled();
  });
});

describe("markShipped: begin_ship's refusals", () => {
  it.each([
    [new OrderRpcError("forbidden", "42501", 403), { ok: false, reason: "forbidden" }],
    [new OrderRpcError("order_not_found", "P0002", 404), { ok: false, reason: "not_found" }],
    [new OrderRpcError("order_closed", "P0001", 400), { ok: false, reason: "conflict", subreason: "order_closed" }],
    [new OrderRpcError("withdrawal_pending", "P0001", 400), { ok: false, reason: "conflict", subreason: "withdrawal_pending" }],
    [new OrderRpcError("rpc_failed", "unknown", 503), { ok: false, reason: "unavailable" }],
  ])("%s → %o, no capture", async (error, expected) => {
    deps.rpc.beginShip.mockRejectedValue(error);
    expect(contract("markShipped", await markShipped(deps, SHIP_INPUT))).toEqual(expected);
    expect(deps.stripe.capturePaymentIntent).not.toHaveBeenCalled();
  });

  it("already shipped → already_shipped, no capture, no email", async () => {
    deps.rpc.beginShip.mockResolvedValue({ outcome: "already_shipped", order: SHIPPED });
    expect(contract("markShipped", await markShipped(deps, SHIP_INPUT))).toEqual({ ok: true, status: "already_shipped" });
    expect(deps.stripe.capturePaymentIntent).not.toHaveBeenCalled();
    expect(deps.mail.sendShipped).not.toHaveBeenCalled();
  });
});

describe("S2-CAP-13 (S2-T-SVC-CAP-01): markShipped captures, then records shipped and sends the shipped email", () => {
  it("begin_ship (with the tracking) → capture (ord-cap key per order) → captured → shipped email stamped → shipped", async () => {
    expect(contract("markShipped", await markShipped(deps, SHIP_INPUT))).toEqual({ ok: true, status: "shipped" });
    expect(deps.rpc.beginShip).toHaveBeenCalledExactlyOnceWith(ORDER_ID, OWNER_ID, "GLS123");
    expect(deps.stripe.capturePaymentIntent).toHaveBeenCalledExactlyOnceWith(PI_ID, ORDER_ID);
    expect(deps.rpc.orderCaptured).toHaveBeenCalledExactlyOnceWith(ORDER_ID, OWNER_ID);
    expect(deps.mail.sendShipped).toHaveBeenCalledExactlyOnceWith(SHIPPED);
    expect(deps.rpc.orderMailSent.mock.calls).toEqual([[ORDER_ID, "shipped", "em-shipped"]]);
    expect(deps.rpc.captureFailed).not.toHaveBeenCalled();
  });

  it("no tracking reference → begin_ship gets null", async () => {
    await markShipped(deps, { accessToken: ACCESS_FX, orderId: ORDER_ID });
    expect(deps.rpc.beginShip).toHaveBeenCalledWith(ORDER_ID, OWNER_ID, null);
  });

  it("captured at Checkout already (captured_at set) → no capture call, marked shipped", async () => {
    deps.rpc.beginShip.mockResolvedValue({ outcome: "capture", order: { ...ORDER, captured_at: ORDER.paid_at } });
    expect((await markShipped(deps, SHIP_INPUT)).result).toEqual({ ok: true, status: "shipped" });
    expect(deps.stripe.capturePaymentIntent).not.toHaveBeenCalled();
    expect(deps.rpc.orderCaptured).toHaveBeenCalledOnce();
  });

  it("a 400 payment_intent_unexpected_state whose re-read shows succeeded (captured before) → shipped", async () => {
    deps.stripe.capturePaymentIntent.mockResolvedValue({ ok: false, kind: "http", status: 400, code: "payment_intent_unexpected_state" });
    deps.stripe.retrievePaymentIntent.mockResolvedValue({ ok: true, data: { id: PI_ID, status: "succeeded" } });
    expect((await markShipped(deps, SHIP_INPUT)).result).toEqual({ ok: true, status: "shipped" });
    expect(deps.stripe.retrievePaymentIntent).toHaveBeenCalledExactlyOnceWith(PI_ID);
  });

  it("the shipped email failing counts 'failed' (the sweep resends it); the order is shipped", async () => {
    deps.mail.sendShipped.mockRejectedValue(new MailError("transient"));
    expect((await markShipped(deps, SHIP_INPUT)).result).toEqual({ ok: true, status: "shipped" });
    expect(deps.rpc.orderMailSent.mock.calls).toEqual([[ORDER_ID, "failed", ""]]);
  });

  it.each([
    ["a re-read showing canceled", { ok: false, kind: "http", status: 400, code: "payment_intent_unexpected_state" }, { ok: true, data: { id: PI_ID, status: "canceled" } }],
    ["charge_expired_for_capture", { ok: false, kind: "http", status: 400, code: "charge_expired_for_capture" }, null],
  ])("the authorization lapsed (%s) → canceled, the owner's expired alert stamped, conflict authorization_expired", async (_label, capture, reread) => {
    deps.stripe.capturePaymentIntent.mockResolvedValue(capture);
    if (reread !== null) deps.stripe.retrievePaymentIntent.mockResolvedValue(reread);
    const canceled = { ...ORDER, status: "canceled" as const, cancel_reason: "authorization_expired" as const };
    deps.rpc.captureFailed.mockResolvedValue({ outcome: "canceled", order: canceled });
    expect(contract("markShipped", await markShipped(deps, SHIP_INPUT))).toEqual({
      ok: false,
      reason: "conflict",
      subreason: "authorization_expired",
    });
    expect(deps.rpc.captureFailed).toHaveBeenCalledExactlyOnceWith(ORDER_ID, "authorization_expired");
    expect(deps.mail.sendAuthorizationExpired).toHaveBeenCalledExactlyOnceWith(canceled);
    expect(deps.rpc.orderMailSent.mock.calls).toEqual([[ORDER_ID, "expired_alert", "em-expired"]]);
    expect(deps.rpc.orderCaptured).not.toHaveBeenCalled();
    expect(deps.mail.sendShipped).not.toHaveBeenCalled();
  });

  it.each([
    ["Stripe 503", { ok: false, kind: "http", status: 503, code: null }],
    ["Stripe 429", { ok: false, kind: "http", status: 429, code: "rate_limit" }],
    ["Stripe 409 (the key's first request still running)", { ok: false, kind: "http", status: 409, code: "idempotency_key_in_use" }],
    ["Stripe 403 (the key lacks PaymentIntents: Write)", { ok: false, kind: "http", status: 403, code: "permission_denied" }],
    ["Stripe 401", { ok: false, kind: "http", status: 401, code: null }],
    ["network", { ok: false, kind: "network" }],
    ["a capture not succeeded", { ok: true, data: { id: PI_ID, status: "processing" } }],
  ])("a transient failure (%s) → unavailable, nothing marked shipped or failed", async (_label, capture) => {
    deps.stripe.capturePaymentIntent.mockResolvedValue(capture);
    expect(contract("markShipped", await markShipped(deps, SHIP_INPUT))).toEqual({ ok: false, reason: "unavailable" });
    expect(deps.rpc.captureFailed).not.toHaveBeenCalled();
    expect(deps.rpc.orderCaptured).not.toHaveBeenCalled();
  });

  it("a refusal whose re-read fails → unavailable, nothing changed", async () => {
    deps.stripe.capturePaymentIntent.mockResolvedValue({ ok: false, kind: "http", status: 402, code: "card_declined" });
    deps.stripe.retrievePaymentIntent.mockResolvedValue({ ok: false, kind: "network" });
    expect((await markShipped(deps, SHIP_INPUT)).result).toEqual({ ok: false, reason: "unavailable" });
    expect(deps.rpc.captureFailed).not.toHaveBeenCalled();
  });

  it("payments_order_captured failing after a successful capture → unavailable, no shipped email; clicking again captures under the same key and records shipped", async () => {
    deps.rpc.orderCaptured.mockRejectedValueOnce(new OrderRpcError("rpc_failed", "unknown", 503));
    expect(contract("markShipped", await markShipped(deps, SHIP_INPUT))).toEqual({ ok: false, reason: "unavailable" });
    expect(deps.mail.sendShipped).not.toHaveBeenCalled();
    expect(deps.rpc.orderMailSent).not.toHaveBeenCalled();
    // The order is still unshipped, so begin_ship answers capture again; Stripe answers the same
    // Idempotency-Key (ord-cap-<order id>, orders-stripe.test.ts) with the first capture.
    expect(contract("markShipped", await markShipped(deps, SHIP_INPUT))).toEqual({ ok: true, status: "shipped" });
    expect(deps.stripe.capturePaymentIntent.mock.calls).toEqual([
      [PI_ID, ORDER_ID],
      [PI_ID, ORDER_ID],
    ]);
    expect(deps.rpc.orderCaptured).toHaveBeenCalledTimes(2);
    expect(deps.rpc.orderMailSent.mock.calls).toEqual([[ORDER_ID, "shipped", "em-shipped"]]);
  });

  it("payments_order_capture_failed failing for a lapsed authorization → unavailable (code capture_failed_rpc_…), no alert sent", async () => {
    deps.stripe.capturePaymentIntent.mockResolvedValue({ ok: false, kind: "http", status: 400, code: "charge_expired_for_capture" });
    deps.rpc.captureFailed.mockRejectedValue(new OrderRpcError("rpc_failed", "unknown", 503));
    const answer = await markShipped(deps, SHIP_INPUT);
    expect(answer).toEqual({ result: { ok: false, reason: "unavailable" }, order: ORDER_ID, code: "capture_failed_rpc_unknown" });
    contract("markShipped", answer);
    expect(deps.rpc.captureFailed).toHaveBeenCalledExactlyOnceWith(ORDER_ID, "authorization_expired");
    expect(deps.mail.sendAuthorizationExpired).not.toHaveBeenCalled();
    expect(deps.rpc.orderMailSent).not.toHaveBeenCalled();
    expect(deps.rpc.orderCaptured).not.toHaveBeenCalled();
  });
});

describe("S2-CAP-13 / A2-3 (S2-T-SVC-CAP-03): a capture refused for another reason → capture_refused", () => {
  it("402 card_declined with the payment intent still requires_capture → flagged, the owner alerted, not shipped", async () => {
    deps.stripe.capturePaymentIntent.mockResolvedValue({ ok: false, kind: "http", status: 402, code: "card_declined" });
    deps.stripe.retrievePaymentIntent.mockResolvedValue({ ok: true, data: { id: PI_ID, status: "requires_capture" } });
    const flagged = { ...ORDER, anomaly: "capture_failed" };
    deps.rpc.captureFailed.mockResolvedValue({ outcome: "unchanged", order: flagged });
    expect(contract("markShipped", await markShipped(deps, SHIP_INPUT))).toEqual({
      ok: false,
      reason: "conflict",
      subreason: "capture_refused",
    });
    expect(deps.rpc.captureFailed).toHaveBeenCalledExactlyOnceWith(ORDER_ID, "capture_refused");
    expect(deps.mail.sendCaptureFailed).toHaveBeenCalledExactlyOnceWith(flagged);
    expect(deps.rpc.orderCaptured).not.toHaveBeenCalled();
    expect(deps.mail.sendShipped).not.toHaveBeenCalled();
    // No stamp column for this alert: the order's capture_failed anomaly stays for the admin.
    expect(deps.rpc.orderMailSent).not.toHaveBeenCalled();
  });

  it("the owner alert failing does not change the answer", async () => {
    deps.stripe.capturePaymentIntent.mockResolvedValue({ ok: false, kind: "http", status: 402, code: "card_declined" });
    deps.rpc.captureFailed.mockResolvedValue({ outcome: "unchanged", order: ORDER });
    deps.mail.sendCaptureFailed.mockRejectedValue(new MailError("config"));
    expect((await markShipped(deps, SHIP_INPUT)).result).toEqual({ ok: false, reason: "conflict", subreason: "capture_refused" });
  });

  it("payments_order_capture_failed failing → unavailable (code capture_failed_rpc_…), no alert sent, not shipped", async () => {
    deps.stripe.capturePaymentIntent.mockResolvedValue({ ok: false, kind: "http", status: 402, code: "card_declined" });
    deps.stripe.retrievePaymentIntent.mockResolvedValue({ ok: true, data: { id: PI_ID, status: "requires_capture" } });
    deps.rpc.captureFailed.mockRejectedValue(new OrderRpcError("rpc_failed", "unknown", 503));
    const answer = await markShipped(deps, SHIP_INPUT);
    expect(answer).toEqual({ result: { ok: false, reason: "unavailable" }, order: ORDER_ID, code: "capture_failed_rpc_unknown" });
    contract("markShipped", answer);
    expect(deps.rpc.captureFailed).toHaveBeenCalledExactlyOnceWith(ORDER_ID, "capture_refused");
    expect(deps.mail.sendCaptureFailed).not.toHaveBeenCalled();
    expect(deps.rpc.orderCaptured).not.toHaveBeenCalled();
  });
});

// ── approveRefund ─────────────────────────────────────────────────────────────

const APPROVE_INPUT = { accessToken: ACCESS_FX, orderId: ORDER_ID, goodsState: "not_shipped" as const, deductionOre: 0 };

describe("S2-SEC-8 (S2-T-SVC-03): approveRefund — Auth refuses the token → unauthenticated", () => {
  it("nothing is approved", async () => {
    deps.auth.getUser.mockResolvedValue(null);
    expect(contract("approveRefund", await approveRefund(deps, APPROVE_INPUT))).toEqual({ ok: false, reason: "unauthenticated" });
    expect(deps.rpc.approveOrderRefund).not.toHaveBeenCalled();
  });
});

describe("approveRefund: the writer's refusals", () => {
  it.each([
    [new OrderRpcError("forbidden", "42501", 403), { ok: false, reason: "forbidden" }],
    [new OrderRpcError("order_not_found", "P0002", 404), { ok: false, reason: "not_found" }],
    [new OrderRpcError("order_refunded", "P0001", 400), { ok: false, reason: "conflict", subreason: "order_refunded" }],
    [new OrderRpcError("order_shipped", "P0001", 400), { ok: false, reason: "conflict", subreason: "order_shipped" }],
    [new OrderRpcError("order_not_shipped", "P0001", 400), { ok: false, reason: "conflict", subreason: "order_not_shipped" }],
    [new OrderRpcError("deduction_invalid", "22023", 400), { ok: false, reason: "invalid_input", subreason: "deduction_invalid" }],
    [new OrderRpcError("deduction_reason_required", "22023", 400), { ok: false, reason: "invalid_input", subreason: "deduction_reason_required" }],
  ])("%s → %o, no pass", async (error, expected) => {
    deps.rpc.approveOrderRefund.mockRejectedValue(error);
    expect(contract("approveRefund", await approveRefund(deps, APPROVE_INPUT))).toEqual(expected);
    expect(mockProcessOrderRefund).not.toHaveBeenCalled();
  });

  it("passes the owner (from Auth), the goods state, the deduction and its reason (null when absent)", async () => {
    await approveRefund(deps, { ...APPROVE_INPUT, goodsState: "returned", deductionOre: 4995, deductionReason: "Ridser" });
    await approveRefund(deps, APPROVE_INPUT);
    expect(deps.rpc.approveOrderRefund.mock.calls).toEqual([
      [{ orderId: ORDER_ID, actor: OWNER_ID, goodsState: "returned", deductionOre: 4995, deductionReason: "Ridser" }],
      [{ orderId: ORDER_ID, actor: OWNER_ID, goodsState: "not_shipped", deductionOre: 0, deductionReason: null }],
    ]);
  });
});

describe("S2-CAP-15 (S2-T-SVC-CAP-02): approveRefund runs one pass and answers what it came to", () => {
  it.each(["canceled", "completed", "needs_manual", "approved"] as const)("a pass ending %s → {ok:true, status:%s}", async (status) => {
    mockProcessOrderRefund.mockResolvedValue(status);
    expect(contract("approveRefund", await approveRefund(deps, APPROVE_INPUT))).toEqual({ ok: true, status });
    expect(mockProcessOrderRefund).toHaveBeenCalledExactlyOnceWith(deps, WD_ID);
  });

  it("a pass that cannot claim (the database) → approved, the sweep finishes it", async () => {
    mockProcessOrderRefund.mockRejectedValue(new OrderRpcError("rpc_failed", "unknown", 503));
    expect((await approveRefund(deps, APPROVE_INPUT)).result).toEqual({ ok: true, status: "approved" });
  });

  it.each([
    [{ ...APPROVED_RELEASE, status: "completed" as const, authorization_canceled_at: "2026-11-17T10:00:00.000Z" }, "canceled"],
    [{ ...APPROVED_RELEASE, action: "refund" as const, refund_ore: 24995, status: "completed" as const }, "completed"],
    [{ ...APPROVED_RELEASE, status: "needs_manual" as const }, "needs_manual"],
  ])("approved before (already_approved, %#) → its state, no new pass", async (withdrawal, status) => {
    deps.rpc.approveOrderRefund.mockResolvedValue({ outcome: "already_approved", withdrawal, order: ORDER });
    expect((await approveRefund(deps, APPROVE_INPUT)).result).toEqual({ ok: true, status });
    expect(mockProcessOrderRefund).not.toHaveBeenCalled();
  });
});

// ── The entrypoint class ──────────────────────────────────────────────────────

describe("OrderService: input and env checks around every method", () => {
  it.each([
    ["startCheckout", { itemId: "not-a-uuid", locale: "da" }],
    ["withdraw", { channel: "phone", orderId: ORDER_ID }],
    ["markShipped", { accessToken: ACCESS_FX, orderId: ORDER_ID, extra: true }],
    ["approveRefund", { accessToken: ACCESS_FX, orderId: ORDER_ID, goodsState: "lost", deductionOre: 0 }],
  ] as const)("%s with a malformed input → invalid_input", async (method, input) => {
    const service = new OrderService({}, FAKE_ENV);
    await expect(service[method](input)).resolves.toEqual({ ok: false, reason: "invalid_input" });
  });

  it("an invalid orders env (no ORDER_LINK_SECRET) → unavailable before any call", async () => {
    const { ORDER_LINK_SECRET: _omitted, ...env } = FAKE_ENV;
    void _omitted;
    await expect(new OrderService({}, env).startCheckout({ itemId: ITEM_ID, locale: "da" })).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(deps.rpc.goodsOffer).not.toHaveBeenCalled();
  });

  it("a valid call runs its handler and logs one line of ids and codes (no token, no email)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const result = await new OrderService({}, FAKE_ENV).markShipped(SHIP_INPUT);
      expect(result).toEqual({ ok: true, status: "shipped" });
      expect(log).toHaveBeenCalledOnce();
      const line = String(log.mock.calls[0]![0]);
      expect(JSON.parse(line)).toEqual({ msg: "payments order service", method: "markShipped", outcome: "ok", code: "mail_sent", order: ORDER_ID });
      expect(line).not.toContain(ACCESS_FX);
      expect(line).not.toContain("@");
    } finally {
      log.mockRestore();
    }
  });

  it("a defect in a handler (an unguarded throw) → unavailable, logged unexpected", async () => {
    deps.stripe.createGoodsCheckoutSession.mockImplementation(() => {
      throw new TypeError("boom");
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(new OrderService({}, FAKE_ENV).startCheckout({ itemId: ITEM_ID, locale: "da" })).resolves.toEqual({
        ok: false,
        reason: "unavailable",
      });
      expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual({
        msg: "payments order service",
        method: "startCheckout",
        outcome: "unavailable",
        code: "unexpected",
        order: null,
      });
    } finally {
      log.mockRestore();
    }
  });
});

// ── parseOrdersEnv ────────────────────────────────────────────────────────────

describe("S2-SEC-9 (S2-T-SVC-04..05): parseOrdersEnv", () => {
  it("S2-T-SVC-04: a valid env → the three goods settings", () => {
    expect(parseOrdersEnv(FAKE_ENV)).toEqual({
      orderLinkSecret: LINK_FX,
      orderNotifyTo: "info@alnyron.dk",
      stripeTaxRateId: "txr_1Ubdp4FBWtA5MNzbg2ZKznPw",
    });
  });

  /** Invalid ORDER_LINK_SECRET values: 31 characters (one short), and two words. */
  const SHORT_LINK_SECRET = "too-short-31-characters-xxxxxxx";
  const SPACED_LINK_SECRET = `${"x".repeat(20)} ${"y".repeat(20)}`;

  it.each([
    ["ORDER_LINK_SECRET", { ORDER_LINK_SECRET: undefined }],
    ["ORDER_LINK_SECRET", { ORDER_LINK_SECRET: SHORT_LINK_SECRET }],
    ["ORDER_LINK_SECRET", { ORDER_LINK_SECRET: SPACED_LINK_SECRET }],
    ["ORDER_NOTIFY_TO", { ORDER_NOTIFY_TO: "not an address" }],
    ["STRIPE_TAX_RATE_ID", { STRIPE_TAX_RATE_ID: "rate_25" }],
  ])("S2-T-SVC-05: %s missing or invalid → throws naming the key, never a value", (key, override) => {
    const env = { ...FAKE_ENV, ...override };
    expect(() => parseOrdersEnv(env)).toThrow(new Error(`payments: missing or invalid orders environment keys: ${key}`));
  });
});
