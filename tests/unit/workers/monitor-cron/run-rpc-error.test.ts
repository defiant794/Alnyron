/**
 * Unit tests: workers/monitor-cron/run.ts — RunSummary.rpcError
 * Journey: monitor-cron-runtime-fix  CRF-AC5–CRF-AC11
 *
 * Covers:
 *   - rpcError null for a clean run (CRF-AC9)
 *   - first failure wins: pendingEmails fails first; claim also fails but does not overwrite (CRF-AC5)
 *   - all eight EngineOp names recorded correctly at their call sites (CRF-AC11)
 *     including snapshot and record (inside a check) and markEmailed, markSignupNotified,
 *     purgeUnconfirmed, pendingSignups
 *   - non-EngineRpcError throw → op name captured, code "unknown", status null (CRF-AC7)
 *   - fetchPage throw → rpcErrors incremented, rpcError stays null (CRF-AC8)
 *   - all-fail incident shape: rpcErrors 4, subrequests 4,
 *     rpcError { op: "pendingEmails", code: "unknown", status: 401 } (CRF-AC6)
 *   - key order: "rpcError" appears immediately after "rpcErrors" in the JSON log line, and the
 *     line is the returned summary plus `msg` (CRF-AC10)
 *   - the whole summary of an empty run, rpcError null included (CRF-AC9)
 *
 * Uses an in-memory fake EngineRpc, a mailer that always succeeds, and fake fetchPage functions.
 */
import { describe, expect, it } from "vitest";
import { EngineRpcError, type EngineRpc } from "../../../../workers/monitor-cron/rpc";
import { runMonitorChecks, type Mailer, type RunConfig } from "../../../../workers/monitor-cron/run";
import type { SendResult } from "@/lib/email/resend";

// ── Fake-RPC building blocks ──────────────────────────────────────────────────

type EngineRpcOverrides = Partial<EngineRpc>;

function baseRpc(overrides: EngineRpcOverrides = {}): EngineRpc {
  return {
    async claim() { return []; },
    async snapshot() { return null; },
    async record() {
      return { applied: true, event_id: null, notify_error: false, notified_at: null, email: null, url: null, label: null, consecutive_errors: 0 };
    },
    async pendingEmails() { return []; },
    async markEmailed() { return true; },
    async pendingSignups() { return []; },
    async markSignupNotified() { return true; },
    async purgeUnconfirmed() { return 0; },
    ...overrides,
  };
}

// ── Config, mailer, fetchPage helpers ────────────────────────────────────────

const BASE_CONFIG: RunConfig = {
  batchSize: 5,
  subrequestLimit: 200,
  siteUrl: "https://alnyron.dk",
  mailFrom: "Alnyron <noreply@send.alnyron.dk>",
};

function silentMailer(): Mailer {
  return async (): Promise<SendResult> => ({ ok: true, id: "ok" });
}

function noop(): void {}

async function stablePage() {
  return { ok: true as const, body: "<html><body>Stable</body></html>", contentType: "text/html", finalUrl: "https://example.com/p", truncated: false, subrequests: 1 };
}

// The claimed monitors' id, and a current-format stored hash that no fetched page here matches:
// a monitor claimed with CHANGED_HASH as its last_hash gets a changed check (snapshot + record).
const CHANGED_MONITOR_ID = "00000000-0000-0000-0000-00000000c001";
const CHANGED_HASH = "v1:" + "d".repeat(64);

// ── CRF-AC9: clean run → rpcError null ───────────────────────────────────────

describe("runMonitorChecks — CRF-AC9: clean run with no failed engine calls → rpcError null", () => {
  it("CRF-AC9run1: idle run (no monitors, no pending emails) → rpcError is null", async () => {
    const rpc = baseRpc();
    const summary = await runMonitorChecks({ rpc, mailer: silentMailer(), fetchPage: stablePage, config: BASE_CONFIG, log: noop });
    expect(summary).toHaveProperty("rpcError", null);
  });

  it("CRF-AC9run2: run with baseline check → rpcError is null", async () => {
    const rpc = baseRpc({
      async claim() {
        return [{ id: CHANGED_MONITOR_ID, user_id: "u1", url: "https://example.com/p", last_hash: null, consecutive_errors: 0, prior_strikes: 0 }];
      },
    });
    const summary = await runMonitorChecks({ rpc, mailer: silentMailer(), fetchPage: stablePage, config: BASE_CONFIG, log: noop });
    expect(summary).toHaveProperty("rpcError", null);
    expect(summary.rpcErrors).toBe(0);
  });
});

