/**
 * Unit tests: src/app/admin/(panel)/orders/actions.ts — markShipped / approveRefund
 * Journey: payments-s2-3d-purchase
 * Criteria: admin order actions (contract §3, §4.1 OrderService error codes)
 *
 * Test IDs: S2-T-ORD-ACT-01..12
 *
 * Contract §4.1 OrderService errors (what parseOrderServiceResult unwraps):
 *   ok:false, reason: 'unauthenticated' | 'forbidden' | 'not_found' | 'refused' |
 *                     'conflict' | 'invalid_input' | 'unavailable'
 *   conflict has a SQL subreason (A1/A2, ORDER_SERVICE_CONFLICTS):
 *     markShipped: 'order_closed' | 'withdrawal_pending' | 'authorization_expired' | 'capture_refused'
 *     approveRefund: 'order_refunded' | 'order_shipped' | 'order_not_shipped'
 *   invalid_input has a subreason: 'deduction_invalid' | 'deduction_reason_required' | …
 *   Each maps to one action error code; the order page shows its Danish text
 *   (messages/da.json Admin.orders.detail.errors).
 *
 * Contract §3 confirmation step (detail page component, not action):
 *   First click shows "Refundér 159,00 kr. til jens@example.dk? Det kan ikke fortrydes."
 *   Second click invokes the action.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── vi.hoisted ──────────────────────────────────────────────────────────────

const {
  mockRequireAdmin,
  mockGetSession,
  mockGetCloudflareContext,
  mockOrdersMarkShipped,
  mockOrdersApproveRefund,
  mockRevalidatePath,
  mockRedirect,
} = vi.hoisted(() => ({
  mockRequireAdmin: vi.fn(),
  mockGetSession: vi.fn(),
  mockGetCloudflareContext: vi.fn(),
  mockOrdersMarkShipped: vi.fn(),
  mockOrdersApproveRefund: vi.fn(),
  mockRevalidatePath: vi.fn(),
  mockRedirect: vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`); }),
}));

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("@/services/auth/require-admin", () => ({ requireAdmin: mockRequireAdmin }));
vi.mock("@/lib/supabase/server", () => ({
  createServerClient: vi.fn(() => ({
    auth: { getSession: mockGetSession },
  })),
}));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: mockGetCloudflareContext,
}));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));

// ── Modules under test ──────────────────────────────────────────────────────

import { markShipped, approveRefund } from "@/app/admin/(panel)/orders/actions";
import { ADMIN_ORDERS_PATH } from "@/config/admin";
import da from "../../../../messages/da.json";

// ── Fixtures ───────────────────────────────────────────────────────────────

const ADMIN_USER = { userId: "admin-uuid", email: "admin@example.com", role: "admin" as const };
const ACCESS_TOKEN = "eyJhbGciOiJIUzI1NiJ9.test-access-token";
const ORDER_ID = "00000000-0000-0000-0000-000000000001";
const ORDER_NUMBER = 1001;

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

function setupDefaultEnv(): void {
  mockRequireAdmin.mockResolvedValue(ADMIN_USER);
  mockGetSession.mockResolvedValue({
    data: { session: { access_token: ACCESS_TOKEN } },
    error: null,
  });
  mockGetCloudflareContext.mockReturnValue({
    env: {
      ORDERS: {
        markShipped: mockOrdersMarkShipped,
        approveRefund: mockOrdersApproveRefund,
      },
    },
  });
  mockOrdersMarkShipped.mockResolvedValue({ ok: true, status: "shipped" });
  mockOrdersApproveRefund.mockResolvedValue({ ok: true, status: "completed" });
}

const APPROVE_FORM_BASE = {
  orderId: ORDER_ID,
  orderNumber: String(ORDER_NUMBER),
  goodsState: "returned",
  deduction: "",
  deductionReason: "",
};

beforeEach(() => { vi.clearAllMocks(); });

// ── S2-T-ORD-ACT-01: requireAdmin before ORDERS ───────────────────────────

describe("S2-T-ORD-ACT-01: markShipped — requireAdmin called before ORDERS binding", () => {
  it("requireAdmin invocation order < markShipped invocation order", async () => {
    setupDefaultEnv();
    expect(await markShipped(form({ orderId: ORDER_ID, orderNumber: String(ORDER_NUMBER) }))).toEqual({
      ok: true,
      status: "shipped",
    });
    expect(mockRequireAdmin.mock.invocationCallOrder[0]).toBeLessThan(
      mockOrdersMarkShipped.mock.invocationCallOrder[0]!,
    );
  });

  it("requireAdmin throwing stops the action — no ORDERS call", async () => {
    mockRequireAdmin.mockRejectedValue(new Error("forbidden"));
    mockGetCloudflareContext.mockReturnValue({ env: { ORDERS: { markShipped: mockOrdersMarkShipped } } });
    await expect(markShipped(form({ orderId: ORDER_ID, orderNumber: String(ORDER_NUMBER) }))).rejects.toThrow("forbidden");
    expect(mockOrdersMarkShipped).not.toHaveBeenCalled();
  });
});

// ── S2-T-ORD-ACT-02: access token from getSession forwarded ───────────────

describe("S2-T-ORD-ACT-02: markShipped — exact input to ORDERS.markShipped", () => {
  it("calls ORDERS.markShipped with exact {accessToken, orderId}", async () => {
    setupDefaultEnv();
    expect(await markShipped(form({ orderId: ORDER_ID, orderNumber: String(ORDER_NUMBER) }))).toEqual({
      ok: true,
      status: "shipped",
    });
    expect(mockOrdersMarkShipped).toHaveBeenCalledWith({
      accessToken: ACCESS_TOKEN,
      orderId: ORDER_ID,
    });
  });

  it("includes trackingRef when provided", async () => {
    setupDefaultEnv();
    expect(
      await markShipped(form({ orderId: ORDER_ID, orderNumber: String(ORDER_NUMBER), trackingRef: "00370712345678" })),
    ).toEqual({ ok: true, status: "shipped" });
    expect(mockOrdersMarkShipped).toHaveBeenCalledWith({
      accessToken: ACCESS_TOKEN,
      orderId: ORDER_ID,
      trackingRef: "00370712345678",
    });
  });
});

// ── S2-T-ORD-ACT-03: ORDERS binding absent → unavailable ──────────────────

describe("S2-T-ORD-ACT-03: markShipped — ORDERS binding absent → unavailable", () => {
  it("answers {ok:false, error:'unavailable'} and still refreshes the order", async () => {
    mockRequireAdmin.mockResolvedValue(ADMIN_USER);
    mockGetSession.mockResolvedValue({ data: { session: { access_token: ACCESS_TOKEN } }, error: null });
    mockGetCloudflareContext.mockReturnValue({ env: {} });
    expect(await markShipped(form({ orderId: ORDER_ID, orderNumber: String(ORDER_NUMBER) }))).toEqual({
      ok: false,
      error: "unavailable",
    });
    expect(mockRevalidatePath.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      ADMIN_ORDERS_PATH,
      `${ADMIN_ORDERS_PATH}/${ORDER_NUMBER}`,
    ]);
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});

// ── S2-T-ORD-ACT-04: revalidatePath after markShipped ────────────────────

describe("S2-T-ORD-ACT-04: markShipped — revalidatePath for list + detail", () => {
  it("revalidates both list and detail on success", async () => {
    setupDefaultEnv();
    expect(await markShipped(form({ orderId: ORDER_ID, orderNumber: String(ORDER_NUMBER) }))).toEqual({
      ok: true,
      status: "shipped",
    });
    const paths = mockRevalidatePath.mock.calls.map((c: unknown[]) => c[0]);
    expect(paths).toEqual([ADMIN_ORDERS_PATH, `${ADMIN_ORDERS_PATH}/${ORDER_NUMBER}`]);
  });
});

// ── S2-T-ORD-ACT-05: approveRefund requireAdmin before ORDERS ─────────────

describe("S2-T-ORD-ACT-05: approveRefund — requireAdmin called before ORDERS binding", () => {
  it("requireAdmin invocation order < approveRefund invocation order", async () => {
    setupDefaultEnv();
    expect(await approveRefund(form(APPROVE_FORM_BASE))).toEqual({ ok: true, status: "completed" });
    expect(mockRequireAdmin.mock.invocationCallOrder[0]).toBeLessThan(
      mockOrdersApproveRefund.mock.invocationCallOrder[0]!,
    );
  });
});

// ── S2-T-ORD-ACT-06: exact input to ORDERS.approveRefund ─────────────────

describe("S2-T-ORD-ACT-06: approveRefund — exact {accessToken, orderId, goodsState, deductionOre, deductionReason}", () => {
  it("parses '49,95' as 4995 øre; full input matches contract §4.1", async () => {
    setupDefaultEnv();
    expect(
      await approveRefund(form({
        orderId: ORDER_ID,
        orderNumber: String(ORDER_NUMBER),
        goodsState: "returned",
        deduction: "49,95",
        deductionReason: "Returfragt",
      })),
    ).toEqual({ ok: true, status: "completed" });
    expect(mockOrdersApproveRefund).toHaveBeenCalledWith({
      accessToken: ACCESS_TOKEN,
      orderId: ORDER_ID,
      goodsState: "returned",
      deductionOre: 4995,
      deductionReason: "Returfragt",
    });
  });

  it("empty deduction → deductionOre=0 (no reason required)", async () => {
    setupDefaultEnv();
    expect(await approveRefund(form(APPROVE_FORM_BASE))).toEqual({ ok: true, status: "completed" });
    expect(mockOrdersApproveRefund).toHaveBeenCalledWith({
      accessToken: ACCESS_TOKEN,
      orderId: ORDER_ID,
      goodsState: "returned",
      deductionOre: 0,
      deductionReason: "",
    });
  });
});

// ── S2-T-ORD-ACT-07: deduction validation — no ORDERS call ───────────────

describe("S2-T-ORD-ACT-07: approveRefund — invalid deduction → validation error, no ORDERS call", () => {
  it.each(["abc", "-5", "1.234"])(
    "deduction '%s' → deduction-format without calling ORDERS",
    async (deduction) => {
      setupDefaultEnv();
      expect(
        await approveRefund(form({
          ...APPROVE_FORM_BASE,
          deduction,
          deductionReason: "Begrundelse",
        })),
      ).toEqual({ ok: false, error: "deduction-format" });
      expect(mockOrdersApproveRefund).not.toHaveBeenCalled();
    },
  );

  it("deduction > 0 with empty reason → reason-required, no ORDERS call", async () => {
    setupDefaultEnv();
    expect(
      await approveRefund(form({
        ...APPROVE_FORM_BASE,
        deduction: "49,95",
        deductionReason: "",
      })),
    ).toEqual({ ok: false, error: "reason-required" });
    expect(mockOrdersApproveRefund).not.toHaveBeenCalled();
  });
});

// ── S2-T-ORD-ACT-08: refusals both actions share, and an answer of another shape ──

describe("S2-T-ORD-ACT-08: approveRefund — shared refusals and an answer of another shape map to exact codes", () => {
  it.each([
    [{ ok: false, reason: "unauthenticated" }, { ok: false, error: "unauthenticated" }],
    [{ ok: false, reason: "forbidden" }, { ok: false, error: "forbidden" }],
    [null, { ok: false, error: "unavailable" }],
    [{ ok: true, status: "paid" }, { ok: false, error: "unavailable" }],
  ])("Worker answer %j → %j, list + detail refreshed, no redirect", async (answer, expected) => {
    setupDefaultEnv();
    mockOrdersApproveRefund.mockResolvedValue(answer);
    expect(await approveRefund(form(APPROVE_FORM_BASE))).toEqual(expected);
    expect(mockRevalidatePath.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      ADMIN_ORDERS_PATH,
      `${ADMIN_ORDERS_PATH}/${ORDER_NUMBER}`,
    ]);
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});

// ── S2-T-ORD-ACT-09: approveRefund revalidatePath ────────────────────────

describe("S2-T-ORD-ACT-09: approveRefund — revalidatePath on success", () => {
  it("revalidates both list and detail on success", async () => {
    setupDefaultEnv();
    expect(await approveRefund(form(APPROVE_FORM_BASE))).toEqual({ ok: true, status: "completed" });
    const paths = mockRevalidatePath.mock.calls.map((c: unknown[]) => c[0]);
    expect(paths).toEqual([ADMIN_ORDERS_PATH, `${ADMIN_ORDERS_PATH}/${ORDER_NUMBER}`]);
  });
});

// ── S2-T-ORD-ACT-10: markShipped maps the Worker's answers to codes ──────

describe("S2-T-ORD-ACT-10: markShipped — exact result per OrderService answer (A1/A2 subreasons)", () => {
  const SHIP_FORM = { orderId: ORDER_ID, orderNumber: String(ORDER_NUMBER) };

  it.each([
    [{ ok: true, status: "shipped" }, { ok: true, status: "shipped" }],
    [{ ok: true, status: "already_shipped" }, { ok: true, status: "already_shipped" }],
    [{ ok: false, reason: "conflict", subreason: "authorization_expired" }, { ok: false, error: "authorization-expired" }],
    [{ ok: false, reason: "conflict", subreason: "capture_refused" }, { ok: false, error: "capture-refused" }],
    [{ ok: false, reason: "conflict", subreason: "order_closed" }, { ok: false, error: "order-closed" }],
    [{ ok: false, reason: "conflict", subreason: "withdrawal_pending" }, { ok: false, error: "withdrawal-pending" }],
    [{ ok: false, reason: "conflict" }, { ok: false, error: "conflict" }],
    [{ ok: false, reason: "unauthenticated" }, { ok: false, error: "unauthenticated" }],
    [{ ok: false, reason: "forbidden" }, { ok: false, error: "forbidden" }],
    [{ ok: false, reason: "not_found" }, { ok: false, error: "not-found" }],
    [{ ok: false, reason: "unavailable" }, { ok: false, error: "unavailable" }],
    [{ ok: false, reason: "invalid_input" }, { ok: false, error: "invalid" }],
    [{ ok: true, status: "paid" }, { ok: false, error: "unavailable" }],
  ])("Worker answer %j → %j, list + detail refreshed", async (answer, expected) => {
    setupDefaultEnv();
    mockOrdersMarkShipped.mockResolvedValue(answer);
    expect(await markShipped(form(SHIP_FORM))).toEqual(expected);
    const paths = mockRevalidatePath.mock.calls.map((c: unknown[]) => c[0]);
    expect(paths).toEqual([ADMIN_ORDERS_PATH, `${ADMIN_ORDERS_PATH}/${ORDER_NUMBER}`]);
  });

  it("a blank tracking reference is left out; a longer one than 200 characters is invalid without a Worker call", async () => {
    setupDefaultEnv();
    expect(await markShipped(form({ ...SHIP_FORM, trackingRef: "   " }))).toEqual({ ok: true, status: "shipped" });
    expect(mockOrdersMarkShipped).toHaveBeenCalledWith({ accessToken: ACCESS_TOKEN, orderId: ORDER_ID });
    mockOrdersMarkShipped.mockClear();
    expect(await markShipped(form({ ...SHIP_FORM, trackingRef: "x".repeat(201) }))).toEqual({ ok: false, error: "invalid" });
    expect(mockOrdersMarkShipped).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-uuid order id", { orderId: "1001", orderNumber: "1001" }],
    ["a signed order number", { orderId: ORDER_ID, orderNumber: "-1" }],
    ["an exponent order number", { orderId: ORDER_ID, orderNumber: "1e3" }],
  ])("%s is invalid without a Worker call", async (_, fields) => {
    setupDefaultEnv();
    expect(await markShipped(form(fields))).toEqual({ ok: false, error: "invalid" });
    expect(mockOrdersMarkShipped).not.toHaveBeenCalled();
  });

  it("no session → unauthenticated without a Worker call", async () => {
    setupDefaultEnv();
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
    expect(await markShipped(form(SHIP_FORM))).toEqual({ ok: false, error: "unauthenticated" });
    expect(mockOrdersMarkShipped).not.toHaveBeenCalled();
  });
});

// ── S2-T-ORD-ACT-11: approveRefund maps the Worker's answers to codes ────

describe("S2-T-ORD-ACT-11: approveRefund — exact result per OrderService answer and per form", () => {
  it.each([
    [{ ok: true, status: "completed" }, { ok: true, status: "completed" }],
    [{ ok: true, status: "canceled" }, { ok: true, status: "canceled" }],
    [{ ok: true, status: "approved" }, { ok: true, status: "approved" }],
    [{ ok: true, status: "needs_manual" }, { ok: true, status: "needs_manual" }],
    [{ ok: false, reason: "conflict", subreason: "order_refunded" }, { ok: false, error: "order-refunded" }],
    [{ ok: false, reason: "conflict", subreason: "order_shipped" }, { ok: false, error: "order-shipped" }],
    [{ ok: false, reason: "conflict", subreason: "order_not_shipped" }, { ok: false, error: "order-not-shipped" }],
    [{ ok: false, reason: "conflict" }, { ok: false, error: "conflict" }],
    [{ ok: false, reason: "invalid_input", subreason: "deduction_invalid" }, { ok: false, error: "deduction-too-large" }],
    [{ ok: false, reason: "invalid_input", subreason: "deduction_reason_required" }, { ok: false, error: "reason-required" }],
    [{ ok: false, reason: "invalid_input" }, { ok: false, error: "invalid" }],
    [{ ok: false, reason: "not_found" }, { ok: false, error: "not-found" }],
    [{ ok: false, reason: "unavailable" }, { ok: false, error: "unavailable" }],
  ])("Worker answer %j → %j", async (answer, expected) => {
    setupDefaultEnv();
    mockOrdersApproveRefund.mockResolvedValue(answer);
    expect(await approveRefund(form(APPROVE_FORM_BASE))).toEqual(expected);
  });

  it("not_shipped sends no deduction (0) and releases; a deduction on it is refused without a Worker call", async () => {
    setupDefaultEnv();
    mockOrdersApproveRefund.mockResolvedValue({ ok: true, status: "canceled" });
    const notShipped = { orderId: ORDER_ID, orderNumber: String(ORDER_NUMBER), goodsState: "not_shipped" };
    expect(await approveRefund(form(notShipped))).toEqual({ ok: true, status: "canceled" });
    expect(mockOrdersApproveRefund).toHaveBeenCalledWith({
      accessToken: ACCESS_TOKEN,
      orderId: ORDER_ID,
      goodsState: "not_shipped",
      deductionOre: 0,
      deductionReason: "",
    });
    mockOrdersApproveRefund.mockClear();
    expect(await approveRefund(form({ ...notShipped, deduction: "10", deductionReason: "x" }))).toEqual({
      ok: false,
      error: "deduction-too-large",
    });
    expect(mockOrdersApproveRefund).not.toHaveBeenCalled();
  });

  it.each([
    ["deduction 'abc' → deduction-format", { deduction: "abc", deductionReason: "x" }, "deduction-format"],
    ["deduction > 0 with a blank reason → reason-required", { deduction: "49,95", deductionReason: "  " }, "reason-required"],
    ["unknown goods state → invalid", { goodsState: "lost" }, "invalid"],
  ])("%s, no Worker call", async (_, fields, error) => {
    setupDefaultEnv();
    expect(await approveRefund(form({ ...APPROVE_FORM_BASE, ...fields }))).toEqual({ ok: false, error });
    expect(mockOrdersApproveRefund).not.toHaveBeenCalled();
  });
});

// ── S2-T-ORD-ACT-12: every action error code has Danish copy ─────────────

describe("S2-T-ORD-ACT-12: Danish messages for every action error (A1/A2 wording)", () => {
  it("Admin.orders.detail.errors has a message for each code, without an em-dash", () => {
    const errors: Record<string, string> = da.Admin.orders.detail.errors;
    const codes = [
      "invalid", "unauthenticated", "forbidden", "not-found", "conflict", "unavailable",
      "order-closed", "withdrawal-pending", "authorization-expired", "capture-refused",
      "deduction-format", "deduction-too-large", "reason-required",
      "order-refunded", "order-shipped", "order-not-shipped",
    ];
    expect(Object.keys(errors).toSorted()).toEqual(codes.toSorted());
    for (const message of Object.values(errors)) expect(message).not.toContain("\u2014");
  });

  it("authorization_expired and capture_refused read exactly as the contract (A1, A2-3)", () => {
    expect(da.Admin.orders.detail.errors["authorization-expired"]).toBe(
      "Betalingen er udløbet. Send ikke varen; kontakt køberen.",
    );
    expect(da.Admin.orders.detail.errors["capture-refused"]).toBe(
      "Betalingen kunne ikke trækkes. Varen er ikke markeret som afsendt.",
    );
  });
});
