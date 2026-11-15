/**
 * Unit tests: workers/payments/orders/rpc.ts — the goods writers' wrappers and reads over
 * supabase-js on a fake fetch (the real PostgREST request and answer shapes)
 * Journey: payments-s2-3d-purchase
 * Criteria: S2-SEC-5 (service-role writers called by the Worker only, as JSON parameters),
 *   S2-WD-6..8 (begin withdrawal without a signed-in user), S2-SWP-1 (pending work shape),
 *   S2-ADM-1..6 (writer refusals mapped by SQLSTATE, never echoing the database's text),
 *   S2-CHK-12, S2-WD-13, S2-ADM-7..23, S2-CAP-6 (each wrapper's request and answer mapping),
 *   the order and withdrawal snapshot parsers (a malformed field rejects the snapshot)
 */
import { describe, expect, it } from "vitest";
import {
  createOrderRpc,
  OrderRpcError,
  orderRefusal,
  parseOrderSnapshot,
  parseOrderWithdrawalSnapshot,
} from "../../../../workers/payments/orders/rpc";
import type { GoodsOrderInput } from "@/lib/payments/orders/session";

const SUPABASE_URL = "https://e2eproject.supabase.co";
const SB_KEY_FX = "sb_secret_unitorders1234";
const ORDER_ID = "00000000-0000-0000-0000-0000000000b1";
const WD_ID = "00000000-0000-0000-0000-0000000000a1";
const PI_ID = "pi_s2rpc000000000001";

/** An order row as payments_order_json writes it (to_jsonb + lines). */
const ORDER_JSON = {
  id: ORDER_ID,
  order_number: 1001,
  user_id: null,
  email: "delivered+s2@resend.dev",
  customer_name: "Lars Andersen",
  phone: "+4520123456",
  shipping_name: "Lars Andersen",
  shipping_address: { line1: "Testvej 1", line2: null, postal_code: "7860", city: "Spøttrup", country: "DK" },
  locale: "da",
  currency: "dkk",
  amount_total_ore: 24995,
  amount_refunded_ore: 0,
  status: "authorized",
  stripe_payment_intent_id: PI_ID,
  paid_at: "2026-11-14T10:00:00+00:00",
  authorization_expires_at: "2026-11-21T10:00:00+00:00",
  captured_at: null,
  canceled_at: null,
  cancel_reason: null,
  anomaly: null,
  tracking_ref: null,
  lines: [{ line_no: 1, item_id: null, offer_kind: "physical", title: "Testfigur", quantity: 1, unit_amount_ore: 24995 }],
};