// ── CRF-AC5: first failure wins ───────────────────────────────────────────────

describe("runMonitorChecks — CRF-AC5: first failure wins, later failures do not overwrite rpcError", () => {
  it("CRF-AC5run1: pendingEmails fails first; claim also fails → op is pendingEmails", async () => {
    const rpc = baseRpc({
      async pendingEmails() { throw new EngineRpcError("unknown", 401); },
      async claim() { throw new EngineRpcError("unknown", 401); },
    });
    const summary = await runMonitorChecks({ rpc, mailer: silentMailer(), fetchPage: stablePage, config: BASE_CONFIG, log: noop });
    expect(summary.rpcErrors).toBe(2);
    expect(summary).toHaveProperty("rpcError", { op: "pendingEmails", code: "unknown", status: 401 });
  });

  it("CRF-AC5run2: second failure (purgeUnconfirmed) after pendingEmails → rpcError stays pendingEmails", async () => {
    const rpc = baseRpc({
      async pendingEmails() { throw new EngineRpcError("unknown", 401); },
      async purgeUnconfirmed() { throw new EngineRpcError("22023", 400); },
    });
    const summary = await runMonitorChecks({ rpc, mailer: silentMailer(), fetchPage: stablePage, config: BASE_CONFIG, log: noop });
    expect(summary.rpcErrors).toBe(2);
    expect(summary).toHaveProperty("rpcError", { op: "pendingEmails", code: "unknown", status: 401 });
  });
});

// ── CRF-AC11: all eight op names ─────────────────────────────────────────────

describe("runMonitorChecks — CRF-AC11: each EngineOp name is captured when that call is first to fail", () => {
  it("CRF-AC11run1: pendingEmails fails → op is 'pendingEmails'", async () => {
    const rpc = baseRpc({ async pendingEmails() { throw new EngineRpcError("unknown", 401); } });
    const summary = await runMonitorChecks({ rpc, mailer: silentMailer(), fetchPage: stablePage, config: BASE_CONFIG, log: noop });
    expect(summary).toHaveProperty("rpcError", { op: "pendingEmails", code: "unknown", status: 401 });
  });

  it("CRF-AC11run2: markEmailed fails (pendingEmails returns a row; send + markEmailed) → op is 'markEmailed'", async () => {
    const rpc = baseRpc({
      async pendingEmails() {
        return [{
          event_id: "evt-01",
          monitor_id: CHANGED_MONITOR_ID,
          user_id: "u1",
          email: "u@example.com",
          url: "https://example.com/p",
          label: null,
          detected_at: "2026-11-10T10:00:00.000Z",
          summary: null,
        }];
      },
      async markEmailed() { throw new EngineRpcError("unknown", 401); },
    });
    const summary = await runMonitorChecks({ rpc, mailer: silentMailer(), fetchPage: stablePage, config: BASE_CONFIG, log: noop });
    expect(summary).toHaveProperty("rpcError", { op: "markEmailed", code: "unknown", status: 401 });
  });

  it("CRF-AC11run3: claim fails (pendingEmails clean) → op is 'claim'", async () => {
    const rpc = baseRpc({ async claim() { throw new EngineRpcError("unknown", 401); } });
    const summary = await runMonitorChecks({ rpc, mailer: silentMailer(), fetchPage: stablePage, config: BASE_CONFIG, log: noop });
    expect(summary).toHaveProperty("rpcError", { op: "claim", code: "unknown", status: 401 });
  });

  it("CRF-AC11run4: snapshot fails during a changed check → op is 'snapshot'", async () => {
    const rpc = baseRpc({
      async claim() {
        return [{ id: CHANGED_MONITOR_ID, user_id: "u1", url: "https://example.com/p", last_hash: CHANGED_HASH, consecutive_errors: 0, prior_strikes: 0 }];
      },
      async snapshot() { throw new EngineRpcError("unknown", 401); },
    });
    // fetchPage returns a page whose hash differs from CHANGED_HASH → triggers snapshot call
    const differentPage = async () => ({ ok: true as const, body: "<html><body>Different</body></html>", contentType: "text/html", finalUrl: "https://example.com/p", truncated: false, subrequests: 1 });
    const summary = await runMonitorChecks({ rpc, mailer: silentMailer(), fetchPage: differentPage, config: BASE_CONFIG, log: noop });
    expect(summary).toHaveProperty("rpcError", { op: "snapshot", code: "unknown", status: 401 });
  });

  it("CRF-AC11run5: record fails during a check → op is 'record'", async () => {
    const rpc = baseRpc({
      async claim() {
        return [{ id: CHANGED_MONITOR_ID, user_id: "u1", url: "https://example.com/p", last_hash: null, consecutive_errors: 0, prior_strikes: 0 }];
      },
      async record() { throw new EngineRpcError("unknown", 401); },
    });
    const summary = await runMonitorChecks({ rpc, mailer: silentMailer(), fetchPage: stablePage, config: BASE_CONFIG, log: noop });
    expect(summary).toHaveProperty("rpcError", { op: "record", code: "unknown", status: 401 });
  });

  it("CRF-AC11run6: purgeUnconfirmed fails → op is 'purgeUnconfirmed'", async () => {
    const rpc = baseRpc({ async purgeUnconfirmed() { throw new EngineRpcError("unknown", 401); } });
    const summary = await runMonitorChecks({ rpc, mailer: silentMailer(), fetchPage: stablePage, config: BASE_CONFIG, log: noop });
    expect(summary).toHaveProperty("rpcError", { op: "purgeUnconfirmed", code: "unknown", status: 401 });
  });

  it("CRF-AC11run7: pendingSignups fails → op is 'pendingSignups'", async () => {
    const rpc = baseRpc({ async pendingSignups() { throw new EngineRpcError("unknown", 401); } });
    const summary = await runMonitorChecks({ rpc, mailer: silentMailer(), fetchPage: stablePage, config: BASE_CONFIG, log: noop });
    expect(summary).toHaveProperty("rpcError", { op: "pendingSignups", code: "unknown", status: 401 });
  });

  it("CRF-AC11run8: markSignupNotified fails → op is 'markSignupNotified'", async () => {
    const rpc = baseRpc({
      async pendingSignups() {
        return [{
          user_id: "00000000-0000-0000-0000-000000005e01",
          email: "new@example.com",
          confirmed_at: "2026-11-10T09:00:00.000Z",
          waiting: 0,
          owner_emails: ["owner@example.com"],
        }];
      },
      async markSignupNotified() { throw new EngineRpcError("unknown", 401); },
    });
    const summary = await runMonitorChecks({ rpc, mailer: silentMailer(), fetchPage: stablePage, config: BASE_CONFIG, log: noop });
    expect(summary).toHaveProperty("rpcError", { op: "markSignupNotified", code: "unknown", status: 401 });
  });
});

