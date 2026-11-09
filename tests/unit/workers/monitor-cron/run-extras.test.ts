/**
 * Unit tests: workers/monitor-cron/run.ts beyond the contract's examples
 * Journey: monitor-engine  ENG-AC1, ENG-AC3, ENG-AC7
 *
 * What the engine passes to monitor_engine_record on a change and on an error
 * (threshold and daily cap), the error email's failure count (the claim's
 * pre-check count plus this run's failure), the subrequest budget edges (an
 * email; the claim limit = min(batch size, one worst-case check of 15 per
 * monitor in what the claim leaves, the wall-time limit): 1 vs none, 2 vs 1,
 * the batch vs one less, the Free and Paid (batch 24) profiles, 410 vs 409 after
 * a full first sweep of 24, a batch of 150 cut to 24 by the wall-time limit, a
 * cut claim that comes back full (budget stop) or short (none); every leased
 * monitor checked at the full 15 each, and the per-check backstop when a check
 * costs one more; the second email sweep; the error email), all on a fake clock
 * that advances at every rpc, mailer and fetchPage call as on Workers (small,
 * realistic costs unless a test sets one); the wall-time edges (claim limit =
 * floor((870 000 ms − run time − 5 000) / 35 000): 1 at 830 000 ms vs none 1 ms
 * later, 2 at 795 000 vs 1 1 ms later, the Paid batch of 24 at 25 000 vs 23 1 ms
 * later; a change email starts only by 855 000 ms (send 10 000 + markEmailed
 * 5 000 before 870 000), in the first sweep and in the second; the second
 * sweep's lookup only by 850 000 ms (lookup + one email); the error email's
 * defensive check at 855 000 vs 855 001 ms, reachable only after a call ran past
 * its timeout); worst-case runs where every call takes its whole timeout (every
 * check failing and sending its error email, or every page changed and the
 * second sweep mailing the events) ending by 870 000 ms; a throwing mailer or
 * RPC, the error email after a mail stop, and the check order: each monitor
 * fetched and recorded in turn, in exactly the order the claim returned
 * (neither id nor url order); every record's `repay` = the claim's
 * `prior_strikes > 0`, for each outcome on both sides; `strikerClaimed` (the
 * claimed monitors with `prior_strikes > 0`) in the summary and the log line.
 */
import { describe, expect, it } from "vitest";
import {
  MONITOR_EMAIL_SEND_TIMEOUT_MS,
  MONITOR_FETCH_TIMEOUT_MS,
  MONITOR_RPC_TIMEOUT_MS,
  MONITOR_RUN_WALL_LIMIT_MS,
} from "@/config/monitor";
import type { EmailMessage, SendResult } from "@/lib/email/resend";
import { buildErrorEmail } from "@/lib/monitor/change-email";
import { hashPageText } from "@/lib/monitor/page-text";
import type { PageFetchResult } from "@/lib/monitor/page-fetch";
import type { ClaimedMonitor, EngineRpc, PendingEmail, RecordInput, RecordResult } from "../../../../workers/monitor-cron/rpc";
import { runMonitorChecks, type Mailer, type RunConfig, type RunSummary } from "../../../../workers/monitor-cron/run";

const CONFIG: RunConfig = {
  batchSize: 5,
  subrequestLimit: 200,
  siteUrl: "https://alnyron.dk",
  mailFrom: "Alnyron <noreply@send.alnyron.dk>",
};

const APPLIED: RecordResult = {
  applied: true,
  event_id: null,
  notify_error: false,
  notified_at: null,
  email: null,
  url: null,
  label: null,
  consecutive_errors: 0,
};

function monitor(overrides: Partial<ClaimedMonitor> = {}): ClaimedMonitor {
  return {
    id: "00000000-0000-0000-0000-0000000000a1",
    user_id: "00000000-0000-0000-0000-0000000000b1",
    url: "https://example.com/page",
    last_hash: null,
    consecutive_errors: 0,
    prior_strikes: 0,
    ...overrides,
  };
}

function pending(eventId: string): PendingEmail {
  return {
    event_id: eventId,
    monitor_id: "00000000-0000-0000-0000-0000000000a1",
    user_id: "00000000-0000-0000-0000-0000000000b1",
    email: "user@example.com",
    url: "https://example.com/page",
    label: null,
    detected_at: "2026-11-08T10:00:00.000Z",
    summary: null,
  };
}

/** The summary of a run that did nothing, at an injected clock of 0. */
const IDLE_SUMMARY: RunSummary = {
  claimed: 0,
  strikerClaimed: 0,
  checked: 0,
  unchanged: 0,
  baselines: 0,
  changed: 0,
  errors: 0,
  staleSkips: 0,
  emailsSent: 0,
  emailsDeferred: 0,
  emailsRejected: 0,
  errorEmails: 0,
  mailStop: null,
  budgetStop: false,
  batchFull: false,
  subrequests: 0,
  rpcErrors: 0,
  durationMs: 0,
};

/** An EngineRpc whose calls resolve to the given values (a claim returns at most its limit); overrides replace single methods. */
function fakeRpc(options: {
  claimed?: ClaimedMonitor[];
  pendingSweeps?: PendingEmail[][];
  snapshot?: string | null;
  record?: (input: RecordInput) => Promise<RecordResult>;
}): EngineRpc {
  let sweep = 0;
  return {
    claim: async (limit) => (options.claimed ?? []).slice(0, limit),
    snapshot: async () => options.snapshot ?? null,
    record: options.record ?? (async () => APPLIED),
    pendingEmails: async () => options.pendingSweeps?.[sweep++] ?? [],
    markEmailed: async () => true,
  };
}

function capturingMailer(results: (SendResult | Error)[]) {
  const sent: { message: EmailMessage; key: string }[] = [];
  const mailer = async (message: EmailMessage, key: string): Promise<SendResult> => {
    const result = results[Math.min(sent.length, results.length - 1)] ?? { ok: true, id: "id" };
    sent.push({ message, key });
    if (result instanceof Error) throw result;
    return result;
  };
  return { mailer, sent };
}

function page(body: string): (url: string) => Promise<PageFetchResult> {
  return async (url) => ({ ok: true, body, contentType: "text/html", finalUrl: url, truncated: false, subrequests: 3 });
}

/** The kinds of I/O a run makes: each EngineRpc call, a send through the mailer, a page fetch. */
type IoKind = keyof EngineRpc | "send" | "fetch";

/** What each kind of I/O costs on the clock, in ms: one value, or one per call by its index (0-based, per kind). */
type IoCosts = Record<IoKind, number | ((call: number) => number)>;

/** Small, realistic costs: 100 ms per database call, 300 ms per email send, 1 s per page check. */
const QUICK_IO: IoCosts = {
  pendingEmails: 100,
  claim: 100,
  snapshot: 100,
  record: 100,
  markEmailed: 100,
  send: 300,
  fetch: 1_000,
};

/** Every call takes its whole timeout: database 5 000 ms, email send 10 000 ms, page check 15 000 ms. */
const TIMEOUT_IO: IoCosts = {
  pendingEmails: MONITOR_RPC_TIMEOUT_MS,
  claim: MONITOR_RPC_TIMEOUT_MS,
  snapshot: MONITOR_RPC_TIMEOUT_MS,
  record: MONITOR_RPC_TIMEOUT_MS,
  markEmailed: MONITOR_RPC_TIMEOUT_MS,
  send: MONITOR_EMAIL_SEND_TIMEOUT_MS,
  fetch: MONITOR_FETCH_TIMEOUT_MS,
};

