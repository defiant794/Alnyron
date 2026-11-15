/**
 * Unit tests: workers/payments/sweep.ts — runSweep with its real Supabase, Stripe and Resend
 * clients on a fake global fetch, so every subrequest is a real fetch the sweep counts.
 * Journey: payments-slice1d-withdrawal
 * Criteria: WD-J7-C03, WD-J7-C05 (contract A8: count real subrequests, budget 45; a withdrawal
 *   pass makes 15 at most and is charged at least 10, an order confirmation 4; an item starts only
 *   when its worst case still fits, so ≤ 45 a run)
 *
 * processWithdrawal is replaced by a pass that makes a given number of real Stripe fetches
 * through the sweep's deps (its own business logic is tested in withdrawal.test.ts). The
 * pending-work read, the confirmation's account email lookup, send and stamp are the real code.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { PAYMENTS_SWEEP_LIMIT, WITHDRAWAL_MAX_MAIL_ATTEMPTS } from "@/config/payments";
import { WITHDRAWAL_TEXT_VERSION } from "@/config/legal/withdrawal-texts";
import type { PaymentsEnv } from "../../../../workers/payments/env";
import type { WithdrawalDeps } from "../../../../workers/payments/withdrawal";

const mockProcessWithdrawal = vi.fn();
vi.mock("../../../../workers/payments/withdrawal", () => ({
  processWithdrawal: (...a: unknown[]) => mockProcessWithdrawal(...a),
}));

import { runSweep } from "../../../../workers/payments/sweep";

// Pre-commit secret scan: no name may end in secret/token/api_key right before "="/":" with a
// quoted 8+ character value, so the literals live in these *_FX constants.
const SB_KEY_FX = "sb_secret_unittestkey1234";
const SK_TEST_FX = "sk_test_unitfakekey1234";
const WHSEC_FX = "whsec_unittest1234";
const RE_FX = "re_unittest1234";

const CONFIG: PaymentsEnv = {
  supabaseUrl: "https://xmgpixhxecamtryohgmk.supabase.co",
  supabaseSecretKey: SB_KEY_FX,
  stripeKey: SK_TEST_FX,
  webhookSecret: WHSEC_FX,
  livemode: false,
  resendApiKey: RE_FX,
  mailFrom: "noreply@alnyron.dk",
  withdrawalAlertTo: "owner@alnyron.dk",
  siteUrl: "https://alnyron.dk",
};

const USER_ID = "00000000-0000-0000-0d1d-000000000001";

/** A pending order confirmation (`ConsentMail`) for session `cs_test_sweep<n>`. */
function consentMail(n: number): Record<string, unknown> {
  return {
    checkout_session_id: `cs_test_sweep${n}`,
    subscription_id: `sub_sweep${n}`,
    user_id: USER_ID,
    locale: "da",
    text_version: WITHDRAWAL_TEXT_VERSION,
    accepted_at: "2026-11-14T10:00:00.000Z",
    started_at: "2026-11-14T10:00:00.000Z",
    plan: { billing_interval: "month", amount_ore: 1000, name: "Monitor Plus" },
  };
}

type Request = { method: string; url: string; body: unknown };

/**
 * The fake network: Supabase RPCs and Auth, Stripe and Resend answer like the real services
 * for the calls the sweep makes (Resend with `resend`, by default a 200 with an email id);
 * every request is recorded.
 */
function fakeNetwork(
  pending: { withdrawals: string[]; consents: Record<string, unknown>[] },
  resend?: () => Response,
) {
  const requests: Request[] = [];
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", async (input: string | URL | globalThis.Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    requests.push({ method, url, body });
    if (url.endsWith("/rest/v1/rpc/payments_pending_work")) return json(pending);
    if (url.endsWith("/rest/v1/rpc/payments_mark_consent_info_sent")) return json({ outcome: "stamped" });
    if (url.includes("/auth/v1/admin/users/")) return json({ id: USER_ID, email: "delivered+sweep@resend.dev" });
    if (url === "https://api.resend.com/emails") return resend?.() ?? json({ id: `email-${requests.length}` });
    if (url.startsWith("https://api.stripe.com/v1/subscriptions/")) return json({ id: "sub_sweepcount", status: "active" });
    throw new Error(`unexpected request ${method} ${url}`);
  });
  return requests;
}

/** Each withdrawal pass makes `calls[i]` real Stripe fetches (the last count repeats). */
function passesMaking(calls: readonly number[]): string[] {
  const started: string[] = [];
  mockProcessWithdrawal.mockImplementation(async (deps: WithdrawalDeps, id: string) => {
    const n = calls[Math.min(started.length, calls.length - 1)] ?? 0;
    started.push(id);
    for (let i = 0; i < n; i += 1) await deps.stripe.retrieveSubscription("sub_sweepcount");
  });
  return started;
}

