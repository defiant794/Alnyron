/**
 * Unit tests: workers/payments/withdrawal-service.ts (WithdrawalService.withdraw class method)
 *             workers/payments/index.ts (default export .scheduled sweep)
 * Journey: payments-slice1d-withdrawal
 * Criteria: WD-J4-C03, WD-J5-C01..C05, WD-J6-C05, WD-J7-C02..C05
 *
 * processWithdrawal is mocked here so this file tests the outer class/sweep layer only.
 * The real processWithdrawal business logic is tested in withdrawal.test.ts (no mock there),
 * the sweep's real subrequest count in sweep.test.ts, and payments_pending_work's A2 filter
 * (WD-J7-C06) against the database in rls-payments-withdrawal.test.ts.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Cloudflare runtime mock ───────────────────────────────────────────────────

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    env: unknown;
    ctx: unknown;
    constructor(ctx: unknown, env: unknown) { this.env = env; this.ctx = ctx; }
  },
}));

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockParsePaymentsEnv  = vi.fn();
const mockProcessWithdrawal = vi.fn();
const mockCreateRpc         = vi.fn();
const mockGetUser           = vi.fn();
const mockBeginWithdrawal   = vi.fn();
const mockSendConfirmation  = vi.fn();

vi.mock("../../../../workers/payments/env", () => ({
  parsePaymentsEnv: (...a: unknown[]) => mockParsePaymentsEnv(...a),
}));

vi.mock("../../../../workers/payments/withdrawal", () => ({
  processWithdrawal: (...a: unknown[]) => mockProcessWithdrawal(...a),
}));

// The Worker's client factory is createPaymentsRpc (rpc.ts); the mailer is mocked so the sweep's
// consent mail never reaches Resend.
vi.mock("../../../../workers/payments/rpc", () => ({
  createPaymentsRpc: (...a: unknown[]) => mockCreateRpc(...a),
}));

vi.mock("../../../../workers/payments/mail", () => ({
  createMailer: () => ({
    sendConfirmationEmail: (...a: unknown[]) => mockSendConfirmation(...a),
    sendReceiptEmail: vi.fn(),
    sendOwnerAlertEmail: vi.fn(),
  }),
}));

// ── Static imports (after vi.mock) ────────────────────────────────────────────

import { WithdrawalService } from "../../../../workers/payments/withdrawal-service";
import PaymentsWorker        from "../../../../workers/payments/index";
import { WITHDRAWAL_TEXT_VERSION } from "@/config/legal/withdrawal-texts";
import { WITHDRAWAL_CALC_VERSION } from "@/lib/payments/withdrawal-refund";

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Pre-commit secret scan: no name may end in secret/token/api_key right before "="/":" with a
// quoted 8+ character value, so the literals live in these *_FX constants.
const SB_KEY_FX = "sb_secret_unittestkey1234";
const SK_TEST_FX = "sk_test_unitfakekey1234";
const WHSEC_FX = "whsec_unittest1234";
const RE_FX = "re_unittest1234";
const ACCESS_TOKEN_FX = "valid_access_token_xyz";

const FAKE_ENV = {
  SUPABASE_URL: "https://xmgpixhxecamtryohgmk.supabase.co",
  SUPABASE_SECRET_KEY: SB_KEY_FX,
  STRIPE_PAYMENTS_KEY: SK_TEST_FX,
  STRIPE_WEBHOOK_SECRET: WHSEC_FX,
  STRIPE_LIVEMODE: "false",
  RESEND_API_KEY: RE_FX,
  MAIL_FROM: "noreply@alnyron.dk",
  WITHDRAWAL_ALERT_TO: "owner@alnyron.dk",
  SITE_URL: "https://alnyron.dk",
};

const PARSED_ENV = {
  supabaseUrl: FAKE_ENV.SUPABASE_URL, supabaseSecretKey: FAKE_ENV.SUPABASE_SECRET_KEY,
  stripeKey: FAKE_ENV.STRIPE_PAYMENTS_KEY, webhookSecret: FAKE_ENV.STRIPE_WEBHOOK_SECRET,
  livemode: false, resendApiKey: FAKE_ENV.RESEND_API_KEY,
  mailFrom: FAKE_ENV.MAIL_FROM, withdrawalAlertTo: FAKE_ENV.WITHDRAWAL_ALERT_TO,
  siteUrl: FAKE_ENV.SITE_URL,
};

const VALID_INPUT = {
  accessToken: ACCESS_TOKEN_FX,
  subscriptionId: "sub_test1234567890",
  consumerName: "Lars Andersen",
  statementVersion: WITHDRAWAL_TEXT_VERSION,
  locale: "da",
};

function fakeWithdrawal(status = "completed"): Record<string, unknown> {
  return {
    id: "00000000-0000-0000-0d1d-000000000001", status,
    stripe_subscription_id: "sub_test1234567890",
    user_id: "user-uuid-1", consumer_name: "Lars Andersen",
    ack_email: "user@test.local", statement_version: WITHDRAWAL_TEXT_VERSION, locale: "da",
    requested_at: "2026-11-14T10:00:00Z", deadline_at: "2026-11-30T23:00:00Z",
    retention_basis: "consent", manual_reason: null,
    paid_ore: status === "completed" ? 1000 : null,
    retained_ore: status === "completed" ? 33 : null,
    refund_ore: status === "completed" ? 967 : null,
    calc_version: status === "completed" ? WITHDRAWAL_CALC_VERSION : null,
    ack_sent_at: null, alerted_at: null, attempts: 0,
    subscription: { stripe_customer_id: "cus_test123", started_at: "2026-11-14T00:00:00Z", status: "active" },
  };
}

beforeEach(() => {
  mockParsePaymentsEnv.mockReturnValue(PARSED_ENV);
  mockGetUser.mockResolvedValue({ id: "user-uuid-1", email: "user@test.local" });
  mockBeginWithdrawal.mockResolvedValue({ outcome: "created", withdrawal: fakeWithdrawal("received") });
  mockProcessWithdrawal.mockResolvedValue(fakeWithdrawal("completed"));
  mockCreateRpc.mockReturnValue({
    getUser: (...a: unknown[]) => mockGetUser(...a),
    paymentsBeginWithdrawal: (...a: unknown[]) => mockBeginWithdrawal(...a),
    paymentsPendingWork: vi.fn().mockResolvedValue({ withdrawals: [], consents: [] }),
    paymentsMarkConsentInfoSent: vi.fn().mockResolvedValue({ outcome: "stamped" }),
  });
});

// ── WithdrawalService.withdraw — invalid input ────────────────────────────────

describe("WD-J5-C05 (WD-T-WK-invalid-input): WithdrawalService.withdraw — invalid_input", () => {
  it("WD-T-WK-invalid-input-null: null → {ok:false, code:'invalid_input'}; getUser not called", async () => {
    const result = await new WithdrawalService({}, FAKE_ENV).withdraw(null);
    expect(result).toEqual({ ok: false, code: "invalid_input" });
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it("WD-T-WK-invalid-input-extra-key: extra 'userId' key → {ok:false, code:'invalid_input'}", async () => {
    const result = await new WithdrawalService({}, FAKE_ENV).withdraw({ ...VALID_INPUT, userId: "injected" });
    expect(result).toEqual({ ok: false, code: "invalid_input" });
  });

  it("WD-T-WK-invalid-input-wrong-version: wrong statementVersion → {ok:false, code:'invalid_input'}", async () => {
    const result = await new WithdrawalService({}, FAKE_ENV).withdraw({ ...VALID_INPUT, statementVersion: "2025-01-01.1" });
    expect(result).toEqual({ ok: false, code: "invalid_input" });
  });
});

// ── WithdrawalService.withdraw — env invalid ──────────────────────────────────

describe("WD-J5-C02: WithdrawalService.withdraw — unavailable when parsePaymentsEnv throws", () => {
  it("WD-T-WK-env-invalid: parsePaymentsEnv throws → {ok:false, code:'unavailable'}", async () => {
    mockParsePaymentsEnv.mockImplementation(() => {
      throw new Error("payments: missing or invalid environment keys: RESEND_API_KEY");
    });
    const result = await new WithdrawalService({}, FAKE_ENV).withdraw(VALID_INPUT);
    expect(result).toEqual({ ok: false, code: "unavailable" });
  });
});

// ── WithdrawalService.withdraw — auth failures ────────────────────────────────

describe("WD-J5-C02 (WD-T-WK-07): WithdrawalService.withdraw — unauthenticated / unavailable on getUser failures", () => {
  it("WD-T-WK-07a: null user → unauthenticated; begin not called", async () => {
    mockGetUser.mockResolvedValue(null);
    const result = await new WithdrawalService({}, FAKE_ENV).withdraw(VALID_INPUT);
    expect(result).toEqual({ ok: false, code: "unauthenticated" });
    expect(mockBeginWithdrawal).not.toHaveBeenCalled();
  });

  it("WD-T-WK-07b: getUser 5xx → unavailable", async () => {
    mockGetUser.mockRejectedValue(Object.assign(new Error("503"), { status: 503 }));
    const result = await new WithdrawalService({}, FAKE_ENV).withdraw(VALID_INPUT);
    expect(result).toEqual({ ok: false, code: "unavailable" });
  });
});

// ── WithdrawalService.withdraw — begin refusals forwarded ────────────────────

describe("WD-J5-C01 / WD-J5-C02: WithdrawalService.withdraw — begin P0001 refusals forwarded verbatim", () => {
  it.each([
    { hint: "window_expired",   expectedCode: "window_expired" },
    { hint: "not_withdrawable", expectedCode: "not_withdrawable" },
  ])("begin P0001 $hint → {ok:false, code:'$expectedCode'}", async ({ hint, expectedCode }) => {
    mockBeginWithdrawal.mockRejectedValue(Object.assign(new Error(hint), { code: "P0001", hint }));
    const result = await new WithdrawalService({}, FAKE_ENV).withdraw(VALID_INPUT);
    expect(result).toEqual({ ok: false, code: expectedCode });
  });
});

// ── WithdrawalService.withdraw — success ─────────────────────────────────────

describe("WD-J4-C03: WithdrawalService.withdraw — the recorded withdrawal mapped to the answer", () => {
  it("WD-T-WK-svc-ok: completed → ok:true with the id, status, notice time and the three amounts", async () => {
    mockProcessWithdrawal.mockResolvedValue(fakeWithdrawal("completed"));
    const result: unknown = await new WithdrawalService({}, FAKE_ENV).withdraw(VALID_INPUT);
    expect(result).toEqual({
      ok: true,
      withdrawalId: "00000000-0000-0000-0d1d-000000000001",
      status: "completed",
      requestedAt: "2026-11-14T10:00:00Z",
      paidOre: 1000,
      retainedOre: 33,
      refundOre: 967,
    });
  });

  it("WD-T-WK-svc-needs-manual: needs_manual → ok:true without amounts (row exists; the owner finishes it)", async () => {
    mockProcessWithdrawal.mockResolvedValue(fakeWithdrawal("needs_manual"));
    const result: unknown = await new WithdrawalService({}, FAKE_ENV).withdraw(VALID_INPUT);
    expect(result).toEqual({
      ok: true,
      withdrawalId: "00000000-0000-0000-0d1d-000000000001",
      status: "needs_manual",
      requestedAt: "2026-11-14T10:00:00Z",
    });
  });

  it("WD-T-WK-svc-process-throws: the pass throws after begin → ok:true with the begin snapshot; logs process_failed then created", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    mockProcessWithdrawal.mockRejectedValue(new Error("claim rpc failed"));
    const result: unknown = await new WithdrawalService({}, FAKE_ENV).withdraw(VALID_INPUT);
    expect(result).toEqual({
      ok: true,
      withdrawalId: "00000000-0000-0000-0d1d-000000000001",
      status: "received",
      requestedAt: "2026-11-14T10:00:00Z",
    });
    expect(spy.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      { msg: "payments withdraw", withdrawal: "00000000-0000-0000-0d1d-000000000001", outcome: "process_failed", code: "rpc_failed" },
      { msg: "payments withdraw", withdrawal: "00000000-0000-0000-0d1d-000000000001", outcome: "created", code: null },
    ]);
    spy.mockRestore();
  });
});

describe("WD-J5-C02: WithdrawalService.withdraw — begin fails for another reason → unavailable", () => {
  it("WD-T-WK-svc-begin-failed: begin throws a non-refusal → {ok:false, code:'unavailable'}; no pass; logs begin_failed", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    mockBeginWithdrawal.mockRejectedValue(new Error("database timeout"));
    const result: unknown = await new WithdrawalService({}, FAKE_ENV).withdraw(VALID_INPUT);
    expect(result).toEqual({ ok: false, code: "unavailable" });
    expect(mockProcessWithdrawal).not.toHaveBeenCalled();
    expect(spy.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      { msg: "payments withdraw", withdrawal: null, outcome: "refused", code: "begin_failed" },
    ]);
    spy.mockRestore();
  });
});

describe("WD-J5-C03 (WD-T-WK-08): WithdrawalService.withdraw — a repeated submit resumes the recorded withdrawal", () => {
  it("WD-T-WK-08c: begin answers existing → one pass over that withdrawal id → ok:true with its stored status", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    mockBeginWithdrawal.mockResolvedValue({ outcome: "existing", withdrawal: fakeWithdrawal("canceled") });
    mockProcessWithdrawal.mockResolvedValue(fakeWithdrawal("canceled"));
    const result: unknown = await new WithdrawalService({}, FAKE_ENV).withdraw(VALID_INPUT);
    expect(mockProcessWithdrawal).toHaveBeenCalledOnce();
    expect(mockProcessWithdrawal).toHaveBeenCalledWith(expect.anything(), "00000000-0000-0000-0d1d-000000000001");
    expect(result).toEqual({
      ok: true,
      withdrawalId: "00000000-0000-0000-0d1d-000000000001",
      status: "canceled",
      requestedAt: "2026-11-14T10:00:00Z",
    });
    expect(spy.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      { msg: "payments withdraw", withdrawal: "00000000-0000-0000-0d1d-000000000001", outcome: "existing", code: null },
    ]);
    spy.mockRestore();
  });
});

// ── WithdrawalService.withdraw — no PII in logs ───────────────────────────────

describe("WD-J6-C05: WithdrawalService.withdraw — accessToken and name never surface in console output", () => {
  it("WD-T-WK-svc-no-token: no PII in console.log calls", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await new WithdrawalService({}, FAKE_ENV).withdraw(VALID_INPUT);
    for (const call of spy.mock.calls) {
      const str = JSON.stringify(call);
      expect(str).not.toContain(VALID_INPUT.accessToken);
      expect(str).not.toContain("Lars Andersen");
    }
    spy.mockRestore();
  });
});

// ── scheduled via index.ts ───────────────────────────────────────────────────

describe("WD-J7-C02 (WD-T-WK-15): scheduled — processWithdrawal called once per pending withdrawal id", () => {
  it("WD-T-WK-15: two ids in pending work → processWithdrawal called for each", async () => {
    mockCreateRpc.mockReturnValue({
      paymentsPendingWork: vi.fn().mockResolvedValue({ withdrawals: ["wd-id-1", "wd-id-2"], consents: [] }),
      paymentsMarkConsentInfoSent: vi.fn(),
    });
    await PaymentsWorker.scheduled({} as never, FAKE_ENV, {} as never);
    expect(mockProcessWithdrawal).toHaveBeenCalledWith(expect.anything(), "wd-id-1");
    expect(mockProcessWithdrawal).toHaveBeenCalledWith(expect.anything(), "wd-id-2");
  });
});

describe("WD-J7-C03 (WD-T-WK-16): scheduled — confirmation email sent and stamped for each unsent consent", () => {
  it("WD-T-WK-16: consent mail sent then paymentsMarkConsentInfoSent called", async () => {
    const mockStamp = vi.fn().mockResolvedValue({ outcome: "stamped" });
    // The sweep's mail dep is createMailer (mocked above); the account email comes from rpc.getUserEmail.
    mockSendConfirmation.mockResolvedValue({ id: "email-id-001" });
    const mockGetUserEmail = vi.fn().mockResolvedValue("user@test.local");
    mockCreateRpc.mockReturnValue({
      paymentsPendingWork: vi.fn().mockResolvedValue({
        withdrawals: [],
        consents: [{
          checkout_session_id: "cs_test_session001",
          subscription_id: "sub_test1234567890",
          user_id: "user-uuid-1",
          locale: "da",
          text_version: WITHDRAWAL_TEXT_VERSION,
          accepted_at: "2026-11-14T10:00:00Z",
          started_at: "2026-11-14T00:00:00Z",
          plan: { billing_interval: "month", amount_ore: 1000, name: "Monitor Plus" },
        }],
      }),
      paymentsMarkConsentInfoSent: mockStamp,
      getUserEmail: mockGetUserEmail,
    });
    await PaymentsWorker.scheduled({} as never, FAKE_ENV, {} as never);
    expect(mockGetUserEmail).toHaveBeenCalledWith("user-uuid-1");
    expect(mockSendConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({ to: "user@test.local", idempotencyKey: "withdrawal-info/cs_test_session001" }),
    );
    // Stamp must be called with the sent email's id (email sent + marked)
    expect(mockStamp).toHaveBeenCalledWith("cs_test_session001", "email-id-001");
  });
});

describe("WD-J7-C04 (WD-T-WK-17): scheduled — isolates errors per item; never throws", () => {
  it("WD-T-WK-17: one failing processWithdrawal does not prevent others; scheduled resolves", async () => {
    let callCount = 0;
    mockProcessWithdrawal.mockImplementation(async (_deps: unknown, id: unknown) => {
      callCount++;
      if (id === "wd-id-fail") throw new Error("simulated transient failure");
      return fakeWithdrawal("completed");
    });
    mockCreateRpc.mockReturnValue({
      paymentsPendingWork: vi.fn().mockResolvedValue({ withdrawals: ["wd-id-fail", "wd-id-ok"], consents: [] }),
      paymentsMarkConsentInfoSent: vi.fn(),
    });
    await expect(PaymentsWorker.scheduled({} as never, FAKE_ENV, {} as never)).resolves.not.toThrow();
    expect(callCount).toBe(2);
  });
});

describe("WD-J7-C05 (WD-T-WK-18): scheduled — stops before 45 accumulated subrequests", () => {
  /**
   * The passes here make no real subrequest, so each is charged its reserve, 10 (A8), and starts
   * only when its worst case, 15, still fits the budget of 45. After the pending-work read (1),
   * passes start at a charged 1, 11 and 21; a fourth would need 31 + 15 > 45.
   * Item 4 must be untouched.
   */
  const CHARGE_PER_ITEM = 10;
  const PASS_WORST_CASE = 15;
  const BUDGET = 45;
  const PENDING_WORK_COST = 1;
  const MAX_ITEMS = Math.floor((BUDGET - PENDING_WORK_COST - PASS_WORST_CASE) / CHARGE_PER_ITEM) + 1; // 3

  it(`WD-T-WK-18: 10-item list → exactly ${MAX_ITEMS} processed; item ${MAX_ITEMS + 1} untouched`, async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `wd-budget-id-${i}`);
    const processed: string[] = [];

    mockProcessWithdrawal.mockImplementation(async (_deps: unknown, id: unknown) => {
      processed.push(String(id));
      return fakeWithdrawal("completed");
    });

    mockCreateRpc.mockReturnValue({
      paymentsPendingWork: vi.fn().mockResolvedValue({ withdrawals: ids, consents: [] }),
      paymentsMarkConsentInfoSent: vi.fn(),
    });

    await PaymentsWorker.scheduled({} as never, FAKE_ENV, {} as never);

    expect(processed.length).toBe(MAX_ITEMS);
    // Item at index MAX_ITEMS was not touched
    expect(processed).not.toContain(ids[MAX_ITEMS]);
  });
});