/**
 * A fake clock that runs as on Workers, where `Date.now()` moves on only at I/O: the run gets
 * `now` (0 when it starts) and its fakes through `rpc`, `mailer` and `fetchPage`; every call
 * advances the clock by its kind's cost before the fake runs, so the run reads the time the call
 * returned at.
 */
function ioClock(costs: IoCosts) {
  let ms = 0;
  const calls: Partial<Record<IoKind, number>> = {};
  function advance(kind: IoKind): void {
    const call = calls[kind] ?? 0;
    calls[kind] = call + 1;
    const cost = costs[kind];
    ms += typeof cost === "function" ? cost(call) : cost;
  }
  return {
    now: () => ms,
    rpc: (inner: EngineRpc): EngineRpc => ({
      claim: async (limit, graceMinutes, errorThreshold) => {
        advance("claim");
        return inner.claim(limit, graceMinutes, errorThreshold);
      },
      snapshot: async (monitorId) => {
        advance("snapshot");
        return inner.snapshot(monitorId);
      },
      record: async (input) => {
        advance("record");
        return inner.record(input);
      },
      pendingEmails: async (limit, dailyCap) => {
        advance("pendingEmails");
        return inner.pendingEmails(limit, dailyCap);
      },
      markEmailed: async (eventId) => {
        advance("markEmailed");
        return inner.markEmailed(eventId);
      },
    }),
    mailer: (inner: Mailer): Mailer => async (message, key) => {
      advance("send");
      return inner(message, key);
    },
    fetchPage: (inner: (url: string) => Promise<PageFetchResult>) => async (url: string) => {
      advance("fetch");
      return inner(url);
    },
  };
}

describe("runMonitorChecks — ENG-AC1: a change is recorded against the claimed hash", () => {
  it("ENG-AC1runx1: record(changed) carries the claimed URL, the old hash, the new hash, snapshot and summary", async () => {
    const oldHash = await hashPageText("Old line");
    const inputs: RecordInput[] = [];
    const rpc = fakeRpc({
      claimed: [monitor({ last_hash: oldHash })],
      snapshot: "Old line",
      record: async (input) => {
        inputs.push(input);
        return { ...APPLIED, event_id: "evt-1" };
      },
    });
    const { mailer } = capturingMailer([{ ok: true, id: "id" }]);
    const summary = await runMonitorChecks({ rpc, mailer, fetchPage: page("<p>New line</p>"), config: CONFIG, log: () => {} });

    expect(summary.changed).toBe(1);
    expect(inputs).toEqual([
      {
        monitorId: "00000000-0000-0000-0000-0000000000a1",
        claimedUrl: "https://example.com/page",
        outcome: "changed",
        expectedHash: oldHash,
        newHash: await hashPageText("New line"),
        snapshot: "New line",
        summary: "+ New line\n\u2212 Old line",
        errorThreshold: 3,
        dailyCap: 10,
        repay: false,
      },
    ]);
  });
});

describe("runMonitorChecks — ENG-AC7: the email budget", () => {
  it("ENG-AC7runx1: emails stop when fewer than 2 subrequests remain; the rest are deferred", async () => {
    // 10 subrequests: pendingEmails 1, then 2 per email (send + markEmailed) → 4 emails, 1 left over.
    const rows = ["e1", "e2", "e3", "e4", "e5"].map(pending);
    const { mailer, sent } = capturingMailer([{ ok: true, id: "id" }]);
    const summary = await runMonitorChecks({
      rpc: fakeRpc({ pendingSweeps: [rows] }),
      mailer,
      fetchPage: page("<p>x</p>"),
      config: { ...CONFIG, subrequestLimit: 10 },
      log: () => {},
    });
    expect(sent.map((mail) => mail.key)).toEqual(["e1", "e2", "e3", "e4"].map((id) => `monitor-event/${id}`));
    expect(summary.emailsSent).toBe(4);
    expect(summary.emailsDeferred).toBe(1);
    expect(summary.budgetStop).toBe(true);
    expect(summary.mailStop).toBeNull();
    expect(summary.subrequests).toBe(9);
  });

  it("ENG-AC7runx5: with exactly 2 subrequests left the email is still sent (send + markEmailed)", async () => {
    // 11 subrequests: pendingEmails 1 → 10 left; the fifth email starts with exactly 2 left.
    const rows = ["e1", "e2", "e3", "e4", "e5"].map(pending);
    const { mailer, sent } = capturingMailer([{ ok: true, id: "id" }]);
    const summary = await runMonitorChecks({
      rpc: fakeRpc({ pendingSweeps: [rows] }),
      mailer,
      fetchPage: page("<p>x</p>"),
      config: { ...CONFIG, subrequestLimit: 11 },
      log: () => {},
    });
    expect(sent.map((mail) => mail.key)).toEqual(["e1", "e2", "e3", "e4", "e5"].map((id) => `monitor-event/${id}`));
    expect(summary.emailsSent).toBe(5);
    expect(summary.emailsDeferred).toBe(0);
    expect(summary.mailStop).toBeNull();
    expect(summary.subrequests).toBe(11);
  });
});

