/**
 * Unit tests: workers/monitor-cron/run.ts — runMonitorChecks
 * Journey: monitor-engine  ENG-AC1–ENG-AC4, ENG-AC6, ENG-AC7
 *
 * Uses in-memory fake EngineRpc + capturing mailer + fake fetchPage.
 * Covers: baseline (no email), unchanged (no email), change → one email with
 *   key "monitor-event/<event_id>", transient failure → same key on retry,
 *   quota stop → mailStop:'quota' + deferred, rejected → markEmailed + no retry,
 *   stale applied:false → staleSkips, legacy hash → baseline,
 *   error with notify_error → error email key, the claim cut to the monitors
 *   the subrequest budget can check (budgetStop), batchFull, exactly one log
 *   line containing no sensitive data, the RPC arguments (batch size + config
 *   constants), durationMs from an injected now().
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PageFetchFailure, PageFetchResult } from "@/lib/monitor/page-fetch";
import { hashPageText } from "@/lib/monitor/page-text";
import {
  MONITOR_DAILY_EMAIL_CAP,
  MONITOR_DUE_GRACE_MINUTES,
  MONITOR_ERROR_THRESHOLD,
} from "@/config/monitor";
import type { EngineRpc } from "../../../../workers/monitor-cron/rpc";
import {
  runMonitorChecks,
  type Mailer,
  type RunConfig,
  type RunSummary,
} from "../../../../workers/monitor-cron/run";
import type { SendResult } from "@/lib/email/resend";
import { buildChangeEmail } from "@/lib/monitor/change-email";

// ── Fake-RPC types (mirror contract §4 EngineRpc return shapes) ──────────────

type ClaimRow = {
  id: string;
  user_id: string;
  url: string;
  last_hash: string | null;
  consecutive_errors: number;
  prior_strikes: number;
};
type RecordRow = {
  applied: boolean;
  event_id: string | null;
  notify_error: boolean;
  notified_at: string | null;
  email: string | null;
  url: string | null;
  label: string | null;
  consecutive_errors: number;
};
type PendingRow = {
  event_id: string;
  monitor_id: string;
  user_id: string;
  email: string;
  url: string;
  label: string | null;
  detected_at: string;
  summary: string | null;
};

// ── Fake-RPC factory ──────────────────────────────────────────────────────────

interface FakeRpcOptions {
  claimRows?: ClaimRow[];
  snapshotResult?: string | null;
  recordResult?: RecordRow;
  /** First call returns [0], second call returns [1], etc. */
  pendingResults?: PendingRow[][];
  markEmailedResult?: boolean;
}

function makeFakeRpc(opts: FakeRpcOptions = {}): EngineRpc {
  let pendingCallIndex = 0;
  return {
    // Like the SQL function, the claim returns at most `limit` rows.
    async claim(limit) {
      return (opts.claimRows ?? []).slice(0, limit);
    },
    async snapshot() {
      return opts.snapshotResult ?? null;
    },
    async record() {
      return (
        opts.recordResult ?? {
          applied: true,
          event_id: null,
          notify_error: false,
          notified_at: null,
          email: null,
          url: null,
          label: null,
          consecutive_errors: 0,
        }
      );
    },
    async pendingEmails() {
      const results = opts.pendingResults ?? [];
      const idx = pendingCallIndex++;
      return results[idx] ?? [];
    },
    async markEmailed() {
      return opts.markEmailedResult ?? true;
    },
  };
}

// ── Capturing-mailer factory ──────────────────────────────────────────────────

interface CapturedMail {
  to: string;
  idempotencyKey: string;
  subject: string;
}