const WITHDRAWAL_JSON = {
  id: WD_ID,
  order_id: ORDER_ID,
  status: "received",
  consumer_name: "Lars Andersen",
  locale: "da",
  requested_at: "2026-11-16T10:00:00+00:00",
  refund_due_at: "2026-11-30T10:00:00+00:00",
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

type Request = { method: string; url: URL; body: unknown };

/** A fake Supabase: `answer` per request (status 200 JSON by default); every request recorded. */
function fakeSupabase(answer: (request: Request) => { status?: number; body: unknown }) {
  const requests: Request[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    };
    requests.push(request);
    const { status = 200, body } = answer(request);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { requests, rpc: createOrderRpc(SUPABASE_URL, SB_KEY_FX, fetchImpl) };
}

describe("writers: JSON parameters to /rest/v1/rpc/<writer>, answers checked", () => {
  it("recordOrder posts p_event and p_order and answers the recorded order", async () => {
    const order: GoodsOrderInput = {
      stripe_checkout_session_id: "cs_test_s2rpc0001",
      stripe_payment_intent_id: PI_ID,
      stripe_customer_id: null,
      stripe_invoice_id: null,
      user_id: null,
      email: "delivered+s2@resend.dev",
      customer_name: "Lars Andersen",
      phone: null,
      shipping_name: "Lars Andersen",
      shipping_address: { line1: "Testvej 1", line2: null, postal_code: "7860", city: "Spøttrup", country: "DK" },
      locale: "da",
      currency: "dkk",
      amount_subtotal_ore: 24995,
      amount_tax_ore: 4999,
      amount_total_ore: 24995,
      terms_version: "goods-2026-11-14.1",
      terms_sha256: null,
      stripe_consent: "accepted",
      anomaly: null,
      paid_at: "2026-11-14T10:00:00.000Z",
      capture_state: "requires_capture",
      authorization_expires_at: "2026-11-21T10:00:00.000Z",
      lines: [
        {
          line_no: 1,
          item_id: null,
          offer_kind: "physical",
          title: "Testfigur",
          quantity: 1,
          unit_amount_ore: 24995,
          amount_total_ore: 24995,
          amount_tax_ore: 4999,
        },
      ],
    };
    const { requests, rpc } = fakeSupabase(() => ({ body: { outcome: "recorded", order_id: ORDER_ID, order_number: 1001 } }));
    const event = { id: "evt_s2rpc01", type: "checkout.session.completed", created: "2026-11-14T10:00:00.000Z", livemode: false };
    await expect(rpc.recordOrder(event, order)).resolves.toEqual({ outcome: "recorded", orderId: ORDER_ID, orderNumber: 1001 });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.url.pathname).toBe("/rest/v1/rpc/payments_record_order");
    expect(requests[0]!.body).toEqual({ p_event: event, p_order: order });
  });

  it("beginOrderWithdrawal sends exactly the five writer arguments, no user id (a link or form notice carries no account)", async () => {
    const { requests, rpc } = fakeSupabase(() => ({
      body: { outcome: "created", withdrawal: WITHDRAWAL_JSON, order: ORDER_JSON },
    }));
    const answer = await rpc.beginOrderWithdrawal({
      orderId: ORDER_ID,
      consumerName: "Lars Andersen",
      channel: "link",
      statementVersion: "goods-2026-11-14.1",
      locale: "da",
    });
    expect(answer).toMatchObject({ outcome: "created", withdrawal: { id: WD_ID }, order: { id: ORDER_ID, line: { title: "Testfigur", quantity: 1 } } });
    expect(requests[0]!.body).toEqual({
      p_order_id: ORDER_ID,
      p_consumer_name: "Lars Andersen",
      p_channel: "link",
      p_statement_version: "goods-2026-11-14.1",
      p_locale: "da",
    });
  });

  it("beginShip leaves p_tracking_ref out without one (its SQL default NULL)", async () => {
    const { requests, rpc } = fakeSupabase(() => ({ body: { outcome: "capture", order: ORDER_JSON } }));
    await rpc.beginShip(ORDER_ID, "00000000-0000-0000-0000-00000000000f", null);
    expect(requests[0]!.body).toEqual({ p_order_id: ORDER_ID, p_actor: "00000000-0000-0000-0000-00000000000f" });
    await rpc.beginShip(ORDER_ID, "00000000-0000-0000-0000-00000000000f", "GLS123");
    expect(requests[1]!.body).toMatchObject({ p_tracking_ref: "GLS123" });
  });

  it("pendingOrderWork maps the three lists, the manual_alert need included", async () => {
    const { rpc } = fakeSupabase(() => ({
      body: {
        orders_mail: [{ order_id: ORDER_ID, needs: ["confirmation", "expired_alert"] }],
        withdrawals: [
          { withdrawal_id: WD_ID, needs: ["ack", "refund"] },
          { withdrawal_id: ORDER_ID, needs: ["manual_alert"] },
        ],
        orders_capture_warning: [{ order_id: ORDER_ID, needs: ["capture_warning"] }],
      },
    }));
    await expect(rpc.pendingOrderWork(20, 24)).resolves.toEqual({
      ordersMail: [{ orderId: ORDER_ID, needs: ["confirmation", "expired_alert"] }],
      withdrawals: [
        { withdrawalId: WD_ID, needs: ["ack", "refund"] },
        { withdrawalId: ORDER_ID, needs: ["manual_alert"] },
      ],
      captureWarnings: [ORDER_ID],
    });
  });

  it.each([
    ["an unknown need", { orders_mail: [{ order_id: ORDER_ID, needs: ["invoice"] }], withdrawals: [], orders_capture_warning: [] }],
    ["a missing list", { orders_mail: [], withdrawals: [] }],
  ])("pendingOrderWork: %s → invalid_response", async (_label, body) => {
    const { rpc } = fakeSupabase(() => ({ body }));
    await expect(rpc.pendingOrderWork(20, 24)).rejects.toMatchObject({ code: "invalid_response", refusal: null });
  });

  it("an answer of the wrong shape is an invalid_response", async () => {
    const { rpc } = fakeSupabase(() => ({ body: { outcome: "shipped", order: { id: ORDER_ID } } }));
    await expect(rpc.orderCaptured(ORDER_ID, "00000000-0000-0000-0000-00000000000f")).rejects.toMatchObject({
      message: "rpc_failed",
      code: "invalid_response",
    });
  });
});

