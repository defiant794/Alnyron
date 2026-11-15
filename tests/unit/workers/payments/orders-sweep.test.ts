/**
 * Unit tests: workers/payments/sweep.ts + orders/sweep.ts — the sweep's goods pass, with the real
 * Supabase, Stripe and Resend clients on a fake global fetch, so every subrequest is a real fetch
 * the sweep counts
 * Journey: payments-s2-3d-purchase
 * Criteria: S2-SWP-1..5 (S2-T-SWP-01..05, S2-T-SWP-08), S2-SEC-9, S2-CAP-11 (S2-T-SWP-06),
 *   S2-CAP-18 (S2-T-SWP-07), S2-ADM-17 (S2-T-SWP-09), S2-ADM-15 (S2-T-SWP-10..11)
 *
 * Coverage:
 *   - the pass runs after the 1d passes, inside what they left of the 45 and at most
 *     PAYMENTS_SWEEP_ORDER_SUBREQUESTS (12); an item starts only when its worst case fits
 *   - orders env invalid → skipped (no pending_order_work request), logged; 1d passes unaffected
 *   - missing order emails (confirmation = invoice, owner, shipped, expired_alert) → sent and stamped
 *   - a withdrawal needing refund → processOrderRefund (mocked except S2-T-SWP-11, which runs
 *     the real pass on counted fetches at the cap of 12); reminder → the owner's reminder
 *   - withdrawal emails ack, owner_alert, receipt and manual_alert → read, sent to the buyer or
 *     ORDER_NOTIFY_TO under their keys, recorded by their step; a failed send → mail_failed
 *   - capture warning → the owner's warning (order-capture-warn/<id>) stamped capture_warning;
 *     a failed send counts failed
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  PAYMENTS_SWEEP_LIMIT,
  PAYMENTS_SWEEP_ORDER_SUBREQUESTS,
  PAYMENTS_SWEEP_SUBREQUEST_BUDGET,
  WITHDRAWAL_LEASE_SECONDS,
  WITHDRAWAL_MAX_MAIL_ATTEMPTS,
} from "@/config/payments";
import { WITHDRAWAL_TEXT_VERSION } from "@/config/legal/withdrawal-texts";
import type { PaymentsEnv } from "../../../../workers/payments/env";
import type * as OrderWithdrawalModule from "../../../../workers/payments/orders/withdrawal";

const mockProcessOrderRefund = vi.fn();
vi.mock("../../../../workers/payments/orders/withdrawal", () => ({
  processOrderRefund: (...args: unknown[]) => mockProcessOrderRefund(...args),
}));

import { runSweep } from "../../../../workers/payments/sweep";
import { createOrderDeps } from "../../../../workers/payments/orders/deps";
import { parseOrdersEnv } from "../../../../workers/payments/orders/env";
import { runOrderPass } from "../../../../workers/payments/orders/sweep";

// Pre-commit secret scan: the literals live in *_FX constants.
const SB_KEY_FX = "sb_secret_unittestkey1234";
const LINK_FX = "order-link-unit-fixture-32-characters-long";

const CONFIG: PaymentsEnv = {
  supabaseUrl: "https://xmgpixhxecamtryohgmk.supabase.co",
  supabaseSecretKey: SB_KEY_FX,
  stripeKey: "sk_test_unitfakekey1234",
  webhookSecret: "whsec_unittest1234",
  livemode: false,
  resendApiKey: "re_unittest1234",
  mailFrom: "Alnyron <noreply@send.alnyron.dk>",
  withdrawalAlertTo: "owner@alnyron.dk",
  siteUrl: "https://alnyron.dk",
};

/** The Worker's raw env: the goods keys parseOrdersEnv reads. */
const ENV = { ORDER_LINK_SECRET: LINK_FX, ORDER_NOTIFY_TO: "info@alnyron.dk", STRIPE_TAX_RATE_ID: "txr_1Ubdp4FBWtA5MNzbg2ZKznPw" };

const ORDER_ID = "00000000-0000-0000-0000-000000000011";
const WD_ID_1 = "00000000-0000-0000-0000-000000000021";
const WD_ID_2 = "00000000-0000-0000-0000-000000000022";
const BUYER = "delivered+s2-sweep@resend.dev";
const REST = `${CONFIG.supabaseUrl}/rest/v1`;

