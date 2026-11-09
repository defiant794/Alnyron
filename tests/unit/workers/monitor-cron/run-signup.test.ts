/**
 * Unit tests: workers/monitor-cron/run.ts — purge step and signupSweep
 * Journey: monitor-signup-notice  SNE-AC1a, SNE-AC1d, SNE-AC1e, SNE-AC1f, SNE-AC1k,
 *          SNE-AC2a-f, SNE-AC2h, SNE-AC2j, SNE-AC3e, SNE-AC4g
 *
 * Uses in-memory fake EngineRpc + capturing mailer + injected clock.
 * Covers:
 *   - Call order: emailSweep → claim → checks → second-sweep → purge → signupSweep (last)
 *   - sweep args: pendingSignups(1, 10), purgeUnconfirmed(5)
 *   - key "monitor-signup/<user_id>", to === owner_emails[0]
 *   - signupNotices / signupNoticesDeferred / purged counters
 *   - mailStop pre-set → signupSweep skipped but purge still runs
 *   - remaining() < 3 → no signup sweep; remaining() < 1 → no purge; exactly 1 → purge runs
 *   - wall doesn't fit → skipped; an exact fit (elapsed + timeout = 870 000 ms) → runs
 *   - neither sets budgetStop
 *   - claimLimit unchanged (purge/signup come after all checks)
 *   - rejected → marked, signupNotices stays 0
 *   - send ok + mark throws, then next run's retry (waiting changed) gets Resend's 409
 *     invalid_idempotent_request → marked, mailStop stays null
 *   - quota/rate-limit/transient → mailStop set, not marked, deferred +1
 *   - markSignupNotified throws → rpcErrors incremented
 *   - pendingSignups throws → rpcErrors incremented, no send
 *   - purge throws → rpcErrors incremented, signupSweep still runs
 *   - empty owner_emails → no send, no mark, deferred +1
 *   - log line JSON contains counters, no address/user_id/key
 *   - waiting=N → signupNoticesDeferred=N
 *   - config constant literals (DAILY_CAP=10, PER_RUN=1, PURGE_BATCH=5)
 */
import { describe, expect, it } from "vitest";
import {
  MONITOR_SIGNUP_NOTICE_DAILY_CAP,
  MONITOR_SIGNUP_NOTICE_PER_RUN,
  MONITOR_UNCONFIRMED_PURGE_BATCH,
  MONITOR_RUN_WALL_LIMIT_MS,
  MONITOR_RPC_TIMEOUT_MS,
  MONITOR_EMAIL_SEND_TIMEOUT_MS,
} from "@/config/monitor";
import type { ClaimedMonitor, EngineRpc, PendingEmail, PendingSignup } from "../../../../workers/monitor-cron/rpc";
import {
  runMonitorChecks,
  type Mailer,
  type RunConfig,
  type RunSummary,
} from "../../../../workers/monitor-cron/run";
import { sendEmail, type SendResult } from "@/lib/email/resend";

// ── Constant-literal pins ─────────────────────────────────────────────────────

describe("config: constants have the specified literal values", () => {
  it("SNE-AC4g-cfg1: MONITOR_SIGNUP_NOTICE_DAILY_CAP is 10", () => {
    expect(MONITOR_SIGNUP_NOTICE_DAILY_CAP).toBe(10);
  });

  it("SNE-AC4g-cfg2: MONITOR_SIGNUP_NOTICE_PER_RUN is 1", () => {
    expect(MONITOR_SIGNUP_NOTICE_PER_RUN).toBe(1);
  });

  it("SNE-AC4g-cfg3: MONITOR_UNCONFIRMED_PURGE_BATCH is 5", () => {
    expect(MONITOR_UNCONFIRMED_PURGE_BATCH).toBe(5);
  });
});

// ── Fake-RPC factory ──────────────────────────────────────────────────────────

interface FakeRpcOptions {
  claimRows?: ClaimedMonitor[];
  pendingSignupResults?: PendingSignup[];
  purgeCount?: number;
  /** First pendingEmails call returns [0], second returns [1]. */
  pendingEmailsSweeps?: PendingEmail[][];
}

function makeFakeRpc(opts: FakeRpcOptions = {}): EngineRpc {
  let pendingEmailsCallIdx = 0;
  return {
    async claim(limit) {
      return (opts.claimRows ?? []).slice(0, limit);
    },
    async snapshot() {
      return null;
    },
    async record() {
      return { applied: true, event_id: null, notify_error: false, notified_at: null, email: null, url: null, label: null, consecutive_errors: 0 };
    },
    async pendingEmails() {
      const sweeps = opts.pendingEmailsSweeps ?? [];
      const idx = pendingEmailsCallIdx++;
      return sweeps[idx] ?? [];
    },
    async markEmailed() {
      return true;
    },
    async pendingSignups() {
      return opts.pendingSignupResults ?? [];
    },
    async purgeUnconfirmed() {
      return opts.purgeCount ?? 0;
    },
    async markSignupNotified() {
      return true;
    },
  };
}

// ── Capturing mailer ──────────────────────────────────────────────────────────

interface CapturedMail {
  to: string;
  idempotencyKey: string;
  subject: string;
  html: string;
  text: string;
}