describe("S2-ADM-1..6: refusals by SQLSTATE; the database's text is never echoed", () => {
  it.each([
    ["P0001", "order_closed"],
    ["P0001", "withdrawal_pending"],
    ["P0002", "order_not_found"],
    ["42501", "forbidden"],
    ["22023", "deduction_reason_required"],
  ])("%s %s → refusal", async (code, message) => {
    const { rpc } = fakeSupabase(() => ({ status: 400, body: { code, message, details: null, hint: null } }));
    const error = await rpc.beginShip(ORDER_ID, "00000000-0000-0000-0000-00000000000f", null).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OrderRpcError);
    expect(orderRefusal(error)).toEqual({ code, reason: message });
    expect(error).toMatchObject({ message, status: 400 });
  });

  it("an unknown message (e.g. a constraint text echoing a value) is rpc_failed with no refusal", async () => {
    const { rpc } = fakeSupabase(() => ({
      status: 400,
      body: { code: "23514", message: 'new row for relation "orders" violates check constraint, value delivered+s2@resend.dev' },
    }));
    const error = await rpc.orderMailSent(ORDER_ID, "owner", "em-1").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ message: "rpc_failed", code: "23514", refusal: null });
    expect(orderRefusal(error)).toBeNull();
  });
});

describe("reads: one GET each (.retry(false)), the order with its first line", () => {
  it("readOrder selects the order with its lines and maps order_items to the line", async () => {
    const { requests, rpc } = fakeSupabase(() => ({
      body: [{ ...ORDER_JSON, lines: undefined, order_items: [{ line_no: 1, title: "Testfigur", quantity: 1 }] }],
    }));
    const order = await rpc.readOrder(ORDER_ID);
    expect(order).toMatchObject({ id: ORDER_ID, order_number: 1001, line: { title: "Testfigur", quantity: 1 } });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.url.pathname).toBe("/rest/v1/orders");
    expect(requests[0]!.url.searchParams.get("id")).toBe(`eq.${ORDER_ID}`);
    expect(requests[0]!.url.searchParams.get("select")).toContain("order_items(line_no,title,quantity)");
  });

  it("readOrder: no row → null; a 503 is not retried", async () => {
    const empty = fakeSupabase(() => ({ body: [] }));
    await expect(empty.rpc.readOrder(ORDER_ID)).resolves.toBeNull();
    const down = fakeSupabase(() => ({ status: 503, body: { message: "unavailable" } }));
    await expect(down.rpc.readOrder(ORDER_ID)).rejects.toBeInstanceOf(OrderRpcError);
    expect(down.requests).toHaveLength(1);
  });

  it("readOrderWithdrawal embeds the order", async () => {
    const { requests, rpc } = fakeSupabase(() => ({
      body: [{ ...WITHDRAWAL_JSON, orders: { ...ORDER_JSON, lines: undefined, order_items: [{ line_no: 1, title: "Testfigur", quantity: 1 }] } }],
    }));
    await expect(rpc.readOrderWithdrawal(WD_ID)).resolves.toMatchObject({ withdrawal: { id: WD_ID }, order: { id: ORDER_ID } });
    expect(requests[0]!.url.pathname).toBe("/rest/v1/order_withdrawals");
  });
});