/** An order row as a read of `orders` with its lines answers it. */
function orderRow(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    order_number: 1001,
    status: "authorized",
    email: BUYER,
    customer_name: "Lars Andersen",
    phone: "+4520123456",
    shipping_name: "Lars Andersen",
    shipping_address: { line1: "Testvej 1", line2: null, postal_code: "7860", city: "Spøttrup", country: "DK" },
    locale: "da",
    amount_total_ore: 24995,
    amount_refunded_ore: 0,
    paid_at: "2026-11-14T10:00:00+00:00",
    authorization_expires_at: "2026-11-21T10:00:00+00:00",
    captured_at: null,
    cancel_reason: null,
    anomaly: null,
    tracking_ref: null,
    stripe_payment_intent_id: "pi_sweep0000000000001",
    order_items: [{ line_no: 1, title: "Testfigur", quantity: 1 }],
    ...overrides,
  };
}

function withdrawalRow(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
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
    orders: orderRow(ORDER_ID),
    ...overrides,
  };
}

type Recorded = { method: string; url: string; body: unknown; idempotencyKey: string | null };

type Pending = {
  /** The 1d list (`payments_pending_work`): consents use 4 of the budget each (charged), 3 real. */
  consents?: number;
  ordersMail?: { order_id: string; needs: string[] }[];
  withdrawals?: { withdrawal_id: string; needs: string[] }[];
  captureWarnings?: string[];
  /** Overrides of the order row a read answers. */
  orderRow?: Record<string, unknown>;
  /** Overrides of the withdrawal row a read answers. */
  withdrawalRow?: Record<string, unknown>;
};

/** A fake network answering like Supabase, Auth and Resend; every request is recorded. */
function fakeNetwork(pending: Pending, resend?: (body: Record<string, unknown>) => Response): Recorded[] {
  const requests: Recorded[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    const idempotencyKey = new Headers(init?.headers).get("idempotency-key");
    requests.push({ method, url, body, idempotencyKey });
    if (url === `${REST}/rpc/payments_pending_work`) {
      const consents = Array.from({ length: pending.consents ?? 0 }, (_, i) => ({
        checkout_session_id: `cs_test_sweep${i}`,
        subscription_id: `sub_sweep${i}`,
        user_id: "00000000-0000-0000-0d1d-000000000001",
        locale: "da",
        text_version: WITHDRAWAL_TEXT_VERSION,
        accepted_at: "2026-11-14T10:00:00.000Z",
        started_at: "2026-11-14T10:00:00.000Z",
        plan: { billing_interval: "month", amount_ore: 1000, name: "Monitor Plus" },
      }));
      return json({ withdrawals: [], consents });
    }
    if (url === `${REST}/rpc/payments_mark_consent_info_sent`) return json({ outcome: "stamped" });
    if (url.includes("/auth/v1/admin/users/")) return json({ id: "00000000-0000-0000-0d1d-000000000001", email: "delivered+sub@resend.dev" });
    if (url === `${REST}/rpc/payments_pending_order_work`) {
      return json({
        orders_mail: pending.ordersMail ?? [],
        withdrawals: pending.withdrawals ?? [],
        orders_capture_warning: (pending.captureWarnings ?? []).map((order_id) => ({ order_id, needs: ["capture_warning"] })),
      });
    }
    if (url === `${REST}/rpc/payments_order_mail_sent`) return json({ outcome: "stamped" });
    if (url === `${REST}/rpc/payments_order_withdrawal_step`) {
      return json({ outcome: "applied", withdrawal: { ...withdrawalRow(WD_ID_1), orders: undefined } });
    }
    if (url.startsWith(`${REST}/orders?`)) {
      const id = new URL(url).searchParams.get("id")?.replace("eq.", "") ?? ORDER_ID;
      return json([orderRow(id, pending.orderRow)]);
    }
    if (url.startsWith(`${REST}/order_withdrawals?`)) {
      const id = new URL(url).searchParams.get("id")?.replace("eq.", "") ?? WD_ID_1;
      return json([withdrawalRow(id, pending.withdrawalRow)]);
    }
    if (url === "https://api.resend.com/emails") {
      return resend?.(body as Record<string, unknown>) ?? json({ id: `email-${requests.length}` });
    }
    throw new Error(`unexpected request ${method} ${url}`);
  });
  return requests;
}

/** The parsed log lines of one message. */
function lines(log: MockInstance<typeof console.log>, msg: string): Record<string, unknown>[] {
  return log.mock.calls
    .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
    .filter((line) => line.msg === msg);
}

