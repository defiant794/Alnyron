/**
 * Unit tests: src/app/order/withdraw/actions.ts — withdrawOrder Server Action
 * Journey: payments-s2-3d-purchase
 * Criteria: S2-WD-3..9 (web layer - withdrawOrder action)
 *
 * Test IDs: S2-T-WACT-01..11
 *
 * Contract §3 (pinned):
 *   - Per-IP rate limit order-withdraw:<ip> fail-closed → state=busy
 *   - Zod failures → state=refused (generic, never reveals why)
 *   - statementVersion = GOODS_TEXT_VERSION forwarded to ORDERS.withdraw
 *   - Link channel: orderId+token → ORDERS.withdraw({channel:'link',...})
 *   - Form channel: orderNumber+email → ORDERS.withdraw({channel:'form',...})
 *   - Result mapping: received→?state=received, refused→?state=refused,
 *     busy→?state=busy, unavailable→?state=unavailable
 *   - No PII in redirect URLs
 *   - ORDERS binding missing → state=unavailable
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// ── vi.hoisted ──────────────────────────────────────────────────────────────

const {
  mockGetCloudflareContext,
  mockLimit,
  mockOrdersWithdraw,
  mockRedirect,
  mockParseSiteEnv,
} = vi.hoisted(() => ({
  mockGetCloudflareContext: vi.fn(),
  mockLimit: vi.fn(),
  mockOrdersWithdraw: vi.fn(),
  mockRedirect: vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`); }),
  mockParseSiteEnv: vi.fn(),
}));

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: mockGetCloudflareContext }));
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
// The action reads the client IP (cf-connecting-ip) from the request headers; outside a
// request scope next/headers throws, so every call sees makeRequestHeaders() (TEST_IP).
vi.mock("next/headers", () => ({ headers: async () => makeRequestHeaders() }));
vi.mock("@/config/env", async (importOriginal) => {
  // Exception: vi.mock factory is hoisted; must dynamically import the original here.
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, parseSiteEnv: mockParseSiteEnv };
});

// ── Module under test ───────────────────────────────────────────────────────

import { withdrawOrder } from "@/app/order/withdraw/actions";
import { GOODS_TEXT_VERSION } from "@/config/legal/goods-texts";

// ── Helpers ────────────────────────────────────────────────────────────────

const SITE_ORIGIN = "https://alnyron.dk";
const ORDER_ID = "00000000-0000-0000-0000-000000000001";
const ORDER_TOKEN = "valid-token-abc123";
const TEST_IP = "203.0.113.42";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

/**
 * `withdrawOrder(fd)` ends in exactly the redirect to `/order/withdraw?state=<state>&lang=<lang>`:
 * the whole message is compared, so nothing the buyer entered can ride along in the URL, and an
 * error that is no redirect fails the test.
 */
async function expectRedirect(fd: FormData, state: string, lang = "da"): Promise<void> {
  await expect(withdrawOrder(fd)).rejects.toHaveProperty(
    "message",
    `NEXT_REDIRECT:/order/withdraw?state=${state}&lang=${lang}`,
  );
}

function setupDefaultEnv(): void {
  mockParseSiteEnv.mockReturnValue({ NEXT_PUBLIC_SITE_URL: SITE_ORIGIN });
  mockGetCloudflareContext.mockReturnValue({
    env: {
      BILLING_RATE_LIMITER: { limit: mockLimit },
      ORDERS: { withdraw: mockOrdersWithdraw },
    },
  });
  mockLimit.mockResolvedValue({ success: true });
  mockOrdersWithdraw.mockResolvedValue({ ok: true, status: "received" });
}

function makeRequestHeaders(ip = TEST_IP): Headers {
  const h = new Headers();
  h.set("cf-connecting-ip", ip);
  return h;
}

beforeEach(() => { vi.clearAllMocks(); });

// ── S2-T-WACT-01: rate limit fail-closed → state=busy ────────────────────