/** The sweep's closing log line. */
function doneLine(log: MockInstance<typeof console.log>): unknown {
  return log.mock.calls
    .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
    .find((line) => line.msg === "payments sweep" && line.outcome === "done");
}

const ids = (count: number) => Array.from({ length: count }, (_, i) => `00000000-0000-0000-0d1d-${String(i).padStart(12, "0")}`);

let log: MockInstance<typeof console.log>;

beforeEach(() => {
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  log.mockRestore();
  vi.unstubAllGlobals();
});

describe("WD-J7-C05 (WD-T-WK-18): the sweep counts real subrequests (A8)", () => {
  it("WD-T-WK-18b: reads pending work with the list limit and the mail attempt cap (one subrequest)", async () => {
    const requests = fakeNetwork({ withdrawals: [], consents: [] });
    passesMaking([0]);
    await runSweep(CONFIG, {});
    expect(requests).toEqual([
      {
        method: "POST",
        url: `${CONFIG.supabaseUrl}/rest/v1/rpc/payments_pending_work`,
        body: { p_limit: PAYMENTS_SWEEP_LIMIT, p_max_mail_attempts: WITHDRAWAL_MAX_MAIL_ATTEMPTS },
      },
    ]);
    expect([PAYMENTS_SWEEP_LIMIT, WITHDRAWAL_MAX_MAIL_ATTEMPTS]).toEqual([20, 24]);
  });

  it("WD-T-WK-18c: every pass makes 13 → 3 passes, 40 subrequests", async () => {
    const requests = fakeNetwork({ withdrawals: ids(20), consents: [] });
    const started = passesMaking([13]);
    await runSweep(CONFIG, {});
    // 1 + 13 + 13 + 13 = 40; a fourth needs 40 + 15 > 45.
    expect(started).toEqual(ids(3));
    expect(requests).toHaveLength(40);
    expect(doneLine(log)).toEqual({
      msg: "payments sweep", outcome: "done", withdrawals: 3, consents: 0, budgetStop: true, subrequests: 40,
    });
  });

  it("WD-T-WK-18d: the worst case: the last pass starts at a charged 30 (= 45 - 15) and makes 15 → 45, never past the budget", async () => {
    const requests = fakeNetwork({ withdrawals: ids(20), consents: [] });
    // 1 + 14 + 15 = 30 charged, then a third pass fits (30 + 15 = 45) and makes 15; a fourth needs 60.
    const started = passesMaking([14, 15, 15]);
    await runSweep(CONFIG, {});
    expect(started).toEqual(ids(3));
    expect(requests).toHaveLength(45);
    expect(doneLine(log)).toMatchObject({ withdrawals: 3, consents: 0, budgetStop: true, subrequests: 45 });
  });

  it("WD-T-WK-18e: a pass making fewer than its reserve is still charged 10: 3 passes of 2 calls each, then a stop", async () => {
    const requests = fakeNetwork({ withdrawals: ids(20), consents: [] });
    const started = passesMaking([2]);
    await runSweep(CONFIG, {});
    // 1 → 11 → 21 → 31 charged; a fourth needs 31 + 15 > 45 (charged its real 2, it would start).
    expect(started).toEqual(ids(3));
    expect(requests).toHaveLength(1 + 3 * 2);
    expect(doneLine(log)).toMatchObject({ withdrawals: 3, budgetStop: true, subrequests: 7 });
  });

  it("WD-T-WK-18f: every pass makes the worst case 15 → each is charged its real 15: 2 passes, 31 subrequests", async () => {
    const requests = fakeNetwork({ withdrawals: ids(20), consents: [] });
    const started = passesMaking([15]);
    await runSweep(CONFIG, {});
    // 1 + 15 + 15 = 31; a third needs 31 + 15 > 45. Charged its reserve 10, a third would start at 21 and the run make 46.
    expect(started).toEqual(ids(2));
    expect(requests).toHaveLength(31);
    expect(doneLine(log)).toEqual({
      msg: "payments sweep", outcome: "done", withdrawals: 2, consents: 0, budgetStop: true, subrequests: 31,
    });
  });
});

