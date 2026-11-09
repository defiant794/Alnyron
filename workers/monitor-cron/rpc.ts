import { createClient } from "@supabase/supabase-js";
import { MONITOR_RPC_TIMEOUT_MS } from "@/config/monitor";
import type { Database } from "@/types/database";

/**
 * The cron's only door to the database: typed wrappers around the five
 * `monitor_engine_*` functions (migration 20261108000100, EXECUTE for
 * service_role only). Row shapes are written out here because the generated
 * types cannot express which returned columns may be NULL.
 */

/**
 * A monitor `monitor_engine_claim` leased for this run. The claim also counted
 * a provisional failure on it (reset by a successful record) and a strike on
 * its owner (taken off by any record), so `consecutive_errors` is the count
 * from BEFORE this run's check, and `prior_strikes` the owner's strikes from
 * before this claim (an overlapping run's unrecorded checks included).
 */
export type ClaimedMonitor = {
  id: string;
  user_id: string;
  url: string;
  last_hash: string | null;
  consecutive_errors: number;
  prior_strikes: number;
};

export type CheckOutcome = "unchanged" | "baseline" | "changed" | "error";

export type RecordInput = {
  monitorId: string;
  /** The URL the run claimed and fetched; the write is skipped when the monitor now has another. */
  claimedUrl: string;
  outcome: CheckOutcome;
  /** `changed`: the stored hash the new one was compared with. */
  expectedHash: string | null;
  /** `baseline` / `changed`: the new page hash. */
  newHash: string | null;
  /** `baseline` / `changed`: the new snapshot (already capped). */
  snapshot: string | null;
  /** `changed`: the change summary, if any. */
  summary: string | null;
  errorThreshold: number;
  /** Monitor emails (change + error) per user per rolling 24 h: an error notification at the cap is not claimed. */
  dailyCap: number;
  /**
   * The claim's `prior_strikes > 0`: a good result (applied unchanged / baseline / changed) then
   * also repays one strike its owner had before the claim, possibly one of an overlapping run's
   * unrecorded checks, never one added by the same claim (it leases at most one monitor of all
   * owners with strikes).
   */
  repay: boolean;
};

/** `monitor_engine_record`'s one row: whether it applied, and the event or error notification it produced. */
export type RecordResult = {
  applied: boolean;
  event_id: string | null;
  notify_error: boolean;
  notified_at: string | null;
  email: string | null;
  url: string | null;
  label: string | null;
  /** The stored count after the record: 0 after a success; after an error, this run's failure included (counted by the claim). */
  consecutive_errors: number | null;
};

/** A change event waiting for its email (`monitor_engine_pending_emails`). */
export type PendingEmail = {
  event_id: string;
  monitor_id: string;
  user_id: string;
  email: string;
  url: string;
  label: string | null;
  detected_at: string;
  summary: string | null;
};

export type EngineRpc = {
  /**
   * Leased monitors in check order: owners without strikes first, then oldest
   * `coalesce(last_checked_at, created_at)`, then id; last, at most one monitor of all owners
   * with strikes together, the first of their due ones in that order.
   */
  claim(limit: number, graceMinutes: number, errorThreshold: number): Promise<ClaimedMonitor[]>;
  snapshot(monitorId: string): Promise<string | null>;
  record(input: RecordInput): Promise<RecordResult>;
  pendingEmails(limit: number, dailyCap: number): Promise<PendingEmail[]>;
  markEmailed(eventId: string): Promise<boolean>;
};

/**
 * A failed engine call. Carries only the PostgREST/Postgres error code
 * (`unknown` for a request without an answer: a network failure, or one
 * aborted after {@link MONITOR_RPC_TIMEOUT_MS}), never the message or details
 * (which may echo arguments such as URLs).
 */
export class EngineRpcError extends Error {
  constructor(readonly code: string) {
    super(`monitor engine rpc failed (${code})`);
    this.name = "EngineRpcError";
  }
}

/** Unwraps a supabase-js result, turning an error into an {@link EngineRpcError}. */
function unwrap<T>({ data, error }: { data: T | null; error: { code?: string } | null }): T | null {
  if (error) throw new EngineRpcError(error.code || "unknown");
  return data;
}

/**
 * The engine client's `fetch` (supabase-js `global.fetch`): every request, its
 * response body included, is aborted after {@link MONITOR_RPC_TIMEOUT_MS}
 * (`AbortSignal.timeout`), and still by a signal the caller passed. supabase-js
 * returns the abort as an error result, so an aborted call throws an
 * {@link EngineRpcError} like any other failed call. That bounds the run time
 * of every database call the cron run reserves for.
 */
export const rpcFetch: typeof fetch = (input, init) => {
  const timeout = AbortSignal.timeout(MONITOR_RPC_TIMEOUT_MS);
  return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
};

/**
 * {@link EngineRpc} over supabase-js with the Supabase secret key (no session,
 * no token refresh), every call aborted after {@link MONITOR_RPC_TIMEOUT_MS}
 * ({@link rpcFetch}).
 */
export function createSupabaseEngineRpc(url: string, secretKey: string): EngineRpc {
  const client = createClient<Database>(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: rpcFetch },
  });

  return {
    async claim(limit, graceMinutes, errorThreshold) {
      const rows = unwrap(
        await client.rpc("monitor_engine_claim", {
          p_limit: limit,
          p_grace_minutes: graceMinutes,
          p_error_threshold: errorThreshold,
        }),
      );
      return rows ?? [];
    },

    async snapshot(monitorId) {
      return unwrap(await client.rpc("monitor_engine_snapshot", { p_monitor_id: monitorId }));
    },

    async record(input) {
      // Omitted (undefined) optional arguments take their SQL default, NULL.
      const rows = unwrap(
        await client.rpc("monitor_engine_record", {
          p_monitor_id: input.monitorId,
          p_claimed_url: input.claimedUrl,
          p_outcome: input.outcome,
          p_expected_hash: input.expectedHash ?? undefined,
          p_new_hash: input.newHash ?? undefined,
          p_snapshot: input.snapshot ?? undefined,
          p_summary: input.summary ?? undefined,
          p_error_threshold: input.errorThreshold,
          p_daily_cap: input.dailyCap,
          p_repay: input.repay,
        }),
      );
      const row = rows?.[0];
      if (row === undefined) throw new EngineRpcError("no_row");
      return row;
    },

    async pendingEmails(limit, dailyCap) {
      const rows = unwrap(
        await client.rpc("monitor_engine_pending_emails", { p_limit: limit, p_daily_cap: dailyCap }),
      );
      return rows ?? [];
    },

    async markEmailed(eventId) {
      return unwrap(await client.rpc("monitor_engine_mark_emailed", { p_event_id: eventId })) === true;
    },
  };
}