describe("S2-CHK-12, S2-WD-13: the read writers' requests and answers", () => {
  const OFFER = { item_id: "00000000-0000-0000-0000-0000000000c1", price_ore: 24995, title: "Testfigur", section_slug: "figurer", item_slug: "dragon", locale: "da" };

  it("goodsOffer posts p_item_id and p_locale and maps the snapshot; a null answer is null (not purchasable)", async () => {
    const { requests, rpc } = fakeSupabase(() => ({ body: OFFER }));
    await expect(rpc.goodsOffer(OFFER.item_id, "en")).resolves.toEqual(OFFER);
    expect(requests[0]!.url.pathname).toBe("/rest/v1/rpc/payments_goods_offer");
    expect(requests[0]!.body).toEqual({ p_item_id: OFFER.item_id, p_locale: "en" });
    const none = fakeSupabase(() => ({ body: null }));
    await expect(none.rpc.goodsOffer(OFFER.item_id, "da")).resolves.toBeNull();
  });

  it.each([
    ["a price of 0", { ...OFFER, price_ore: 0 }],
    ["a negative price", { ...OFFER, price_ore: -1 }],
    ["a fractional price", { ...OFFER, price_ore: 249.95 }],
    ["no title", { ...OFFER, title: undefined }],
    ["an unknown locale", { ...OFFER, locale: "de" }],
    ["not an object", "offer"],
  ])("goodsOffer: %s → invalid_response", async (_label, body) => {
    const { rpc } = fakeSupabase(() => ({ body }));
    await expect(rpc.goodsOffer(OFFER.item_id, "da")).rejects.toMatchObject({ code: "invalid_response", refusal: null });
  });

  it("findOrder posts p_order_number and p_email: the order id, or null for no match; a non-string id is invalid_response", async () => {
    const { requests, rpc } = fakeSupabase(() => ({ body: { order_id: ORDER_ID } }));
    await expect(rpc.findOrder(1001, "delivered+s2@resend.dev")).resolves.toBe(ORDER_ID);
    expect(requests[0]!.url.pathname).toBe("/rest/v1/rpc/payments_find_order");
    expect(requests[0]!.body).toEqual({ p_order_number: 1001, p_email: "delivered+s2@resend.dev" });
    await expect(fakeSupabase(() => ({ body: { order_id: null } })).rpc.findOrder(1001, "x@y.dk")).resolves.toBeNull();
    await expect(fakeSupabase(() => ({ body: { order_id: 7 } })).rpc.findOrder(1001, "x@y.dk")).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
});

describe("S2-ADM-7..23: the approval, claim, step and capture writers' requests and answers", () => {
  const ACTOR = "00000000-0000-0000-0000-00000000000f";
  const APPROVED = { ...WITHDRAWAL_JSON, status: "approved", goods_state: "returned", action: "refund", refund_ore: 20000, deduction_ore: 4995 };

  it("approveOrderRefund leaves p_deduction_reason out without one (its SQL default NULL) and sends it with one", async () => {
    const { requests, rpc } = fakeSupabase(() => ({ body: { outcome: "approved", withdrawal: APPROVED, order: ORDER_JSON } }));
    const answer = await rpc.approveOrderRefund({ orderId: ORDER_ID, actor: ACTOR, goodsState: "not_shipped", deductionOre: 0, deductionReason: null });
    expect(requests[0]!.url.pathname).toBe("/rest/v1/rpc/payments_approve_order_refund");
    expect(requests[0]!.body).toEqual({ p_order_id: ORDER_ID, p_actor: ACTOR, p_goods_state: "not_shipped", p_deduction_ore: 0 });
    expect(answer).toMatchObject({ outcome: "approved", withdrawal: { id: WD_ID, action: "refund", refund_ore: 20000 }, order: { id: ORDER_ID } });
    await rpc.approveOrderRefund({ orderId: ORDER_ID, actor: ACTOR, goodsState: "returned", deductionOre: 4995, deductionReason: "Ridser" });
    expect(requests[1]!.body).toEqual({
      p_order_id: ORDER_ID,
      p_actor: ACTOR,
      p_goods_state: "returned",
      p_deduction_ore: 4995,
      p_deduction_reason: "Ridser",
    });
  });

  it("claimOrderWithdrawal posts the id and lease and maps claimed; a non-boolean claimed is invalid_response", async () => {
    const { requests, rpc } = fakeSupabase(() => ({ body: { claimed: false, withdrawal: APPROVED, order: ORDER_JSON } }));
    await expect(rpc.claimOrderWithdrawal(WD_ID, 120)).resolves.toMatchObject({ claimed: false, withdrawal: { id: WD_ID }, order: { id: ORDER_ID } });
    expect(requests[0]!.url.pathname).toBe("/rest/v1/rpc/payments_claim_order_withdrawal");
    expect(requests[0]!.body).toEqual({ p_withdrawal_id: WD_ID, p_lease_seconds: 120 });
    const bad = fakeSupabase(() => ({ body: { claimed: "yes", withdrawal: APPROVED, order: ORDER_JSON } }));
    await expect(bad.rpc.claimOrderWithdrawal(WD_ID, 120)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("orderWithdrawalStep posts p_withdrawal_id, p_step and p_data and maps the withdrawal, its manual reason included", async () => {
    const manual = { ...APPROVED, status: "needs_manual", manual_reason: "stripe_refused" };
    const { requests, rpc } = fakeSupabase(() => ({ body: { outcome: "already", withdrawal: manual } }));
    const answer = await rpc.orderWithdrawalStep(WD_ID, "manual_alert_sent", { email_id: "em-manual" });
    expect(requests[0]!.url.pathname).toBe("/rest/v1/rpc/payments_order_withdrawal_step");
    expect(requests[0]!.body).toEqual({ p_withdrawal_id: WD_ID, p_step: "manual_alert_sent", p_data: { email_id: "em-manual" } });
    expect(answer).toMatchObject({ outcome: "already", withdrawal: { id: WD_ID, status: "needs_manual", manual_reason: "stripe_refused" } });
  });

  it("orderCaptured maps the shipped order", async () => {
    const { requests, rpc } = fakeSupabase(() => ({ body: { outcome: "shipped", order: { ...ORDER_JSON, status: "shipped" } } }));
    await expect(rpc.orderCaptured(ORDER_ID, ACTOR)).resolves.toMatchObject({ outcome: "shipped", order: { id: ORDER_ID, status: "shipped" } });
    expect(requests[0]!.body).toEqual({ p_order_id: ORDER_ID, p_actor: ACTOR });
  });

  it.each([
    ["authorization_expired", "canceled", { status: "canceled", cancel_reason: "authorization_expired" }],
    ["capture_refused", "unchanged", { anomaly: "capture_failed" }],
  ] as const)("captureFailed %s posts p_reason and maps %s", async (reason, outcome, fields) => {
    const { requests, rpc } = fakeSupabase(() => ({ body: { outcome, order: { ...ORDER_JSON, ...fields } } }));
    await expect(rpc.captureFailed(ORDER_ID, reason)).resolves.toMatchObject({ outcome, order: { id: ORDER_ID, ...fields } });
    expect(requests[0]!.url.pathname).toBe("/rest/v1/rpc/payments_order_capture_failed");
    expect(requests[0]!.body).toEqual({ p_order_id: ORDER_ID, p_reason: reason });
  });
});

describe("S2-ADM-19..20, S2-CAP-6: the webhook writers' requests and answers", () => {
  const EVENT = { id: "evt_s2rpc02", type: "charge.refunded", created: "2026-11-20T10:00:00.000Z", livemode: false };

  it("syncOrderRefund posts the event, payment intent and amount and maps synced; unknown_order and duplicate pass through", async () => {
    const { requests, rpc } = fakeSupabase(() => ({ body: { outcome: "synced", order_id: ORDER_ID, amount_refunded_ore: 20000, status: "refunded" } }));
    await expect(rpc.syncOrderRefund(EVENT, PI_ID, 20000)).resolves.toEqual({
      outcome: "synced",
      orderId: ORDER_ID,
      amountRefundedOre: 20000,
      status: "refunded",
    });
    expect(requests[0]!.url.pathname).toBe("/rest/v1/rpc/payments_sync_order_refund");
    expect(requests[0]!.body).toEqual({ p_event: EVENT, p_payment_intent: PI_ID, p_amount_refunded: 20000 });
    for (const outcome of ["unknown_order", "duplicate"] as const) {
      await expect(fakeSupabase(() => ({ body: { outcome } })).rpc.syncOrderRefund(EVENT, PI_ID, 1)).resolves.toEqual({ outcome });
    }
    const bad = fakeSupabase(() => ({ body: { outcome: "synced", order_id: ORDER_ID, amount_refunded_ore: 20000, status: "paid" } }));
    await expect(bad.rpc.syncOrderRefund(EVENT, PI_ID, 20000)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("authorizationCanceled maps canceled (with the order) and ignored (with the order id); ignored without an order id is invalid_response", async () => {
    const canceledEvent = { ...EVENT, type: "payment_intent.canceled" };
    const canceled = fakeSupabase(() => ({ body: { outcome: "canceled", order: { ...ORDER_JSON, status: "canceled", cancel_reason: "withdrawn" } } }));
    await expect(canceled.rpc.authorizationCanceled(canceledEvent, PI_ID)).resolves.toMatchObject({
      outcome: "canceled",
      order: { id: ORDER_ID, status: "canceled", cancel_reason: "withdrawn" },
    });
    expect(canceled.requests[0]!.url.pathname).toBe("/rest/v1/rpc/payments_order_authorization_canceled");
    expect(canceled.requests[0]!.body).toEqual({ p_event: canceledEvent, p_payment_intent: PI_ID });
    await expect(fakeSupabase(() => ({ body: { outcome: "ignored", order_id: ORDER_ID } })).rpc.authorizationCanceled(canceledEvent, PI_ID)).resolves.toEqual({
      outcome: "ignored",
      orderId: ORDER_ID,
    });
    await expect(fakeSupabase(() => ({ body: { outcome: "ignored" } })).rpc.authorizationCanceled(canceledEvent, PI_ID)).rejects.toMatchObject({
      code: "invalid_response",
    });
    await expect(fakeSupabase(() => ({ body: { outcome: "duplicate" } })).rpc.authorizationCanceled(canceledEvent, PI_ID)).resolves.toEqual({
      outcome: "duplicate",
    });
  });
});

describe("the snapshot parsers: a field of the wrong kind rejects the whole snapshot", () => {
  it("the order's line is the lowest line_no, whatever the array order", () => {
    const order = parseOrderSnapshot({
      ...ORDER_JSON,
      lines: [
        { line_no: 2, title: "Anden", quantity: 3 },
        { line_no: 1, title: "Første", quantity: 1 },
      ],
    });
    expect(order?.line).toEqual({ title: "Første", quantity: 1 });
  });

  it("a valid order and withdrawal parse; an address without a line2 key reads it as null", () => {
    const address = { line1: "Testvej 1", postal_code: "7860", city: "Spøttrup", country: "DK" };
    expect(parseOrderSnapshot({ ...ORDER_JSON, shipping_address: address })?.shipping_address).toEqual({ ...address, line2: null });
    expect(parseOrderWithdrawalSnapshot(WITHDRAWAL_JSON)).toEqual(WITHDRAWAL_JSON);
  });

  it.each([
    ["an unknown status", { status: "paid" }],
    ["an unknown cancel_reason", { cancel_reason: "fraud" }],
    ["a non-string address field", { shipping_address: { ...ORDER_JSON.shipping_address, postal_code: 7860 } }],
    ["an address that is no object", { shipping_address: "Testvej 1" }],
    ["an unknown locale", { locale: "de" }],
    ["a fractional amount", { amount_total_ore: 249.95 }],
    ["no lines", { lines: [] }],
    ["a line without a title", { lines: [{ line_no: 1, quantity: 1 }] }],
  ])("order: %s → null", (_label, fields) => {
    expect(parseOrderSnapshot({ ...ORDER_JSON, ...fields })).toBeNull();
  });

  it.each([
    ["an unknown status", { status: "refunded" }],
    ["an unknown action", { action: "credit_note" }],
    ["a non-boolean late", { late: "false" }],
    ["a non-boolean shipped_before_notice", { shipped_before_notice: 0 }],
    ["an unknown manual_reason", { manual_reason: "invoice_shape" }],
    ["no manual_reason key", { manual_reason: undefined }],
    ["an unknown locale", { locale: "sv" }],
    ["a negative refund_ore", { refund_ore: -1 }],
  ])("withdrawal: %s → null", (_label, fields) => {
    expect(parseOrderWithdrawalSnapshot({ ...WITHDRAWAL_JSON, ...fields })).toBeNull();
  });
});
