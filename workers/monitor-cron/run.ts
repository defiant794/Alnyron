import {
  MONITOR_CHECK_SUBREQUESTS,
  MONITOR_CHECK_WALL_MS,
  MONITOR_DAILY_EMAIL_CAP,
  MONITOR_DUE_GRACE_MINUTES,
  MONITOR_EMAIL_SEND_TIMEOUT_MS,
  MONITOR_ERROR_THRESHOLD,
  MONITOR_RPC_TIMEOUT_MS,
  MONITOR_RUN_WALL_LIMIT_MS,
} from "@/config/monitor";
import type { EmailMessage, SendFailure, SendResult } from "@/lib/email/resend";
import { buildChangeEmail, buildErrorEmail } from "@/lib/monitor/change-email";
import { summarizeChange } from "@/lib/monitor/change-summary";
import { fetchMonitorPage, type PageFetchResult } from "@/lib/monitor/page-fetch";
import { hashPageText, isCurrentPageHash, pageSnapshot, pageText } from "@/lib/monitor/page-text";
import type { ClaimedMonitor, EngineRpc, PendingEmail, RecordInput, RecordResult } from "./rpc";

/** Sends one email; `idempotencyKey` makes a retry of the same email a no-op at the provider. */
export type Mailer = (message: EmailMessage, idempotencyKey: string) => Promise<SendResult>;

export type RunConfig = { batchSize: number; subrequestLimit: number; siteUrl: string; mailFrom: string };

/** Counters of one run: the run's only log line. Holds no URL, address, page text or key. */
export type RunSummary = {
  claimed: number;
  /** Claimed monitors whose owner had strikes before the claim (`prior_strikes > 0`). */
  strikerClaimed: number;
  checked: number;
  unchanged: number;
  baselines: number;
  changed: number;
  errors: number;
  staleSkips: number;
  emailsSent: number;
  emailsDeferred: number;
  emailsRejected: number;
  errorEmails: number;
  mailStop: SendFailure | null;
  /**
   * The budget held work back: no claim or a smaller one that came back full (due monitors may
   * wait), a deferred email, the skipped second sweep, a lost error email, or (only after a check
   * cost more than its worst case) a leased monitor left unchecked. Either budget: the
   * subrequests left, or the run's wall-clock time ({@link MONITOR_RUN_WALL_LIMIT_MS}, with every
   * call taking its whole timeout).
   */
  budgetStop: boolean;
  /** The claim returned `batchSize` monitors: more may be due. */
  batchFull: boolean;
  subrequests: number;
  rpcErrors: number;
  durationMs: number;
};

/** Subrequests one change email needs: the send and `markEmailed`. */
const EMAIL_SUBREQUESTS = 2;

/** Subrequests the second email sweep needs at least: `pendingEmails` plus one email. */
const SWEEP_SUBREQUESTS = 1 + EMAIL_SUBREQUESTS;

/** Run time one change email may take: its send and `markEmailed`, each at its whole timeout. */
const EMAIL_WALL_MS = MONITOR_EMAIL_SEND_TIMEOUT_MS + MONITOR_RPC_TIMEOUT_MS;

/** Run time the second email sweep needs at least: `pendingEmails` plus one email, at their timeouts. */
const SWEEP_WALL_MS = MONITOR_RPC_TIMEOUT_MS + EMAIL_WALL_MS;