function makeCapturingMailer(result: SendResult = { ok: true, id: "mail-ok" }): {
  mailer: Mailer;
  mails: CapturedMail[];
} {
  const mails: CapturedMail[] = [];
  const mailer: Mailer = async (message, idempotencyKey) => {
    mails.push({ to: message.to, idempotencyKey, subject: message.subject, html: message.html, text: message.text });
    return result;
  };
  return { mailer, mails };
}

// ── Test config ───────────────────────────────────────────────────────────────

const BASE_CONFIG: RunConfig = {
  batchSize: 5,
  subrequestLimit: 200,
  siteUrl: "https://alnyron.dk",
  mailFrom: "Alnyron <noreply@send.alnyron.dk>",
};

const OWNER_EMAIL = "owner@alnyron-e2e.invalid";
const USER_ID = "00000000-0000-0000-0000-000000000099";
const CONFIRMED_AT = "2026-11-08T10:00:00.000Z";

const SIGNUP_ROW: PendingSignup = {
  user_id: USER_ID,
  email: "ny.bruger@eksempel.dk",
  confirmed_at: CONFIRMED_AT,
  waiting: 0,
  owner_emails: [OWNER_EMAIL],
};

// ── Call order ────────────────────────────────────────────────────────────────

describe("runMonitorChecks — SNE-AC2a: purge and signupSweep are last (after all checks and second sweep)", () => {
  it("SNE-AC2a-run1: full call order: pendingEmails → claim → record → pendingEmails(2nd) → send(change) → markEmailed → purge → pendingSignups → send(signup) → markSignupNotified", async () => {
    // Use a changed monitor (last_hash differs from page) so eventsCreated=1 → second sweep fires.
    const differentHash = "v1:" + "b".repeat(64);
    const EVENT_ID = "evt-order-1";
    const callOrder: string[] = [];
    let pendingEmailsCall = 0;
    const rpc: EngineRpc = {
      async claim(limit) {
        callOrder.push("claim");
        return [{ id: "mon-1", user_id: "u1", url: "https://example.com/", last_hash: differentHash, consecutive_errors: 0, prior_strikes: 0 }].slice(0, limit);
      },
      async snapshot() { return null; },
      async record() {
        callOrder.push("record");
        return { applied: true, event_id: EVENT_ID, notify_error: false, notified_at: null, email: null, url: null, label: null, consecutive_errors: 0 };
      },
      async pendingEmails() {
        const idx = pendingEmailsCall++;
        callOrder.push(`pendingEmails${idx === 0 ? "" : "(2nd)"}`);
        if (idx === 0) return [];
        // Second sweep returns the event just created so a change email is sent.
        return [{ event_id: EVENT_ID, monitor_id: "mon-1", user_id: "u1", email: "user@example.com", url: "https://example.com/", label: null, detected_at: new Date().toISOString(), summary: null }];
      },
      async markEmailed() {
        callOrder.push(`markEmailed`);
        return true;
      },
      async pendingSignups(limit, dailyCap) {
        callOrder.push(`pendingSignups(${limit},${dailyCap})`);
        return [SIGNUP_ROW];
      },
      async purgeUnconfirmed(limit) {
        callOrder.push(`purgeUnconfirmed(${limit})`);
        return 0;
      },
      async markSignupNotified(userId) {
        callOrder.push(`markSignupNotified(${userId})`);
        return true;
      },
    };
    // Capturing mailer records each send in order.
    const mailKeys: string[] = [];
    const mailer: Mailer = async (message, idempotencyKey) => {
      callOrder.push(`send(${idempotencyKey.startsWith("monitor-event") ? "change" : "signup"})`);
      mailKeys.push(idempotencyKey);
      return { ok: true, id: "ok" };
    };
    // fetchPage returns a page whose hash differs from differentHash → triggers "changed" outcome.
    await runMonitorChecks({
      rpc,
      mailer,
      fetchPage: async (url) => ({ ok: true, body: "<html><body><p>new content xyz</p></body></html>", contentType: "text/html", finalUrl: url, truncated: false, subrequests: 1 }),
      config: BASE_CONFIG,
      log: () => {},
    });
    expect(callOrder).toEqual([
      "pendingEmails",         // 1st sweep (before claim, finds nothing)
      "claim",
      "record",                // changed (the page's hash differs from last_hash); the second sweep fires because event_id is returned
      "pendingEmails(2nd)",    // second sweep after checks
      "send(change)",          // change-event email
      "markEmailed",           // mark change event emailed
      `purgeUnconfirmed(${MONITOR_UNCONFIRMED_PURGE_BATCH})`,
      `pendingSignups(${MONITOR_SIGNUP_NOTICE_PER_RUN},${MONITOR_SIGNUP_NOTICE_DAILY_CAP})`,
      "send(signup)",          // signup notice email
      `markSignupNotified(${USER_ID})`,
    ]);
    expect(mailKeys).toEqual([`monitor-event/${EVENT_ID}`, `monitor-signup/${USER_ID}`]);
  });
});

// ── sweep args ────────────────────────────────────────────────────────────────