/** The order pass's requests: everything after the 1d pass's single read (no 1d work listed). */
const orderPassRequests = (requests: Recorded[]) => {
  expect(requests[0]?.url).toBe(`${REST}/rpc/payments_pending_work`);
  return requests.slice(1);
};

let log: MockInstance<typeof console.log>;

beforeEach(() => {
  vi.clearAllMocks();
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  mockProcessOrderRefund.mockResolvedValue("completed");
});

afterEach(() => {
  log.mockRestore();
  vi.unstubAllGlobals();
});

describe("PAYMENTS_SWEEP_ORDER_SUBREQUESTS pin", () => {
  it("is 12, inside the sweep's budget of 45", () => {
    expect(PAYMENTS_SWEEP_ORDER_SUBREQUESTS).toBe(12);
    expect(PAYMENTS_SWEEP_ORDER_SUBREQUESTS).toBeLessThan(PAYMENTS_SWEEP_SUBREQUEST_BUDGET);
  });
});

describe("S2-SWP-2 / S2-SEC-9 (S2-T-SWP-02): orders env invalid → the order pass is skipped and logged", () => {
  it("no pending_order_work request; the 1d pass ran and logged its own done line", async () => {
    const requests = fakeNetwork({ ordersMail: [{ order_id: ORDER_ID, needs: ["confirmation"] }] });
    await runSweep(CONFIG, { ...ENV, ORDER_LINK_SECRET: undefined });
    expect(requests.map(({ url }) => url)).toEqual([`${REST}/rpc/payments_pending_work`]);
    expect(lines(log, "payments order sweep")).toEqual([
      { msg: "payments order sweep", outcome: "skipped", code: "orders_env_unavailable" },
    ]);
    expect(lines(log, "payments sweep")).toContainEqual(expect.objectContaining({ outcome: "done" }));
  });
});

describe("S2-SWP-1 (S2-T-SWP-01): after the 1d passes, within what they left, at most 12", () => {
  it("reads the order work with the list limit and the mail cap after the 1d read", async () => {
    const requests = fakeNetwork({});
    await runSweep(CONFIG, ENV);
    expect(requests).toEqual([
      { method: "POST", url: `${REST}/rpc/payments_pending_work`, body: expect.anything(), idempotencyKey: null },
      {
        method: "POST",
        url: `${REST}/rpc/payments_pending_order_work`,
        body: { p_limit: PAYMENTS_SWEEP_LIMIT, p_max_mail_attempts: WITHDRAWAL_MAX_MAIL_ATTEMPTS },
        idempotencyKey: null,
      },
    ]);
    expect(lines(log, "payments order sweep")).toEqual([
      { msg: "payments order sweep", outcome: "done", orders: 0, warnings: 0, withdrawals: 0, budgetStop: false, subrequests: 1 },
    ]);
  });

  it("own cap: orders with 2 emails each (worst 1 + 2 × 2 = 5) → 2 of them (1 + 5 + 5 = 11; a third needs 16 > 12)", async () => {
    const ordersMail = Array.from({ length: 5 }, (_, i) => ({
      order_id: `00000000-0000-0000-0000-00000000010${i}`,
      needs: ["confirmation", "owner"],
    }));
    const requests = fakeNetwork({ ordersMail });
    await runSweep(CONFIG, ENV);
    const orderRequests = orderPassRequests(requests);
    expect(orderRequests).toHaveLength(11);
    expect(orderRequests.length).toBeLessThanOrEqual(PAYMENTS_SWEEP_ORDER_SUBREQUESTS);
    expect(lines(log, "payments order sweep").at(-1)).toEqual({
      msg: "payments order sweep",
      outcome: "done",
      orders: 2,
      warnings: 0,
      withdrawals: 0,
      budgetStop: true,
      subrequests: 11,
    });
  });

  it("never past the 45: 9 order confirmations of the 1d pass charge 1 + 9 × 4 = 37 → 8 left: one order (5), not two", async () => {
    const ordersMail = [
      { order_id: "00000000-0000-0000-0000-000000000101", needs: ["confirmation", "owner"] },
      { order_id: "00000000-0000-0000-0000-000000000102", needs: ["confirmation", "owner"] },
    ];
    const requests = fakeNetwork({ consents: 9, ordersMail });
    await runSweep(CONFIG, ENV);
    expect(lines(log, "payments sweep").find((line) => line.outcome === "done")).toMatchObject({ consents: 9, subrequests: 28 });
    expect(lines(log, "payments order sweep").at(-1)).toMatchObject({ orders: 1, budgetStop: true, subrequests: 6 });
    expect(requests).toHaveLength(28 + 6);
  });

  it("the 1d passes used the whole budget (11 confirmations, 1 + 44 charged) → the order pass is skipped", async () => {
    const requests = fakeNetwork({ consents: 11, ordersMail: [{ order_id: ORDER_ID, needs: ["confirmation"] }] });
    await runSweep(CONFIG, ENV);
    expect(requests.some(({ url }) => url.includes("payments_pending_order_work"))).toBe(false);
    expect(lines(log, "payments order sweep")).toEqual([
      { msg: "payments order sweep", outcome: "skipped", code: "budget_spent" },
    ]);
  });
});