describe("runMonitorChecks — ENG-AC7: the claim asks only for the monitors the budget can check", () => {
  /**
   * One run on {@link QUICK_IO}'s clock that first sends `pendingCount` pending change emails,
   * then claims: the fake claim records its limit and returns that many never-checked monitors
   * (more are due than any claim asks for), or only `due` of them. Each is checked as a baseline:
   * page 3 + record 1.
   */
  async function sizedRun(options: { subrequestLimit: number; batchSize: number; pendingCount: number; due?: number }) {
    const time = ioClock(QUICK_IO);
    const claims: number[] = [];
    const rows = Array.from({ length: options.pendingCount }, (_, index) => pending(`e${index + 1}`));
    const rpc: EngineRpc = {
      ...fakeRpc({ pendingSweeps: [rows] }),
      claim: async (limit) => {
        claims.push(limit);
        return Array.from({ length: Math.min(limit, options.due ?? limit) }, (_, index) => monitor({ id: `m${index + 1}` }));
      },
    };
    const { mailer, sent } = capturingMailer([{ ok: true, id: "id" }]);
    const summary = await runMonitorChecks({
      rpc: time.rpc(rpc),
      mailer: time.mailer(mailer),
      fetchPage: time.fetchPage(page("<p>x</p>")),
      config: { ...CONFIG, subrequestLimit: options.subrequestLimit, batchSize: options.batchSize },
      log: () => {},
      now: time.now,
    });
    return { claims, sent, summary };
  }

  // "left" = subrequests left right before the claim; it needs 1 + 15 per monitor. Run time:
  // lookup 100 + 400 per first-sweep email (send 300 + markEmailed 100), then claim 100 + 1 100
  // per check (page 1 000 + record 100), so the wall-time limit cuts only the batch of 150.
  it.for([
    {
      id: "ENG-AC7runx2",
      label: "17, nothing pending: 16 left affords exactly one check → limit 1, a cut claim that came back full",
      subrequestLimit: 17, batchSize: 5, pendingCount: 0,
      claims: [1], claimed: 1, budgetStop: true, batchFull: false, subrequests: 6, durationMs: 1_300,
    },
    {
      id: "ENG-AC7runx8",
      label: "16, nothing pending: 15 left, one short of claim + check → no claim, budget stop",
      subrequestLimit: 16, batchSize: 5, pendingCount: 0,
      claims: [], claimed: 0, budgetStop: true, batchFull: false, subrequests: 1, durationMs: 100,
    },
    {
      id: "ENG-AC7runx9",
      label: "32: 31 left = 1 + 2 × 15 → limit 2",
      subrequestLimit: 32, batchSize: 5, pendingCount: 0,
      claims: [2], claimed: 2, budgetStop: true, batchFull: false, subrequests: 10, durationMs: 2_400,
    },
    {
      id: "ENG-AC7runx10",
      label: "31: 30 left, one short of 1 + 2 × 15 → limit 1",
      subrequestLimit: 31, batchSize: 5, pendingCount: 0,
      claims: [1], claimed: 1, budgetStop: true, batchFull: false, subrequests: 6, durationMs: 1_300,
    },
    {
      id: "ENG-AC7runx11",
      label: "50 after 2 emails: 45 left affords 2 checks (3 need 46) → limit 2 of a batch of 5",
      subrequestLimit: 50, batchSize: 5, pendingCount: 2,
      claims: [2], claimed: 2, budgetStop: true, batchFull: false, subrequests: 14, durationMs: 3_200,
    },
    {
      id: "ENG-AC7runx12",
      label: "Free profile, 50 with batch 2 after a full first sweep (2 emails): 45 left → the whole batch",
      subrequestLimit: 50, batchSize: 2, pendingCount: 2,
      claims: [2], claimed: 2, budgetStop: false, batchFull: true, subrequests: 14, durationMs: 3_200,
    },
    {
      id: "ENG-AC7runx13",
      label: "77: 76 left = 1 + 5 × 15 → the batch size 5",
      subrequestLimit: 77, batchSize: 5, pendingCount: 0,
      claims: [5], claimed: 5, budgetStop: false, batchFull: true, subrequests: 22, durationMs: 5_700,
    },
    {
      id: "ENG-AC7runx14",
      label: "76: 75 left, one short of 1 + 5 × 15 → limit 4",
      subrequestLimit: 76, batchSize: 5, pendingCount: 0,
      claims: [4], claimed: 4, budgetStop: true, batchFull: false, subrequests: 18, durationMs: 4_600,
    },
    {
      id: "ENG-AC7runx15",
      label: "Paid profile (batch 24, 10000) after a full first sweep (24 emails): claimed 9 700 ms in with 9951 left → the whole batch of 24, no budget stop",
      subrequestLimit: 10_000, batchSize: 24, pendingCount: 24,
      claims: [24], claimed: 24, budgetStop: false, batchFull: true, subrequests: 146, durationMs: 36_200,
    },
    {
      id: "ENG-AC7runx16",
      label: "410 with batch 24 after a full first sweep: 361 left = 1 + 24 × 15 → the batch size 24",
      subrequestLimit: 410, batchSize: 24, pendingCount: 24,
      claims: [24], claimed: 24, budgetStop: false, batchFull: true, subrequests: 146, durationMs: 36_200,
    },
    {
      id: "ENG-AC7runx17",
      label: "409 with batch 24 after a full first sweep: 360 left → limit 23",
      subrequestLimit: 409, batchSize: 24, pendingCount: 24,
      claims: [23], claimed: 23, budgetStop: true, batchFull: false, subrequests: 142, durationMs: 35_100,
    },
    {
      id: "ENG-AC7runx21",
      label: "10000 with batch 150, claimed 100 ms in: the wall-time limit ((870 000 − 100 − 5 000) / 35 000) cuts it to 24, a cut claim that came back full",
      subrequestLimit: 10_000, batchSize: 150, pendingCount: 0,
      claims: [24], claimed: 24, budgetStop: true, batchFull: false, subrequests: 98, durationMs: 26_600,
    },
  ])("$id: $label", async (row) => {
    const { claims, sent, summary } = await sizedRun(row);
    expect(claims).toEqual(row.claims);
    expect(sent.map((mail) => mail.key)).toEqual(
      Array.from({ length: row.pendingCount }, (_, index) => `monitor-event/e${index + 1}`),
    );
    expect(summary).toEqual({
      ...IDLE_SUMMARY,
      claimed: row.claimed,
      checked: row.claimed,
      baselines: row.claimed,
      emailsSent: row.pendingCount,
      budgetStop: row.budgetStop,
      batchFull: row.batchFull,
      subrequests: row.subrequests,
      durationMs: row.durationMs,
    });
  });

  it("ENG-AC7runx18: a cut claim that comes back short leased every due monitor: no budget stop", async () => {
    // 50 after 2 emails: limit 2 of a batch of 5, but only 1 monitor is due.
    const { claims, summary } = await sizedRun({ subrequestLimit: 50, batchSize: 5, pendingCount: 2, due: 1 });
    expect(claims).toEqual([2]);
    expect(summary).toEqual({
      ...IDLE_SUMMARY,
      claimed: 1,
      checked: 1,
      baselines: 1,
      emailsSent: 2,
      // pendingEmails 1 + 2 emails × 2 + claim 1 + page 3 + record 1.
      subrequests: 10,
      // lookup 100 + 2 × 400 + claim 100 + page 1 000 + record 100.
      durationMs: 2_100,
    });
  });

  it("ENG-AC7runx3: when the first sweep leaves under 16 (claim + one check), nothing is claimed or leased", async () => {
    // 17: pendingEmails 1 + one email 2 → 14 left.
    const { claims, sent, summary } = await sizedRun({ subrequestLimit: 17, batchSize: 5, pendingCount: 1 });
    expect(sent.map((mail) => mail.key)).toEqual(["monitor-event/e1"]);
    expect(claims).toEqual([]);
    expect(summary).toEqual({ ...IDLE_SUMMARY, emailsSent: 1, budgetStop: true, subrequests: 3, durationMs: 500 });
  });

  it("ENG-AC7runx4: when the first sweep leaves exactly 15 (one short of claim + check), nothing is claimed", async () => {
    // 18: pendingEmails 1 + one email 2 → 15 left.
    const { claims, sent, summary } = await sizedRun({ subrequestLimit: 18, batchSize: 5, pendingCount: 1 });
    expect(sent.map((mail) => mail.key)).toEqual(["monitor-event/e1"]);
    expect(claims).toEqual([]);
    expect(summary).toEqual({ ...IDLE_SUMMARY, emailsSent: 1, budgetStop: true, subrequests: 3, durationMs: 500 });
  });
});

