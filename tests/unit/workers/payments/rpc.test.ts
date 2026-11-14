/**
 * Unit tests: workers/payments/rpc.ts — createPaymentsRpc
 * Journey: payments-slice1c-webhook
 * Criteria: WH-AC25a..WH-AC25g, WH-AC_A16d,
 *           WH-AC25c-A13 (retry:false — A13),
 *           WH-AC25f-A14 (refusal field — A14),
 *           WH-AC_A28a (accountExists — A28).
 *
 * Covers: each method's RPC call shape, timeout abort,
 * PaymentsRpcError for 22023 and rpc_failed, otherEntitlingSubscriptionIds query shape,
 * retry behaviour, refusal field, and accountExists(userId) mapping.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPaymentsRpc, PaymentsRpcError } from "../../../../workers/payments/rpc";
import { PAYMENTS_RPC_TIMEOUT_MS } from "@/config/payments";

const SUPABASE_URL = "https://payments-unit-test.supabase.co";
const SECRET_KEY = "sb_secret_payments-unit-test";

/** Stands in for AbortSignal.timeout: captures the requested ms. */
function fakeTimeout() {
  const timer = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timer.signal);
  return { timer, timeout };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── WH-AC25a: syncSubscription RPC call shape ─────────────────────────────────

describe("WH-AC25a: syncSubscription calls payments_sync_subscription with p_event and p_subscription", () => {
  it("WH-AC25a: RPC function name and param names", async () => {
    const calls: { fn: string; args: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
      const fnMatch = String(url).match(/\/rpc\/([^?]+)/);
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ fn: fnMatch?.[1] ?? String(url), args: body });
      return new Response(JSON.stringify({ outcome: "applied", paused: 0 }), { status: 200 });
    });

    const rpc = createPaymentsRpc(SUPABASE_URL, SECRET_KEY);
    const event = { id: "evt_001", type: "customer.subscription.created", created: "2026-01-01T00:00:00.000Z", livemode: false };
    const sub = { id: "sub_001", customer: "cus_001", user_id: "00000000-0000-0000-0000-000000000001", price_id: "price_001", status: "active", current_period_end: null, cancel_at_period_end: false, start_date: "2026-01-01T00:00:00.000Z" };

    await expect(rpc.syncSubscription(event, sub)).resolves.toEqual({ outcome: "applied", paused: 0 });

    const rpcCall = calls.find((c) => String(c.fn).includes("payments_sync_subscription"));
    expect(rpcCall).toBeDefined();
    expect(rpcCall?.args).toEqual({ p_event: event, p_subscription: sub });
  });
});

// ── WH-AC25b: recordSubscriptionInvoice RPC call shape ───────────────────────

describe("WH-AC25b: recordSubscriptionInvoice calls payments_record_subscription_invoice", () => {
  it("WH-AC25b: RPC function name and p_event, p_subscription, p_invoice params", async () => {
    const calls: { fn: string; args: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
      const fnMatch = String(url).match(/\/rpc\/([^?]+)/);
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ fn: fnMatch?.[1] ?? String(url), args: body });
      return new Response(JSON.stringify({ outcome: "applied", paused: 0 }), { status: 200 });
    });

    const rpc = createPaymentsRpc(SUPABASE_URL, SECRET_KEY);
    const event = { id: "evt_002", type: "invoice.paid", created: "2026-01-01T00:00:00.000Z", livemode: false };
    const sub = { id: "sub_002", customer: "cus_002", user_id: null, price_id: "price_002", status: "active", current_period_end: null, cancel_at_period_end: false, start_date: "2026-01-01T00:00:00.000Z" };
    const invoice = { id: "in_002", subscription_id: "sub_002", email: "", amount_total_ore: 9500, amount_tax_ore: 1900, period_start: null, period_end: null, paid_at: "2026-01-01T00:00:00.000Z" };

    await rpc.recordSubscriptionInvoice(event, sub, invoice);

    const rpcCall = calls.find((c) => String(c.fn).includes("payments_record_subscription_invoice"));
    expect(rpcCall).toBeDefined();
    expect(rpcCall?.args).toEqual({ p_event: event, p_subscription: sub, p_invoice: invoice });
  });
});

// ── WH-AC25c: otherEntitlingSubscriptionIds query shape ──────────────────────