describe("runMonitorChecks — SNE-AC2a: pendingSignups called with (PER_RUN, DAILY_CAP)", () => {
  it("SNE-AC2a-run2: pendingSignups receives (MONITOR_SIGNUP_NOTICE_PER_RUN, MONITOR_SIGNUP_NOTICE_DAILY_CAP)", async () => {
    const signupArgs: number[][] = [];
    const purgeArgs: number[] = [];
    const rpc: EngineRpc = {
      ...makeFakeRpc({ pendingSignupResults: [] }),
      async pendingSignups(limit, dailyCap) {
        signupArgs.push([limit, dailyCap]);
        return [];
      },
      async purgeUnconfirmed(limit) {
        purgeArgs.push(limit);
        return 0;
      },
    };
    const { mailer } = makeCapturingMailer();
    await runMonitorChecks({ rpc, mailer, fetchPage: async (url) => ({ ok: true, body: "<p>x</p>", contentType: "text/html", finalUrl: url, truncated: false, subrequests: 1 }), config: BASE_CONFIG, log: () => {} });
    expect(signupArgs).toEqual([[MONITOR_SIGNUP_NOTICE_PER_RUN, MONITOR_SIGNUP_NOTICE_DAILY_CAP]]);
    expect(purgeArgs).toEqual([MONITOR_UNCONFIRMED_PURGE_BATCH]);
  });
});

// ── idempotency key and to address ───────────────────────────────────────────

describe("runMonitorChecks — SNE-AC1a: signup notice key is monitor-signup/<user_id>, to is owner_emails[0]", () => {
  it("SNE-AC1a-run3: key='monitor-signup/<user_id>', to=owner_emails[0]", async () => {
    const rpc = makeFakeRpc({ pendingSignupResults: [SIGNUP_ROW] });
    const { mailer, mails } = makeCapturingMailer();
    await runMonitorChecks({ rpc, mailer, fetchPage: async (url) => ({ ok: true, body: "<p>x</p>", contentType: "text/html", finalUrl: url, truncated: false, subrequests: 1 }), config: BASE_CONFIG, log: () => {} });
    expect(mails).toHaveLength(1);
    expect(mails[0]!.idempotencyKey).toBe(`monitor-signup/${USER_ID}`);
    expect(mails[0]!.to).toBe(OWNER_EMAIL);
  });
});

// ── counters ──────────────────────────────────────────────────────────────────

describe("runMonitorChecks — SNE-AC1a: signupNotices counter incremented on successful send", () => {
  it("SNE-AC1a-run4: one successful notice → signupNotices:1, purged:2, signupNoticesDeferred:0", async () => {
    const rpc = makeFakeRpc({ pendingSignupResults: [SIGNUP_ROW], purgeCount: 2 });
    const { mailer } = makeCapturingMailer();
    const summary = await runMonitorChecks({ rpc, mailer, fetchPage: async (url) => ({ ok: true, body: "<p>x</p>", contentType: "text/html", finalUrl: url, truncated: false, subrequests: 1 }), config: BASE_CONFIG, log: () => {} });
    expect(summary.signupNotices).toBe(1);
    expect(summary.purged).toBe(2);
    expect(summary.signupNoticesDeferred).toBe(0);
  });
});

// ── waiting field → signupNoticesDeferred ─────────────────────────────────────

describe("runMonitorChecks — SNE-AC2h: waiting field on returned row → signupNoticesDeferred", () => {
  it("SNE-AC2h-run5: waiting=3 on the returned row → signupNoticesDeferred:3", async () => {
    const rowWithWaiting: PendingSignup = { ...SIGNUP_ROW, waiting: 3 };
    const rpc = makeFakeRpc({ pendingSignupResults: [rowWithWaiting] });
    const { mailer } = makeCapturingMailer();
    const summary = await runMonitorChecks({ rpc, mailer, fetchPage: async (url) => ({ ok: true, body: "<p>x</p>", contentType: "text/html", finalUrl: url, truncated: false, subrequests: 1 }), config: BASE_CONFIG, log: () => {} });
    // waiting=3 → signupNoticesDeferred=3 (the 3 un-returned rows not covered this run)
    expect(summary.signupNoticesDeferred).toBe(3);
    // the one row that was returned was sent successfully
    expect(summary.signupNotices).toBe(1);
  });
});

// ── mailStop already set → no signup sweep ───────────────────────────────────

describe("runMonitorChecks — SNE-AC2f: mailStop pre-set → signupSweep skipped, purge still runs", () => {
  it("SNE-AC2f-run6: when first sweep sets mailStop, pendingSignups is not called, purge still runs", async () => {
    const signupCalls: number[] = [];
    const purgeResults: number[] = [];
    // First sweep sets mailStop via quota
    const rpc: EngineRpc = {
      ...makeFakeRpc({
        pendingEmailsSweeps: [
          [{ event_id: "evt-1", monitor_id: "mon-1", user_id: "u1", email: "u@ex.com", url: "https://ex.com/", label: null, detected_at: new Date().toISOString(), summary: null }],
        ],
      }),
      async pendingSignups(limit, dailyCap) {
        signupCalls.push(dailyCap);
        return [];
      },
      async purgeUnconfirmed(limit) {
        purgeResults.push(limit);
        return 1;
      },
    };
    const { mailer } = makeCapturingMailer({ ok: false, kind: "quota", status: 429 });
    const summary = await runMonitorChecks({ rpc, mailer, fetchPage: async (url) => ({ ok: true, body: "<p>x</p>", contentType: "text/html", finalUrl: url, truncated: false, subrequests: 1 }), config: BASE_CONFIG, log: () => {} });
    expect(summary.mailStop).toBe("quota");
    // signupSweep skipped because mailStop is set
    expect(signupCalls).toHaveLength(0);
    // purge still runs
    expect(purgeResults).toEqual([MONITOR_UNCONFIRMED_PURGE_BATCH]);
    expect(summary.purged).toBe(1);
  });
});