// ── CRF-AC7: non-EngineRpcError throw records op + code "unknown" + status null ──

describe("runMonitorChecks — CRF-AC7: non-EngineRpcError from an engine call → code unknown, status null", () => {
  it("CRF-AC7run1: claim throws a plain Error → rpcError { op: 'claim', code: 'unknown', status: null }", async () => {
    const rpc = baseRpc({
      async claim() { throw new Error("unexpected network down"); },
    });
    const summary = await runMonitorChecks({ rpc, mailer: silentMailer(), fetchPage: stablePage, config: BASE_CONFIG, log: noop });
    expect(summary.rpcErrors).toBe(1);
    expect(summary).toHaveProperty("rpcError", { op: "claim", code: "unknown", status: null });
  });

  it("CRF-AC7run2: pendingEmails throws a plain Error → rpcError { op: 'pendingEmails', code: 'unknown', status: null }", async () => {
    const rpc = baseRpc({
      async pendingEmails() { throw new Error("network"); },
    });
    const summary = await runMonitorChecks({ rpc, mailer: silentMailer(), fetchPage: stablePage, config: BASE_CONFIG, log: noop });
    expect(summary).toHaveProperty("rpcError", { op: "pendingEmails", code: "unknown", status: null });
  });
});

// ── CRF-AC8: fetchPage throw → rpcErrors++, rpcError stays null ──────────────

describe("runMonitorChecks — CRF-AC8: fetchPage throw is not an engine call → rpcError stays null", () => {
  it("CRF-AC8run1: fetchPage throws → rpcErrors incremented, rpcError is null", async () => {
    const rpc = baseRpc({
      async claim() {
        return [{ id: CHANGED_MONITOR_ID, user_id: "u1", url: "https://example.com/p", last_hash: null, consecutive_errors: 0, prior_strikes: 0 }];
      },
    });
    const failingPage = async () => { throw new Error("page network down"); };
    const summary = await runMonitorChecks({ rpc, mailer: silentMailer(), fetchPage: failingPage, config: BASE_CONFIG, log: noop });
    expect(summary.rpcErrors).toBe(1);
    expect(summary).toHaveProperty("rpcError", null);
  });
});