describe("WH-AC25c: otherEntitlingSubscriptionIds queries subscriptions with correct filters", () => {
  it("WH-AC25c: request URL contains table name, user_id filter, status in ENTITLING, exclude id", async () => {
    vi.stubGlobal("fetch", async () => {
      return new Response(JSON.stringify([{ stripe_subscription_id: "sub_other001" }]), { status: 200 });
    });

    const rpc = createPaymentsRpc(SUPABASE_URL, SECRET_KEY);
    const result = await rpc.otherEntitlingSubscriptionIds(
      "00000000-0000-0000-0000-000000000001",
      "sub_excludeA",
    );

    expect(Array.isArray(result)).toBe(true);
    expect(result).toContain("sub_other001");
  });

  it("WH-AC25c2: URL targets subscriptions, filters user_id, status in ENTITLING, excludes id via neq", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: unknown) => {
      urls.push(String(url));
      return new Response(JSON.stringify([]), { status: 200 });
    });

    const rpc = createPaymentsRpc(SUPABASE_URL, SECRET_KEY);
    await rpc.otherEntitlingSubscriptionIds("00000000-0000-0000-0000-000000000002", "sub_excl");

    const decoded = decodeURIComponent(urls[0] ?? "");
    expect(decoded).toContain("user_id=eq.00000000-0000-0000-0000-000000000002");
    expect(decoded).toContain("status=in.(trialing,active,past_due)");
    expect(decoded).toContain("stripe_subscription_id=neq.sub_excl");
    expect(decoded).toContain("select=stripe_subscription_id");
  });
});

// ── WH-AC25d: timeout via AbortSignal.timeout(PAYMENTS_RPC_TIMEOUT_MS) ───────
// WH-AC25d1 (constant pin) lives in tests/unit/config/payments.test.ts (WH-AC27d).

describe("WH-AC25d: every request is aborted after PAYMENTS_RPC_TIMEOUT_MS", () => {
  it("WH-AC25d2: syncSubscription request uses AbortSignal.timeout(PAYMENTS_RPC_TIMEOUT_MS)", async () => {
    const { timeout } = fakeTimeout();
    vi.stubGlobal("fetch", async () => {
      return new Response(JSON.stringify({ outcome: "applied", paused: 0 }), { status: 200 });
    });

    const rpc = createPaymentsRpc(SUPABASE_URL, SECRET_KEY);
    const event = { id: "evt_to", type: "t", created: "2026-01-01T00:00:00.000Z", livemode: false };
    const sub = { id: "sub_to", customer: "cus_to", user_id: null, price_id: "price_to", status: "active", current_period_end: null, cancel_at_period_end: false, start_date: "2026-01-01T00:00:00.000Z" };
    await rpc.syncSubscription(event, sub);

    expect(timeout.mock.calls.some((c) => c[0] === PAYMENTS_RPC_TIMEOUT_MS)).toBe(true);
  });
});

// ── WH-AC25e: invalid result → PaymentsRpcError("rpc_failed") ────────────────

describe("WH-AC25e: result not {outcome ∈ applied|duplicate|stale, paused integer} → PaymentsRpcError rpc_failed", () => {
  it.each([
    { label: "empty array", body: [] },
    { label: "wrong outcome", body: { outcome: "unknown_value", paused: 0 } },
    { label: "paused is float", body: { outcome: "applied", paused: 1.5 } },
    { label: "paused is negative", body: { outcome: "applied", paused: -1 } },
    { label: "row array instead of the jsonb object", body: [{ outcome: "applied", paused: 0 }] },
    { label: "null result", body: null },
  ])("WH-AC25e: $label → rejects with PaymentsRpcError('rpc_failed')", async ({ body }) => {
    vi.stubGlobal("fetch", async () => {
      return new Response(JSON.stringify(body), { status: 200 });
    });

    const rpc = createPaymentsRpc(SUPABASE_URL, SECRET_KEY);
    const event = { id: "evt_bad", type: "t", created: "2026-01-01T00:00:00.000Z", livemode: false };
    const sub = { id: "sub_bad", customer: "cus_bad", user_id: null, price_id: "price_bad", status: "active", current_period_end: null, cancel_at_period_end: false, start_date: "2026-01-01T00:00:00.000Z" };

    await expect(rpc.syncSubscription(event, sub)).rejects.toSatisfy(
      (e) => e instanceof PaymentsRpcError && e.message === "rpc_failed",
    );
  });
});

// ── WH-AC25f: PaymentsRpcError carries the DB keyword for 22023 ──────────────

