/**
 * Unit tests: src/app/monitor/(panel)/billing/withdraw/actions.ts — withdrawSubscription
 * Journey: payments-slice1d-withdrawal
 * Criteria: WD-J4-C03, WD-J5-C01..C04, WD-J5-C05, WD-J5-C06
 *
 * Coverage:
 *   - requireMonitor called first (fail closed)
 *   - allowBillingSession (from @/lib/payments/rate-limit) checked right after requireMonitor;
 *       false / throw → ?error=unavailable, no binding/my_withdrawal_status/token call
 *   - allowBillingSession called with SESSION.userId
 *   - name from formData only: empty / whitespace / 201 chars / control char → no binding call
 *   - subscriptionId from my_withdrawal_status() server-side, never from form
 *   - Worker input pinned whole-object toEqual (name, subscriptionId, accessToken, locale, statementVersion)
 *   - no userId key in Worker input (identity comes from token, not from web)
 *   - binding missing → ?error=unavailable; token not in console.log/error/warn
 *   - Worker ok:true → revalidatePath + redirect /monitor/billing/withdraw
 *   - Worker ok:false each code → redirect ?error=<code>
 *   - parseWithdrawResult null → ?error=unavailable, unless my_withdrawal_status() then shows the
 *       withdrawal recorded (the call can fail after the Worker recorded it) → no error
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── vi.hoisted ────────────────────────────────────────────────────────────────

const {
  mockRequireMonitor,
  mockAllowBillingSession,
  mockRpc,
  mockGetSession,
  mockGetCloudflareContext,
  mockRevalidatePath,
  mockRedirect,
  mockPaymentsWithdraw,
} = vi.hoisted(() => {
  const mockPaymentsWithdraw = vi.fn();
  return {
    mockRequireMonitor:       vi.fn(),
    mockAllowBillingSession:  vi.fn(),
    mockRpc:                  vi.fn(),
    mockGetSession:           vi.fn(),
    mockGetCloudflareContext: vi.fn(),
    mockRevalidatePath:       vi.fn(),
    mockRedirect:             vi.fn((url: string) => {
      throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;${url}` });
    }),
    mockPaymentsWithdraw,
  };
});

vi.mock("@/services/auth/require-role", () => ({ requireMonitor: mockRequireMonitor }));
vi.mock("@/lib/payments/rate-limit",    () => ({ allowBillingSession: mockAllowBillingSession }));
vi.mock("next/cache",      () => ({ revalidatePath: mockRevalidatePath }));
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: mockGetCloudflareContext }));
// Supabase server client for getSession + my_withdrawal_status RPC
// Supabase server client — async factory (src/lib/supabase/server.ts exports async createServerClient)
vi.mock("@/lib/supabase/server", () => ({
  createServerClient: vi.fn(async () => ({
    auth: { getSession: (...a: unknown[]) => mockGetSession(...a) },
    rpc: (...a: unknown[]) => mockRpc(...a),
  })),
}));
// The action sends the Monitor locale (a cookie; there is no request here), so it is mocked.
vi.mock("@/i18n/monitor-locale", () => ({ getMonitorLocale: vi.fn(async () => "da") }));

// ── Static imports (after vi.mock) ────────────────────────────────────────────

import { withdrawSubscription } from "@/app/monitor/(panel)/billing/withdraw/actions";
import { WITHDRAWAL_TEXT_VERSION } from "@/config/legal/withdrawal-texts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

function extractRedirectUrl(err: unknown): string {
  if (err instanceof Error && "digest" in err) {
    const { digest } = err;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT;"))
      return digest.replace("NEXT_REDIRECT;", "");
  }
  throw err;
}

async function runAction(fields: Record<string, string> = { name: "Lars Andersen" }): Promise<string> {
  let url = "";
  try { await withdrawSubscription(form(fields)); }
  catch (e) { url = extractRedirectUrl(e); }
  return url;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SESSION  = { userId: "user-uuid-1", email: "u@test.local", role: "monitor_user" as const };
const ACCESS_TOKEN_FX = "eyJhbGciOiJIUzI1NiJ9.unit-test-access-token";

// my_withdrawal_status always answers started_at (the service rejects a shape without it).
const VALID_WD_STATUS = {
  subscription_id: "sub_test1234567890",
  status: "active", started_at: "2026-11-14T00:00:00Z", window_open: true, has_consent: true,
  deadline_at: "2026-11-30T23:00:00Z",
  withdrawal: null,
  invoice: { stripe_invoice_id: "in_test", amount_total_ore: 1000, period_start: "2026-11-01T00:00:00Z", period_end: "2026-12-01T00:00:00Z" },
};

const OK_COMPLETED = {
  ok: true, withdrawalId: "00000000-0000-0000-0d1d-000000000001", status: "completed",
  requestedAt: "2026-11-14T10:00:00Z", paidOre: 1000, retainedOre: 33, refundOre: 967,
};

beforeEach(() => {
  mockRequireMonitor.mockResolvedValue(SESSION);
  mockAllowBillingSession.mockResolvedValue(true);
  mockGetSession.mockResolvedValue({ data: { session: { access_token: ACCESS_TOKEN_FX } } });
  mockRpc.mockResolvedValue({ data: VALID_WD_STATUS, error: null });
  mockGetCloudflareContext.mockReturnValue({ env: { PAYMENTS: { withdraw: mockPaymentsWithdraw } } });
  mockPaymentsWithdraw.mockResolvedValue(OK_COMPLETED);
});

afterEach(() => { vi.clearAllMocks(); });

// ── requireMonitor gate ───────────────────────────────────────────────────────

describe("WD-J4-C03 (WD-T-ACT-01): withdrawSubscription — requireMonitor called first", () => {
  it("WD-T-ACT-01: requireMonitor redirect stops action; allowBillingSession not called", async () => {
    mockRequireMonitor.mockImplementation(() => {
      throw Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;/monitor/login" });
    });
    await expect(withdrawSubscription(form({ name: "Lars" }))).rejects.toMatchObject({ message: "NEXT_REDIRECT" });
    expect(mockAllowBillingSession).not.toHaveBeenCalled();
    expect(mockPaymentsWithdraw).not.toHaveBeenCalled();
  });
});

// ── allowBillingSession from @/lib/payments/rate-limit ───────────────────────

describe("WD-J4-C03: allowBillingSession — called with SESSION.userId right after requireMonitor", () => {
  it("called with SESSION.userId", async () => {
    await runAction();
    expect(mockAllowBillingSession).toHaveBeenCalledWith(SESSION.userId);
  });
});

describe("WD-J5-C04: allowBillingSession false → ?error=unavailable; no binding/my_withdrawal_status call", () => {
  it.each([
    { label: "returns false",  setup: () => mockAllowBillingSession.mockResolvedValue(false) },
    { label: "throws",         setup: () => mockAllowBillingSession.mockRejectedValue(new Error("limiter down")) },
  ])("$label → redirect ?error=unavailable; PAYMENTS.withdraw never called", async ({ setup }) => {
    setup();
    const url = await runAction();
    expect(url).toContain("error=unavailable");
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockPaymentsWithdraw).not.toHaveBeenCalled();
  });
});

// ── name validation ───────────────────────────────────────────────────────────

describe("WD-J5-C05 (WD-T-CON-05): withdrawSubscription — invalid name → redirect; no binding call", () => {
  it.each([
    { label: "empty string",         name: "" },
    { label: "whitespace-only",      name: "   " },
    { label: "201 chars",            name: "A".repeat(201) },
    { label: "control char U+0001",  name: "Lars\x01Andersen" },
  ])("invalid name: $label → error redirect; PAYMENTS.withdraw never called", async ({ name }) => {
    const url = await runAction({ name });
    expect(url).toContain("error=");
    expect(mockPaymentsWithdraw).not.toHaveBeenCalled();
  });
});

// ── subscriptionId from server, never from form ───────────────────────────────

describe("WD-J4-C03 (WD-T-ACT-02): subscriptionId from my_withdrawal_status(), never from form", () => {
  it("WD-T-ACT-02: injected subscriptionId in form is ignored; server value used", async () => {
    await runAction({ name: "Lars Andersen", subscriptionId: "sub_evil_injection" });
    expect(mockPaymentsWithdraw).toHaveBeenCalledOnce();
    const arg = mockPaymentsWithdraw.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg?.["subscriptionId"]).toBe("sub_test1234567890");
    expect(arg?.["subscriptionId"]).not.toBe("sub_evil_injection");
  });
});

// ── Worker input pinned whole-object ─────────────────────────────────────────

describe("WD-J4-C03: Worker input pinned whole-object — no userId key, correct all fields", () => {
  it("toEqual: name trimmed, subscriptionId from server, accessToken from session, locale da, statementVersion pinned, no userId", async () => {
    await runAction({ name: "  Lars Andersen  " });
    expect(mockPaymentsWithdraw).toHaveBeenCalledOnce();
    expect(mockPaymentsWithdraw.mock.calls[0]?.[0]).toEqual({
      accessToken:      ACCESS_TOKEN_FX,
      subscriptionId:   "sub_test1234567890",
      consumerName:     "Lars Andersen",
      statementVersion: WITHDRAWAL_TEXT_VERSION,
      locale:           "da",
      // no userId: identity comes from accessToken in the Worker only
    });
  });
});

// ── binding missing → unavailable ────────────────────────────────────────────

describe("WD-J5-C04 (WD-T-ACT-06): withdrawSubscription — binding missing → ?error=unavailable; no PII in logs", () => {
  it("WD-T-ACT-06: PAYMENTS absent → ?error=unavailable; ACCESS_TOKEN_FX not in log/error/warn", async () => {
    mockGetCloudflareContext.mockReturnValue({ env: {} });
    const spies = [
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
    ];
    const url = await runAction({ name: "Lars Andersen" });
    expect(url).toContain("error=unavailable");
    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        const str = JSON.stringify(call);
        expect(str).not.toContain(ACCESS_TOKEN_FX);
        expect(str).not.toContain("Lars Andersen");
      }
      spy.mockRestore();
    }
  });
});

// ── success path ──────────────────────────────────────────────────────────────

describe("WD-J4-C04 (WD-T-ACT-03): withdrawSubscription — ok:true → revalidatePath + redirect to withdraw page", () => {
  it("WD-T-ACT-03: redirect to /monitor/billing/withdraw after success", async () => {
    const url = await runAction({ name: "Lars Andersen" });
    expect(mockRevalidatePath).toHaveBeenCalled();
    expect(url).toContain("/monitor/billing/withdraw");
    expect(url).not.toContain("error=");
  });
});

// ── error codes ───────────────────────────────────────────────────────────────

describe("WD-J5-C01..C02 / WD-T-ACT-04..05: it.each every ok:false error code → redirect with that code", () => {
  it.each(["unauthenticated", "invalid_input", "not_withdrawable", "window_expired", "unavailable"])(
    "code=%s → url includes that code", async (code) => {
      mockPaymentsWithdraw.mockResolvedValue({ ok: false, code });
      const url = await runAction();
      expect(url).toContain(code);
    },
  );
});

// ── parseWithdrawResult null → unavailable ────────────────────────────────────

describe("WD-J5-C06 (WD-T-ACT-07): withdrawSubscription — Worker returns malformed shape → ?error=unavailable", () => {
  it("WD-T-ACT-07: garbage Worker response → ?error=unavailable", async () => {
    mockPaymentsWithdraw.mockResolvedValue({ unexpected: "garbage" });
    const url = await runAction();
    expect(url).toContain("error=unavailable");
  });
});

// ── The action's own refusals and the binding failures ───────────────────────

describe("WD-J4-C03: withdrawSubscription — the action's own refusals, before the Worker", () => {
  it("my_withdrawal_status() answers null (no subscription) → ?error=not_withdrawable; no token read, no Worker call", async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    const url = await runAction();
    expect(url).toBe("/monitor/billing/withdraw?error=not_withdrawable");
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockPaymentsWithdraw).not.toHaveBeenCalled();
  });

  it("my_withdrawal_status() fails → ?error=unavailable; no Worker call", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "57014", message: "canceling statement" } });
    const url = await runAction();
    expect(url).toBe("/monitor/billing/withdraw?error=unavailable");
    expect(mockPaymentsWithdraw).not.toHaveBeenCalled();
  });

  it("no session (no access token) → ?error=unauthenticated; no Worker call", async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });
    const url = await runAction();
    expect(url).toBe("/monitor/billing/withdraw?error=unauthenticated");
    expect(mockPaymentsWithdraw).not.toHaveBeenCalled();
  });

  it("no Cloudflare context (getCloudflareContext throws) → ?error=unavailable", async () => {
    mockGetCloudflareContext.mockImplementation(() => {
      throw new Error("no context");
    });
    const url = await runAction();
    expect(url).toBe("/monitor/billing/withdraw?error=unavailable");
    expect(mockPaymentsWithdraw).not.toHaveBeenCalled();
  });

  it("invalid name → exactly ?error=invalid_input, before my_withdrawal_status()", async () => {
    const url = await runAction({ name: "   " });
    expect(url).toBe("/monitor/billing/withdraw?error=invalid_input");
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe("WD-J5-C04: withdrawSubscription — the binding call fails → ?error=unavailable", () => {
  it("PAYMENTS.withdraw rejects (Worker error, binding unreachable) → ?error=unavailable; nothing revalidated", async () => {
    mockPaymentsWithdraw.mockRejectedValue(new Error("Worker threw"));
    const url = await runAction();
    expect(url).toBe("/monitor/billing/withdraw?error=unavailable");
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});

describe("WD-J5-C06 (WD-T-ACT-08): withdrawSubscription — no usable answer, but the notice may be recorded: the database decides", () => {
  const RECORDED_WD_STATUS = {
    ...VALID_WD_STATUS,
    window_open: false,
    withdrawal: {
      id: "00000000-0000-0000-0d1d-000000000001", status: "received", requested_at: "2026-11-14T10:00:00Z",
      paid_ore: null, retained_ore: null, refund_ore: null, refunded_at: null,
    },
  };

  it.each<[label: string, fail: () => void]>([
    ["the binding call rejects (Worker CPU limit, dropped RPC)", () => mockPaymentsWithdraw.mockRejectedValue(new Error("Network connection lost."))],
    ["the Worker answers a malformed shape", () => mockPaymentsWithdraw.mockResolvedValue({ unexpected: "garbage" })],
  ])("WD-T-ACT-08a: %s, and the re-read shows the withdrawal recorded → no error; both pages revalidated", async (_label, fail) => {
    fail();
    mockRpc
      .mockResolvedValueOnce({ data: VALID_WD_STATUS, error: null })
      .mockResolvedValueOnce({ data: RECORDED_WD_STATUS, error: null });
    const url = await runAction();
    expect(url).toBe("/monitor/billing/withdraw");
    expect(mockRpc).toHaveBeenCalledTimes(2);
    expect(mockRevalidatePath.mock.calls).toEqual([["/monitor/billing/withdraw"], ["/monitor/billing"]]);
  });

  it("WD-T-ACT-08b: the call rejects and the re-read shows no withdrawal → ?error=unavailable; nothing revalidated", async () => {
    mockPaymentsWithdraw.mockRejectedValue(new Error("Worker threw"));
    const url = await runAction();
    expect(url).toBe("/monitor/billing/withdraw?error=unavailable");
    expect(mockRpc).toHaveBeenCalledTimes(2);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("WD-T-ACT-08c: the call rejects and the re-read fails too → ?error=unavailable", async () => {
    mockPaymentsWithdraw.mockRejectedValue(new Error("Worker threw"));
    mockRpc
      .mockResolvedValueOnce({ data: VALID_WD_STATUS, error: null })
      .mockResolvedValueOnce({ data: null, error: { code: "57014", message: "canceling statement" } });
    const url = await runAction();
    expect(url).toBe("/monitor/billing/withdraw?error=unavailable");
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("WD-T-ACT-08d: a Worker refusal (ok:false) is final: no re-read", async () => {
    mockPaymentsWithdraw.mockResolvedValue({ ok: false, code: "window_expired" });
    const url = await runAction();
    expect(url).toBe("/monitor/billing/withdraw?error=window_expired");
    expect(mockRpc).toHaveBeenCalledOnce();
  });
});

describe("WD-J4-C04: withdrawSubscription — success revalidates both billing pages and redirects without a query", () => {
  it("ok:true (pending status) → revalidatePath withdraw + billing, redirect exactly /monitor/billing/withdraw", async () => {
    mockPaymentsWithdraw.mockResolvedValue({
      ok: true, withdrawalId: "00000000-0000-0000-0d1d-000000000001", status: "received", requestedAt: "2026-11-14T10:00:00Z",
    });
    const url = await runAction();
    expect(url).toBe("/monitor/billing/withdraw");
    expect(mockRevalidatePath.mock.calls).toEqual([["/monitor/billing/withdraw"], ["/monitor/billing"]]);
  });
});