describe("S2-SWP-3 (S2-T-SWP-03): missing order emails → sent and stamped", () => {
  it("confirmation (the invoice) to the buyer and the owner's new order to ORDER_NOTIFY_TO, each stamped", async () => {
    const requests = fakeNetwork({ ordersMail: [{ order_id: ORDER_ID, needs: ["confirmation", "owner"] }] });
    await runSweep(CONFIG, ENV);
    const goods = orderPassRequests(requests).slice(1);
    expect(goods.map(({ method, url }) => `${method} ${url.split("?")[0]}`)).toEqual([
      `GET ${REST}/orders`,
      "POST https://api.resend.com/emails",
      `POST ${REST}/rpc/payments_order_mail_sent`,
      "POST https://api.resend.com/emails",
      `POST ${REST}/rpc/payments_order_mail_sent`,
    ]);
    expect(goods[1]).toMatchObject({ idempotencyKey: `order-confirm/${ORDER_ID}`, body: { to: [BUYER] } });
    expect(goods[1]).toMatchObject({ body: { subject: "Ordrebekræftelse og faktura nr. 1001" } });
    expect(goods[3]).toMatchObject({ idempotencyKey: `order-owner/${ORDER_ID}`, body: { to: ["info@alnyron.dk"] } });
    expect(goods[2]!.body).toEqual({ p_order_id: ORDER_ID, p_kind: "confirmation", p_email_id: "email-4" });
    expect(goods[4]!.body).toEqual({ p_order_id: ORDER_ID, p_kind: "owner", p_email_id: "email-6" });
  });

  it("shipped → order-shipped/<id> to the buyer, stamped shipped", async () => {
    const requests = fakeNetwork({
      ordersMail: [{ order_id: ORDER_ID, needs: ["shipped"] }],
      orderRow: { status: "shipped", captured_at: "2026-11-15T10:00:00+00:00", tracking_ref: "GLS123" },
    });
    await runSweep(CONFIG, ENV);
    const goods = orderPassRequests(requests).slice(1);
    expect(goods.map(({ method, url }) => `${method} ${url.split("?")[0]}`)).toEqual([
      `GET ${REST}/orders`,
      "POST https://api.resend.com/emails",
      `POST ${REST}/rpc/payments_order_mail_sent`,
    ]);
    expect(new URL(goods[0]!.url).searchParams.get("id")).toBe(`eq.${ORDER_ID}`);
    expect(goods[1]).toMatchObject({
      idempotencyKey: `order-shipped/${ORDER_ID}`,
      body: { to: [BUYER], subject: "Din ordre nr. 1001 er sendt" },
    });
    expect(goods[2]!.body).toEqual({ p_order_id: ORDER_ID, p_kind: "shipped", p_email_id: "email-4" });
  });

  it("a failed send counts 'failed' and the pass goes on", async () => {
    const requests = fakeNetwork(
      { ordersMail: [{ order_id: ORDER_ID, needs: ["confirmation", "owner"] }] },
      (body) => (JSON.stringify(body.to) === JSON.stringify([BUYER]) ? new Response("{}", { status: 500 }) : new Response(JSON.stringify({ id: "em-owner" }))),
    );
    await runSweep(CONFIG, ENV);
    const stamps = requests.filter(({ url }) => url.endsWith("/rpc/payments_order_mail_sent")).map(({ body }) => body);
    expect(stamps).toEqual([
      { p_order_id: ORDER_ID, p_kind: "failed", p_email_id: "" },
      { p_order_id: ORDER_ID, p_kind: "owner", p_email_id: "em-owner" },
    ]);
    expect(lines(log, "payments order sweep")).toContainEqual({
      msg: "payments order sweep",
      order: ORDER_ID,
      need: "confirmation",
      outcome: "failed",
      code: "mail_transient",
    });
  });
});