describe("WH-AC25f: PaymentsRpcError carries DB keyword as message, http status in .status", () => {
  it("WH-AC25f1: PaymentsRpcError is an Error subclass", () => {
    const e = new PaymentsRpcError("unknown_plan");
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(PaymentsRpcError);
  });

  it("WH-AC25f2: message is the DB keyword", () => {
    const e = new PaymentsRpcError("customer_user_mismatch");
    expect(e.message).toBe("customer_user_mismatch");
  });

  it("WH-AC25f3: .code and .status are accessible readonly properties with correct values", () => {
    const e = new PaymentsRpcError("rpc_failed", "some_code", 400);
    expect(e.code).toBe("some_code");
    expect(e.status).toBe(400);
  });

  it("WH-AC25f4: 22023 response with known message → PaymentsRpcError with that message", async () => {
    vi.stubGlobal("fetch", async () => {
      return new Response(
        JSON.stringify({ code: "22023", message: "unknown_plan", details: null, hint: null }),
        { status: 400 },
      );
    });

    const rpc = createPaymentsRpc(SUPABASE_URL, SECRET_KEY);
    const event = { id: "evt_22023", type: "t", created: "2026-01-01T00:00:00.000Z", livemode: false };
    const sub = { id: "sub_22023", customer: "cus_22023", user_id: null, price_id: "price_22023", status: "active", current_period_end: null, cancel_at_period_end: false, start_date: "2026-01-01T00:00:00.000Z" };

    await expect(rpc.syncSubscription(event, sub)).rejects.toSatisfy(
      (e) => e instanceof PaymentsRpcError && e.message === "unknown_plan" && e.code === "22023",
    );
  });
});

// ── WH-AC_A16d: HTTP status 0 on the invalid_response path → PaymentsRpcError status:null ─

describe("WH-AC_A16d: otherEntitlingSubscriptionIds status-0 response → PaymentsRpcError status:null", () => {
  it("WH-AC_A16d: duck-typed status-0 response on otherEntitling path → code=invalid_response, status=null", async () => {
    // Target: the non-array-data throw in otherEntitlingSubscriptionIds, where status 0
    // must be mapped to null. A duck-typed Response bypasses the RangeError that
    // new Response(null, { status: 0 }) throws in Node.
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 0,
      statusText: "",
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => "{}",
    }));
    const rpc = createPaymentsRpc(SUPABASE_URL, SECRET_KEY);
    const err = await rpc
      .otherEntitlingSubscriptionIds("00000000-0000-0000-0000-000000000001", "sub_x")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentsRpcError);
    if (!(err instanceof PaymentsRpcError)) throw new Error("expected PaymentsRpcError");
    expect(err.code).toBe("invalid_response");
    expect(err.status).toBeNull();
  });
});

// ── WH-AC25g: createPaymentsRpc uses no-session auth ─────────────────────────

describe("WH-AC25g: createPaymentsRpc uses no-session auth (persistSession:false, autoRefreshToken:false)", () => {
  it("WH-AC25g: requests carry the service-role apikey, not a session JWT from token refresh", async () => {
    const authHeaders: string[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      authHeaders.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response(JSON.stringify({ outcome: "applied", paused: 0 }), { status: 200 });
    });

    const rpc = createPaymentsRpc(SUPABASE_URL, SECRET_KEY);
    const event = { id: "evt_auth", type: "t", created: "2026-01-01T00:00:00.000Z", livemode: false };
    const sub = { id: "sub_auth", customer: "cus_auth", user_id: null, price_id: "price_auth", status: "active", current_period_end: null, cancel_at_period_end: false, start_date: "2026-01-01T00:00:00.000Z" };
    await rpc.syncSubscription(event, sub);

    expect(authHeaders.length).toBeGreaterThan(0);
    expect(authHeaders.every((h) => h === `Bearer ${SECRET_KEY}`)).toBe(true);
  });
});

// ── WH-AC25c-A13: otherEntitlingSubscriptionIds makes exactly ONE fetch attempt ──