function makeCapturingMailer(result: SendResult = { ok: true, id: "mail-ok" }): {
  mailer: Mailer;
  mails: CapturedMail[];
} {
  const mails: CapturedMail[] = [];
  const mailer: Mailer = async (message, idempotencyKey) => {
    mails.push({ to: message.to, idempotencyKey, subject: message.subject });
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

const MONITOR_ID = "00000000-0000-0000-0000-000000000011";
const USER_ID = "00000000-0000-0000-0000-000000000022";
const MONITOR_URL = "https://example.com/watched";

/** A fake fetchPage that returns a successful HTML page. */
function makeFakeFetchPage(
  body = "<html><body><p>Page content</p></body></html>",
  contentType = "text/html",
  subrequests = 1,
): (url: string) => Promise<PageFetchResult> {
  return async () => ({ ok: true, body, contentType, finalUrl: MONITOR_URL, truncated: false, subrequests });
}

/** A fake fetchPage that always fails. */
function makeFailingFetchPage(
  reason: PageFetchFailure = "http_status",
  subrequests = 1,
): (url: string) => Promise<PageFetchResult> {
  return async () => ({ ok: false, reason, subrequests });
}

// ── Baseline — first check, no email ─────────────────────────────────────────

describe("runMonitorChecks — ENG-AC2: baseline (last_hash null) → no email, baselines++", () => {
  it("ENG-AC2run1: monitor with last_hash null → baselines:1, emailsSent:0", async () => {
    const rpc = makeFakeRpc({
      claimRows: [{ id: MONITOR_ID, user_id: USER_ID, url: MONITOR_URL, last_hash: null, consecutive_errors: 0, prior_strikes: 0 }],
      recordResult: { applied: true, event_id: null, notify_error: false, notified_at: null, email: null, url: null, label: null, consecutive_errors: 0 },
      pendingResults: [[], []],
    });
    const { mailer, mails } = makeCapturingMailer();
    const summary = await runMonitorChecks({
      rpc, mailer,
      fetchPage: makeFakeFetchPage(),
      config: BASE_CONFIG,
      log: () => {},
    });
    expect(summary.baselines).toBe(1);
    expect(summary.emailsSent).toBe(0);
    expect(mails).toHaveLength(0);
  });
});

// ── Unchanged — same hash, no email ──────────────────────────────────────────

describe("runMonitorChecks — ENG-AC2: unchanged (same hash) → no email, unchanged++", () => {
  it("ENG-AC2run2: monitor whose page hash matches last_hash → unchanged:1, emailsSent:0", async () => {
    const pageBody = "<html><body><p>Static content</p></body></html>";
    const pageHash = await hashPageText("Static content");
    const rpc = makeFakeRpc({
      claimRows: [{ id: MONITOR_ID, user_id: USER_ID, url: MONITOR_URL, last_hash: pageHash, consecutive_errors: 0, prior_strikes: 0 }],
      recordResult: { applied: true, event_id: null, notify_error: false, notified_at: null, email: null, url: null, label: null, consecutive_errors: 0 },
      pendingResults: [[], []],
    });
    const { mailer, mails } = makeCapturingMailer();
    const summary = await runMonitorChecks({
      rpc, mailer,
      fetchPage: makeFakeFetchPage(pageBody),
      config: BASE_CONFIG,
      log: () => {},
    });
    expect(summary.unchanged).toBe(1);
    expect(summary.emailsSent).toBe(0);
    expect(mails).toHaveLength(0);
  });
});

// ── Change → one email, markEmailed called ────────────────────────────────────

describe("runMonitorChecks — ENG-AC1: change → exactly one email built from pending row", () => {
  it("ENG-AC1run1: change produces email with key 'monitor-event/<event_id>', markEmailed called once", async () => {
    const eventId = randomUUID();
    const differentHash = "v1:" + "b".repeat(64);
    // pendingRow uses a distinct url/label to prove the email is built from the stored row,
    // not from real-time page data.
    const PENDING_URL = "https://pending.example.com/stored-url";
    const PENDING_LABEL = "Pending Row Label";
    const pendingRow: PendingRow = {
      event_id: eventId,
      monitor_id: MONITOR_ID,
      user_id: USER_ID,
      email: "user@example.com",
      url: PENDING_URL,
      label: PENDING_LABEL,
      detected_at: new Date().toISOString(),
      summary: "+ New paragraph",
    };
    let markEmailedCalledWith: string | undefined;
    // pendingResults: first call (before checks) → empty; second call (after event) → [pendingRow]
    const rpc: EngineRpc = {
      ...makeFakeRpc({
        claimRows: [{ id: MONITOR_ID, user_id: USER_ID, url: MONITOR_URL, last_hash: differentHash, consecutive_errors: 0, prior_strikes: 0 }],
        pendingResults: [[], [pendingRow]],
        recordResult: { applied: true, event_id: eventId, notify_error: false, notified_at: null, email: null, url: null, label: null, consecutive_errors: 0 },
      }),
      async markEmailed(id: string) {
        markEmailedCalledWith = id;
        return true;
      },
    };

    const { mailer, mails } = makeCapturingMailer();
    const summary = await runMonitorChecks({
      rpc, mailer,
      fetchPage: makeFakeFetchPage(),
      config: BASE_CONFIG,
      log: () => {},
    });
    expect(summary.emailsSent).toBe(1);
    // Built from the pending row (its url, label and summary), not from the page this run fetched.
    const expected = buildChangeEmail({
      eventId,
      monitorId: MONITOR_ID,
      url: PENDING_URL,
      label: PENDING_LABEL,
      detectedAt: pendingRow.detected_at,
      summary: pendingRow.summary,
      siteUrl: BASE_CONFIG.siteUrl,
    });
    expect(mails).toEqual([
      { to: "user@example.com", idempotencyKey: `monitor-event/${eventId}`, subject: expected.subject },
    ]);
    expect(markEmailedCalledWith).toBe(eventId);
  });
});

// ── Transient failure → pending row kept, same key on retry ──────────────────

describe("runMonitorChecks — ENG-AC1: transient mailer failure → event stays pending, same key on next run", () => {
  it("ENG-AC1run2: transient → event not marked emailed; re-presented with same idempotency key", async () => {
    const eventId = randomUUID();
    const pendingRow: PendingRow = {
      event_id: eventId,
      monitor_id: MONITOR_ID,
      user_id: USER_ID,
      email: "user@example.com",
      url: MONITOR_URL,
      label: "My Site",
      detected_at: new Date().toISOString(),
      summary: null,
    };
    const markEmailedCalls: string[] = [];
    const rpc = makeFakeRpc({
      claimRows: [],
      pendingResults: [[pendingRow], [pendingRow]], // both runs present the same event
      markEmailedResult: true,
    });
    // Override markEmailed to capture calls
    const rpcTracked: EngineRpc = {
      ...rpc,
      async markEmailed(id) { markEmailedCalls.push(id); return true; },
    };

    const { mailer: transientMailer, mails: mails1 } = makeCapturingMailer({
      ok: false, kind: "transient", status: 503,
    });
    const summary1 = await runMonitorChecks({
      rpc: rpcTracked, mailer: transientMailer,
      fetchPage: makeFakeFetchPage(),
      config: BASE_CONFIG,
      log: () => {},
    });
    // Transient: event NOT marked emailed
    expect(markEmailedCalls).toHaveLength(0);
    expect(summary1.mailStop).toBe("transient");

    // Run 2: same event reappears → same idempotency key
    let pendingCalls = 0;
    const rpc2: EngineRpc = {
      ...makeFakeRpc({ claimRows: [] }),
      async pendingEmails() { return pendingCalls++ === 0 ? [pendingRow] : []; },
    };
    const { mailer: okMailer, mails: mails2 } = makeCapturingMailer();
    await runMonitorChecks({
      rpc: rpc2, mailer: okMailer,
      fetchPage: makeFakeFetchPage(),
      config: BASE_CONFIG,
      log: () => {},
    });
    expect(mails1).toHaveLength(1);
    expect(mails2).toHaveLength(1);
    expect(mails1[0]!.idempotencyKey).toBe(`monitor-event/${eventId}`);
    expect(mails2[0]!.idempotencyKey).toBe(`monitor-event/${eventId}`);
  });
});

// ── Quota stop → mailStop:'quota', remaining events deferred ─────────────────

describe("runMonitorChecks — ENG-AC4: quota stop → mailStop:'quota', pending rows deferred", () => {
  it("ENG-AC4run1: mailer returns quota on first email → mailStop:'quota', emailsDeferred for the rest", async () => {
    const rows: PendingRow[] = [
      { event_id: "evt-a", monitor_id: MONITOR_ID, user_id: USER_ID, email: "u@example.com", url: MONITOR_URL, label: null, detected_at: new Date().toISOString(), summary: null },
      { event_id: "evt-b", monitor_id: MONITOR_ID, user_id: USER_ID, email: "u@example.com", url: MONITOR_URL, label: null, detected_at: new Date().toISOString(), summary: null },
      { event_id: "evt-c", monitor_id: MONITOR_ID, user_id: USER_ID, email: "u@example.com", url: MONITOR_URL, label: null, detected_at: new Date().toISOString(), summary: null },
    ];
    const rpc = makeFakeRpc({ claimRows: [], pendingResults: [rows] });
    const { mailer } = makeCapturingMailer({ ok: false, kind: "quota", status: 429 });
    const summary = await runMonitorChecks({
      rpc, mailer,
      fetchPage: makeFakeFetchPage(),
      config: BASE_CONFIG,
      log: () => {},
    });
    expect(summary.mailStop).toBe("quota");
    // First email tried (and failed): it and the two after it stay pending for the next run.
    expect(summary.emailsDeferred).toBe(3);
  });
});

// ── Rejected → markEmailed + emailsRejected++ ────────────────────────────────

describe("runMonitorChecks — ENG-AC1: rejected → markEmailed called, no retry", () => {
  it("ENG-AC1run3: mailer returns rejected → markEmailed called, emailsRejected:1", async () => {
    const eventId = "evt-rejected";
    const pendingRow: PendingRow = {
      event_id: eventId, monitor_id: MONITOR_ID, user_id: USER_ID, email: "u@example.com",
      url: MONITOR_URL, label: null, detected_at: new Date().toISOString(), summary: null,
    };
    const markEmailedCalls: string[] = [];
    let pendingCalls = 0;
    const rpc: EngineRpc = {
      ...makeFakeRpc({ claimRows: [] }),
      async pendingEmails() { return pendingCalls++ === 0 ? [pendingRow] : []; },
      async markEmailed(id) { markEmailedCalls.push(id); return true; },
    };
    const { mailer } = makeCapturingMailer({ ok: false, kind: "rejected", status: 422 });
    const summary = await runMonitorChecks({
      rpc, mailer,
      fetchPage: makeFakeFetchPage(),
      config: BASE_CONFIG,
      log: () => {},
    });
    expect(summary.emailsRejected).toBe(1);
    expect(markEmailedCalls).toEqual([eventId]);
  });
});

// ── Stale (applied:false) → staleSkips++ ─────────────────────────────────────

describe("runMonitorChecks — ENG-AC1: stale record (applied:false) → staleSkips++, no email", () => {
  it("ENG-AC1run4: record returns applied:false → staleSkips:1, emailsSent:0", async () => {
    const rpc = makeFakeRpc({
      claimRows: [{ id: MONITOR_ID, user_id: USER_ID, url: MONITOR_URL, last_hash: "v1:" + "a".repeat(64), consecutive_errors: 0, prior_strikes: 0 }],
      recordResult: { applied: false, event_id: null, notify_error: false, notified_at: null, email: null, url: null, label: null, consecutive_errors: 0 },
      pendingResults: [[], []],
    });
    const { mailer, mails } = makeCapturingMailer();
    const summary = await runMonitorChecks({
      rpc, mailer,
      fetchPage: makeFakeFetchPage("<html><body><p>Different content xyz</p></body></html>"),
      config: BASE_CONFIG,
      log: () => {},
    });
    expect(summary.staleSkips).toBe(1);
    expect(mails).toHaveLength(0);
  });
});

// ── Legacy hash → baseline ────────────────────────────────────────────────────

describe("runMonitorChecks — ENG-AC2: legacy hash (no v1: prefix) → baseline, no email", () => {
  it("ENG-AC2run3: last_hash without 'v1:' prefix → baselines:1, emailsSent:0", async () => {
    const rpc = makeFakeRpc({
      claimRows: [{ id: MONITOR_ID, user_id: USER_ID, url: MONITOR_URL, last_hash: "a".repeat(64), consecutive_errors: 0, prior_strikes: 0 }],
      recordResult: { applied: true, event_id: null, notify_error: false, notified_at: null, email: null, url: null, label: null, consecutive_errors: 0 },
      pendingResults: [[], []],
    });
    const { mailer, mails } = makeCapturingMailer();
    const summary = await runMonitorChecks({
      rpc, mailer,
      fetchPage: makeFakeFetchPage(),
      config: BASE_CONFIG,
      log: () => {},
    });
    expect(summary.baselines).toBe(1);
    expect(mails).toHaveLength(0);
  });
});

// ── Error with notify_error → error email ────────────────────────────────────

describe("runMonitorChecks — ENG-AC3: fetch failure + notify_error → one error email with correct key", () => {
  it("ENG-AC3run1: record(error) returns notify_error:true → error email key 'monitor-error/<id>/<notified_at>'", async () => {
    const notifiedAt = "2026-11-08T10:00:00.000Z";
    const rpc = makeFakeRpc({
      claimRows: [{ id: MONITOR_ID, user_id: USER_ID, url: MONITOR_URL, last_hash: null, consecutive_errors: 2, prior_strikes: 0 }],
      recordResult: {
        applied: true, event_id: null, notify_error: true,
        notified_at: notifiedAt, email: "user@example.com",
        url: MONITOR_URL, label: "My Site", consecutive_errors: 3,
      },
      pendingResults: [[], []],
    });
    const { mailer, mails } = makeCapturingMailer();
    const summary = await runMonitorChecks({
      rpc, mailer,
      fetchPage: makeFailingFetchPage("http_status"),
      config: BASE_CONFIG,
      log: () => {},
    });
    expect(summary.errorEmails).toBe(1);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.idempotencyKey).toBe(`monitor-error/${MONITOR_ID}/${notifiedAt}`);
  });

  it("ENG-AC3run2: record(error) returns notify_error:false → no error email", async () => {
    const rpc = makeFakeRpc({
      claimRows: [{ id: MONITOR_ID, user_id: USER_ID, url: MONITOR_URL, last_hash: null, consecutive_errors: 3, prior_strikes: 0 }],
      recordResult: { applied: true, event_id: null, notify_error: false, notified_at: null, email: null, url: null, label: null, consecutive_errors: 4 },
      pendingResults: [[], []],
    });
    const { mailer, mails } = makeCapturingMailer();
    const summary = await runMonitorChecks({
      rpc, mailer,
      fetchPage: makeFailingFetchPage("http_status"),
      config: BASE_CONFIG,
      log: () => {},
    });
    expect(summary.errorEmails).toBe(0);
    expect(mails).toHaveLength(0);
  });
});

// ── Claim sized to the subrequest budget ─────────────────────────────────────

describe("runMonitorChecks — ENG-AC7: the claim asks only for what the budget can check → budgetStop:true", () => {
  it("ENG-AC7run1: subrequestLimit=20 with 5 due monitors → claim(1), that monitor checked, budgetStop:true", async () => {
    // Budget: 20
    // pendingEmails RPC: -1 → 19 left before the claim
    // Claim limit: min(batchSize 5, floor((19 - 1) / 15)) = 1 → claim RPC: -1 → 18
    // Check: fetchPage(subrequests=1) → -1 → 17; record RPC → -1 → 16
    // The budget cut the claim below the batch size and it came back full → budgetStop
    const fiveMonitors: ClaimRow[] = Array.from({ length: 5 }, (_, i) => ({
      id: `mon-${i}`,
      user_id: USER_ID,
      url: MONITOR_URL,
      last_hash: null,
      consecutive_errors: 0,
      prior_strikes: 0,
    }));
    const fake = makeFakeRpc({
      claimRows: fiveMonitors,
      recordResult: { applied: true, event_id: null, notify_error: false, notified_at: null, email: null, url: null, label: null, consecutive_errors: 0 },
      pendingResults: [[], []],
    });
    const claimLimits: number[] = [];
    const rpc: EngineRpc = {
      ...fake,
      async claim(limit, graceMinutes, errorThreshold) {
        claimLimits.push(limit);
        return fake.claim(limit, graceMinutes, errorThreshold);
      },
    };
    const { mailer } = makeCapturingMailer();
    const summary = await runMonitorChecks({
      rpc, mailer,
      fetchPage: makeFakeFetchPage(undefined, undefined, 1),
      config: { ...BASE_CONFIG, subrequestLimit: 20, batchSize: 5 },
      log: () => {},
      now: () => 0,
    });
    expect(claimLimits).toEqual([1]);
    expect(summary).toEqual({
      claimed: 1, strikerClaimed: 0, checked: 1, unchanged: 0, baselines: 1, changed: 0, errors: 0, staleSkips: 0,
      emailsSent: 0, emailsDeferred: 0, emailsRejected: 0, errorEmails: 0,
      mailStop: null, budgetStop: true, batchFull: false,
      subrequests: 4, // pendingEmails + claim + page 1 + record
      rpcErrors: 0, durationMs: 0,
    });
  });
});

// ── batchFull ─────────────────────────────────────────────────────────────────

describe("runMonitorChecks — ENG-AC7: batchFull when claimed === batchSize", () => {
  it("ENG-AC7run2: 2 claimed with batchSize:2 → batchFull:true", async () => {
    const rpc = makeFakeRpc({
      claimRows: [
        { id: "mon-a", user_id: USER_ID, url: MONITOR_URL, last_hash: null, consecutive_errors: 0, prior_strikes: 0 },
        { id: "mon-b", user_id: USER_ID, url: MONITOR_URL, last_hash: null, consecutive_errors: 0, prior_strikes: 0 },
      ],
      recordResult: { applied: true, event_id: null, notify_error: false, notified_at: null, email: null, url: null, label: null, consecutive_errors: 0 },
      pendingResults: [[], []],
    });
    const { mailer } = makeCapturingMailer();
    const summary = await runMonitorChecks({
      rpc, mailer,
      fetchPage: makeFakeFetchPage(),
      config: { ...BASE_CONFIG, batchSize: 2 },
      log: () => {},
    });
    expect(summary.batchFull).toBe(true);
    expect(summary.claimed).toBe(2);
  });

  it("ENG-AC7run3: 1 claimed with batchSize:2 → batchFull:false", async () => {
    const rpc = makeFakeRpc({
      claimRows: [{ id: "mon-a", user_id: USER_ID, url: MONITOR_URL, last_hash: null, consecutive_errors: 0, prior_strikes: 0 }],
      recordResult: { applied: true, event_id: null, notify_error: false, notified_at: null, email: null, url: null, label: null, consecutive_errors: 0 },
      pendingResults: [[], []],
    });
    const { mailer } = makeCapturingMailer();
    const summary = await runMonitorChecks({
      rpc, mailer,
      fetchPage: makeFakeFetchPage(),
      config: { ...BASE_CONFIG, batchSize: 2 },
      log: () => {},
    });
    expect(summary.batchFull).toBe(false);
  });
});

// ── Exactly one log line, no sensitive data ───────────────────────────────────

describe("runMonitorChecks — ENG-AC6: exactly one log line per run, no sensitive data", () => {
  it("ENG-AC6run1: log callback called exactly once", async () => {
    const rpc = makeFakeRpc({ claimRows: [], pendingResults: [[]] });
    const { mailer } = makeCapturingMailer();
    const logLines: string[] = [];
    await runMonitorChecks({
      rpc, mailer,
      fetchPage: makeFakeFetchPage(),
      config: BASE_CONFIG,
      log: (line) => logLines.push(line),
    });
    expect(logLines).toHaveLength(1);
  });

  it("ENG-AC6run2: log line is exactly the JSON of msg:'monitor-cron run' and the run's counters", async () => {
    const rpc = makeFakeRpc({ claimRows: [], pendingResults: [[]] });
    const { mailer } = makeCapturingMailer();
    const logLines: string[] = [];
    await runMonitorChecks({
      rpc, mailer,
      fetchPage: makeFakeFetchPage(),
      config: BASE_CONFIG,
      log: (line) => logLines.push(line),
      now: () => 1_000,
    });
    expect(JSON.parse(logLines[0]!)).toEqual({
      msg: "monitor-cron run",
      claimed: 0, strikerClaimed: 0, checked: 0, unchanged: 0, baselines: 0, changed: 0, errors: 0, staleSkips: 0,
      emailsSent: 0, emailsDeferred: 0, emailsRejected: 0, errorEmails: 0,
      mailStop: null, budgetStop: false, batchFull: false,
      subrequests: 2, // pendingEmails + claim
      rpcErrors: 0, durationMs: 0,
    });
  });

  it("ENG-AC6run3: log line contains no user email, monitor URL, or page body from the run", async () => {
    // These values flow through the run (pending email row + fetchPage body) but must
    // never appear in the JSON log line, which contains only RunSummary counters.
    const SECRET_EMAIL = "supersecret@example.com";
    const SECRET_URL   = "https://secret-monitor.example.com/page";
    const SECRET_BODY  = "Secret page content xyz do-not-log";
    const pendingRow: PendingRow = {
      event_id: randomUUID(), monitor_id: MONITOR_ID, user_id: USER_ID,
      email: SECRET_EMAIL, url: SECRET_URL, label: "Secret",
      detected_at: new Date().toISOString(), summary: null,
    };
    const rpc = makeFakeRpc({
      // Claim row at SECRET_URL so fetchPage(SECRET_URL) is called in the check phase
      claimRows: [{ id: MONITOR_ID, user_id: USER_ID, url: SECRET_URL, last_hash: null, consecutive_errors: 0, prior_strikes: 0 }],
      pendingResults: [[pendingRow]],
      recordResult: { applied: true, event_id: null, notify_error: false, notified_at: null, email: null, url: null, label: null, consecutive_errors: 0 },
    });
    const { mailer } = makeCapturingMailer();
    const logLines: string[] = [];
    await runMonitorChecks({
      rpc, mailer,
      fetchPage: async () => ({
        ok: true as const, body: SECRET_BODY, contentType: "text/html",
        finalUrl: SECRET_URL, truncated: false, subrequests: 1,
      }),
      config: BASE_CONFIG,
      log: (line: string) => logLines.push(line),
    });
    const line = logLines[0]!;
    expect(line).not.toContain(SECRET_EMAIL);
    expect(line).not.toContain(SECRET_URL);
    expect(line).not.toContain(SECRET_BODY);
  });

  it("ENG-AC6run4: the log line carries exactly the returned RunSummary", async () => {
    const rpc = makeFakeRpc({
      claimRows: [{ id: MONITOR_ID, user_id: USER_ID, url: MONITOR_URL, last_hash: null, consecutive_errors: 0, prior_strikes: 0 }],
      pendingResults: [[]],
    });
    const { mailer } = makeCapturingMailer();
    const logLines: string[] = [];
    const summary: RunSummary = await runMonitorChecks({
      rpc, mailer,
      fetchPage: makeFakeFetchPage(),
      config: BASE_CONFIG,
      log: (line) => logLines.push(line),
    });
    expect(summary.baselines).toBe(1);
    expect(JSON.parse(logLines[0]!)).toEqual({ msg: "monitor-cron run", ...summary });
  });
});

// ── now() injection — durationMs ─────────────────────────────────────────────

describe("runMonitorChecks — deterministic durationMs via injected now()", () => {
  it("ENG-AC7run4: injected now() yields deterministic durationMs", async () => {
    const rpc = makeFakeRpc({ claimRows: [], pendingResults: [[]] });
    const { mailer } = makeCapturingMailer();
    let callCount = 0;
    // now() returns 0 on first call (start), 500 on second (end)
    const summary = await runMonitorChecks({
      rpc, mailer,
      fetchPage: makeFakeFetchPage(),
      config: BASE_CONFIG,
      log: () => {},
      now: () => (callCount++ === 0 ? 0 : 500),
    });
    expect(summary.durationMs).toBe(500);
  });
});

// ── Engine parameters passed to the RPCs ─────────────────────────────────────

describe("runMonitorChecks — ENG-AC2: RPC calls carry the batch size and the config constants", () => {
  it("ENG-AC2run4: claim(batchSize, grace, threshold), pendingEmails(batchSize, daily cap) twice, record(threshold, daily cap)", async () => {
    // 199 subrequests left before the claim afford 13 worst-case checks, so the batch size 7 stands.
    const claimArgs: number[][] = [];
    const pendingArgs: number[][] = [];
    const recordLimits: number[][] = [];
    const fake = makeFakeRpc({
      claimRows: [{ id: MONITOR_ID, user_id: USER_ID, url: MONITOR_URL, last_hash: "v1:" + "0".repeat(64), consecutive_errors: 0, prior_strikes: 0 }],
      recordResult: { applied: true, event_id: "evt-args", notify_error: false, notified_at: null, email: null, url: null, label: null, consecutive_errors: 0 },
    });
    const rpc: EngineRpc = {
      ...fake,
      async claim(limit, graceMinutes, errorThreshold) {
        claimArgs.push([limit, graceMinutes, errorThreshold]);
        return fake.claim(limit, graceMinutes, errorThreshold);
      },
      async pendingEmails(limit, dailyCap) {
        pendingArgs.push([limit, dailyCap]);
        return fake.pendingEmails(limit, dailyCap);
      },
      async record(input) {
        recordLimits.push([input.errorThreshold, input.dailyCap]);
        return fake.record(input);
      },
    };
    const { mailer } = makeCapturingMailer();
    await runMonitorChecks({
      rpc, mailer,
      fetchPage: makeFakeFetchPage(),
      config: { ...BASE_CONFIG, batchSize: 7 },
      log: () => {},
    });
    expect(claimArgs).toEqual([[7, MONITOR_DUE_GRACE_MINUTES, MONITOR_ERROR_THRESHOLD]]);
    // The changed check created an event, so the second sweep runs with the same arguments.
    expect(pendingArgs).toEqual([
      [7, MONITOR_DAILY_EMAIL_CAP],
      [7, MONITOR_DAILY_EMAIL_CAP],
    ]);
    expect(recordLimits).toEqual([[MONITOR_ERROR_THRESHOLD, MONITOR_DAILY_EMAIL_CAP]]);
  });
});
