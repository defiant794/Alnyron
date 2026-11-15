/**
 * Unit tests: src/services/admin/orders.ts — listOrders / getOrderByNumber
 * Journey: payments-s2-3d-purchase
 * Criteria: admin orders service (contract §3)
 *
 * Test IDs: S2-T-ADM-SVC-01..12
 *
 * Contract §3:
 *   - `listOrders` / `getOrderByNumber` use `createServerClient` (session-scoped
 *     RLS client), never the service-role or public client.
 *   - `.from("orders")` with a select string that embeds `order_items` and
 *     `order_withdrawals` (needed for status badges and anomaly).
 *   - Ordered by `created_at` descending (newest first).
 *   - `listOrders` reads every order in one query (no status filter): the page
 *     filters and counts the rows itself.
 *   - `order_withdrawals` is a one-to-one embed (`order_id` is unique): PostgREST
 *     returns an object or null, not an array.
 *   - Maps DB rows to `AdminOrderRow` (list) and `AdminOrderDetail` (detail), whole
 *     objects compared: the first line by `line_no`, the withdrawal (status, late,
 *     `completedAt = refunded_at ?? authorization_canceled_at`), and a
 *     status outside the CHECK lists throws.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── vi.hoisted ──────────────────────────────────────────────────────────────

const { mockFrom, mockSelect, mockEq, mockNot, mockOrder, mockMaybeSingle, mockCreateServerClient } =
  vi.hoisted(() => ({
    mockFrom: vi.fn(),
    mockSelect: vi.fn(),
    mockEq: vi.fn(),
    mockNot: vi.fn(),
    mockOrder: vi.fn(),
    mockMaybeSingle: vi.fn(),
    // In vi.hoisted: the hoisted vi.mock factory below reads it before top-level code runs.
    mockCreateServerClient: vi.fn(),
  }));

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: mockCreateServerClient,
}));

// ── Build a chainable query stub ───────────────────────────────────────────

/**
 * The Supabase client stub: `from()` starts a chainable, awaitable query that
 * resolves to `terminal`. The client itself is NOT thenable: the service awaits
 * `createServerClient()` (async in production), and awaiting a thenable client
 * would unwrap it to `terminal`.
 */
function makeChain(terminal: { data: unknown; error: null }) {
  const chain: Record<string, unknown> = {};
  chain["select"] = mockSelect.mockReturnValue(chain);
  chain["eq"] = mockEq.mockReturnValue(chain);
  chain["not"] = mockNot.mockReturnValue(chain);
  chain["order"] = mockOrder.mockReturnValue(chain);
  chain["maybeSingle"] = mockMaybeSingle.mockResolvedValue(terminal);
  // Promise interface for array result
  chain["then"] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(terminal).then(resolve);
  return { from: mockFrom.mockReturnValue(chain) };
}

/** Serves `data` as the query result of the next service call. */
function serve(data: unknown) {
  mockCreateServerClient.mockReturnValue(makeChain({ data, error: null }));
}

// ── Module under test ───────────────────────────────────────────────────────

import { listOrders, getOrderByNumber } from "@/services/admin/orders";
import type { AdminOrderDetail } from "@/services/admin/orders";

// ── Fixtures ───────────────────────────────────────────────────────────────

/** A list row as `LIST_SELECT` returns it: no withdrawal, one line. */
const LIST_DB_ROW = {
  id: "00000000-0000-0000-0000-000000000001",
  order_number: 1001,
  email: "buyer@test.local",
  shipping_name: "Lars Andersen",
  amount_total_ore: 24995,
  status: "authorized",
  paid_at: "2026-11-13T09:40:00Z",
  anomaly: null,
  order_items: [{ line_no: 1, title: "Drage, 12 cm" }],
  order_withdrawals: null,
};

/** A list row with a withdrawal waiting for manual handling, an anomaly and two lines out of order. */
const LIST_DB_ROW_WITHDRAWN = {
  id: "00000000-0000-0000-0000-000000000002",
  order_number: 1002,
  email: "jens@test.local",
  shipping_name: null,
  amount_total_ore: 17900,
  status: "shipped",
  paid_at: "2026-11-13T10:00:00Z",
  anomaly: "tax_mismatch",
  order_items: [
    { line_no: 2, title: "Gaveæske" },
    { line_no: 1, title: "Ugle, 8 cm" },
  ],
  order_withdrawals: { status: "needs_manual" },
};

const ORDER_ITEM = {
  line_no: 1,
  title: "Drage, 12 cm",
  offer_kind: "physical",
  quantity: 1,
  unit_amount_ore: 24995,
  amount_total_ore: 24995,
};

