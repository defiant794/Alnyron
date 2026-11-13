import { createClient } from "@supabase/supabase-js";
import {
  ENTITLING_SUBSCRIPTION_STATUSES,
  PAYMENTS_MAX_DUPLICATE_CANDIDATES,
  PAYMENTS_RPC_TIMEOUT_MS,
} from "@/config/payments";
import { asRecord, type InvoicePayload, type RpcEvent, type SubscriptionPayload } from "@/lib/payments/webhook-mapping";
import type { Database } from "@/types/database";

/**
 * The webhook Worker's only door to Supabase: the two service-role-only
 * writers of migration 20261112000100 (`payments_sync_subscription`,
 * `payments_record_subscription_invoice`), one read of `subscriptions`, and
 * one Supabase Auth lookup (whether an account exists). Every subscription
 * rule (event dedupe, staleness, final statuses, the billing customer, the
 * lapse pause) lives in those writers, not here.
 */

/** A writer's answer: what it did with the event, and how many monitors its lapse pause paused. */
export type WriterOutcome = { outcome: "applied" | "duplicate" | "stale"; paused: number };

export type PaymentsRpc = {
  syncSubscription(event: RpcEvent, subscription: SubscriptionPayload): Promise<WriterOutcome>;
  recordSubscriptionInvoice(
    event: RpcEvent,
    subscription: SubscriptionPayload,
    invoice: InvoicePayload,
  ): Promise<WriterOutcome>;
  /**
   * The user's other subscriptions in an entitling status (`stripe_subscription_id`s),
   * `excludeSubscriptionId` left out: at most PAYMENTS_MAX_DUPLICATE_CANDIDATES, the
   * oldest recorded first (`created_at`, then `stripe_subscription_id`).
   */
  otherEntitlingSubscriptionIds(userId: string, excludeSubscriptionId: string): Promise<string[]>;
  /**
   * Whether Supabase Auth has an account with this id (`GET /auth/v1/admin/users/{id}`):
   * true when Auth returns that user, false when Auth answers 404 `user_not_found`;
   * any other answer or failure throws a {@link PaymentsRpcError} (a retry may fix it).
   */
  accountExists(userId: string): Promise<boolean>;
};

/** The writers' refusals (SQLSTATE 22023 messages): retrying the same event cannot change them. */
const WRITER_REFUSALS = ["invalid_payload", "unknown_plan", "unknown_user", "customer_user_mismatch"] as const;

export type WriterRefusal = (typeof WRITER_REFUSALS)[number];

/**
 * A failed database or Auth call. `message` is the writer's refusal (one of
 * {@link WRITER_REFUSALS}) when the database raised it with SQLSTATE 22023,
 * else `rpc_failed`; never a message, detail or hint of the answer, which may
 * echo payload values. `code` is the PostgREST/Postgres error code, or Supabase
 * Auth's error code (`unknown` when the answer has none, `invalid_response`
 * for an answer of the wrong shape); `status` the answer's HTTP status, null
 * when there was no answer (a network failure, or a call aborted after
 * {@link PAYMENTS_RPC_TIMEOUT_MS}): the constructor stores status 0,
 * supabase-js's status for no answer, as null.
 */
export class PaymentsRpcError extends Error {
  readonly code: string;
  readonly status: number | null;
  /** The writer's refusal (SQLSTATE 22023 with a {@link WRITER_REFUSALS} message), else null: a failure a retry may fix. */
  readonly refusal: WriterRefusal | null;

  constructor(message: WriterRefusal | "rpc_failed", code = "unknown", status: number | null = null) {
    super(message);
    this.name = "PaymentsRpcError";
    this.code = code;
    this.status = status === 0 ? null : status;
    this.refusal = code === "22023" && message !== "rpc_failed" ? message : null;
  }
}