/**
 * One cron run of the monitor engine:
 * 1. email pending change events (older runs' unsent ones first);
 * 2. lease up to `batchSize` due monitors, no more than the subrequests left
 *    after the claim can check at their worst case, and no more than can be
 *    checked before {@link MONITOR_RUN_WALL_LIMIT_MS} at their worst case
 *    ({@link MONITOR_CHECK_WALL_MS} each) once the claim call itself has taken
 *    its whole {@link MONITOR_RPC_TIMEOUT_MS} (at most 24 per run); the claim
 *    also counts a provisional failure on each, which a successful record
 *    resets (a run that dies before recording, e.g. on the CPU limit, still
 *    backs the monitor off), and a strike on its owner, which every record
 *    takes off again;
 * 3. check each, strictly in the order the claim returned them (owners without
 *    strikes first, then oldest; then at most one monitor of all owners with
 *    strikes together, the oldest due one), so a page that kills the run
 *    leaves only the monitors after it unchecked, and once its owner has
 *    strikes none (it is the batch's last check):
 *    fetch, hash, and record unchanged / baseline / changed / error (an error
 *    streak's first notification emailed at once, unless the owner is at the
 *    daily email cap, which counts change and error emails alike) with `repay`
 *    = the claim's `prior_strikes > 0`: a good result then also repays one
 *    strike its owner had before the claim (an overlapping run's unrecorded
 *    checks count too), never one added by the same claim (it leases at most
 *    one monitor of all owners with strikes), so an owner whose page kills the
 *    run keeps that check's strike, and the page stays its batch's last check
 *    until a good check from a later claim repays it, unless a good check in an
 *    overlapping run, claimed while that page was being checked, already repaid
 *    it (an accepted residual, see the README's "Accepted residuals");
 * 4. email the events this run created.
 *
 * Every change email is built from the stored event row only and sent with the
 * key `monitor-event/<event id>`, so a retry within Resend's 24 h window cannot
 * send twice; a rate-limit, quota, config or transient failure stops sending
 * for the rest of the run and leaves the events pending, a rejection marks the
 * event emailed (no retry). The run stays within `subrequestLimit` (Cloudflare's
 * per-invocation subrequest cap) by not starting a claim, check, email or sweep
 * it could not finish, and within {@link MONITOR_RUN_WALL_LIMIT_MS} (Cloudflare
 * stops a cron run after 15 minutes) by not starting a claim, email or second
 * sweep that could end after it with every call taking its whole timeout (page
 * fetch 15 s, email send {@link MONITOR_EMAIL_SEND_TIMEOUT_MS}, database call
 * {@link MONITOR_RPC_TIMEOUT_MS}), run time read from the injected clock (on
 * Workers, `Date.now()` moves on at each I/O). The claim reserves a worst-case
 * check for every monitor it leases, in subrequests
 * ({@link MONITOR_CHECK_SUBREQUESTS}) and in run time
 * ({@link MONITOR_CHECK_WALL_MS}: fetch, error email, snapshot and record), and
 * no check is skipped for time, so neither budget leaves a leased monitor
 * unchecked: its provisional failure stays only when the run dies, a database
 * call fails (an aborted one included; a claim whose answer is lost may still
 * have leased its monitors), or the record's guard refuses a change (monitor
 * paused mid-check, or its stored hash moved), and its owner's strike only when
 * the run dies or a database call fails. A URL edited mid-check resets the
 * failure count instead, and the guard drops the stale result. A change email
 * or the second sweep skipped for time leaves its events pending, like one
 * skipped for subrequests, and counts as a budget stop; an error notification
 * is skipped for time only after a call ran past its timeout (it is then lost).
 * The run never throws: failed database calls are counted in `rpcErrors`. Logs
 * exactly one line, the {@link RunSummary} as JSON.
 */