describe("S2-SWP-4 (S2-T-SWP-04): a withdrawal needing its refund or release → one processOrderRefund pass each", () => {
  it("calls processOrderRefund for each, without a read", async () => {
    const requests = fakeNetwork({
      withdrawals: [
        { withdrawal_id: WD_ID_1, needs: ["refund"] },
        { withdrawal_id: WD_ID_2, needs: ["refund"] },
      ],
    });
    await runSweep(CONFIG, ENV);
    expect(mockProcessOrderRefund.mock.calls.map(([, id]) => id)).toEqual([WD_ID_1, WD_ID_2]);
    expect(requests.some(({ url }) => url.includes("/order_withdrawals?"))).toBe(false);
    expect(lines(log, "payments order sweep")).toContainEqual({
      msg: "payments order sweep",
      withdrawal: WD_ID_1,
      need: "refund",
      outcome: "completed",
      code: null,
    });
  });
});

describe("S2-ADM-15 (S2-T-SWP-10): reserve 6 subrequests for a refund pass, including its refund lookup", () => {
  it.each([
    { limit: 6, calls: 0, budgetStop: true },
    { limit: 7, calls: 1, budgetStop: false },
  ])("a pending-work read plus the refund reservation fits only at limit $limit: $calls pass", async ({ limit, calls, budgetStop }) => {
    const requests = fakeNetwork({ withdrawals: [{ withdrawal_id: WD_ID_1, needs: ["refund"] }] });
    await runOrderPass(createOrderDeps(CONFIG, parseOrdersEnv(ENV)), { limit, count: () => requests.length });
    expect(mockProcessOrderRefund).toHaveBeenCalledTimes(calls);
    if (calls !== 0) expect(mockProcessOrderRefund).toHaveBeenCalledWith(expect.anything(), WD_ID_1);
    expect(requests.map(({ url }) => url)).toEqual([`${REST}/rpc/payments_pending_order_work`]);
    expect(lines(log, "payments order sweep").at(-1)).toMatchObject({ withdrawals: calls, budgetStop, subrequests: 1 });
  });
});