// ── budget: remaining() < 3 → no signup sweep ────────────────────────────────

describe("runMonitorChecks — SNE-AC2c: remaining() < 3 → pendingSignups not called", () => {
  it("SNE-AC2c-run7: subrequestLimit=4 leaves exactly 2 after purge → signupSweep skipped but purge ran", async () => {
    // emailSweep(-1=3 left); claimLimit=floor(2/15)=0 → budgetStop=true, no claim
    // purge: 3>=1 → runs(+1); remaining=2; signupSweep: 2<3 → skipped
    const signupCalls: number[] = [];
    const purgeCalls: number[] = [];
    const rpc: EngineRpc = {
      ...makeFakeRpc({ claimRows: [] }),
      async pendingSignups(limit, cap) {
        signupCalls.push(cap);
        return [];
      },
      async purgeUnconfirmed(limit) {
        purgeCalls.push(limit);
        return 0;
      },
    };
    const { mailer } = makeCapturingMailer();
    const summary = await runMonitorChecks({ rpc, mailer, fetchPage: async (url) => ({ ok: true, body: "<p>x</p>", contentType: "text/html", finalUrl: url, truncated: false, subrequests: 1 }), config: { ...BASE_CONFIG, subrequestLimit: 4, batchSize: 1 }, log: () => {} });
    expect(signupCalls).toHaveLength(0); // signup skipped (remaining=2 < 3 after purge)
    expect(purgeCalls).toHaveLength(1);  // purge ran (remaining=3 >= 1 before purge)
    // budgetStop=true is from claimLimit=0, NOT from the signup sweep
    expect(summary.budgetStop).toBe(true);
  });
});

// ── budget: remaining() < 1 → no purge ───────────────────────────────────────

describe("runMonitorChecks — SNE-AC2b: remaining() < 1 → purge skipped", () => {
  it("SNE-AC2b-run8: subrequestLimit=1 leaves 0 after emailSweep → purge and signupSweep both skipped", async () => {
    // subrequestLimit=1: emailSweep(1) → remaining=0; claimLimit=floor(-1/15)=-1<1 → budgetStop
    // purge: 0<1 → skipped; signupSweep: 0<3 → skipped
    const purgeCalls: number[] = [];
    const signupCalls: number[] = [];
    const rpc: EngineRpc = {
      ...makeFakeRpc({ claimRows: [] }),
      async purgeUnconfirmed(limit) { purgeCalls.push(limit); return 0; },
      async pendingSignups(limit, cap) { signupCalls.push(cap); return []; },
    };
    const { mailer } = makeCapturingMailer();
    const summary = await runMonitorChecks({ rpc, mailer, fetchPage: async (url) => ({ ok: true, body: "<p>x</p>", contentType: "text/html", finalUrl: url, truncated: false, subrequests: 1 }), config: { ...BASE_CONFIG, subrequestLimit: 1, batchSize: 5 }, log: () => {} });
    expect(purgeCalls).toHaveLength(0);
    expect(signupCalls).toHaveLength(0);
    // budgetStop=true from claimLimit<1; neither purge nor signup is what set it
    expect(summary.budgetStop).toBe(true);
  });
});

describe("runMonitorChecks — SNE-AC2b: exactly 1 subrequest left before the purge → purge runs", () => {
  it("SNE-AC2b-run23: subrequestLimit=2 leaves exactly 1 after emailSweep → purge runs (0 left), signupSweep skipped", async () => {
    // subrequestLimit=2: emailSweep(1) → remaining=1; claimLimit=floor(0/15)=0<1 → budgetStop
    // purge: 1>=1 → runs → remaining=0; signupSweep: 0<3 → skipped
    const purgeCalls: number[] = [];
    const signupCalls: number[] = [];
    const rpc: EngineRpc = {
      ...makeFakeRpc({ claimRows: [] }),
      async purgeUnconfirmed(limit) { purgeCalls.push(limit); return 2; },
      async pendingSignups(limit, cap) { signupCalls.push(cap); return []; },
    };
    const { mailer } = makeCapturingMailer();
    const summary = await runMonitorChecks({ rpc, mailer, fetchPage: async (url) => ({ ok: true, body: "<p>x</p>", contentType: "text/html", finalUrl: url, truncated: false, subrequests: 1 }), config: { ...BASE_CONFIG, subrequestLimit: 2, batchSize: 5 }, log: () => {} });
    expect(purgeCalls).toEqual([MONITOR_UNCONFIRMED_PURGE_BATCH]);
    expect(summary.purged).toBe(2);
    expect(signupCalls).toHaveLength(0);
    expect(summary.subrequests).toBe(2);
    expect(summary.rpcErrors).toBe(0);
  });
});

// ── wall time ─────────────────────────────────────────────────────────────────