describe("runMonitorChecks — ENG-AC7: every leased monitor is checked", () => {
  /**
   * One run at 32 subrequests with batch 2 and nothing pending, on {@link QUICK_IO}'s clock: 31
   * left → a claim of 2, then 30 left. Every check fails and claims its streak's notification:
   * page (the given subrequests), record 1, error email 1. A page reporting 13 makes a check cost
   * exactly the reserved 15 (a real fetch reports at most 12); 14 makes it cost one more.
   */
  async function reserveRun(pageSubrequests: readonly number[]) {
    const time = ioClock(QUICK_IO);
    let fetches = 0;
    const rpc: EngineRpc = {
      ...fakeRpc({
        record: async () => ({
          ...APPLIED,
          notify_error: true,
          notified_at: "2026-11-08T10:00:00.000+00:00",
          email: "user@example.com",
          url: "https://example.com/page",
          consecutive_errors: 3,
        }),
      }),
      claim: async (limit) =>
        Array.from({ length: limit }, (_, index) => monitor({ id: `m${index + 1}`, consecutive_errors: 2 })),
    };
    const { mailer, sent } = capturingMailer([{ ok: true, id: "id" }]);
    const summary = await runMonitorChecks({
      rpc: time.rpc(rpc),
      mailer: time.mailer(mailer),
      fetchPage: time.fetchPage(async () => ({ ok: false, reason: "http_status", subrequests: pageSubrequests[fetches++] ?? 0 })),
      config: { ...CONFIG, subrequestLimit: 32, batchSize: 2 },
      log: () => {},
      now: time.now,
    });
    return { summary, sent };
  }

  it("ENG-AC7runx19: two checks at the full reserved 15 each are both made, ending at exactly the limit", async () => {
    const { summary, sent } = await reserveRun([13, 13]);
    expect(sent.map((mail) => mail.key)).toEqual([
      "monitor-error/m1/2026-11-08T10:00:00.000+00:00",
      "monitor-error/m2/2026-11-08T10:00:00.000+00:00",
    ]);
    expect(summary).toEqual({
      ...IDLE_SUMMARY,
      claimed: 2,
      checked: 2,
      errors: 2,
      errorEmails: 2,
      batchFull: true,
      // pendingEmails 1 + claim 1 + 2 × (page 13 + record 1 + error email 1).
      subrequests: 32,
      // lookup 100 + claim 100 + 2 × (page 1 000 + record 100 + error email 300).
      durationMs: 3_000,
    });
  });

  it("ENG-AC7runx20: backstop: a check costing 16 leaves 14, so the next leased monitor is not checked", async () => {
    const { summary, sent } = await reserveRun([14, 13]);
    expect(sent.map((mail) => mail.key)).toEqual(["monitor-error/m1/2026-11-08T10:00:00.000+00:00"]);
    expect(summary).toEqual({
      ...IDLE_SUMMARY,
      claimed: 2,
      checked: 1,
      errors: 1,
      errorEmails: 1,
      budgetStop: true,
      batchFull: true,
      // pendingEmails 1 + claim 1 + page 14 + record 1 + error email 1.
      subrequests: 18,
      // lookup 100 + claim 100 + page 1 000 + record 100 + error email 300.
      durationMs: 1_600,
    });
  });
});

describe("runMonitorChecks — ENG-AC7: the second email sweep needs room for one email", () => {
  /**
   * One run at the env floor of 17, batch size 1 (so the budget does not cut the claim), on
   * {@link QUICK_IO}'s clock, that claims a monitor whose page changed; the second sweep returns
   * the new event. The page fetch reports `pageSubrequests`, so after it, snapshot and record the
   * run has `17 - 2 - pageSubrequests - 2` subrequests left for the sweep.
   */
  async function changedRun(pageSubrequests: number) {
    const time = ioClock(QUICK_IO);
    const oldHash = await hashPageText("Old line");
    let sweeps = 0;
    const rpc: EngineRpc = {
      ...fakeRpc({
        claimed: [monitor({ last_hash: oldHash })],
        snapshot: "Old line",
        record: async () => ({ ...APPLIED, event_id: "evt-1" }),
      }),
      pendingEmails: async () => (sweeps++ === 0 ? [] : [pending("evt-1")]),
    };
    const { mailer, sent } = capturingMailer([{ ok: true, id: "id" }]);
    const summary = await runMonitorChecks({
      rpc: time.rpc(rpc),
      mailer: time.mailer(mailer),
      fetchPage: time.fetchPage(async (url) => ({
        ok: true,
        body: "<p>New line</p>",
        contentType: "text/html",
        finalUrl: url,
        truncated: false,
        subrequests: pageSubrequests,
      })),
      config: { ...CONFIG, subrequestLimit: 17, batchSize: 1 },
      log: () => {},
      now: time.now,
    });
    return { summary, sent, sweeps };
  }

  it("ENG-AC7runx6: with exactly 3 left (pendingEmails + send + markEmailed) the sweep runs and sends", async () => {
    // 17: pendingEmails 1 + claim 1 + page 10 + snapshot 1 + record 1 → 3 left.
    const { summary, sent, sweeps } = await changedRun(10);
    expect(sweeps).toBe(2);
    expect(sent.map((mail) => mail.key)).toEqual(["monitor-event/evt-1"]);
    expect(summary.changed).toBe(1);
    expect(summary.emailsSent).toBe(1);
    expect(summary.budgetStop).toBe(false);
    expect(summary.subrequests).toBe(17);
  });

  it("ENG-AC7runx7: with exactly 2 left the sweep is skipped and the event waits for the next run", async () => {
    // 17: pendingEmails 1 + claim 1 + page 11 + snapshot 1 + record 1 → 2 left.
    const { summary, sent, sweeps } = await changedRun(11);
    expect(sweeps).toBe(1);
    expect(sent).toEqual([]);
    expect(summary.changed).toBe(1);
    expect(summary.emailsSent).toBe(0);
    expect(summary.emailsDeferred).toBe(0);
    expect(summary.budgetStop).toBe(true);
    expect(summary.subrequests).toBe(15);
  });
});

describe("runMonitorChecks — ENG-AC3: the error email needs one subrequest", () => {
  /**
   * One run at the env floor of 17, batch size 1 (so the budget does not cut the claim), on
   * {@link QUICK_IO}'s clock, whose only check fails and claims the streak's notification. A real
   * page fetch reports at most 12 subrequests, which always leaves room for the email; the
   * injected 13 and 14 reach the guard's edge (17 - 2 - page - record = 1 and 0 left).
   */
  async function failedRun(pageSubrequests: number) {
    const time = ioClock(QUICK_IO);
    const rpc = fakeRpc({
      claimed: [monitor({ consecutive_errors: 2 })],
      record: async () => ({
        ...APPLIED,
        notify_error: true,
        notified_at: "2026-11-08T10:00:00.000+00:00",
        email: "user@example.com",
        url: "https://example.com/page",
        consecutive_errors: 3,
      }),
    });
    const { mailer, sent } = capturingMailer([{ ok: true, id: "id" }]);
    const summary = await runMonitorChecks({
      rpc: time.rpc(rpc),
      mailer: time.mailer(mailer),
      fetchPage: time.fetchPage(async () => ({ ok: false, reason: "http_status", subrequests: pageSubrequests })),
      config: { ...CONFIG, subrequestLimit: 17, batchSize: 1 },
      log: () => {},
      now: time.now,
    });
    return { summary, sent };
  }

  it("ENG-AC3runx2: with exactly 1 subrequest left the error email is sent", async () => {
    const { summary, sent } = await failedRun(13);
    expect(sent.map((mail) => mail.key)).toEqual([
      "monitor-error/00000000-0000-0000-0000-0000000000a1/2026-11-08T10:00:00.000+00:00",
    ]);
    expect(summary.errors).toBe(1);
    expect(summary.errorEmails).toBe(1);
    expect(summary.budgetStop).toBe(false);
    expect(summary.subrequests).toBe(17);
  });

  it("ENG-AC3runx3: with none left the error email is skipped and the run reports a budget stop", async () => {
    const { summary, sent } = await failedRun(14);
    expect(sent).toEqual([]);
    expect(summary.errors).toBe(1);
    expect(summary.errorEmails).toBe(0);
    expect(summary.mailStop).toBeNull();
    expect(summary.budgetStop).toBe(true);
    expect(summary.subrequests).toBe(17);
  });
});