// ── CRF-AC6: all-fail incident shape ─────────────────────────────────────────

describe("runMonitorChecks — CRF-AC6: all-fail incident (every call 401) reproduces production incident shape", () => {
  it("CRF-AC6run1: pendingEmails + claim + purgeUnconfirmed + pendingSignups all 401 → rpcErrors 4, subrequests 4, rpcError pendingEmails 401", async () => {
    const rpc = baseRpc({
      async pendingEmails() { throw new EngineRpcError("unknown", 401); },
      async claim() { throw new EngineRpcError("unknown", 401); },
      async purgeUnconfirmed() { throw new EngineRpcError("unknown", 401); },
      async pendingSignups() { throw new EngineRpcError("unknown", 401); },
    });
    const logLines: string[] = [];
    const summary = await runMonitorChecks({
      rpc,
      mailer: silentMailer(),
      fetchPage: stablePage,
      config: { ...BASE_CONFIG, subrequestLimit: 50 },
      log: (line) => logLines.push(line),
    });

    expect(summary.rpcErrors).toBe(4);
    expect(summary.subrequests).toBe(4);
    expect(summary.claimed).toBe(0);
    expect(summary).toHaveProperty("rpcError", { op: "pendingEmails", code: "unknown", status: 401 });

    // Exactly one run line; `runMonitorChecks` resolved (no throw → outcome 'ok').
    expect(logLines).toHaveLength(1);
  });
});

// ── CRF-AC10: key order in JSON log line ─────────────────────────────────────

describe("runMonitorChecks — CRF-AC10: 'rpcError' key appears immediately after 'rpcErrors' in the log JSON", () => {
  it("CRF-AC10run1: JSON.stringify key order has rpcError right after rpcErrors", async () => {
    const rpc = baseRpc();
    const logLines: string[] = [];
    await runMonitorChecks({ rpc, mailer: silentMailer(), fetchPage: stablePage, config: BASE_CONFIG, log: (l) => logLines.push(l) });
    const parsed = JSON.parse(logLines[0]!);
    const keys = Object.keys(parsed);
    const rpcErrorsIdx = keys.indexOf("rpcErrors");
    const rpcErrorIdx = keys.indexOf("rpcError");
    expect(rpcErrorsIdx).toBeGreaterThanOrEqual(0);
    expect(rpcErrorIdx).toBe(rpcErrorsIdx + 1);
  });

  it("CRF-AC10run2: the log line is exactly the returned RunSummary plus msg, rpcError included", async () => {
    const rpc = baseRpc({ async pendingEmails() { throw new EngineRpcError("unknown", 401); } });
    const logLines: string[] = [];
    const summary = await runMonitorChecks({ rpc, mailer: silentMailer(), fetchPage: stablePage, config: BASE_CONFIG, log: (l) => logLines.push(l) });
    expect(summary.rpcError).toEqual({ op: "pendingEmails", code: "unknown", status: 401 });
    expect(JSON.parse(logLines[0]!)).toEqual({ msg: "monitor-cron run", ...summary });
  });
});

// ── Full summary shape ────────────────────────────────────────────────────────

describe("runMonitorChecks — CRF-AC9: full summary shape includes rpcError: null on a clean run", () => {
  it("CRF-AC9run3: an empty run's whole summary, rpcError null included", async () => {
    const rpc = baseRpc();
    const summary = await runMonitorChecks({
      rpc, mailer: silentMailer(), fetchPage: stablePage,
      config: BASE_CONFIG, log: noop, now: () => 0,
    });
    expect(summary).toEqual({
      claimed: 0, strikerClaimed: 0, checked: 0, unchanged: 0, baselines: 0, changed: 0, errors: 0, staleSkips: 0,
      emailsSent: 0, emailsDeferred: 0, emailsRejected: 0, errorEmails: 0,
      signupNotices: 0, signupNoticesDeferred: 0, purged: 0,
      mailStop: null, budgetStop: false, batchFull: false,
      subrequests: 4, // pendingEmails + claim (the budget allows a claim) + purge + pendingSignups
      rpcErrors: 0,
      rpcError: null,
      durationMs: 0,
    });
  });
});
