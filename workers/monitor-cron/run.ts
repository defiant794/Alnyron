import {
  MONITOR_CHECK_SUBREQUESTS,
  MONITOR_CHECK_WALL_MS,
  MONITOR_DAILY_EMAIL_CAP,
  MONITOR_DUE_GRACE_MINUTES,
  MONITOR_EMAIL_SEND_TIMEOUT_MS,
  MONITOR_ERROR_THRESHOLD,
  MONITOR_RPC_TIMEOUT_MS,
  MONITOR_RUN_WALL_LIMIT_MS,
  MONITOR_SIGNUP_NOTICE_DAILY_CAP,
  MONITOR_SIGNUP_NOTICE_PER_RUN,
  MONITOR_UNCONFIRMED_PURGE_BATCH,
} from "@/config/monitor";
import type { EmailMessage, SendFailure, SendResult } from "@/lib/email/resend";
import { buildChangeEmail, buildErrorEmail } from "@/lib/monitor/change-email";
import { summarizeChange } from "@/lib/monitor/change-summary";
import { fetchMonitorPage, type PageFetchResult } from "@/lib/monitor/page-fetch";
import { hashPageText, isCurrentPageHash, pageSnapshot, pageText } from "@/lib/monitor/page-text";
import { buildSignupNoticeEmail } from "@/lib/monitor/signup-notice-email";
import {
  EngineRpcError,
  type ClaimedMonitor,
  type EngineOp,
  type EngineRpc,
  type PendingEmail,
  type PendingSignup,
  type RecordInput,
  type RecordResult,
} from "./rpc";

/** Sends one email; `idempotencyKey` makes a retry of the same email a no-op at the provider. */
export type Mailer = (message: EmailMessage, idempotencyKey: string) => Promise<SendResult>;

export type RunConfig = { batchSize: number; subrequestLimit: number; siteUrl: string; mailFrom: string };

/**
 * Counters of one run and its first failed engine call: the run's only log line. Holds no URL,
 * address, page text or key, and no error message (it may echo a call's arguments).
 */
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
  /** Owner notices of new confirmed signups handed to the provider (a rejected one is not counted). */
  signupNotices: number;
  /**
   * New confirmed signups this run did not notify: those the lookup did not return (beyond the
   * per-run limit or the daily notice cap; only reported when it returned one), one without an
   * owner address, or one held back by a send failure that stopped sending.
   */
  signupNoticesDeferred: number;
  /** Stale unconfirmed `monitor_user` accounts deleted. */
  purged: number;
  mailStop: SendFailure | null;
  /**
   * The budget held work back: no claim or a smaller one that came back full (due monitors may
   * wait), a deferred email, the skipped second sweep, a lost error email, or (only after a check
   * cost more than its worst case) a leased monitor left unchecked. Either budget: the
   * subrequests left, or the run's wall-clock time ({@link MONITOR_RUN_WALL_LIMIT_MS}, with every
   * call taking its whole timeout). The purge and the signup notice, the run's last steps, never
   * set it: they only use what the checks left, and skipping them holds back no monitor.
   */
  budgetStop: boolean;
  /** The claim returned `batchSize` monitors: more may be due. */
  batchFull: boolean;
  subrequests: number;
  rpcErrors: number;
  /**
   * The run's first failed engine call, null when none failed: the {@link EngineRpc} method
   * (`op`), the error code ({@link EngineRpcError}'s; `unknown` for any other error) and the
   * HTTP status of the call's answer (null when it got none, a network failure or an abort after
   * {@link MONITOR_RPC_TIMEOUT_MS}, and for any error other than an {@link EngineRpcError}).
   * Later failed calls never replace it. A failure outside an engine call (a page fetch that
   * threw) counts in `rpcErrors` but is not reported here.
   */
  rpcError: { op: EngineOp; code: string; status: number | null } | null;
  durationMs: number;
};

/** Subrequests one email needs: the send and its mark call (`markEmailed` / `markSignupNotified`). */
const EMAIL_SUBREQUESTS = 2;

/** Subrequests an email sweep (change events or signup notices) needs at least: the lookup plus one email. */
const SWEEP_SUBREQUESTS = 1 + EMAIL_SUBREQUESTS;

/** Run time one email may take: its send and its mark call, each at its whole timeout. */
const EMAIL_WALL_MS = MONITOR_EMAIL_SEND_TIMEOUT_MS + MONITOR_RPC_TIMEOUT_MS;