describe("S2-ADM-15 (S2-T-SWP-11): an approved link withdrawal's ack, owner alert and refund fit the cap of 12", () => {
  it("sends and stamps all three emails, creates and records the refund, without stopping the queue", async () => {
    const { processOrderRefund } = await vi.importActual<typeof OrderWithdrawalModule>(
      "../../../../workers/payments/orders/withdrawal",
    );
    mockProcessOrderRefund.mockImplementationOnce(processOrderRefund);
    const order = orderRow(ORDER_ID, { status: "shipped", captured_at: "2026-11-15T10:00:00+00:00" });
    const approved = withdrawalRow(WD_ID_1, {
      channel: "link",
      status: "approved",
      action: "refund",
      refund_ore: 24995,
      shipped_before_notice: true,
      orders: order,
    });
    const completed = { ...approved, status: "completed", refunded_at: "2026-11-20T10:00:00+00:00" };
    const refundId = "re_sweep0000000000001";
    const answers = [
      { orders_mail: [], orders_capture_warning: [], withdrawals: [{ withdrawal_id: WD_ID_1, needs: ["ack", "owner_alert", "refund"] }] },
      [approved],
      { id: "email-ack" },
      { outcome: "applied", withdrawal: approved },
      { id: "email-alert" },
      { outcome: "applied", withdrawal: approved },
      { claimed: true, withdrawal: { ...approved, attempts: 1 }, order },
      { object: "list", data: [], has_more: false },
      { id: refundId, status: "succeeded" },
      { outcome: "applied", withdrawal: completed },
      { id: "email-credit" },
      { outcome: "applied", withdrawal: completed },
    ];
    const fetchSpy = vi.fn<typeof fetch>();
    for (const answer of answers) fetchSpy.mockResolvedValueOnce(Response.json(answer));
    const deps = createOrderDeps(CONFIG, parseOrdersEnv(ENV), fetchSpy);

    await runOrderPass(deps, { limit: PAYMENTS_SWEEP_ORDER_SUBREQUESTS, count: () => fetchSpy.mock.calls.length });

    expect(mockProcessOrderRefund).toHaveBeenCalledExactlyOnceWith(deps, WD_ID_1);
    const requests = fetchSpy.mock.calls;
    expect(requests.map(([url, init]) => `${init?.method ?? "GET"} ${String(url).split("?")[0]}`)).toEqual([
      `POST ${REST}/rpc/payments_pending_order_work`,
      `GET ${REST}/order_withdrawals`,
      "POST https://api.resend.com/emails",
      `POST ${REST}/rpc/payments_order_withdrawal_step`,
      "POST https://api.resend.com/emails",
      `POST ${REST}/rpc/payments_order_withdrawal_step`,
      `POST ${REST}/rpc/payments_claim_order_withdrawal`,
      "GET https://api.stripe.com/v1/refunds",
      "POST https://api.stripe.com/v1/refunds",
      `POST ${REST}/rpc/payments_order_withdrawal_step`,
      "POST https://api.resend.com/emails",
      `POST ${REST}/rpc/payments_order_withdrawal_step`,
    ]);
    expect(new URL(String(requests[1]![0])).searchParams.get("id")).toBe(`eq.${WD_ID_1}`);
    expect(JSON.parse(String(requests[6]![1]?.body))).toEqual({
      p_withdrawal_id: WD_ID_1, p_lease_seconds: WITHDRAWAL_LEASE_SECONDS,
    });
    expect(String(requests[7]![0])).toBe(
      "https://api.stripe.com/v1/refunds?payment_intent=pi_sweep0000000000001&limit=100",
    );
    expect(new URLSearchParams(String(requests[8]![1]?.body))).toEqual(new URLSearchParams({
      payment_intent: "pi_sweep0000000000001",
      amount: "24995",
      "metadata[order_withdrawal_id]": WD_ID_1,
      "metadata[order_number]": "1001",
    }));
    expect(new Headers(requests[8]![1]?.headers).get("idempotency-key")).toBe(`ord-re-${WD_ID_1}`);
    expect([requests[2]!, requests[4]!, requests[10]!].map(([, init]) => ({
      key: new Headers(init?.headers).get("idempotency-key"),
      body: JSON.parse(String(init?.body)),
    }))).toMatchObject([
      { key: `order-wd-ack/${WD_ID_1}`, body: { to: [BUYER], subject: "Vi har modtaget din fortrydelse (ordre 1001)" } },
      { key: `order-wd-alert/${WD_ID_1}`, body: { to: ["info@alnyron.dk"], subject: "Fortrydelse modtaget: ordre 1001" } },
      { key: `order-refund/${WD_ID_1}`, body: { to: [BUYER], subject: "Kreditnota til faktura nr. 1001" } },
    ]);
    expect(requests.filter(([url]) => String(url).endsWith("/rpc/payments_order_withdrawal_step"))
      .map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { p_withdrawal_id: WD_ID_1, p_step: "ack_sent", p_data: { email_id: "email-ack" } },
      { p_withdrawal_id: WD_ID_1, p_step: "owner_alerted", p_data: { email_id: "email-alert" } },
      { p_withdrawal_id: WD_ID_1, p_step: "refunded", p_data: { refund_id: refundId, refund_tax_ore: 4999 } },
      { p_withdrawal_id: WD_ID_1, p_step: "receipt_sent", p_data: { email_id: "email-credit" } },
    ]);
    expect(lines(log, "payments order sweep")).toEqual([
      { msg: "payments order sweep", withdrawal: WD_ID_1, need: "ack", outcome: "sent", code: null },
      { msg: "payments order sweep", withdrawal: WD_ID_1, need: "owner_alert", outcome: "sent", code: null },
      { msg: "payments order sweep", withdrawal: WD_ID_1, need: "refund", outcome: "completed", code: null },
      { msg: "payments order sweep", outcome: "done", orders: 0, warnings: 0, withdrawals: 1, budgetStop: false, subrequests: 12 },
    ]);
  });
});

describe("S2-SWP-5 (S2-T-SWP-05): a received withdrawal near its refund deadline → the owner's reminder", () => {
  it("reads the withdrawal with its order, sends order-wd-remind/<id> to ORDER_NOTIFY_TO and records reminder_sent", async () => {
    const requests = fakeNetwork({ withdrawals: [{ withdrawal_id: WD_ID_1, needs: ["reminder"] }] });
    await runSweep(CONFIG, ENV);
    const resend = requests.filter(({ url }) => url === "https://api.resend.com/emails");
    expect(resend).toHaveLength(1);
    expect(resend[0]).toMatchObject({ idempotencyKey: `order-wd-remind/${WD_ID_1}`, body: { to: ["info@alnyron.dk"] } });
    const steps = requests.filter(({ url }) => url.endsWith("/rpc/payments_order_withdrawal_step")).map(({ body }) => body);
    expect(steps).toEqual([{ p_withdrawal_id: WD_ID_1, p_step: "reminder_sent", p_data: {} }]);
  });
});