describe("runMonitorChecks — SNE-AC2d: wall time doesn't fit → purge and signupSweep skipped", () => {
  it("SNE-AC2d-run9: when now() returns WALL_LIMIT-RPC_TIMEOUT+1 after the first call, purge and signupSweep are skipped and the run ends cleanly", async () => {
    // tooLate = 865 001 ms. fitsWall(5000): 865001+5000=870001>870000 → purge skipped.
    // claimLimit wall term: floor((870000-865001-5000)/35000)=floor(-1/35000)=-1<1 → budgetStop=true.
    const purgeCalls: number[] = [];
    const signupCalls: number[] = [];
    const rpc: EngineRpc = {
      ...makeFakeRpc({ claimRows: [] }),
      async purgeUnconfirmed(limit) { purgeCalls.push(limit); return 0; },
      async pendingSignups(limit, cap) { signupCalls.push(cap); return []; },
    };
    const { mailer } = makeCapturingMailer();
    const tooLate = MONITOR_RUN_WALL_LIMIT_MS - MONITOR_RPC_TIMEOUT_MS + 1;
    let callCount = 0;
    const summary = await runMonitorChecks({
      rpc, mailer,
      fetchPage: async (url) => ({ ok: true, body: "<p>x</p>", contentType: "text/html", finalUrl: url, truncated: false, subrequests: 1 }),
      config: BASE_CONFIG,
      log: () => {},
      now: () => (callCount++ === 0 ? 0 : tooLate),
    });
    expect(purgeCalls).toHaveLength(0);
    expect(signupCalls).toHaveLength(0);
    // budgetStop=true from wall-clamped claimLimit<1 (not from purge/signup)
    expect(summary.budgetStop).toBe(true);
  });
});

describe("runMonitorChecks — SNE-AC2d: an exact wall fit (elapsed + worst case = 870 000 ms) still runs", () => {
  // The signup sweep's worst case: lookup + send + mark, each at its whole timeout (20 000 ms).
  const SWEEP_WALL = MONITOR_RPC_TIMEOUT_MS + MONITOR_EMAIL_SEND_TIMEOUT_MS + MONITOR_RPC_TIMEOUT_MS;
  it.for([
    {
      id: "SNE-AC2d-run24",
      label: "865 000 ms in: the purge's 5 000 ms end exactly at the limit → purge runs; the sweep's 20 000 ms do not fit",
      at: MONITOR_RUN_WALL_LIMIT_MS - MONITOR_RPC_TIMEOUT_MS,
      purges: 1,
      lookups: 0,
      notices: 0,
    },
    {
      id: "SNE-AC2d-run25",
      label: "850 000 ms in: the sweep's lookup + one notice (20 000 ms) end exactly at the limit → purge, lookup and notice run",
      at: MONITOR_RUN_WALL_LIMIT_MS - SWEEP_WALL,
      purges: 1,
      lookups: 1,
      notices: 1,
    },
    {
      id: "SNE-AC2d-run26",
      label: "850 001 ms in: 1 ms late for the sweep → purge only",
      at: MONITOR_RUN_WALL_LIMIT_MS - SWEEP_WALL + 1,
      purges: 1,
      lookups: 0,
      notices: 0,
    },
  ])("$id: $label", async (row) => {
    const purgeCalls: number[] = [];
    const signupCalls: number[] = [];
    const rpc: EngineRpc = {
      ...makeFakeRpc({ claimRows: [] }),
      async purgeUnconfirmed(limit) { purgeCalls.push(limit); return 0; },
      async pendingSignups(limit, cap) { signupCalls.push(cap); return [SIGNUP_ROW]; },
    };
    const { mailer, mails } = makeCapturingMailer();
    let callCount = 0;
    const summary = await runMonitorChecks({
      rpc, mailer,
      fetchPage: async (url) => ({ ok: true, body: "<p>x</p>", contentType: "text/html", finalUrl: url, truncated: false, subrequests: 1 }),
      config: BASE_CONFIG,
      log: () => {},
      // The clock stands still after the start: every budget check sees `at`.
      now: () => (callCount++ === 0 ? 0 : row.at),
    });
    expect(purgeCalls).toHaveLength(row.purges);
    expect(signupCalls).toHaveLength(row.lookups);
    expect(mails).toHaveLength(row.notices);
    expect(summary.signupNotices).toBe(row.notices);
    // budgetStop=true from the wall-clamped claimLimit<1 (not from purge/signup)
    expect(summary.budgetStop).toBe(true);
  });
});

// ── neither sets budgetStop ───────────────────────────────────────────────────

describe("runMonitorChecks — SNE-AC2a: purge and signupSweep never set budgetStop", () => {
  it("SNE-AC2a-run10: a successful purge and signupSweep leave budgetStop:false", async () => {
    const rpc = makeFakeRpc({ pendingSignupResults: [SIGNUP_ROW], purgeCount: 3 });
    const { mailer } = makeCapturingMailer();
    const summary = await runMonitorChecks({ rpc, mailer, fetchPage: async (url) => ({ ok: true, body: "<p>x</p>", contentType: "text/html", finalUrl: url, truncated: false, subrequests: 1 }), config: BASE_CONFIG, log: () => {} });
    expect(summary.budgetStop).toBe(false);
  });
});

// ── purge+signup excluded from claim-limit formula ────────────────────────────