describe("WD-J7-C03 (WD-T-WK-16b): a full withdrawal list never starves the order confirmations", () => {
  it("WD-T-WK-16c: 20 withdrawals + 2 confirmations → passes leave room for a pass's worst case and a confirmation (15 + 4): 3 passes, then both confirmations", async () => {
    const requests = fakeNetwork({ withdrawals: ids(20), consents: [consentMail(1), consentMail(2)] });
    const started = passesMaking([10]);
    await runSweep(CONFIG, {});
    // 1 + 3 × 10 = 31; a fourth pass needs 31 + 15 + 4 > 45; the confirmations fit (35, 39).
    expect(started).toEqual(ids(3));
    const confirmation = requests.slice(31, 34);
    expect(confirmation.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `GET ${CONFIG.supabaseUrl}/auth/v1/admin/users/${USER_ID}`,
      "POST https://api.resend.com/emails",
      `POST ${CONFIG.supabaseUrl}/rest/v1/rpc/payments_mark_consent_info_sent`,
    ]);
    expect(confirmation[2]?.body).toEqual({ p_checkout_session_id: "cs_test_sweep1", p_email_id: "email-33" });
    expect(doneLine(log)).toEqual({
      msg: "payments sweep", outcome: "done", withdrawals: 3, consents: 2, budgetStop: true, subrequests: 37,
    });
  });

  it("WD-T-WK-16f: passes overrunning their reserve (10, 15, 15) with one confirmation waiting → the confirmation still fits after them", async () => {
    const requests = fakeNetwork({ withdrawals: ids(20), consents: [consentMail(1)] });
    // 1 → 11 → 26 (26 + 15 + 4 = 45: the third pass starts) → 41; a fourth needs 60; the confirmation 45.
    const started = passesMaking([10, 15, 15]);
    await runSweep(CONFIG, {});
    expect(started).toEqual(ids(3));
    expect(requests.filter(({ url }) => url.endsWith("/rpc/payments_mark_consent_info_sent")).map(({ body }) => body)).toEqual([
      { p_checkout_session_id: "cs_test_sweep1", p_email_id: "email-43" },
    ]);
    expect(doneLine(log)).toEqual({
      msg: "payments sweep", outcome: "done", withdrawals: 3, consents: 1, budgetStop: true, subrequests: 44,
    });
  });

  it("WD-T-WK-16d: no confirmation waiting → passes of 11 run 3 times (1 + 33 = 34; a fourth needs 34 + 15 > 45)", async () => {
    const requests = fakeNetwork({ withdrawals: ids(20), consents: [] });
    const started = passesMaking([11]);
    await runSweep(CONFIG, {});
    expect(started).toEqual(ids(3));
    expect(requests).toHaveLength(34);
    expect(doneLine(log)).toMatchObject({ withdrawals: 3, consents: 0, budgetStop: true, subrequests: 34 });
  });

  it("WD-T-WK-16e: the same passes with two confirmations waiting → 3 passes (34 + 15 + 4 > 45), then both confirmations", async () => {
    const requests = fakeNetwork({ withdrawals: ids(20), consents: [consentMail(1), consentMail(2)] });
    const started = passesMaking([11]);
    await runSweep(CONFIG, {});
    expect(started).toEqual(ids(3));
    const stamps = requests.filter(({ url }) => url.endsWith("/rpc/payments_mark_consent_info_sent"));
    expect(stamps.map(({ body }) => body)).toEqual([
      { p_checkout_session_id: "cs_test_sweep1", p_email_id: "email-36" },
      { p_checkout_session_id: "cs_test_sweep2", p_email_id: "email-39" },
    ]);
    expect(doneLine(log)).toEqual({
      msg: "payments sweep", outcome: "done", withdrawals: 3, consents: 2, budgetStop: true, subrequests: 40,
    });
  });

  it("WD-T-WK-16g: passes of 13 with one confirmation waiting → 2 passes (27 + 15 + 4 > 45; with none waiting 3 run, WD-T-WK-18c), then the confirmation", async () => {
    const requests = fakeNetwork({ withdrawals: ids(20), consents: [consentMail(1)] });
    const started = passesMaking([13]);
    await runSweep(CONFIG, {});
    // 1 + 13 + 13 = 27; the confirmation's lookup, send and stamp are subrequests 28, 29 and 30.
    expect(started).toEqual(ids(2));
    expect(requests.filter(({ url }) => url.endsWith("/rpc/payments_mark_consent_info_sent")).map(({ body }) => body)).toEqual([
      { p_checkout_session_id: "cs_test_sweep1", p_email_id: "email-29" },
    ]);
    expect(doneLine(log)).toEqual({
      msg: "payments sweep", outcome: "done", withdrawals: 2, consents: 1, budgetStop: true, subrequests: 30,
    });
  });
});

describe("WD-J2-C03 (WD-T-WH-05b): a confirmation Resend answers as a replay of its key is stamped as sent", () => {
  it("WD-T-WH-05c: 409 invalid_idempotent_request on withdrawal-info/<session> → stamped with idempotent_replay; logged sent", async () => {
    const requests = fakeNetwork(
      { withdrawals: [], consents: [consentMail(1)] },
      () => new Response(JSON.stringify({ name: "invalid_idempotent_request" }), { status: 409 }),
    );
    passesMaking([0]);
    await runSweep(CONFIG, {});
    expect(requests.filter(({ url }) => url.endsWith("/rpc/payments_mark_consent_info_sent")).map(({ body }) => body)).toEqual([
      { p_checkout_session_id: "cs_test_sweep1", p_email_id: "idempotent_replay" },
    ]);
    expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual({
      msg: "payments sweep", session: "cs_test_sweep1", outcome: "sent", code: null,
    });
  });
});