describe("S2-CAP-11 (S2-T-SWP-06): the capture warning before a reservation lapses", () => {
  it("sends order-capture-warn/<id> to the owner and stamps capture_warning", async () => {
    const requests = fakeNetwork({ captureWarnings: [ORDER_ID] });
    await runSweep(CONFIG, ENV);
    const resend = requests.filter(({ url }) => url === "https://api.resend.com/emails");
    expect(resend).toHaveLength(1);
    expect(resend[0]).toMatchObject({ idempotencyKey: `order-capture-warn/${ORDER_ID}`, body: { to: ["info@alnyron.dk"] } });
    expect(requests.filter(({ url }) => url.endsWith("/rpc/payments_order_mail_sent")).map(({ body }) => body)).toEqual([
      { p_order_id: ORDER_ID, p_kind: "capture_warning", p_email_id: expect.stringMatching(/^email-/) },
    ]);
    expect(lines(log, "payments order sweep").at(-1)).toMatchObject({ warnings: 1, subrequests: 4 });
  });

  it("a failed send counts 'failed'", async () => {
    const requests = fakeNetwork({ captureWarnings: [ORDER_ID] }, () => new Response("{}", { status: 503 }));
    await runSweep(CONFIG, ENV);
    expect(requests.filter(({ url }) => url.endsWith("/rpc/payments_order_mail_sent")).map(({ body }) => body)).toEqual([
      { p_order_id: ORDER_ID, p_kind: "failed", p_email_id: "" },
    ]);
  });
});

describe("S2-CAP-18 (S2-T-SWP-07): the lapsed-reservation alert is resent until stamped (A2-2)", () => {
  it("expired_alert → order-expired/<id> to the owner, stamped expired_alert", async () => {
    const requests = fakeNetwork({ ordersMail: [{ order_id: ORDER_ID, needs: ["expired_alert"] }] });
    await runSweep(CONFIG, ENV);
    const resend = requests.filter(({ url }) => url === "https://api.resend.com/emails");
    expect(resend).toHaveLength(1);
    expect(resend[0]).toMatchObject({ idempotencyKey: `order-expired/${ORDER_ID}`, body: { to: ["info@alnyron.dk"] } });
    expect(requests.filter(({ url }) => url.endsWith("/rpc/payments_order_mail_sent")).map(({ body }) => body)).toEqual([
      { p_order_id: ORDER_ID, p_kind: "expired_alert", p_email_id: expect.stringMatching(/^email-/) },
    ]);
  });

  it("a failed send counts 'failed' (the sweep tries again next hour while under the mail cap)", async () => {
    const requests = fakeNetwork({ ordersMail: [{ order_id: ORDER_ID, needs: ["expired_alert"] }] }, () => new Response("{}", { status: 500 }));
    await runSweep(CONFIG, ENV);
    expect(requests.filter(({ url }) => url.endsWith("/rpc/payments_order_mail_sent")).map(({ body }) => body)).toEqual([
      { p_order_id: ORDER_ID, p_kind: "failed", p_email_id: "" },
    ]);
  });
});