describe("runMonitorChecks — SNE-AC2j: purge and signupSweep subrequest cost not deducted from claim budget", () => {
  it("SNE-AC2j-run22: idle run (no monitors, no signup/purge work) completes with budgetStop:false and rpcErrors:0", async () => {
    // With BASE_CONFIG (subrequestLimit=200) and no-op purge/signup, the run must not
    // set budgetStop or accumulate rpcErrors — proving no subrequest-budget interference.
    const rpc = makeFakeRpc({ pendingSignupResults: [], purgeCount: 0 });
    const { mailer } = makeCapturingMailer();
    const summary = await runMonitorChecks({
      rpc, mailer,
      fetchPage: async (url) => ({ ok: true, body: "<p>x</p>", contentType: "text/html", finalUrl: url, truncated: false, subrequests: 1 }),
      config: BASE_CONFIG,
      log: () => {},
    });
    expect(summary.budgetStop).toBe(false);
    expect(summary.rpcErrors).toBe(0);
    expect(summary.purged).toBe(0);
    expect(summary.signupNotices).toBe(0);
  });
});

// ── claimLimit unchanged ──────────────────────────────────────────────────────

describe("runMonitorChecks — SNE-AC2a: purge/signupSweep do not reduce check capacity", () => {
  it.for([
    {
      id: "SNE-AC2a-run11a",
      subrequestLimit: 18,
      // 18: emailSweep(-1=17); claimLimit=min(5,floor(16/15))=1; claim+check → remaining=12.
      // If purge reserved 1 before claim: floor(15/15)=1 (unchanged — doesn't catch this mistake).
      // If signup reserved 3 before claim: floor(13/15)=0 (caught — but that's a different bug).
    },
    {
      id: "SNE-AC2a-run11b",
      subrequestLimit: 17,
      // 17: emailSweep(-1=16); claimLimit=min(5,floor(15/15))=1; claim+check → remaining=11.
      // If purge reserves 1 before claim: floor(14/15)=0 → claimLimit=0 → caught.
      // If signup reserves 1 before claim: floor(14/15)=0 → caught.
      // A correct implementation: purge runs AFTER checks, floor(15/15)=1 → claimLimit=1.
    },
  ])("$id: subrequestLimit=$subrequestLimit → claimLimit=1; monitor claimed+checked; purge+signup come after", async (row) => {
    const claimLimits: number[] = [];
    const claimRow = { id: "mon-chk", user_id: "u1", url: "https://example.com/chk", last_hash: null, consecutive_errors: 0, prior_strikes: 0 };
    const rpc: EngineRpc = {
      ...makeFakeRpc({ claimRows: [claimRow] }),
      async claim(limit) {
        claimLimits.push(limit);
        return [claimRow].slice(0, limit);
      },
      async purgeUnconfirmed() { return 0; },
      async pendingSignups() { return []; },
    };
    const { mailer } = makeCapturingMailer();
    const summary = await runMonitorChecks({ rpc, mailer, fetchPage: async (url) => ({ ok: true, body: "<p>x</p>", contentType: "text/html", finalUrl: url, truncated: false, subrequests: 1 }), config: { ...BASE_CONFIG, subrequestLimit: row.subrequestLimit, batchSize: 5 }, log: () => {} });
    expect(claimLimits).toEqual([1]);           // purge/signup don't reduce the claim limit
    expect(summary.checked).toBe(1);           // the claimed monitor was actually checked
    expect(summary.baselines).toBe(1);
    expect(summary.budgetStop).toBe(true);     // cut claim (1 of 5) came back full
  });
});

// ── rejected → marked, signupNotices stays 0 ─────────────────────────────────

describe("runMonitorChecks — SNE-AC1f: rejected → markSignupNotified called, signupNotices:0", () => {
  it("SNE-AC1f-run12: mailer returns rejected → markSignupNotified called, signupNotices stays 0", async () => {
    const markedIds: string[] = [];
    const rpc: EngineRpc = {
      ...makeFakeRpc({ pendingSignupResults: [SIGNUP_ROW] }),
      async markSignupNotified(userId) {
        markedIds.push(userId);
        return true;
      },
    };
    const { mailer } = makeCapturingMailer({ ok: false, kind: "rejected", status: 422 });
    const summary = await runMonitorChecks({ rpc, mailer, fetchPage: async (url) => ({ ok: true, body: "<p>x</p>", contentType: "text/html", finalUrl: url, truncated: false, subrequests: 1 }), config: BASE_CONFIG, log: () => {} });
    expect(markedIds).toEqual([USER_ID]);
    expect(summary.signupNotices).toBe(0);
    expect(summary.signupNoticesDeferred).toBe(0);
  });
});