describe("S2-T-WACT-01: withdrawOrder — rate limit missing → fail closed state=busy", () => {
  it("redirects to /order/withdraw?state=busy when BILLING_RATE_LIMITER absent", async () => {
    mockParseSiteEnv.mockReturnValue({ NEXT_PUBLIC_SITE_URL: SITE_ORIGIN });
    mockGetCloudflareContext.mockReturnValue({
      env: { ORDERS: { withdraw: mockOrdersWithdraw } },
    });
    const fd = form({ consumer_name: "Lars Andersen", statement_version: GOODS_TEXT_VERSION, order_id: ORDER_ID, token: ORDER_TOKEN, channel: "link" });
    await expectRedirect(fd, "busy");
    expect(mockOrdersWithdraw).not.toHaveBeenCalled();
  });
});

// ── S2-T-WACT-02: rate limit throws → state=busy ─────────────────────────

describe("S2-T-WACT-02: withdrawOrder — rate limiter throws → state=busy", () => {
  it("redirects to ?state=busy when limiter.limit throws", async () => {
    setupDefaultEnv();
    mockLimit.mockRejectedValue(new Error("limiter error"));
    const fd = form({ consumer_name: "Lars Andersen", statement_version: GOODS_TEXT_VERSION, order_id: ORDER_ID, token: ORDER_TOKEN, channel: "link" });
    await expectRedirect(fd, "busy");
    expect(mockOrdersWithdraw).not.toHaveBeenCalled();
  });
});

// ── S2-T-WACT-03: rate limit key order-withdraw:<ip> ─────────────────────

describe("S2-T-WACT-03: withdrawOrder — rate limit key is order-withdraw:<ip>", () => {
  it("calls BILLING_RATE_LIMITER.limit with key order-withdraw:<ip>", async () => {
    setupDefaultEnv();
    const fd = form({ consumer_name: "Lars Andersen", statement_version: GOODS_TEXT_VERSION, order_id: ORDER_ID, token: ORDER_TOKEN, channel: "link" });
    await expectRedirect(fd, "received");
    expect(mockLimit).toHaveBeenCalledWith({ key: `order-withdraw:${TEST_IP}` });
  });
});

// ── S2-T-WACT-04: zod failure → state=refused (generic, no PII) ──────────

describe("S2-T-WACT-04: withdrawOrder — zod invalid → state=refused, no PII in URL", () => {
  it("redirects to exactly ?state=refused for invalid consumer_name", async () => {
    setupDefaultEnv();
    // consumer_name too long (> 200 chars) is invalid per contract
    const fd = form({ consumer_name: "x".repeat(201), statement_version: GOODS_TEXT_VERSION, order_id: ORDER_ID, token: ORDER_TOKEN, channel: "link" });
    await expectRedirect(fd, "refused");
    expect(mockOrdersWithdraw).not.toHaveBeenCalled();
  });
});

// ── S2-T-WACT-05: statementVersion = GOODS_TEXT_VERSION forwarded ─────────

describe("S2-T-WACT-05: withdrawOrder — statementVersion = GOODS_TEXT_VERSION forwarded to ORDERS", () => {
  it("calls ORDERS.withdraw with statementVersion = GOODS_TEXT_VERSION", async () => {
    setupDefaultEnv();
    const fd = form({
      consumer_name: "Lars Andersen",
      statement_version: GOODS_TEXT_VERSION,
      order_id: ORDER_ID,
      token: ORDER_TOKEN,
      channel: "link",
    });
    await expectRedirect(fd, "received");
    expect(mockOrdersWithdraw).toHaveBeenCalledWith(
      expect.objectContaining({ statementVersion: GOODS_TEXT_VERSION }),
    );
  });
});

// ── S2-T-WACT-06: link channel → ORDERS.withdraw({channel:'link',...}) ────

describe("S2-T-WACT-06: withdrawOrder — link channel input to ORDERS.withdraw", () => {
  it("passes {channel:'link', orderId, token, consumerName, statementVersion} to ORDERS.withdraw", async () => {
    setupDefaultEnv();
    const fd = form({
      consumer_name: "Lars Andersen",
      statement_version: GOODS_TEXT_VERSION,
      order_id: ORDER_ID,
      token: ORDER_TOKEN,
      channel: "link",
      locale: "da",
    });
    await expectRedirect(fd, "received");
    expect(mockOrdersWithdraw).toHaveBeenCalledWith({
      channel: "link",
      orderId: ORDER_ID,
      token: ORDER_TOKEN,
      consumerName: "Lars Andersen",
      statementVersion: GOODS_TEXT_VERSION,
      locale: "da",
    });
  });
});