describe("runMonitorChecks — ENG-AC7: the wall-time limit (870 000 ms, every call counted at its whole timeout)", () => {
  // The claim may lease floor((870 000 − run time − 5 000) / 35 000) monitors:
  // MONITOR_RUN_WALL_LIMIT_MS less the claim call's own MONITOR_RPC_TIMEOUT_MS, at
  // MONITOR_CHECK_WALL_MS per check. The first sweep's lookup (nothing pending) returns `at` ms
  // into the run; every other call costs QUICK_IO (claim 100, then page 1 000 + record 100 per
  // check). 10 000 subrequests never cut the claim here.
  it.for([
    {
      id: "ENG-AC7runx22",
      label: "830 000 ms in: 40 000 left = the claim's 5 000 + exactly one check of 35 000 → limit 1 of a batch of 5, a cut claim that came back full",
      at: 830_000, batchSize: 5, claims: [1], budgetStop: true, batchFull: false, durationMs: 831_200,
    },
    {
      id: "ENG-AC7runx23",
      label: "830 001 ms in: 1 ms short of the claim + one check → no claim, budget stop",
      at: 830_001, batchSize: 5, claims: [], budgetStop: true, batchFull: false, durationMs: 830_001,
    },
    {
      id: "ENG-AC7runx24",
      label: "795 000 ms in: 75 000 left fits the claim and exactly two checks → limit 2",
      at: 795_000, batchSize: 5, claims: [2], budgetStop: true, batchFull: false, durationMs: 797_300,
    },
    {
      id: "ENG-AC7runx25",
      label: "795 001 ms in: 1 ms short of two checks → limit 1",
      at: 795_001, batchSize: 5, claims: [1], budgetStop: true, batchFull: false, durationMs: 796_201,
    },
    {
      id: "ENG-AC7runx26",
      label: "Paid profile, batch 24, 25 000 ms in: 845 000 left fits the claim and exactly 24 checks → the whole batch, no budget stop",
      at: 25_000, batchSize: 24, claims: [24], budgetStop: false, batchFull: true, durationMs: 51_500,
    },
    {
      id: "ENG-AC7runx27",
      label: "batch 24, 25 001 ms in: 1 ms short of 24 checks → limit 23, a cut claim that came back full",
      at: 25_001, batchSize: 24, claims: [23], budgetStop: true, batchFull: false, durationMs: 50_401,
    },
  ])("$id: $label", async (row) => {
    const time = ioClock({ ...QUICK_IO, pendingEmails: row.at });
    const claims: number[] = [];
    const rpc: EngineRpc = {
      ...fakeRpc({}),
      claim: async (limit) => {
        claims.push(limit);
        return Array.from({ length: limit }, (_, index) => monitor({ id: `m${index + 1}` }));
      },
    };
    const { mailer } = capturingMailer([{ ok: true, id: "id" }]);
    const summary = await runMonitorChecks({
      rpc: time.rpc(rpc),
      mailer: time.mailer(mailer),
      fetchPage: time.fetchPage(page("<p>x</p>")),
      config: { ...CONFIG, subrequestLimit: 10_000, batchSize: row.batchSize },
      log: () => {},
      now: time.now,
    });
    const claimed = row.claims[0] ?? 0;
    expect(claims).toEqual(row.claims);
    expect(summary).toEqual({
      ...IDLE_SUMMARY,
      claimed,
      checked: claimed,
      baselines: claimed,
      budgetStop: row.budgetStop,
      batchFull: row.batchFull,
      // pendingEmails 1; with a claim, also the claim 1 and page 3 + record 1 per monitor.
      subrequests: claimed > 0 ? 2 + 4 * claimed : 1,
      // `at`; with a claim, also the claim 100 and page 1 000 + record 100 per monitor.
      durationMs: row.durationMs,
    });
  });

  // A change email starts only while its send (MONITOR_EMAIL_SEND_TIMEOUT_MS) and markEmailed
  // (MONITOR_RPC_TIMEOUT_MS) can both end by the limit: at most 855 000 ms into the run. Two
  // pending emails: lookup 100, then the first send's cost (`firstSendMs`) and markEmailed 100
  // bring the clock to where the second email would start; it then costs QUICK_IO's 300 + 100.
  it.for([
    {
      id: "ENG-AC7runx28",
      label: "the second email starts 855 000 ms in: send and markEmailed fit by 870 000, sent",
      firstSendMs: 854_800, sent: ["e1", "e2"], emailsDeferred: 0, subrequests: 5, durationMs: 855_400,
    },
    {
      id: "ENG-AC7runx29",
      label: "the second email would start 855 001 ms in: 1 ms late, deferred (still pending)",
      firstSendMs: 854_801, sent: ["e1"], emailsDeferred: 1, subrequests: 3, durationMs: 855_001,
    },
  ])("$id: first sweep — $label", async (row) => {
    const time = ioClock({ ...QUICK_IO, send: (call) => (call === 0 ? row.firstSendMs : 300) });
    const claims: number[] = [];
    const rpc: EngineRpc = {
      ...fakeRpc({ pendingSweeps: [["e1", "e2"].map(pending)] }),
      claim: async (limit) => {
        claims.push(limit);
        return [];
      },
    };
    const { mailer, sent } = capturingMailer([{ ok: true, id: "id" }]);
    const summary = await runMonitorChecks({
      rpc: time.rpc(rpc),
      mailer: time.mailer(mailer),
      fetchPage: time.fetchPage(page("<p>x</p>")),
      config: { ...CONFIG, subrequestLimit: 10_000 },
      log: () => {},
      now: time.now,
    });
    expect(sent.map((mail) => mail.key)).toEqual(row.sent.map((id) => `monitor-event/${id}`));
    // Either way no check fits any more at the claim: no claim, a budget stop.
    expect(claims).toEqual([]);
    expect(summary).toEqual({
      ...IDLE_SUMMARY,
      emailsSent: row.sent.length,
      emailsDeferred: row.emailsDeferred,
      budgetStop: true,
      // pendingEmails 1 + 2 per email (send + markEmailed).
      subrequests: row.subrequests,
      durationMs: row.durationMs,
    });
  });

  /**
   * One run, batch size 1, whose one monitor's page changed. The page fetch costs `fetchMs`, so
   * the second sweep is considered `fetchMs` + 400 ms into the run (lookup, claim, snapshot and
   * record 100 each); it finds the new event and an older one (two emails). The first send costs
   * `firstSendMs`, every other call QUICK_IO.
   */
  async function secondSweepRun(fetchMs: number, firstSendMs: number) {
    const time = ioClock({ ...QUICK_IO, fetch: fetchMs, send: (call) => (call === 0 ? firstSendMs : 300) });
    const oldHash = await hashPageText("Old line");
    let sweeps = 0;
    const rpc: EngineRpc = {
      ...fakeRpc({
        claimed: [monitor({ last_hash: oldHash })],
        snapshot: "Old line",
        record: async () => ({ ...APPLIED, event_id: "evt-1" }),
      }),
      pendingEmails: async () => (sweeps++ === 0 ? [] : ["evt-0", "evt-1"].map(pending)),
    };
    const { mailer, sent } = capturingMailer([{ ok: true, id: "id" }]);
    const summary = await runMonitorChecks({
      rpc: time.rpc(rpc),
      mailer: time.mailer(mailer),
      fetchPage: time.fetchPage(page("<p>New line</p>")),
      config: { ...CONFIG, subrequestLimit: 10_000, batchSize: 1 },
      log: () => {},
      now: time.now,
    });
    return { summary, sent: sent.map((mail) => mail.key), sweeps };
  }

  /** The summary of {@link secondSweepRun}'s run before its second sweep: one claimed, changed monitor. */
  const CHANGED_RUN = { ...IDLE_SUMMARY, claimed: 1, checked: 1, changed: 1, batchFull: true };

  it("ENG-AC7runx30: second sweep 850 000 ms in: its lookup and one email fit by 870 000, so it runs and both emails are sent", async () => {
    const { summary, sent, sweeps } = await secondSweepRun(849_600, 300);
    expect(sweeps).toBe(2);
    expect(sent).toEqual(["monitor-event/evt-0", "monitor-event/evt-1"]);
    expect(summary).toEqual({
      ...CHANGED_RUN,
      emailsSent: 2,
      // pendingEmails 1 + claim 1 + page 3 + snapshot 1 + record 1 + pendingEmails 1 + 2 × 2.
      subrequests: 12,
      // 850 000 + lookup 100 + 2 × (send 300 + markEmailed 100).
      durationMs: 850_900,
    });
  });

  it("ENG-AC7runx31: second sweep 850 001 ms in: skipped (no lookup), the new event waits for the next run, budget stop", async () => {
    const { summary, sent, sweeps } = await secondSweepRun(849_601, 300);
    expect(sweeps).toBe(1);
    expect(sent).toEqual([]);
    expect(summary).toEqual({ ...CHANGED_RUN, budgetStop: true, subrequests: 7, durationMs: 850_001 });
  });

  it("ENG-AC7runx35: second sweep 700 000 ms in, its first email ending 855 000 ms in: the second still starts in time, sent", async () => {
    // 700 000 + lookup 100 + first send 154 800 + markEmailed 100 = 855 000.
    const { summary, sent, sweeps } = await secondSweepRun(699_600, 154_800);
    expect(sweeps).toBe(2);
    expect(sent).toEqual(["monitor-event/evt-0", "monitor-event/evt-1"]);
    expect(summary).toEqual({ ...CHANGED_RUN, emailsSent: 2, subrequests: 12, durationMs: 855_400 });
  });

  it("ENG-AC7runx32: second sweep 700 000 ms in, its first email ending 855 001 ms in: the second email is deferred, budget stop", async () => {
    const { summary, sent, sweeps } = await secondSweepRun(699_600, 154_801);
    expect(sweeps).toBe(2);
    expect(sent).toEqual(["monitor-event/evt-0"]);
    expect(summary).toEqual({
      ...CHANGED_RUN,
      emailsSent: 1,
      emailsDeferred: 1,
      budgetStop: true,
      // pendingEmails 1 + claim 1 + page 3 + snapshot 1 + record 1 + pendingEmails 1 + send 1 + mark 1.
      subrequests: 10,
      durationMs: 855_001,
    });
  });

  /**
   * One run, batch size 1, whose one check fails and claims the streak's notification. The page
   * fetch costs `fetchMs` (far past its 15 000 ms timeout: only a call that overran its timeout
   * reaches this edge, as the claim reserved the email's time), so the error email is considered
   * `fetchMs` + 300 ms into the run (lookup, claim and record 100 each).
   */
  async function failedRunAt(fetchMs: number) {
    const time = ioClock({ ...QUICK_IO, fetch: fetchMs });
    const rpc = fakeRpc({
      claimed: [monitor({ consecutive_errors: 2 })],
      record: async () => ({
        ...APPLIED,
        notify_error: true,
        notified_at: "2026-11-08T10:00:00.000+00:00",
        email: "user@example.com",
        url: "https://example.com/page",
        consecutive_errors: 3,
      }),
    });
    const { mailer, sent } = capturingMailer([{ ok: true, id: "id" }]);
    const summary = await runMonitorChecks({
      rpc: time.rpc(rpc),
      mailer: time.mailer(mailer),
      fetchPage: time.fetchPage(async () => ({ ok: false, reason: "timeout", subrequests: 3 })),
      config: { ...CONFIG, subrequestLimit: 10_000, batchSize: 1 },
      log: () => {},
      now: time.now,
    });
    return { summary, sent: sent.map((mail) => mail.key) };
  }

  /** The summary of {@link failedRunAt}'s run without its error email: one claimed, failed monitor. */
  const FAILED_RUN = { ...IDLE_SUMMARY, claimed: 1, checked: 1, errors: 1, batchFull: true };

  it("ENG-AC7runx33: defensive check: the error email starting 855 000 ms in still fits by 870 000: sent", async () => {
    const { summary, sent } = await failedRunAt(854_700);
    expect(sent).toEqual(["monitor-error/00000000-0000-0000-0000-0000000000a1/2026-11-08T10:00:00.000+00:00"]);
    // pendingEmails 1 + claim 1 + page 3 + record 1 + error email 1; 855 000 + send 300.
    expect(summary).toEqual({ ...FAILED_RUN, errorEmails: 1, subrequests: 7, durationMs: 855_300 });
  });

  it("ENG-AC7runx34: defensive check: the error email 855 001 ms in is 1 ms late: not sent (the claimed notification is lost), budget stop", async () => {
    const { summary, sent } = await failedRunAt(854_701);
    expect(sent).toEqual([]);
    expect(summary).toEqual({ ...FAILED_RUN, budgetStop: true, subrequests: 6, durationMs: 855_001 });
  });
});