describe("runMonitorChecks — SNE-AC1f: a retry whose payload changed gets Resend's 409 → marked, sending goes on", () => {
  it("SNE-AC1f-run27: send ok + markSignupNotified throws; next run's retry (waiting 0 → 1) gets 409 invalid_idempotent_request → the account is marked, mailStop stays null", async () => {
    const markedIds: string[] = [];
    let markThrows = true;
    const rpcWith = (waiting: number): EngineRpc => ({
      ...makeFakeRpc({ pendingSignupResults: [{ ...SIGNUP_ROW, waiting }] }),
      async markSignupNotified(userId) {
        markedIds.push(userId);
        if (markThrows) throw new Error("db down");
        return true;
      },
    });
    const fetchPage = async (url: string) => ({ ok: true as const, body: "<p>x</p>", contentType: "text/html", finalUrl: url, truncated: false, subrequests: 1 });

    // Run 1: Resend accepts the notice, the stamp fails.
    const first = makeCapturingMailer();
    const run1 = await runMonitorChecks({ rpc: rpcWith(0), mailer: first.mailer, fetchPage, config: BASE_CONFIG, log: () => {} });
    expect(run1.signupNotices).toBe(1);
    expect(run1.rpcErrors).toBe(1);

    // Run 2: the account is still pending, now with one more waiting, so the same key carries
    // another payload; the real sendEmail maps Resend's 409 body.
    markThrows = false;
    const retries: { key: string; text: string }[] = [];
    const mailer: Mailer = (message, idempotencyKey) => {
      retries.push({ key: idempotencyKey, text: message.text });
      return sendEmail("re_unit_test_key", message, idempotencyKey, async () =>
        new Response(JSON.stringify({ name: "invalid_idempotent_request" }), { status: 409 }),
      );
    };
    const run2 = await runMonitorChecks({ rpc: rpcWith(1), mailer, fetchPage, config: BASE_CONFIG, log: () => {} });

    expect(retries.map((retry) => retry.key)).toEqual([`monitor-signup/${USER_ID}`]);
    expect(retries[0]!.key).toBe(first.mails[0]!.idempotencyKey);
    expect(retries[0]!.text).not.toBe(first.mails[0]!.text);
    expect(markedIds).toEqual([USER_ID, USER_ID]);
    expect(run2.mailStop).toBeNull();
    expect(run2.signupNotices).toBe(0);
    expect(run2.signupNoticesDeferred).toBe(1);
    expect(run2.rpcErrors).toBe(0);
  });
});

// ── quota/rate-limit/transient → mailStop set, not marked, deferred +1 ───────

describe("runMonitorChecks — SNE-AC1e: transient/quota → mailStop set, not marked, deferred +1", () => {
  for (const kind of ["transient", "quota", "rate_limited"] as const) {
    it(`SNE-AC1e-run13-${kind}: ${kind} → mailStop=${kind}, markSignupNotified not called, signupNoticesDeferred:1`, async () => {
      const markedIds: string[] = [];
      const rpc: EngineRpc = {
        ...makeFakeRpc({ pendingSignupResults: [SIGNUP_ROW] }),
        async markSignupNotified(userId) {
          markedIds.push(userId);
          return true;
        },
      };
      const { mailer } = makeCapturingMailer({ ok: false, kind, status: 429 });
      const summary = await runMonitorChecks({ rpc, mailer, fetchPage: async (url) => ({ ok: true, body: "<p>x</p>", contentType: "text/html", finalUrl: url, truncated: false, subrequests: 1 }), config: BASE_CONFIG, log: () => {} });
      expect(summary.mailStop).toBe(kind);
      expect(markedIds).toHaveLength(0);
      expect(summary.signupNotices).toBe(0);
      expect(summary.signupNoticesDeferred).toBe(1);
    });
  }
});

// ── mark throws → rpcErrors +1 ───────────────────────────────────────────────

describe("runMonitorChecks — SNE-AC1k: markSignupNotified throws → rpcErrors incremented", () => {
  it("SNE-AC1k-run14: markSignupNotified throws → rpcErrors incremented, send succeeded so signupNotices:1", async () => {
    const rpc: EngineRpc = {
      ...makeFakeRpc({ pendingSignupResults: [SIGNUP_ROW] }),
      async markSignupNotified() {
        throw new Error("db down");
      },
    };
    const { mailer } = makeCapturingMailer();
    const summary = await runMonitorChecks({ rpc, mailer, fetchPage: async (url) => ({ ok: true, body: "<p>x</p>", contentType: "text/html", finalUrl: url, truncated: false, subrequests: 1 }), config: BASE_CONFIG, log: () => {} });
    expect(summary.rpcErrors).toBe(1);
    // notice was sent before the mark threw
    expect(summary.signupNotices).toBe(1);
  });
});

// ── pendingSignups throws → rpcErrors +1, no send ────────────────────────────

describe("runMonitorChecks — SNE-AC1k: pendingSignups throws → rpcErrors incremented, no mail sent", () => {
  it("SNE-AC1k-run15: pendingSignups throws → rpcErrors incremented, no mail sent", async () => {
    const rpc: EngineRpc = {
      ...makeFakeRpc(),
      async pendingSignups() {
        throw new Error("rpc down");
      },
    };
    const { mailer, mails } = makeCapturingMailer();
    const summary = await runMonitorChecks({ rpc, mailer, fetchPage: async (url) => ({ ok: true, body: "<p>x</p>", contentType: "text/html", finalUrl: url, truncated: false, subrequests: 1 }), config: BASE_CONFIG, log: () => {} });
    expect(summary.rpcErrors).toBe(1);
    expect(mails).toHaveLength(0);
    expect(summary.signupNotices).toBe(0);
  });
});

// ── purge throws → rpcErrors +1, signup sweep still runs ─────────────────────