// ── S2-T-WACT-07: form channel → ORDERS.withdraw({channel:'form',...}) ────

describe("S2-T-WACT-07: withdrawOrder — form channel input to ORDERS.withdraw", () => {
  it("passes {channel:'form', orderNumber, email, consumerName, statementVersion} to ORDERS.withdraw", async () => {
    setupDefaultEnv();
    const fd = form({
      consumer_name: "Lars Andersen",
      statement_version: GOODS_TEXT_VERSION,
      order_number: "1001",
      email: "buyer@test.local",
      channel: "form",
      locale: "da",
    });
    await expectRedirect(fd, "received");
    expect(mockOrdersWithdraw).toHaveBeenCalledWith({
      channel: "form",
      orderNumber: 1001,
      email: "buyer@test.local",
      consumerName: "Lars Andersen",
      statementVersion: GOODS_TEXT_VERSION,
      locale: "da",
    });
  });
});

// ── S2-T-WACT-08: result=received → ?state=received ──────────────────────

describe("S2-T-WACT-08: withdrawOrder — {ok:true, status:'received'} → ?state=received", () => {
  it("redirects to /order/withdraw?state=received in the page's language", async () => {
    setupDefaultEnv();
    mockOrdersWithdraw.mockResolvedValue({ ok: true, status: "received" });
    const fd = form({ consumer_name: "Lars Andersen", statement_version: GOODS_TEXT_VERSION, order_id: ORDER_ID, token: ORDER_TOKEN, channel: "link", locale: "en" });
    await expectRedirect(fd, "received", "en");
  });
});

// ── S2-T-WACT-09: result=refused → ?state=refused ────────────────────────

describe("S2-T-WACT-09: withdrawOrder — {ok:false, reason:'refused'} → ?state=refused", () => {
  it("redirects to exactly /order/withdraw?state=refused (no PII in the URL)", async () => {
    setupDefaultEnv();
    mockOrdersWithdraw.mockResolvedValue({ ok: false, reason: "refused" });
    const fd = form({ consumer_name: "Lars Andersen", statement_version: GOODS_TEXT_VERSION, order_id: ORDER_ID, token: ORDER_TOKEN, channel: "link", locale: "da" });
    await expectRedirect(fd, "refused");
  });
});

// ── S2-T-WACT-10: ORDERS binding missing → state=unavailable ─────────────

describe("S2-T-WACT-10: withdrawOrder — ORDERS binding missing → ?state=unavailable", () => {
  it("redirects to ?state=unavailable when ORDERS binding absent", async () => {
    mockParseSiteEnv.mockReturnValue({ NEXT_PUBLIC_SITE_URL: SITE_ORIGIN });
    mockLimit.mockResolvedValue({ success: true });
    mockGetCloudflareContext.mockReturnValue({
      env: { BILLING_RATE_LIMITER: { limit: mockLimit } },
    });
    const fd = form({ consumer_name: "Lars Andersen", statement_version: GOODS_TEXT_VERSION, order_id: ORDER_ID, token: ORDER_TOKEN, channel: "link", locale: "da" });
    await expectRedirect(fd, "unavailable");
  });
});

// ── S2-T-WACT-11: no PII in refused redirect for form channel ────────────

describe("S2-T-WACT-11: withdrawOrder — same refused redirect for every identification failure, no PII", () => {
  it.each([
    ["refused (not found)", { ok: false, reason: "refused" }],
    ["invalid_input (bad statementVersion)", { ok: false, reason: "invalid_input" }],
  ])("maps %s to exactly ?state=refused (no order number, email or name in the URL)", async (_label, result) => {
    setupDefaultEnv();
    mockOrdersWithdraw.mockResolvedValue(result);
    const fd = form({
      consumer_name: "Lars Andersen",
      statement_version: GOODS_TEXT_VERSION,
      order_number: "1001",
      email: "buyer@test.local",
      channel: "form",
      locale: "da",
    });
    await expectRedirect(fd, "refused");
  });
});