/** Run time an email sweep needs at least: the lookup plus one email, at their timeouts. */
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
 * 4. email the events this run created;
 * 5. delete up to {@link MONITOR_UNCONFIRMED_PURGE_BATCH} `monitor_user`
 *    accounts still unconfirmed 24 hours after signup (frees stuck addresses
 *    and bounds stale pre-registrations; the pre-registered password itself
 *    is emptied by a database trigger when `confirmation_sent_at` changes from
 *    a non-NULL value or `recovery_sent_at` to a new non-NULL value, e.g. once
 *    the address signs up again, a confirmation is resent or a password reset
 *    is sent, see the README), when a subrequest and one database call's run
 *    time are left;
 * 6. last, unless sending stopped this run: tell the site owner (the first
 *    `owner` profile's address) about up to
 *    {@link MONITOR_SIGNUP_NOTICE_PER_RUN} new confirmed `monitor_user`
 *    accounts, at most {@link MONITOR_SIGNUP_NOTICE_DAILY_CAP} per rolling
 *    24 hours, when the lookup plus one notice still fit both budgets.
 *
 * Steps 5 and 6 come after every check and only use what the checks left: they
 * change neither the claim's size nor `budgetStop`, and skipping them for
 * budget holds nothing back that the next run cannot do. A signup notice is
 * built from the lookup's row only and sent with the key
 * `monitor-signup/<user id>`, then the account is stamped notified; a
 * rejection stamps it too (no retry), any other failure stops sending and
 * leaves it for a later run (inside the lookup's 23 h window). Without an
 * owner address nothing is sent or stamped. A notice sent but not stamped (the
 * mark call failed) is sent again next run under the same key; its `waiting`
 * count may have changed since, and Resend answers a key reused with a
 * different payload with a 409 that `sendEmail` reports as a rejection, so the
 * account is then stamped without a second email and sending goes on.
 *
 * Every change email is built from the stored event plus the monitor's current
 * URL and label and the owner's current address, and sent with the key
 * `monitor-event/<event id>`; a rate-limit, quota, config or transient failure
 * stops sending for the rest of the run and leaves the events pending, a
 * rejection marks the event emailed (no retry). A change email sent but not
 * marked (the mark call failed) is sent again next run under the same key: for
 * the same payload Resend returns the first send's result instead of a second
 * email, and a retry whose payload changed (the monitor renamed or its URL
 * edited, or the owner's address changed, meanwhile) gets Resend's 409
 * `invalid_idempotent_request` (per Resend's docs as of 2026-11): `sendEmail`
 * reports it as a rejection, so the event is marked and counted in
 * `emailsRejected`, with no second email, and sending goes on. The first send
 * under that key was most likely delivered (inferred; Resend's docs don't say
 * so). The run stays within `subrequestLimit` (Cloudflare's
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
 * The run never throws: failed database calls are counted in `rpcErrors`, and
 * the first of them is reported in `rpcError` (its {@link EngineRpc} method,
 * error code and HTTP status). Logs exactly one line, the {@link RunSummary} as
 * JSON.
 */
export async function runMonitorChecks(deps: {
  rpc: EngineRpc;
  mailer: Mailer;
  fetchPage?: (url: string) => Promise<PageFetchResult>;
  config: RunConfig;
  log?: (line: string) => void;
  now?: () => number;
}): Promise<RunSummary> {
  const { config } = deps;
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
    signupNotices: 0,
    signupNoticesDeferred: 0,
    purged: 0,
    mailStop: null,
    budgetStop: false,
    batchFull: false,
    subrequests: 0,
    rpcErrors: 0,
    rpcError: null,
    durationMs: 0,
  };
  const remaining = () => config.subrequestLimit - summary.subrequests;
  /** Run time so far, by the injected clock. */
  const elapsed = () => now() - started;
  /** Whether work started now that takes at most `worstCaseMs` still ends by the wall limit. */
  const fitsWall = (worstCaseMs: number) => elapsed() + worstCaseMs <= MONITOR_RUN_WALL_LIMIT_MS;

  /**
   * Makes one engine call. When it is the run's first to fail, notes it in `summary.rpcError`;
   * the error is rethrown either way, for the step that counts it in `rpcErrors`.
   */
  async function engineCall<T>(op: EngineOp, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (summary.rpcError === null) {
        summary.rpcError =
          error instanceof EngineRpcError
            ? { op, code: error.code, status: error.status }
            : { op, code: "unknown", status: null };
      }
      throw error;
    }
  }

  /** `deps.rpc` with every method called through {@link engineCall} under its own name. */
  const rpc: EngineRpc = {
    claim: (...args) => engineCall("claim", () => deps.rpc.claim(...args)),
    snapshot: (...args) => engineCall("snapshot", () => deps.rpc.snapshot(...args)),
    record: (...args) => engineCall("record", () => deps.rpc.record(...args)),
    pendingEmails: (...args) => engineCall("pendingEmails", () => deps.rpc.pendingEmails(...args)),
    markEmailed: (...args) => engineCall("markEmailed", () => deps.rpc.markEmailed(...args)),
    pendingSignups: (...args) => engineCall("pendingSignups", () => deps.rpc.pendingSignups(...args)),
    markSignupNotified: (...args) => engineCall("markSignupNotified", () => deps.rpc.markSignupNotified(...args)),
    purgeUnconfirmed: (...args) => engineCall("purgeUnconfirmed", () => deps.rpc.purgeUnconfirmed(...args)),
  };

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
        // Sent again next run under the same key: Resend sends no second email, deduplicating
        // the same payload and answering a changed one (monitor URL/label or owner address
        // edited) with a 409 that `sendEmail` reports as a rejection, so the event is marked then.
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

  /**
   * Deletes stale unconfirmed `monitor_user` accounts (one subrequest), when a subrequest and one
   * database call's run time are left; sending having stopped does not matter here.
   */
  async function purgeUnconfirmed(): Promise<void> {
    if (remaining() < 1 || !fitsWall(MONITOR_RPC_TIMEOUT_MS)) return;
    summary.subrequests += 1;
    try {
      summary.purged += await rpc.purgeUnconfirmed(MONITOR_UNCONFIRMED_PURGE_BATCH);
    } catch {
      summary.rpcErrors += 1;
    }
  }

  /**
   * Tells the site owner about new confirmed signups: the lookup (one subrequest), then per
   * returned account a notice to the first owner address and its stamp, until done or a send
   * failure or a budget stops it. Starts only while sending has not stopped and the lookup plus
   * one notice fit both budgets. Every row carries the same `waiting` count (the accounts the
   * lookup did not return), so it is counted once. The notice of an account without an owner
   * address is deferred, not sent or stamped; a rejected one is stamped (no retry).
   */
  async function signupSweep(): Promise<void> {
    if (summary.mailStop !== null || remaining() < SWEEP_SUBREQUESTS || !fitsWall(SWEEP_WALL_MS)) return;
    summary.subrequests += 1;
    let rows: PendingSignup[];
    try {
      rows = await rpc.pendingSignups(MONITOR_SIGNUP_NOTICE_PER_RUN, MONITOR_SIGNUP_NOTICE_DAILY_CAP);
    } catch {
      summary.rpcErrors += 1;
      return;
    }
    summary.signupNoticesDeferred += rows[0]?.waiting ?? 0;
    for (const [index, row] of rows.entries()) {
      if (summary.mailStop !== null || remaining() < EMAIL_SUBREQUESTS || !fitsWall(EMAIL_WALL_MS)) {
        summary.signupNoticesDeferred += rows.length - index;
        return;
      }
      const owner = row.owner_emails[0];
      if (owner === undefined) {
        summary.signupNoticesDeferred += 1;
        continue;
      }
      const content = buildSignupNoticeEmail({ email: row.email, confirmedAt: row.confirmed_at, waiting: row.waiting });
      const result = await send({ from: config.mailFrom, to: owner, ...content }, `monitor-signup/${row.user_id}`);
      if (!result.ok && result.kind !== "rejected") {
        summary.mailStop = result.kind;
        summary.signupNoticesDeferred += rows.length - index;
        return;
      }
      if (result.ok) summary.signupNotices += 1;
      summary.subrequests += 1;
      try {
        await rpc.markSignupNotified(row.user_id);
      } catch {
        // Sent again next run under the same key: Resend returns the first send's result for the
        // same payload, and a 409 (a rejection: stamped, no second email) when `waiting` changed.
        summary.rpcErrors += 1;
      }
    }
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

    // Last, with whatever the checks left: neither touches the claim or budgetStop.
    await purgeUnconfirmed();
    await signupSweep();
  } finally {
    summary.durationMs = elapsed();
    const log = deps.log ?? ((line: string) => console.log(line));
    log(JSON.stringify({ msg: "monitor-cron run", ...summary }));
  }
  return summary;
}