describe("runMonitorChecks — ENG-AC7: a run whose every call takes its whole timeout still ends by 870 000 ms", () => {
  /**
   * One run on {@link TIMEOUT_IO}'s clock (database 5 000, send 10 000, page 15 000 ms): the first
   * sweep finds `pendingCount` change events, the claim returns as many monitors as it asks for.
   * `pages: "error"`: every page fails and every record claims its streak's notification, so each
   * check costs page + record + error email = 30 000. `"changed"`: every page changed (page +
   * snapshot + record = 25 000), and the second sweep finds the events the checks created.
   */
  async function worstCaseRun(options: {
    subrequestLimit: number;
    batchSize: number;
    pendingCount: number;
    pages: "error" | "changed";
  }) {
    const time = ioClock(TIMEOUT_IO);
    const oldHash = await hashPageText("Old line");
    const firstSweep = Array.from({ length: options.pendingCount }, (_, index) => pending(`e${index + 1}`));
    const created: string[] = [];
    let sweeps = 0;
    const rpc: EngineRpc = {
      claim: async (limit) =>
        Array.from({ length: limit }, (_, index) => monitor({ id: `m${index + 1}`, last_hash: oldHash, consecutive_errors: 2 })),
      snapshot: async () => "Old line",
      record: async (input) => {
        if (input.outcome === "error") {
          return {
            ...APPLIED,
            notify_error: true,
            notified_at: "2026-11-08T10:00:00.000+00:00",
            email: "user@example.com",
            url: input.claimedUrl,
            consecutive_errors: 3,
          };
        }
        created.push(`evt-${input.monitorId}`);
        return { ...APPLIED, event_id: `evt-${input.monitorId}` };
      },
      pendingEmails: async () => (sweeps++ === 0 ? firstSweep : created.map(pending)),
      markEmailed: async () => true,
    };
    const { mailer, sent } = capturingMailer([{ ok: true, id: "id" }]);
    const summary = await runMonitorChecks({
      rpc: time.rpc(rpc),
      mailer: time.mailer(mailer),
      fetchPage: time.fetchPage(
        options.pages === "error"
          ? async () => ({ ok: false, reason: "timeout", subrequests: 3 })
          : page("<p>New line</p>"),
      ),
      config: { ...CONFIG, subrequestLimit: options.subrequestLimit, batchSize: options.batchSize },
      log: () => {},
      now: time.now,
    });
    return { summary, sent: sent.map((mail) => mail.key) };
  }

  /** The idempotency keys `key(1)` … `key(count)`. */
  function keys(count: number, key: (n: number) => string): string[] {
    return Array.from({ length: count }, (_, index) => key(index + 1));
  }

  it.for([
    {
      id: "ENG-AC7runx36",
      label: "Free profile (batch 2, 50), 2 pending: the sweep ends 35 000 ms in, both monitors claimed → 100 000 ms",
      subrequestLimit: 50, batchSize: 2, pendingCount: 2,
      claimed: 2, emailsSent: 2, emailsDeferred: 0, budgetStop: false, batchFull: true, subrequests: 16, durationMs: 100_000,
    },
    {
      id: "ENG-AC7runx37",
      label: "Paid profile (batch 24, 10000), nothing pending: 24 claimed 5 000 ms in → 730 000 ms",
      subrequestLimit: 10_000, batchSize: 24, pendingCount: 0,
      claimed: 24, emailsSent: 0, emailsDeferred: 0, budgetStop: false, batchFull: true, subrequests: 122, durationMs: 730_000,
    },
    {
      id: "ENG-AC7runx38",
      label: "Paid profile, 24 pending: the sweep ends 365 000 ms in, so the claim is cut to 14 → 790 000 ms",
      subrequestLimit: 10_000, batchSize: 24, pendingCount: 24,
      claimed: 14, emailsSent: 24, emailsDeferred: 0, budgetStop: true, batchFull: false, subrequests: 120, durationMs: 790_000,
    },
    {
      id: "ENG-AC7runx39",
      label: "batch 150, 55 pending: the sweep ends 830 000 ms in, one monitor claimed, its error email starts exactly 855 000 ms in → 865 000 ms",
      subrequestLimit: 10_000, batchSize: 150, pendingCount: 55,
      claimed: 1, emailsSent: 55, emailsDeferred: 0, budgetStop: true, batchFull: false, subrequests: 117, durationMs: 865_000,
    },
    {
      id: "ENG-AC7runx40",
      label: "batch 150, 58 pending: 57 sent, the 58th would start 860 000 ms in (deferred), no claim → 860 000 ms",
      subrequestLimit: 10_000, batchSize: 150, pendingCount: 58,
      claimed: 0, emailsSent: 57, emailsDeferred: 1, budgetStop: true, batchFull: false, subrequests: 115, durationMs: 860_000,
    },
  ])("$id: every check fails and sends its error email — $label", async (row) => {
    const { summary, sent } = await worstCaseRun({ ...row, pages: "error" });
    expect(sent).toEqual([
      ...keys(row.emailsSent, (n) => `monitor-event/e${n}`),
      ...keys(row.claimed, (n) => `monitor-error/m${n}/2026-11-08T10:00:00.000+00:00`),
    ]);
    expect(summary).toEqual({
      ...IDLE_SUMMARY,
      claimed: row.claimed,
      checked: row.claimed,
      errors: row.claimed,
      errorEmails: row.claimed,
      emailsSent: row.emailsSent,
      emailsDeferred: row.emailsDeferred,
      budgetStop: row.budgetStop,
      batchFull: row.batchFull,
      subrequests: row.subrequests,
      durationMs: row.durationMs,
    });
    expect(summary.durationMs).toBeLessThanOrEqual(MONITOR_RUN_WALL_LIMIT_MS);
  });

  it.for([
    {
      id: "ENG-AC7runx41",
      label: "Paid profile, nothing pending: 24 changes end 610 000 ms in; the second sweep sends 17 of its 24 emails, the last starting exactly 855 000 ms in → 870 000 ms, 7 deferred",
      subrequestLimit: 10_000, batchSize: 24, pendingCount: 0,
      claimed: 24, secondSweepSent: 17, emailsDeferred: 7, batchFull: true, subrequests: 157,
    },
    {
      id: "ENG-AC7runx42",
      label: "batch 150, 50 pending: the sweep ends 755 000 ms in, 3 claimed; the second sweep starts 835 000 ms in and sends 2 of 3 → 870 000 ms, 1 deferred",
      subrequestLimit: 10_000, batchSize: 150, pendingCount: 50,
      claimed: 3, secondSweepSent: 2, emailsDeferred: 1, batchFull: false, subrequests: 122,
    },
  ])("$id: every page changed — $label", async (row) => {
    const { summary, sent } = await worstCaseRun({ ...row, pages: "changed" });
    expect(sent).toEqual([
      ...keys(row.pendingCount, (n) => `monitor-event/e${n}`),
      ...keys(row.secondSweepSent, (n) => `monitor-event/evt-m${n}`),
    ]);
    expect(summary).toEqual({
      ...IDLE_SUMMARY,
      claimed: row.claimed,
      checked: row.claimed,
      changed: row.claimed,
      emailsSent: row.pendingCount + row.secondSweepSent,
      emailsDeferred: row.emailsDeferred,
      budgetStop: true,
      batchFull: row.batchFull,
      subrequests: row.subrequests,
      durationMs: 870_000,
    });
    expect(summary.durationMs).toBeLessThanOrEqual(MONITOR_RUN_WALL_LIMIT_MS);
  });
});