describe("runMonitorChecks — SNE-AC3e: purge throws → rpcErrors +1, signupSweep still runs", () => {
  it("SNE-AC3e-run16: purge throws → rpcErrors incremented, pendingSignups still called", async () => {
    const signupCalls: number[] = [];
    const rpc: EngineRpc = {
      ...makeFakeRpc({ pendingSignupResults: [] }),
      async purgeUnconfirmed() {
        throw new Error("purge down");
      },
      async pendingSignups(limit, cap) {
        signupCalls.push(cap);
        return [];
      },
    };
    const { mailer } = makeCapturingMailer();
    const summary = await runMonitorChecks({ rpc, mailer, fetchPage: async (url) => ({ ok: true, body: "<p>x</p>", contentType: "text/html", finalUrl: url, truncated: false, subrequests: 1 }), config: BASE_CONFIG, log: () => {} });
    expect(summary.rpcErrors).toBe(1);
    expect(signupCalls).toHaveLength(1);
  });
});

// ── empty owner_emails → no send, no mark, deferred +1 ───────────────────────

describe("runMonitorChecks — SNE-AC1d: empty owner_emails → no send, no mark, deferred +1", () => {
  it("SNE-AC1d-run17: pendingSignups returns row with owner_emails:[] → signupNoticesDeferred:1, no mail, no mark", async () => {
    const noOwnerRow: PendingSignup = { ...SIGNUP_ROW, owner_emails: [] };
    const markedIds: string[] = [];
    const rpc: EngineRpc = {
      ...makeFakeRpc({ pendingSignupResults: [noOwnerRow] }),
      async markSignupNotified(userId) {
        markedIds.push(userId);
        return true;
      },
    };
    const { mailer, mails } = makeCapturingMailer();
    const summary = await runMonitorChecks({ rpc, mailer, fetchPage: async (url) => ({ ok: true, body: "<p>x</p>", contentType: "text/html", finalUrl: url, truncated: false, subrequests: 1 }), config: BASE_CONFIG, log: () => {} });
    expect(mails).toHaveLength(0);
    expect(markedIds).toHaveLength(0);
    expect(summary.signupNotices).toBe(0);
    expect(summary.signupNoticesDeferred).toBe(1);
  });
});

// ── log line: counters present, no sensitive data ─────────────────────────────

describe("runMonitorChecks — SNE-AC2e: log line has counters, no address/user_id/key", () => {
  it("SNE-AC2e-run18: log line JSON contains purged/signupNotices/signupNoticesDeferred", async () => {
    const rpc = makeFakeRpc({ pendingSignupResults: [SIGNUP_ROW], purgeCount: 1 });
    const { mailer } = makeCapturingMailer();
    const logLines: string[] = [];
    await runMonitorChecks({ rpc, mailer, fetchPage: async (url) => ({ ok: true, body: "<p>x</p>", contentType: "text/html", finalUrl: url, truncated: false, subrequests: 1 }), config: BASE_CONFIG, log: (line) => logLines.push(line), now: () => 0 });
    const logObj = JSON.parse(logLines[0]!) as Record<string, unknown>;
    expect(logObj).toHaveProperty("purged");
    expect(logObj).toHaveProperty("signupNotices");
    expect(logObj["signupNoticesDeferred"]).toBe(0);
    expect(logObj["purged"]).toBe(1);
    expect(logObj["signupNotices"]).toBe(1);
  });

  it("SNE-AC2e-run19: log line contains no user address, user_id, or idempotency key from the signup notice", async () => {
    const SECRET_EMAIL = "super-secret-owner@example-owner.com";
    const SECRET_USER_EMAIL = "secret-user@example-user.com";
    const SECRET_USER_ID = "00000000-dead-beef-cafe-000000000099";
    const rpc = makeFakeRpc({
      pendingSignupResults: [{
        user_id: SECRET_USER_ID,
        email: SECRET_USER_EMAIL,
        confirmed_at: CONFIRMED_AT,
        waiting: 0,
        owner_emails: [SECRET_EMAIL],
      }],
    });
    const { mailer } = makeCapturingMailer();
    const logLines: string[] = [];
    await runMonitorChecks({ rpc, mailer, fetchPage: async (url) => ({ ok: true, body: "<p>x</p>", contentType: "text/html", finalUrl: url, truncated: false, subrequests: 1 }), config: BASE_CONFIG, log: (line) => logLines.push(line) });
    const line = logLines[0]!;
    expect(line).not.toContain(SECRET_EMAIL);
    expect(line).not.toContain(SECRET_USER_EMAIL);
    expect(line).not.toContain(SECRET_USER_ID);
    expect(line).not.toContain("monitor-signup");
  });

  it("SNE-AC2e-run20: log line JSON matches the returned RunSummary exactly (including counters for purge and signup)", async () => {
    const rpc = makeFakeRpc({ pendingSignupResults: [SIGNUP_ROW], purgeCount: 1 });
    const { mailer } = makeCapturingMailer();
    const logLines: string[] = [];
    const summary: RunSummary = await runMonitorChecks({ rpc, mailer, fetchPage: async (url) => ({ ok: true, body: "<p>x</p>", contentType: "text/html", finalUrl: url, truncated: false, subrequests: 1 }), config: BASE_CONFIG, log: (line) => logLines.push(line), now: () => 0 });
    expect(JSON.parse(logLines[0]!)).toEqual({ msg: "monitor-cron run", ...summary });
    expect(summary.purged).toBe(1);
    expect(summary.signupNotices).toBe(1);
    expect(summary.signupNoticesDeferred).toBe(0);
  });
});