export async function runMonitorChecks(deps: {
  rpc: EngineRpc;
  mailer: Mailer;
  fetchPage?: (url: string) => Promise<PageFetchResult>;
  config: RunConfig;
  log?: (line: string) => void;
  now?: () => number;
}): Promise<RunSummary> {
  const { rpc, config } = deps;
  const fetchPage = deps.fetchPage ?? ((url: string) => fetchMonitorPage(url));
  const now = deps.now ?? Date.now;
  const started = now();
  const summary: RunSummary = {
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
  const remaining = () => config.subrequestLimit - summary.subrequests;
  /** Run time so far, by the injected clock. */
  const elapsed = () => now() - started;
  /** Whether work started now that takes at most `worstCaseMs` still ends by the wall limit. */
  const fitsWall = (worstCaseMs: number) => elapsed() + worstCaseMs <= MONITOR_RUN_WALL_LIMIT_MS;

  /** Sends through the mailer, counting the subrequest; a throwing mailer counts as a transient failure. */
  async function send(message: EmailMessage, idempotencyKey: string): Promise<SendResult> {
    summary.subrequests += 1;
    try {
      return await deps.mailer(message, idempotencyKey);
    } catch {
      return { ok: false, kind: "transient", status: null };
    }
  }

  /** Emails the pending change events in order until done, a send failure or a budget stops it. */
  async function sendPending(rows: readonly PendingEmail[]): Promise<void> {
    for (const [index, row] of rows.entries()) {
      if (summary.mailStop !== null || remaining() < EMAIL_SUBREQUESTS || !fitsWall(EMAIL_WALL_MS)) {
        if (summary.mailStop === null) summary.budgetStop = true;
        summary.emailsDeferred += rows.length - index;
        return;
      }
      const content = buildChangeEmail({
        eventId: row.event_id,
        monitorId: row.monitor_id,
        url: row.url,
        label: row.label,
        detectedAt: row.detected_at,
        summary: row.summary,
        siteUrl: config.siteUrl,
      });
      const result = await send({ from: config.mailFrom, to: row.email, ...content }, `monitor-event/${row.event_id}`);
      if (!result.ok && result.kind !== "rejected") {
        summary.mailStop = result.kind;
        summary.emailsDeferred += rows.length - index;
        return;
      }
      if (result.ok) summary.emailsSent += 1;
      else summary.emailsRejected += 1;
      summary.subrequests += 1;
      try {
        await rpc.markEmailed(row.event_id);
      } catch {
        // Resent next run under the same idempotency key, which Resend deduplicates.
        summary.rpcErrors += 1;
      }
    }
  }

  /** Fetches the pending events (one subrequest) and emails them. */
  async function emailSweep(): Promise<void> {
    summary.subrequests += 1;
    let rows: PendingEmail[];
    try {
      rows = await rpc.pendingEmails(config.batchSize, MONITOR_DAILY_EMAIL_CAP);
    } catch {
      summary.rpcErrors += 1;
      return;
    }
    await sendPending(rows);
  }

  async function record(input: Omit<RecordInput, "errorThreshold" | "dailyCap">): Promise<RecordResult> {
    summary.subrequests += 1;
    const result = await rpc.record({ ...input, errorThreshold: MONITOR_ERROR_THRESHOLD, dailyCap: MONITOR_DAILY_EMAIL_CAP });
    if (!result.applied) summary.staleSkips += 1;
    return result;
  }

  /**
   * Emails the one notification of an error streak, unless sending already stopped this run.
   * Without a subrequest left for it, or without the run time of a change email's send (checked
   * like one, though the claim reserved it in both budgets: only a check that cost more than its
   * worst case gets here), the notification is lost (`record` already claimed it and logged it
   * against the daily cap), so that counts as a budget stop. The failure count is the claim's
   * pre-check count plus this run's failure (the claim counted it; `record(error)` adds nothing).
   */
  async function sendErrorEmail(monitor: ClaimedMonitor, result: RecordResult): Promise<void> {
    if (result.email === null || result.notified_at === null || summary.mailStop !== null) return;
    if (remaining() < 1 || !fitsWall(EMAIL_WALL_MS)) {
      summary.budgetStop = true;
      return;
    }
    const content = buildErrorEmail({
      monitorId: monitor.id,
      url: result.url ?? monitor.url,
      label: result.label,
      failures: monitor.consecutive_errors + 1,
      siteUrl: config.siteUrl,
    });
    const sent = await send(
      { from: config.mailFrom, to: result.email, ...content },
      `monitor-error/${monitor.id}/${result.notified_at}`,
    );
    if (sent.ok) summary.errorEmails += 1;
    else if (sent.kind !== "rejected") summary.mailStop = sent.kind;
  }

  /** Checks one leased monitor and records the outcome; returns whether it created a change event. */
  async function check(monitor: ClaimedMonitor): Promise<boolean> {
    const page = await fetchPage(monitor.url);
    summary.subrequests += page.subrequests;
    const base = {
      monitorId: monitor.id,
      claimedUrl: monitor.url,
      expectedHash: null,
      summary: null,
      repay: monitor.prior_strikes > 0,
    };

    if (!page.ok) {
      const result = await record({ ...base, outcome: "error", newHash: null, snapshot: null });
      if (!result.applied) return false;
      summary.errors += 1;
      if (result.notify_error) await sendErrorEmail(monitor, result);
      return false;
    }

    const text = pageText(page.body, page.contentType);
    const hash = await hashPageText(text);
    const snapshot = pageSnapshot(text);

    if (monitor.last_hash === null || !isCurrentPageHash(monitor.last_hash)) {
      // First check, or a hash from an older pageText: a silent new baseline.
      if ((await record({ ...base, outcome: "baseline", newHash: hash, snapshot })).applied) summary.baselines += 1;
      return false;
    }
    if (monitor.last_hash === hash) {
      if ((await record({ ...base, outcome: "unchanged", newHash: null, snapshot: null })).applied) {
        summary.unchanged += 1;
      }
      return false;
    }

    summary.subrequests += 1;
    const oldSnapshot = await rpc.snapshot(monitor.id);
    const result = await record({
      ...base,
      outcome: "changed",
      expectedHash: monitor.last_hash,
      newHash: hash,
      snapshot,
      summary: summarizeChange(oldSnapshot, snapshot),
    });
    if (result.applied) summary.changed += 1;
    return result.applied && result.event_id !== null;
  }

  try {
    await emailSweep();

    let claimed: ClaimedMonitor[] = [];
    // After the claim's own subrequest, one worst-case check per leased monitor; after the claim
    // call's own timeout, MONITOR_CHECK_WALL_MS per leased monitor before the wall limit.
    const claimLimit = Math.min(
      config.batchSize,
      Math.floor((remaining() - 1) / MONITOR_CHECK_SUBREQUESTS),
      Math.floor((MONITOR_RUN_WALL_LIMIT_MS - elapsed() - MONITOR_RPC_TIMEOUT_MS) / MONITOR_CHECK_WALL_MS),
    );
    if (claimLimit < 1) {
      // Nothing leased: the due monitors stay due for the next run.
      summary.budgetStop = true;
    } else {
      summary.subrequests += 1;
      try {
        claimed = await rpc.claim(claimLimit, MONITOR_DUE_GRACE_MINUTES, MONITOR_ERROR_THRESHOLD);
      } catch {
        summary.rpcErrors += 1;
      }
      // A claim the budget cut below the batch size came back full: more monitors may be due.
      if (claimLimit < config.batchSize && claimed.length === claimLimit) summary.budgetStop = true;
    }
    summary.claimed = claimed.length;
    summary.strikerClaimed = claimed.filter((monitor) => monitor.prior_strikes > 0).length;
    summary.batchFull = claimed.length === config.batchSize;

    let eventsCreated = 0;
    // In the claim's order, never re-sorted: the one monitor of an owner with strikes, if any,
    // comes last.
    for (const monitor of claimed) {
      if (remaining() < MONITOR_CHECK_SUBREQUESTS) {
        // Backstop that keeps the run inside its limit: the claim reserved a worst-case check per
        // monitor, so only a check costing more than that (an injected page result over a real
        // fetch's 12) gets here.
        summary.budgetStop = true;
        break;
      }
      summary.checked += 1;
      try {
        if (await check(monitor)) eventsCreated += 1;
      } catch {
        summary.rpcErrors += 1;
      }
    }

    if (eventsCreated > 0 && summary.mailStop === null) {
      if (remaining() >= SWEEP_SUBREQUESTS && fitsWall(SWEEP_WALL_MS)) await emailSweep();
      else summary.budgetStop = true;
    }
  } finally {
    summary.durationMs = elapsed();
    const log = deps.log ?? ((line: string) => console.log(line));
    log(JSON.stringify({ msg: "monitor-cron run", ...summary }));
  }
  return summary;
}