describe("runMonitorChecks — ENG-AC1: failures that must not end the run", () => {
  it("ENG-AC1runx2: a throwing mailer counts as a transient failure and stops sending", async () => {
    const { mailer, sent } = capturingMailer([new Error("boom")]);
    const summary = await runMonitorChecks({
      rpc: fakeRpc({ pendingSweeps: [["e1", "e2"].map(pending)] }),
      mailer,
      fetchPage: page("<p>x</p>"),
      config: CONFIG,
      log: () => {},
    });
    expect(sent.map((mail) => mail.key)).toEqual(["monitor-event/e1"]);
    expect(summary.mailStop).toBe("transient");
    expect(summary.emailsDeferred).toBe(2);
  });

  it("ENG-AC1runx3: a throwing record counts an RPC error and the next monitor is still checked", async () => {
    let calls = 0;
    const rpc = fakeRpc({
      claimed: [monitor({ id: "m1" }), monitor({ id: "m2" })],
      record: async () => {
        calls += 1;
        if (calls === 1) throw new Error("rpc down");
        return APPLIED;
      },
    });
    const { mailer } = capturingMailer([{ ok: true, id: "id" }]);
    const summary = await runMonitorChecks({ rpc, mailer, fetchPage: page("<p>x</p>"), config: CONFIG, log: () => {} });
    expect(summary.rpcErrors).toBe(1);
    expect(summary.checked).toBe(2);
    expect(summary.baselines).toBe(1);
  });
});

describe("runMonitorChecks — ENG-AC3: the error email after a mail stop", () => {
  it("ENG-AC3runx1: once sending stopped (quota), a claimed error notification is not mailed", async () => {
    const rpc = fakeRpc({
      claimed: [monitor({ consecutive_errors: 2 })],
      pendingSweeps: [[pending("e1")]],
      record: async () => ({
        ...APPLIED,
        notify_error: true,
        notified_at: "2026-11-08T10:00:00.000+00:00",
        email: "user@example.com",
        url: "https://example.com/page",
        consecutive_errors: 3,
      }),
    });
    const { mailer, sent } = capturingMailer([{ ok: false, kind: "quota", status: 429 }]);
    const summary = await runMonitorChecks({
      rpc,
      mailer,
      fetchPage: async () => ({ ok: false, reason: "http_status", subrequests: 3 }),
      config: CONFIG,
      log: () => {},
    });
    expect(sent.map((mail) => mail.key)).toEqual(["monitor-event/e1"]);
    expect(summary.mailStop).toBe("quota");
    expect(summary.errors).toBe(1);
    expect(summary.errorEmails).toBe(0);
  });
});