describe("S2-SWP-1 (S2-T-SWP-08): the withdrawal emails left undone → read, sent to the right recipient, recorded", () => {
  it.each([
    {
      need: "ack",
      row: {},
      to: BUYER,
      key: `order-wd-ack/${WD_ID_1}`,
      subject: "Vi har modtaget din fortrydelse (ordre 1001)",
      step: "ack_sent",
    },
    {
      need: "owner_alert",
      row: {},
      to: "info@alnyron.dk",
      key: `order-wd-alert/${WD_ID_1}`,
      subject: "Fortrydelse modtaget: ordre 1001",
      step: "owner_alerted",
    },
    {
      need: "receipt",
      row: { status: "completed", action: "refund", refund_ore: 24995, refunded_at: "2026-11-20T10:00:00+00:00" },
      to: BUYER,
      key: `order-refund/${WD_ID_1}`,
      subject: "Kreditnota til faktura nr. 1001",
      step: "receipt_sent",
    },
  ])("$need → $key to $to, step $step", async ({ need, row, to, key, subject, step }) => {
    const requests = fakeNetwork({ withdrawals: [{ withdrawal_id: WD_ID_1, needs: [need] }], withdrawalRow: row });
    await runSweep(CONFIG, ENV);
    const goods = orderPassRequests(requests).slice(1);
    expect(goods.map(({ method, url }) => `${method} ${url.split("?")[0]}`)).toEqual([
      `GET ${REST}/order_withdrawals`,
      "POST https://api.resend.com/emails",
      `POST ${REST}/rpc/payments_order_withdrawal_step`,
    ]);
    expect(new URL(goods[0]!.url).searchParams.get("id")).toBe(`eq.${WD_ID_1}`);
    expect(goods[1]).toMatchObject({ idempotencyKey: key, body: { to: [to], subject } });
    expect(goods[2]!.body).toEqual({ p_withdrawal_id: WD_ID_1, p_step: step, p_data: { email_id: "email-4" } });
    expect(lines(log, "payments order sweep")).toContainEqual({
      msg: "payments order sweep",
      withdrawal: WD_ID_1,
      need,
      outcome: "sent",
      code: null,
    });
  });

  it("a receipt asked for before the withdrawal completed sends nothing: mail_failed, logged mail_not_due", async () => {
    const requests = fakeNetwork({ withdrawals: [{ withdrawal_id: WD_ID_1, needs: ["receipt"] }] });
    await runSweep(CONFIG, ENV);
    expect(requests.some(({ url }) => url === "https://api.resend.com/emails")).toBe(false);
    expect(requests.filter(({ url }) => url.endsWith("/rpc/payments_order_withdrawal_step")).map(({ body }) => body)).toEqual([
      { p_withdrawal_id: WD_ID_1, p_step: "mail_failed", p_data: {} },
    ]);
    expect(lines(log, "payments order sweep")).toContainEqual({
      msg: "payments order sweep",
      withdrawal: WD_ID_1,
      need: "receipt",
      outcome: "failed",
      code: "mail_not_due",
    });
  });
});

describe("S2-ADM-17 (S2-T-SWP-09): the owner's manual-handling alert is resent until stamped (amendment A3-3)", () => {
  it("manual_alert → order-wd-manual/<id> to ORDER_NOTIFY_TO with the reason, step manual_alert_sent", async () => {
    const requests = fakeNetwork({
      withdrawals: [{ withdrawal_id: WD_ID_1, needs: ["manual_alert"] }],
      withdrawalRow: { status: "needs_manual", action: "refund", refund_ore: 24995, manual_reason: "stripe_refused" },
    });
    await runSweep(CONFIG, ENV);
    const goods = orderPassRequests(requests).slice(1);
    expect(goods.map(({ method, url }) => `${method} ${url.split("?")[0]}`)).toEqual([
      `GET ${REST}/order_withdrawals`,
      "POST https://api.resend.com/emails",
      `POST ${REST}/rpc/payments_order_withdrawal_step`,
    ]);
    expect(goods[1]).toMatchObject({
      idempotencyKey: `order-wd-manual/${WD_ID_1}`,
      body: {
        to: ["info@alnyron.dk"],
        subject: "Ordre 1001: fortrydelsen kræver manuel behandling",
        text: expect.stringContaining("Årsag: Stripe afviste tilbagebetalingen eller frigivelsen af reservationen."),
      },
    });
    expect(goods[2]!.body).toEqual({ p_withdrawal_id: WD_ID_1, p_step: "manual_alert_sent", p_data: { email_id: "email-4" } });
  });

  it("a failed send records mail_failed (the sweep tries again next hour while under the mail cap)", async () => {
    const requests = fakeNetwork(
      {
        withdrawals: [{ withdrawal_id: WD_ID_1, needs: ["manual_alert"] }],
        withdrawalRow: { status: "needs_manual", action: "refund", refund_ore: 24995, manual_reason: "retries_exhausted" },
      },
      () => new Response("{}", { status: 500 }),
    );
    await runSweep(CONFIG, ENV);
    expect(requests.filter(({ url }) => url.endsWith("/rpc/payments_order_withdrawal_step")).map(({ body }) => body)).toEqual([
      { p_withdrawal_id: WD_ID_1, p_step: "mail_failed", p_data: {} },
    ]);
  });
});