/** A supabase-js error answer as a {@link PaymentsRpcError}. */
function rpcError(error: { code?: string; message?: string }, status: number): PaymentsRpcError {
  const code = error.code || "unknown";
  const refusal = code === "22023" ? WRITER_REFUSALS.find((keyword) => keyword === error.message) : undefined;
  return new PaymentsRpcError(refusal ?? "rpc_failed", code, status);
}

/** A writer's jsonb answer, checked: `{outcome: applied|duplicate|stale, paused: integer ≥ 0}`. */
function writerOutcome({ data, error, status }: { data: unknown; error: { code?: string; message?: string } | null; status: number }): WriterOutcome {
  if (error) throw rpcError(error, status);
  const answer = asRecord(data);
  const outcome = answer?.outcome;
  const paused = answer?.paused;
  if (
    (outcome !== "applied" && outcome !== "duplicate" && outcome !== "stale") ||
    typeof paused !== "number" ||
    !Number.isSafeInteger(paused) ||
    paused < 0
  ) {
    throw new PaymentsRpcError("rpc_failed", "invalid_response", status);
  }
  return { outcome, paused };
}

/**
 * The client's `fetch` (supabase-js `global.fetch`, also used by its Auth
 * client): every request, its response body included, is aborted after
 * {@link PAYMENTS_RPC_TIMEOUT_MS}, and still by a signal the caller passed.
 * supabase-js returns the abort as an error answer, so a timed-out call fails
 * like any other.
 */
const paymentsFetch: typeof fetch = (input, init) => {
  const timeout = AbortSignal.timeout(PAYMENTS_RPC_TIMEOUT_MS);
  return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
};

/**
 * {@link PaymentsRpc} over supabase-js with the Supabase secret key (no
 * session, no token refresh). Database arguments go as JSON (PostgREST
 * parameters), never as SQL text.
 */
export function createPaymentsRpc(url: string, secretKey: string): PaymentsRpc {
  const client = createClient<Database>(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: paymentsFetch },
  });

  return {
    async syncSubscription(event, subscription) {
      return writerOutcome(
        await client.rpc("payments_sync_subscription", { p_event: event, p_subscription: subscription }),
      );
    },

    async recordSubscriptionInvoice(event, subscription, invoice) {
      return writerOutcome(
        await client.rpc("payments_record_subscription_invoice", {
          p_event: event,
          p_subscription: subscription,
          p_invoice: invoice,
        }),
      );
    },

    async otherEntitlingSubscriptionIds(userId, excludeSubscriptionId) {
      // A GET, which postgrest-js would retry on a network failure, timeout, 503 or 520 (with
      // backoff): one attempt only, so the call stays bounded by PAYMENTS_RPC_TIMEOUT_MS.
      const { data, error, status } = await client
        .from("subscriptions")
        .select("stripe_subscription_id")
        .eq("user_id", userId)
        .in("status", [...ENTITLING_SUBSCRIPTION_STATUSES])
        .neq("stripe_subscription_id", excludeSubscriptionId)
        .order("created_at", { ascending: true })
        .order("stripe_subscription_id")
        .limit(PAYMENTS_MAX_DUPLICATE_CANDIDATES)
        .retry(false);
      if (error) throw rpcError(error, status);
      if (!Array.isArray(data)) throw new PaymentsRpcError("rpc_failed", "invalid_response", status);
      return data.map((row) => row.stripe_subscription_id);
    },

    async accountExists(userId) {
      // auth-js sends one request (no retries) and answers a failure as `error`; it throws instead for an
      // id that is not a UUID and for a body it cannot read as a user (e.g. JSON null).
      const { data, error } = await client.auth.admin.getUserById(userId).catch(() => {
        throw new PaymentsRpcError("rpc_failed", "invalid_response");
      });
      if (error !== null) {
        if (error.status === 404 && error.code === "user_not_found") return false;
        throw new PaymentsRpcError("rpc_failed", error.code ?? "unknown", error.status ?? null);
      }
      if (asRecord(data.user)?.id !== userId) throw new PaymentsRpcError("rpc_failed", "invalid_response");
      return true;
    },
  };
}