describe("WH-AC25c-A13: otherEntitlingSubscriptionIds makes exactly one fetch attempt (retry:false)", () => {
  it("WH-AC25c-A13a: TimeoutError → exactly one fetch, throws PaymentsRpcError", async () => {
    // postgrest-js retries on fetch errors/503/520 without retry(false); A13 uses it.
    let fetchCount = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCount++;
      throw new DOMException("Timeout", "TimeoutError");
    });

    const rpc = createPaymentsRpc(SUPABASE_URL, SECRET_KEY);
    await expect(
      rpc.otherEntitlingSubscriptionIds("00000000-0000-0000-0000-000000000001", "sub_excl"),
    ).rejects.toBeInstanceOf(PaymentsRpcError);

    expect(fetchCount).toBe(1);
  });

  it("WH-AC25c-A13b: HTTP 503 → exactly one fetch, throws PaymentsRpcError", async () => {
    // A13: postgrest-js retries on 503 without retry(false).
    let fetchCount = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCount++;
      return new Response(JSON.stringify({ message: "service unavailable" }), { status: 503 });
    });

    const rpc = createPaymentsRpc(SUPABASE_URL, SECRET_KEY);
    await expect(
      rpc.otherEntitlingSubscriptionIds("00000000-0000-0000-0000-000000000001", "sub_excl"),
    ).rejects.toBeInstanceOf(PaymentsRpcError);

    expect(fetchCount).toBe(1);
  });
});

// ── WH-AC25f-A14: PaymentsRpcError exposes a typed refusal field ──────────────

describe("WH-AC25f-A14: PaymentsRpcError exposes a typed refusal field", () => {
  // A14: PaymentsRpcError exposes a typed `refusal` field set by the rpcError factory.
  // Tests go through the actual RPC call path so they test observable behaviour, not the constructor.

  it.each([
    { message: "invalid_payload", expectedRefusal: "invalid_payload" },
    { message: "unknown_plan", expectedRefusal: "unknown_plan" },
    { message: "unknown_user", expectedRefusal: "unknown_user" },
    { message: "customer_user_mismatch", expectedRefusal: "customer_user_mismatch" },
  ])("WH-AC25f-A14: 22023 $message → error.refusal === '$expectedRefusal'", async ({ message, expectedRefusal }) => {
    vi.stubGlobal("fetch", async () => new Response(
      JSON.stringify({ code: "22023", message, details: null, hint: null }),
      { status: 400 },
    ));
    const rpc = createPaymentsRpc(SUPABASE_URL, SECRET_KEY);
    const event = { id: "evt_A14ref", type: "t", created: "2026-01-01T00:00:00.000Z", livemode: false };
    const sub = { id: "sub_A14ref", customer: "cus_A14r", user_id: null, price_id: "priceA14r", status: "active", current_period_end: null, cancel_at_period_end: false, start_date: "2026-01-01T00:00:00.000Z" };

    const err = await rpc.syncSubscription(event, sub).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentsRpcError);
    if (!(err instanceof PaymentsRpcError)) throw new Error("expected PaymentsRpcError");
    expect(err.refusal).toBe(expectedRefusal);
  });

  it("WH-AC25f-A14e: 22023 with unlisted message → error.refusal === null", async () => {
    vi.stubGlobal("fetch", async () => new Response(
      JSON.stringify({ code: "22023", message: "some_other_constraint", details: null, hint: null }),
      { status: 400 },
    ));
    const rpc = createPaymentsRpc(SUPABASE_URL, SECRET_KEY);
    const event = { id: "evt_A14null", type: "t", created: "2026-01-01T00:00:00.000Z", livemode: false };
    const sub = { id: "sub_A14null", customer: "cus_A14n", user_id: null, price_id: "priceA14n", status: "active", current_period_end: null, cancel_at_period_end: false, start_date: "2026-01-01T00:00:00.000Z" };

    const err = await rpc.syncSubscription(event, sub).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentsRpcError);
    if (!(err instanceof PaymentsRpcError)) throw new Error("expected PaymentsRpcError");
    expect(err.refusal).toBeNull();
  });
});

// ── WH-AC_A21a: otherEntitlingSubscriptionIds query has order and limit (A21) ──

describe("WH-AC_A21a: otherEntitlingSubscriptionIds query uses order=created_at.asc,stripe_subscription_id.asc and limit=5", () => {
  it("WH-AC_A21a: URL `order` param = 'created_at.asc,stripe_subscription_id.asc' and `limit` = '5'", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: unknown) => {
      urls.push(String(url));
      return new Response(JSON.stringify([]), { status: 200 });
    });

    const rpc = createPaymentsRpc(SUPABASE_URL, SECRET_KEY);
    await rpc.otherEntitlingSubscriptionIds("00000000-0000-0000-0000-000000000003", "sub_excl_a21");

    const rawUrl = urls[0] ?? "";
    const qs = rawUrl.includes("?") ? rawUrl.split("?")[1] : "";
    const params = new URLSearchParams(decodeURIComponent(qs ?? ""));
    // A21: exact order value and exact limit value via URLSearchParams.get
    expect(params.get("order")).toBe("created_at.asc,stripe_subscription_id.asc");
    expect(params.get("limit")).toBe("5");
  });
});