describe("runMonitorChecks — ENG-AC3: an error after the claim's provisional failure", () => {
  it("ENG-AC3runx4: record(error) carries the threshold and the daily cap; the email counts the claim's pre-check errors plus this failure", async () => {
    const inputs: RecordInput[] = [];
    const rpc = fakeRpc({
      // The claim returns the count from before this run (4) and has already stored 5.
      claimed: [monitor({ consecutive_errors: 4 })],
      record: async (input) => {
        inputs.push(input);
        // The failure count comes from the claim, not from this row.
        return {
          ...APPLIED,
          notify_error: true,
          notified_at: "2026-11-08T10:00:00.000+00:00",
          email: "user@example.com",
          url: "https://example.com/page",
          consecutive_errors: null,
        };
      },
    });
    const { mailer, sent } = capturingMailer([{ ok: true, id: "id" }]);
    const summary = await runMonitorChecks({
      rpc,
      mailer,
      fetchPage: async () => ({ ok: false, reason: "http_status", subrequests: 3 }),
      config: CONFIG,
      log: () => {},
    });

    expect(inputs).toEqual([
      {
        monitorId: "00000000-0000-0000-0000-0000000000a1",
        claimedUrl: "https://example.com/page",
        outcome: "error",
        expectedHash: null,
        newHash: null,
        snapshot: null,
        summary: null,
        errorThreshold: 3,
        dailyCap: 10,
        repay: false,
      },
    ]);
    expect(sent).toEqual([
      {
        message: {
          from: CONFIG.mailFrom,
          to: "user@example.com",
          ...buildErrorEmail({
            monitorId: "00000000-0000-0000-0000-0000000000a1",
            url: "https://example.com/page",
            label: null,
            failures: 5,
            siteUrl: CONFIG.siteUrl,
          }),
        },
        key: "monitor-error/00000000-0000-0000-0000-0000000000a1/2026-11-08T10:00:00.000+00:00",
      },
    ]);
    expect(summary.errors).toBe(1);
    expect(summary.errorEmails).toBe(1);
  });
});

describe("runMonitorChecks — ENG-AC3: monitors are checked in the order the claim returned them", () => {
  it("ENG-AC3runx5: each monitor is fetched and recorded in turn, in the claim's order (neither id nor url order), never re-sorted", async () => {
    const events: string[] = [];
    const rpc = fakeRpc({
      claimed: [
        monitor({ id: "m3", url: "https://example.com/c" }),
        monitor({ id: "m1", url: "https://example.com/a" }),
        monitor({ id: "m2", url: "https://example.com/b" }),
      ],
      record: async (input) => {
        events.push(`record ${input.monitorId}`);
        return APPLIED;
      },
    });
    const { mailer } = capturingMailer([{ ok: true, id: "id" }]);
    const summary = await runMonitorChecks({
      rpc,
      mailer,
      fetchPage: async (url) => {
        events.push(`fetch ${url}`);
        return { ok: true, body: "<p>Page</p>", contentType: "text/html", finalUrl: url, truncated: false, subrequests: 3 };
      },
      config: CONFIG,
      log: () => {},
      now: () => 0,
    });

    expect(events).toEqual([
      "fetch https://example.com/c",
      "record m3",
      "fetch https://example.com/a",
      "record m1",
      "fetch https://example.com/b",
      "record m2",
    ]);
    // pendingEmails 1 + claim 1 + 3 × (page 3 + record 1) = 14; three never-checked pages are baselines.
    expect(summary).toEqual({ ...IDLE_SUMMARY, claimed: 3, checked: 3, baselines: 3, subrequests: 14 });
  });
});

describe("runMonitorChecks — ENG-AC3: a record repays only strikes from before its claim", () => {
  it("ENG-AC3runx6: every record carries repay = the claim's prior_strikes > 0 (0 → false; 1, 2, 3 → true) for baseline, unchanged, changed and error", async () => {
    const current = await hashPageText("Page");
    const old = await hashPageText("Old page");
    // Not a real claim's shape (that has at most one monitor of an owner with strikes, last): the
    // run maps every row alike, so one fake batch covers each outcome with both repay values.
    const claimed: Array<[id: string, lastHash: string | null, priorStrikes: number]> = [
      ["m1", null, 0],
      ["m2", null, 1],
      ["m3", current, 2],
      ["m4", current, 0],
      ["m5", old, 3],
      ["m6", old, 0],
      ["m7", null, 1],
      ["m8", null, 0],
    ];
    const inputs: RecordInput[] = [];
    const rpc = fakeRpc({
      claimed: claimed.map(([id, lastHash, priorStrikes]) => monitor({
        id,
        user_id: `owner-${id}`,
        url: `https://example.com/${id}`,
        last_hash: lastHash,
        prior_strikes: priorStrikes,
      })),
      snapshot: "Old page",
      record: async (input) => {
        inputs.push(input);
        return APPLIED;
      },
    });
    const { mailer } = capturingMailer([{ ok: true, id: "id" }]);
    const summary = await runMonitorChecks({
      rpc,
      mailer,
      // m7 and m8 fail to fetch (error); every other page reads "Page".
      fetchPage: async (url) => (url.endsWith("/m7") || url.endsWith("/m8")
        ? { ok: false, reason: "http_status", subrequests: 3 }
        : { ok: true, body: "<p>Page</p>", contentType: "text/html", finalUrl: url, truncated: false, subrequests: 3 }),
      config: { ...CONFIG, batchSize: 8 },
      log: () => {},
      now: () => 0,
    });

    expect(inputs.map((input) => [input.monitorId, input.outcome, input.repay])).toEqual([
      ["m1", "baseline", false],
      ["m2", "baseline", true],
      ["m3", "unchanged", true],
      ["m4", "unchanged", false],
      ["m5", "changed", true],
      ["m6", "changed", false],
      ["m7", "error", true],
      ["m8", "error", false],
    ]);
    // pendingEmails 1 + claim 1 + 8 × (page 3 + record 1) + 2 snapshots (the changed checks) = 36;
    // m2, m3, m5 and m7 were claimed with prior_strikes above 0.
    expect(summary).toEqual({
      ...IDLE_SUMMARY,
      claimed: 8,
      strikerClaimed: 4,
      checked: 8,
      baselines: 2,
      unchanged: 2,
      changed: 2,
      errors: 2,
      batchFull: true,
      subrequests: 36,
    });
  });

  it("ENG-AC3runx7: strikerClaimed counts the claimed monitors with prior_strikes above 0, in the run's log line", async () => {
    const logLines: string[] = [];
    const summary = await runMonitorChecks({
      // Two rows with prior_strikes above 0: not a real claim's shape (that has at most one), but
      // the run counts whatever the claim returned.
      rpc: fakeRpc({
        claimed: [
          monitor({ id: "m1", user_id: "owner-1", prior_strikes: 0 }),
          monitor({ id: "m2", user_id: "owner-2", prior_strikes: 0 }),
          monitor({ id: "m3", user_id: "owner-3", prior_strikes: 1 }),
          monitor({ id: "m4", user_id: "owner-4", prior_strikes: 3 }),
        ],
      }),
      mailer: capturingMailer([{ ok: true, id: "id" }]).mailer,
      fetchPage: page("<p>x</p>"),
      config: CONFIG,
      log: (line) => logLines.push(line),
      now: () => 0,
    });
    // pendingEmails 1 + claim 1 + 4 × (page 3 + record 1) = 18; four never-checked pages are baselines.
    const expected = { ...IDLE_SUMMARY, claimed: 4, strikerClaimed: 2, checked: 4, baselines: 4, subrequests: 18 };
    expect(summary).toEqual(expected);
    expect(logLines.map((line) => JSON.parse(line) as unknown)).toEqual([{ msg: "monitor-cron run", ...expected }]);
  });
});