/** A detail row as `DETAIL_SELECT` returns it: authorized, not shipped, no withdrawal. */
const DETAIL_DB_ROW = {
  id: "00000000-0000-0000-0000-000000000001",
  order_number: 1001,
  email: "buyer@test.local",
  customer_name: "Lars Andersen",
  phone: "+4520123456",
  shipping_name: "Lars Andersen",
  shipping_address: { line1: "Testvej 1", postal_code: "7860", city: "Spøttrup", country: "DK" },
  amount_total_ore: 24995,
  amount_tax_ore: 4999,
  amount_refunded_ore: 0,
  locale: "da",
  status: "authorized",
  paid_at: "2026-11-13T09:40:00Z",
  authorization_expires_at: "2026-11-20T09:40:00Z",
  captured_at: null,
  canceled_at: null,
  cancel_reason: null,
  confirmation_sent_at: "2026-11-13T09:41:00Z",
  shipped_at: null,
  tracking_ref: null,
  anomaly: null,
  stripe_checkout_session_id: "cs_test_abc123",
  stripe_payment_intent_id: "pi_test_abc123",
  stripe_customer_id: null,
  stripe_invoice_id: null,
  order_items: [ORDER_ITEM],
  order_withdrawals: null,
};

/** The {@link DETAIL_DB_ROW} as the admin page gets it. */
const DETAIL: AdminOrderDetail = {
  id: "00000000-0000-0000-0000-000000000001",
  orderNumber: 1001,
  email: "buyer@test.local",
  customerName: "Lars Andersen",
  phone: "+4520123456",
  shippingName: "Lars Andersen",
  shippingAddress: { line1: "Testvej 1", line2: null, postal_code: "7860", city: "Spøttrup", country: "DK" },
  amountTotalOre: 24995,
  amountTaxOre: 4999,
  amountRefundedOre: 0,
  locale: "da",
  status: "authorized",
  paidAt: "2026-11-13T09:40:00Z",
  authorizationExpiresAt: "2026-11-20T09:40:00Z",
  capturedAt: null,
  canceledAt: null,
  cancelReason: null,
  confirmationSentAt: "2026-11-13T09:41:00Z",
  shippedAt: null,
  trackingRef: null,
  anomaly: null,
  stripeCheckoutSessionId: "cs_test_abc123",
  stripePaymentIntentId: "pi_test_abc123",
  stripeCustomerId: null,
  stripeInvoiceId: null,
  lines: [{ title: "Drage, 12 cm", offerKind: "physical", quantity: 1, unitAmountOre: 24995, amountTotalOre: 24995 }],
  withdrawal: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ── S2-T-ADM-SVC-01: uses createServerClient (session RLS client) ─────────

describe("S2-T-ADM-SVC-01: listOrders — uses createServerClient, not service-role or public client", () => {
  it("calls createServerClient from @/lib/supabase/server once, with no arguments", async () => {
    serve([]);
    await listOrders();
    expect(mockCreateServerClient).toHaveBeenCalledOnce();
    expect(mockCreateServerClient).toHaveBeenCalledWith();
  });
});

// ── S2-T-ADM-SVC-02: from("orders") with select embedding items + withdrawals

describe("S2-T-ADM-SVC-02: listOrders — from('orders') with select including embeds", () => {
  it("calls .from('orders')", async () => {
    serve([]);
    await listOrders();
    expect(mockFrom).toHaveBeenCalledWith("orders");
  });

  it("select string includes order_items embed", async () => {
    serve([]);
    await listOrders();
    const selectArg: string = mockSelect.mock.calls[0]?.[0] ?? "";
    expect(selectArg).toContain("order_items");
  });

  it("select string includes order_withdrawals embed", async () => {
    serve([]);
    await listOrders();
    const selectArg: string = mockSelect.mock.calls[0]?.[0] ?? "";
    expect(selectArg).toContain("order_withdrawals");
  });
});

// ── S2-T-ADM-SVC-03: ordered newest first ────────────────────────────────

describe("S2-T-ADM-SVC-03: listOrders — ordered by created_at descending", () => {
  it("calls .order('created_at', { ascending: false })", async () => {
    serve([]);
    await listOrders();
    expect(mockOrder).toHaveBeenCalledWith("created_at", { ascending: false });
  });
});

// ── S2-T-ADM-SVC-04: one read of every order, no filter ─────────────────

describe("S2-T-ADM-SVC-04: listOrders — every order in one query, no status or withdrawal filter", () => {
  it("calls neither .eq nor .not (the page filters the rows it read)", async () => {
    serve([]);
    await listOrders();
    expect(mockFrom).toHaveBeenCalledOnce();
    expect(mockEq).not.toHaveBeenCalled();
    expect(mockNot).not.toHaveBeenCalled();
  });
});

// ── S2-T-ADM-SVC-05: maps DB rows to AdminOrderRow ────────────────────────

describe("S2-T-ADM-SVC-05: listOrders — maps DB rows to exact AdminOrderRow objects", () => {
  it("maps an order without and an order with a withdrawal, the first line by line_no", async () => {
    serve([LIST_DB_ROW, LIST_DB_ROW_WITHDRAWN]);
    expect(await listOrders()).toStrictEqual([
      {
        id: "00000000-0000-0000-0000-000000000001",
        orderNumber: 1001,
        email: "buyer@test.local",
        shippingName: "Lars Andersen",
        amountTotalOre: 24995,
        status: "authorized",
        paidAt: "2026-11-13T09:40:00Z",
        anomaly: null,
        itemTitle: "Drage, 12 cm",
        withdrawal: null,
      },
      {
        id: "00000000-0000-0000-0000-000000000002",
        orderNumber: 1002,
        email: "jens@test.local",
        shippingName: null,
        amountTotalOre: 17900,
        status: "shipped",
        paidAt: "2026-11-13T10:00:00Z",
        anomaly: "tax_mismatch",
        itemTitle: "Ugle, 8 cm",
        withdrawal: { status: "needs_manual" },
      },
    ]);
  });
});

// ── S2-T-ADM-SVC-06: getOrderByNumber uses maybeSingle + eq order_number ──

describe("S2-T-ADM-SVC-06: getOrderByNumber — from('orders'), .eq('order_number', n), .maybeSingle()", () => {
  it("calls .eq('order_number', 1001)", async () => {
    serve(DETAIL_DB_ROW);
    await getOrderByNumber(1001);
    expect(mockEq).toHaveBeenCalledWith("order_number", 1001);
  });

  it("calls .maybeSingle() for a single-row fetch", async () => {
    serve(DETAIL_DB_ROW);
    await getOrderByNumber(1001);
    expect(mockMaybeSingle).toHaveBeenCalledOnce();
  });
});

// ── S2-T-ADM-SVC-07: getOrderByNumber maps detail row ────────────────────

describe("S2-T-ADM-SVC-07: getOrderByNumber — maps DB row to the exact AdminOrderDetail", () => {
  it("maps DETAIL_DB_ROW (no withdrawal; line2 absent → null)", async () => {
    serve(DETAIL_DB_ROW);
    expect(await getOrderByNumber(1001)).toStrictEqual(DETAIL);
  });
});

// ── S2-T-ADM-SVC-08: getOrderByNumber null for unknown / NaN ─────────────

describe("S2-T-ADM-SVC-08: getOrderByNumber — null for unknown or NaN", () => {
  it("returns null when maybeSingle returns {data: null}", async () => {
    serve(null);
    expect(await getOrderByNumber(99999)).toBeNull();
  });

  it.each([NaN, 0, -1, 1.5])("returns null for %s without a query", async (orderNumber) => {
    serve(null);
    expect(await getOrderByNumber(orderNumber)).toBeNull();
    expect(mockCreateServerClient).not.toHaveBeenCalled();
    expect(mockEq).not.toHaveBeenCalled();
  });
});

// ── S2-T-ADM-SVC-09: a refunded withdrawal ───────────────────────────────

describe("S2-T-ADM-SVC-09: getOrderByNumber — a refund withdrawal (returned goods, late, deduction)", () => {
  it("maps the withdrawal; completedAt is refunded_at", async () => {
    serve({
      ...DETAIL_DB_ROW,
      status: "refunded",
      amount_refunded_ore: 19995,
      captured_at: "2026-11-14T08:00:00Z",
      shipped_at: "2026-11-14T08:00:00Z",
      tracking_ref: "GLS123",
      order_withdrawals: {
        status: "completed",
        requested_at: "2026-12-01T10:00:00Z",
        deadline_at: "2026-11-29T23:00:00Z",
        late: true,
        refund_due_at: "2026-12-15T10:00:00Z",
        deduction_ore: 5000,
        deduction_reason: "Ridser i lakken",
        refund_ore: 19995,
        refunded_at: "2026-12-05T09:00:00Z",
        authorization_canceled_at: null,
        manual_reason: null,
      },
    });
    expect(await getOrderByNumber(1001)).toStrictEqual({
      ...DETAIL,
      status: "refunded",
      amountRefundedOre: 19995,
      capturedAt: "2026-11-14T08:00:00Z",
      shippedAt: "2026-11-14T08:00:00Z",
      trackingRef: "GLS123",
      withdrawal: {
        status: "completed",
        requestedAt: "2026-12-01T10:00:00Z",
        deadlineAt: "2026-11-29T23:00:00Z",
        late: true,
        refundDueAt: "2026-12-15T10:00:00Z",
        deductionOre: 5000,
        deductionReason: "Ridser i lakken",
        refundOre: 19995,
        completedAt: "2026-12-05T09:00:00Z",
        manualReason: null,
      },
    });
  });
});

// ── S2-T-ADM-SVC-10: a released authorization ────────────────────────────

describe("S2-T-ADM-SVC-10: getOrderByNumber — a release before dispatch (canceled order, not shipped)", () => {
  it("maps the withdrawal; completedAt is authorization_canceled_at; a null late is false", async () => {
    serve({
      ...DETAIL_DB_ROW,
      status: "canceled",
      canceled_at: "2026-11-15T09:00:00Z",
      cancel_reason: "withdrawn",
      order_withdrawals: {
        status: "completed",
        requested_at: "2026-11-14T10:00:00Z",
        deadline_at: null,
        late: null,
        refund_due_at: "2026-11-28T10:00:00Z",
        deduction_ore: 0,
        deduction_reason: null,
        refund_ore: null,
        refunded_at: null,
        authorization_canceled_at: "2026-11-15T09:00:00Z",
        manual_reason: null,
      },
    });
    expect(await getOrderByNumber(1001)).toStrictEqual({
      ...DETAIL,
      status: "canceled",
      canceledAt: "2026-11-15T09:00:00Z",
      cancelReason: "withdrawn",
      withdrawal: {
        status: "completed",
        requestedAt: "2026-11-14T10:00:00Z",
        deadlineAt: null,
        late: false,
        refundDueAt: "2026-11-28T10:00:00Z",
        deductionOre: 0,
        deductionReason: null,
        refundOre: null,
        completedAt: "2026-11-15T09:00:00Z",
        manualReason: null,
      },
    });
  });

  it("a received withdrawal waiting for manual handling: not completed, the manual reason", async () => {
    serve({
      ...DETAIL_DB_ROW,
      order_withdrawals: {
        status: "needs_manual",
        requested_at: "2026-11-14T10:00:00Z",
        deadline_at: null,
        late: false,
        refund_due_at: "2026-11-28T10:00:00Z",
        deduction_ore: 0,
        deduction_reason: null,
        refund_ore: null,
        refunded_at: null,
        authorization_canceled_at: null,
        manual_reason: "stripe_refused",
      },
    });
    const detail = await getOrderByNumber(1001);
    expect(detail?.withdrawal).toStrictEqual({
      status: "needs_manual",
      requestedAt: "2026-11-14T10:00:00Z",
      deadlineAt: null,
      late: false,
      refundDueAt: "2026-11-28T10:00:00Z",
      deductionOre: 0,
      deductionReason: null,
      refundOre: null,
      completedAt: null,
      manualReason: "stripe_refused",
    });
  });
});

// ── S2-T-ADM-SVC-11: a value outside the CHECK lists throws ──────────────

describe("S2-T-ADM-SVC-11: a status, cancel reason or offer kind the schema does not allow throws", () => {
  it("listOrders: an unknown order status", async () => {
    serve([{ ...LIST_DB_ROW, status: "paid" }]);
    await expect(listOrders()).rejects.toThrow("Unexpected order value: paid");
  });

  it("listOrders: an unknown withdrawal status", async () => {
    serve([{ ...LIST_DB_ROW, order_withdrawals: { status: "pending" } }]);
    await expect(listOrders()).rejects.toThrow("Unexpected order value: pending");
  });

  it.each([
    ["order status", { status: "paid" }, "paid"],
    ["cancel reason", { status: "canceled", canceled_at: "2026-11-15T09:00:00Z", cancel_reason: "fraud" }, "fraud"],
    ["offer kind", { order_items: [{ ...ORDER_ITEM, offer_kind: "print" }] }, "print"],
  ])("getOrderByNumber: an unknown %s", async (_label, patch, value) => {
    serve({ ...DETAIL_DB_ROW, ...patch });
    await expect(getOrderByNumber(1001)).rejects.toThrow(`Unexpected order value: ${value}`);
  });
});

// ── S2-T-ADM-SVC-12: lines in line_no order ──────────────────────────────

describe("S2-T-ADM-SVC-12: getOrderByNumber — lines in line_no order, whatever order PostgREST returns", () => {
  it("a two-line order: lines sorted by line_no", async () => {
    serve({
      ...DETAIL_DB_ROW,
      order_items: [
        { line_no: 2, title: "Gaveæske", offer_kind: "physical", quantity: 2, unit_amount_ore: 2500, amount_total_ore: 5000 },
        ORDER_ITEM,
      ],
    });
    expect((await getOrderByNumber(1001))?.lines).toStrictEqual([
      { title: "Drage, 12 cm", offerKind: "physical", quantity: 1, unitAmountOre: 24995, amountTotalOre: 24995 },
      { title: "Gaveæske", offerKind: "physical", quantity: 2, unitAmountOre: 2500, amountTotalOre: 5000 },
    ]);
  });
});