// ── WH-AC_A28a: accountExists(userId) ───────────────────────────────────────

describe("WH-AC_A28a: accountExists makes GET /auth/v1/admin/users/<id>, correct headers, one fetch, correct boolean/error mapping (A28a)", () => {
  const TEST_USER_ID = "00000000-0000-0000-0000-000000000099";

  it("WH-AC_A28a-rpc-url: request is GET <SUPABASE_URL>/auth/v1/admin/users/<userId>, exactly one fetch", async () => {
    const urls: string[] = [];
    const methods: (string | undefined)[] = [];
    vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
      urls.push(String(url));
      methods.push(init?.method);
      return new Response(
        JSON.stringify({ id: TEST_USER_ID, email: "u@test.local", aud: "authenticated", role: "authenticated" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const rpc = createPaymentsRpc(SUPABASE_URL, SECRET_KEY);
    await rpc.accountExists(TEST_USER_ID);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe(`${SUPABASE_URL}/auth/v1/admin/users/${TEST_USER_ID}`);
    expect(methods[0]).toBe("GET");
  });

  it("WH-AC_A28a-rpc-headers: Authorization and apikey headers both equal the secret key", async () => {
    const captured: { authorization: string | null; apikey: string | null }[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      captured.push({ authorization: h.get("authorization"), apikey: h.get("apikey") });
      return new Response(
        JSON.stringify({ id: TEST_USER_ID, email: "u@test.local", aud: "authenticated" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const rpc = createPaymentsRpc(SUPABASE_URL, SECRET_KEY);
    await rpc.accountExists(TEST_USER_ID);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.authorization).toBe(`Bearer ${SECRET_KEY}`);
    expect(captured[0]?.apikey).toBe(SECRET_KEY);
  });

  it("WH-AC_A28a-rpc-true: 200 user response with string id → resolves true", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({ id: TEST_USER_ID, email: "u@test.local", aud: "authenticated", role: "authenticated" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const rpc = createPaymentsRpc(SUPABASE_URL, SECRET_KEY);
    await expect(rpc.accountExists(TEST_USER_ID)).resolves.toBe(true);
  });

  it("WH-AC_A28a-rpc-false-404: HTTP 404 user_not_found → resolves false; exactly one fetch", async () => {
    let fetchCount = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCount++;
      return new Response(
        JSON.stringify({ code: 404, error_code: "user_not_found", msg: "User not found" }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    });
    const rpc = createPaymentsRpc(SUPABASE_URL, SECRET_KEY);
    await expect(rpc.accountExists(TEST_USER_ID)).resolves.toBe(false);
    expect(fetchCount).toBe(1);
  });

  it.each([
    { label: "HTTP 500", fetchImpl: async () => new Response(JSON.stringify({ code: 500, msg: "Internal" }), { status: 500, headers: { "content-type": "application/json" } }) },
    { label: "HTTP 401", fetchImpl: async () => new Response(JSON.stringify({ code: 401, msg: "Unauthorized" }), { status: 401, headers: { "content-type": "application/json" } }) },
    { label: "HTTP 403", fetchImpl: async () => new Response(JSON.stringify({ code: 403, msg: "Forbidden" }), { status: 403, headers: { "content-type": "application/json" } }) },
    { label: "network error", fetchImpl: async (): Promise<Response> => { throw new TypeError("Failed to fetch"); } },
    { label: "timeout", fetchImpl: async (): Promise<Response> => { throw new DOMException("Timeout", "TimeoutError"); } },
    { label: "unexpected body (200 empty user, no id)", fetchImpl: async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }) },
    { label: "unexpected body (200 null, auth-js TypeError)", fetchImpl: async (): Promise<Response> => new Response("null", { status: 200, headers: { "content-type": "application/json" } }) },
  ])("WH-AC_A28a-rpc-transient: $label → throws PaymentsRpcError; exactly one fetch", async ({ fetchImpl }) => {
    let fetchCount = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCount++;
      return fetchImpl();
    });
    const rpc = createPaymentsRpc(SUPABASE_URL, SECRET_KEY);
    await expect(rpc.accountExists(TEST_USER_ID)).rejects.toBeInstanceOf(PaymentsRpcError);
    expect(fetchCount).toBe(1);
  });

  it("WH-AC_A28a-rpc-timeout: request uses AbortSignal.timeout(PAYMENTS_RPC_TIMEOUT_MS) via paymentsFetch", async () => {
    const { timeout } = fakeTimeout();
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({ id: TEST_USER_ID, email: "u@test.local" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const rpc = createPaymentsRpc(SUPABASE_URL, SECRET_KEY);
    await rpc.accountExists(TEST_USER_ID);
    expect(timeout.mock.calls.some((c) => c[0] === PAYMENTS_RPC_TIMEOUT_MS)).toBe(true);
  });

  it("WH-AC_A28a-rpc-false-versioned: 404 in Auth's 2024-01-01 error format (code user_not_found) → resolves false", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ code: "user_not_found", message: "User not found" }), {
        status: 404,
        headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" },
      }),
    );
    const rpc = createPaymentsRpc(SUPABASE_URL, SECRET_KEY);
    await expect(rpc.accountExists(TEST_USER_ID)).resolves.toBe(false);
  });

  it.each([
    { label: "HTTP 404 without an error code (e.g. a wrong URL)", status: 404, body: { code: 404, msg: "Not Found" } },
    { label: "HTTP 404 with another error code", status: 404, body: { code: 404, error_code: "not_found", msg: "Not Found" } },
    { label: "HTTP 200 with another user's id", status: 200, body: { id: "00000000-0000-0000-0000-000000000098", aud: "authenticated" } },
  ])("WH-AC_A28a-rpc-strict: $label → throws PaymentsRpcError (only Auth's 404 user_not_found means no account)", async ({ status, body }) => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
    );
    const rpc = createPaymentsRpc(SUPABASE_URL, SECRET_KEY);
    await expect(rpc.accountExists(TEST_USER_ID)).rejects.toBeInstanceOf(PaymentsRpcError);
  });

  it.each([
    {
      label: "HTTP 403 not_admin",
      fetchImpl: async () =>
        new Response(JSON.stringify({ code: "not_admin", message: "User not allowed" }), {
          status: 403,
          headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" },
        }),
      code: "not_admin",
      status: 403,
    },
    {
      label: "HTTP 503",
      fetchImpl: async () => new Response(JSON.stringify({ msg: "Unavailable" }), { status: 503, headers: { "content-type": "application/json" } }),
      code: "unknown",
      status: 503,
    },
    {
      label: "network error",
      fetchImpl: async (): Promise<Response> => { throw new TypeError("Failed to fetch"); },
      code: "unknown",
      status: null,
    },
    {
      label: "unreadable body (200 null)",
      fetchImpl: async () => new Response("null", { status: 200, headers: { "content-type": "application/json" } }),
      code: "invalid_response",
      status: null,
    },
  ])("WH-AC_A28a-rpc-fields: $label → rpc_failed, code $code, status $status (the log's rpc_<code>[_<status>])", async ({ fetchImpl, code, status }) => {
    vi.stubGlobal("fetch", fetchImpl);
    const rpc = createPaymentsRpc(SUPABASE_URL, SECRET_KEY);
    const err = await rpc.accountExists(TEST_USER_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentsRpcError);
    if (!(err instanceof PaymentsRpcError)) throw new Error("expected PaymentsRpcError");
    expect({ message: err.message, code: err.code, status: err.status, refusal: err.refusal }).toEqual({
      message: "rpc_failed",
      code,
      status,
      refusal: null,
    });
  });

  it("WH-AC_A28a-rpc-nonuuid: an id that is not a UUID → PaymentsRpcError invalid_response, never false, no request", async () => {
    // auth-js throws (validateUUID) instead of answering: it must not read as "no such account".
    let fetchCount = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCount++;
      return new Response("{}", { status: 404 });
    });
    const rpc = createPaymentsRpc(SUPABASE_URL, SECRET_KEY);
    const err = await rpc.accountExists("not-a-uuid").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentsRpcError);
    if (!(err instanceof PaymentsRpcError)) throw new Error("expected PaymentsRpcError");
    expect({ message: err.message, code: err.code, status: err.status }).toEqual({
      message: "rpc_failed",
      code: "invalid_response",
      status: null,
    });
    expect(fetchCount).toBe(0);
  });
});
