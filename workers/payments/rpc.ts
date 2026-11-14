import { createClient } from "@supabase/supabase-js";
import type { Locale } from "next-intl";
import {
  BILLING_INTERVALS,
  ENTITLING_SUBSCRIPTION_STATUSES,
  PAYMENTS_MAX_DUPLICATE_CANDIDATES,
  PAYMENTS_RPC_TIMEOUT_MS,
  type BillingInterval,
} from "@/config/payments";
import {
  WITHDRAWAL_MANUAL_REASONS,
  type WithdrawalManualReason,
  type WithdrawalStatus,
} from "@/lib/payments/withdrawal-emails";
import type { RetentionBasis } from "@/lib/payments/withdrawal-refund";
import { asRecord, type InvoicePayload, type RpcEvent, type SubscriptionPayload } from "@/lib/payments/webhook-mapping";
import type { Database, Json } from "@/types/database";

/**
 * The payments Worker's only door to Supabase: the service-role-only writers
 * of migrations 20261112000100 (`payments_sync_subscription`,
 * `payments_record_subscription_invoice`) and 20261114000300 (the consent and
 * withdrawal writers), one read of `subscriptions`, and Supabase Auth (whether
 * an account exists, its email, the user of an access token). Every rule
 * (event dedupe, staleness, final statuses, the billing customer, the lapse
 * pause, the withdrawal window and its state machine) lives in those writers,
 * not here. Every answer is checked: one of the wrong shape is a
 * {@link PaymentsRpcError} `invalid_response`.
 */

/** A writer's answer: what it did with the event, and how many monitors its lapse pause paused. */
export type WriterOutcome = { outcome: "applied" | "duplicate" | "stale"; paused: number };

/** `payments_record_checkout_consent`'s payload. */
export type ConsentPayload = {
  checkout_session_id: string;
  subscription_id: string;
  text_version: string;
  text_sha256: string;
  locale: Locale;
  stripe_consent: "accepted";
  accepted_at: string;
};

/** The order confirmation email's context of a recorded consent (`private.payments_consent_mail`). */
export type ConsentMail = {
  checkout_session_id: string;
  subscription_id: string;
  /** Null once the account is deleted: no email then. */
  user_id: string | null;
  locale: Locale;
  text_version: string;
  accepted_at: string;
  started_at: string | null;
  plan: { billing_interval: BillingInterval; amount_ore: number; name: string };
};

/** A withdrawal as the withdrawal writers answer it (`private.payments_withdrawal_json`). */
export type WithdrawalSnapshot = {
  id: string;
  status: WithdrawalStatus;
  stripe_subscription_id: string;
  user_id: string | null;
  consumer_name: string;
  ack_email: string;
  statement_version: string;
  locale: Locale;
  requested_at: string;
  deadline_at: string;
  retention_basis: RetentionBasis | null;
  manual_reason: WithdrawalManualReason | null;
  canceled_at: string | null;
  stripe_invoice_id: string | null;
  paid_ore: number | null;
  retained_ore: number | null;
  refund_ore: number | null;
  refund_tax_ore: number | null;
  stripe_credit_note_id: string | null;
  refunded_at: string | null;
  ack_sent_at: string | null;
  alerted_at: string | null;
  attempts: number;
  subscription: { stripe_customer_id: string; started_at: string | null; status: string };
};

/** The steps `payments_withdrawal_step` records. */
export type WithdrawalStep =
  | "canceled"
  | "refunded"
  | "no_refund_due"
  | "needs_manual"
  | "ack_sent"
  | "alerted"
  | "failed";

/** What `payments_begin_withdrawal` records: the user comes from the verified access token only. */
export type BeginWithdrawalInput = {
  userId: string;
  subscriptionId: string;
  consumerName: string;
  ackEmail: string;
  statementVersion: string;
  locale: Locale;
};

/** The signed-in user of an access token, as Supabase Auth answers it. */
export type TokenUser = { id: string; email: string | null };

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
  /** `payments_record_checkout_consent`: records an accepted consent, with the order confirmation's context while unsent. */
  paymentsRecordCheckoutConsent(
    consent: ConsentPayload,
  ): Promise<{ outcome: "recorded" | "duplicate"; mail: ConsentMail | null }>;
  /** `payments_mark_consent_info_sent`: stamps the order confirmation as sent (first stamp wins). */
  paymentsMarkConsentInfoSent(checkoutSessionId: string, emailId: string): Promise<{ outcome: "stamped" | "already" }>;
  /**
   * The account email of a user (`GET /auth/v1/admin/users/{id}`): null when Auth has no such
   * user (404 `user_not_found`) or it has no email; any other failure throws.
   */
  getUserEmail(userId: string): Promise<string | null>;
};

/** The withdrawal flow's database and Auth calls (WithdrawalService and the sweep). */
export type WithdrawalRpc = {
  /** `payments_begin_withdrawal`: records the withdrawal notice (P0001 not_withdrawable / window_expired refuse it). */
  paymentsBeginWithdrawal(
    input: BeginWithdrawalInput,
  ): Promise<{ outcome: "created" | "existing"; withdrawal: WithdrawalSnapshot }>;
  /** `payments_claim_withdrawal`: leases a withdrawal for one pass of the Worker. */
  paymentsClaimWithdrawal(
    withdrawalId: string,
    leaseSeconds: number,
  ): Promise<{ outcome: "claimed" | "busy" | "done"; withdrawal: WithdrawalSnapshot }>;
  /** `payments_withdrawal_step`: records one step (P0001 invalid_transition / invoice_not_recorded refuse it). */
  paymentsWithdrawalStep(
    withdrawalId: string,
    step: WithdrawalStep,
    data: Record<string, Json>,
  ): Promise<{ outcome: "applied" | "already"; withdrawal: WithdrawalSnapshot }>;
  /**
   * `payments_pending_work`: the withdrawals (least recently touched first; one whose only work
   * left is an email only while it has had fewer than `maxMailAttempts` passes) and the unsent
   * order confirmations the sweep finishes.
   */
  paymentsPendingWork(
    limit: number,
    maxMailAttempts: number,
  ): Promise<{ withdrawals: string[]; consents: ConsentMail[] }>;
  /**
   * The user of an access token (`GET /auth/v1/user`, verified by Supabase Auth): null when
   * Auth refuses the token (a 4xx but 429); any other failure throws a {@link PaymentsRpcError}.
   */
  getUser(accessToken: string): Promise<TokenUser | null>;
};

/** The writers' refusals (SQLSTATE 22023 messages): retrying the same event cannot change them. */
const WRITER_REFUSALS = ["invalid_payload", "unknown_plan", "unknown_user", "customer_user_mismatch"] as const;

export type WriterRefusal = (typeof WRITER_REFUSALS)[number];

/** The consent and withdrawal writers' business refusals (SQLSTATE P0001 messages). */
const WITHDRAWAL_REFUSALS = [
  "unknown_subscription",
  "unknown_consent",
  "unknown_withdrawal",
  "not_withdrawable",
  "window_expired",
  "invalid_transition",
  "invoice_not_recorded",
] as const;

export type WithdrawalRefusal = (typeof WITHDRAWAL_REFUSALS)[number];

/**
 * A failed database or Auth call. `message` is the writer's refusal: one of
 * {@link WRITER_REFUSALS} when the database raised it with SQLSTATE 22023, one
 * of {@link WITHDRAWAL_REFUSALS} with SQLSTATE P0001; else `rpc_failed`; never
 * a message, detail or hint of the answer, which may echo payload values.
 * `code` is the PostgREST/Postgres error code, or Supabase Auth's error code
 * (`unknown` when the answer has none, `invalid_response` for an answer of the
 * wrong shape); `status` the answer's HTTP status, null when there was no
 * answer (a network failure, or a call aborted after
 * {@link PAYMENTS_RPC_TIMEOUT_MS}): the constructor stores status 0,
 * supabase-js's status for no answer, as null.
 */
export class PaymentsRpcError extends Error {
  readonly code: string;
  readonly status: number | null;
  /** The writer's refusal (SQLSTATE 22023 with a {@link WRITER_REFUSALS} message), else null: a failure a retry may fix. */
  readonly refusal: WriterRefusal | null;

  constructor(message: WriterRefusal | WithdrawalRefusal | "rpc_failed", code = "unknown", status: number | null = null) {
    super(message);
    this.name = "PaymentsRpcError";
    this.code = code;
    this.status = status === 0 ? null : status;
    this.refusal = code === "22023" && message !== "rpc_failed" && isWriterRefusal(message) ? message : null;
  }
}

function isWriterRefusal(message: string): message is WriterRefusal {
  return (WRITER_REFUSALS as readonly string[]).includes(message);
}

/** A supabase-js error answer as a {@link PaymentsRpcError}. */
function rpcError(error: { code?: string; message?: string }, status: number): PaymentsRpcError {
  const code = error.code || "unknown";
  const refusal =
    code === "22023"
      ? WRITER_REFUSALS.find((keyword) => keyword === error.message)
      : code === "P0001"
        ? WITHDRAWAL_REFUSALS.find((keyword) => keyword === error.message)
        : undefined;
  return new PaymentsRpcError(refusal ?? "rpc_failed", code, status);
}

/** A supabase-js answer: the data, or the error answer as a {@link PaymentsRpcError}. */
type RpcAnswer = { data: unknown; error: { code?: string; message?: string } | null; status: number };

/** The answer's data, after throwing its error. */
function answerData({ data, error, status }: RpcAnswer): unknown {
  if (error) throw rpcError(error, status);
  return data;
}

/** An answer of the wrong shape. */
function invalidResponse(status: number | null = null): PaymentsRpcError {
  return new PaymentsRpcError("rpc_failed", "invalid_response", status);
}

/** A writer's jsonb answer, checked: `{outcome: applied|duplicate|stale, paused: integer ≥ 0}`. */
function writerOutcome(answer: RpcAnswer): WriterOutcome {
  const record = asRecord(answerData(answer));
  const outcome = record?.outcome;
  const paused = record?.paused;
  if (
    (outcome !== "applied" && outcome !== "duplicate" && outcome !== "stale") ||
    typeof paused !== "number" ||
    !Number.isSafeInteger(paused) ||
    paused < 0
  ) {
    throw invalidResponse(answer.status);
  }
  return { outcome, paused };
}

/** The record's `outcome` when it is one of `outcomes`, else null. */
function outcomeOf<Outcome extends string>(record: Record<string, unknown> | null, outcomes: readonly Outcome[]): Outcome | null {
  const outcome = record?.outcome;
  return outcomes.find((candidate) => candidate === outcome) ?? null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isOre(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNullableOre(value: unknown): value is number | null {
  return value === null || isOre(value);
}

function isLocale(value: unknown): value is Locale {
  return value === "da" || value === "en";
}

const WITHDRAWAL_STATUSES: readonly WithdrawalStatus[] = ["received", "canceled", "completed", "needs_manual"];

/** `value` as a {@link WithdrawalSnapshot}, or null when a field is missing or of the wrong type. */
function parseWithdrawal(value: unknown): WithdrawalSnapshot | null {
  const w = asRecord(value);
  const subscription = asRecord(w?.subscription);
  if (w === null || subscription === null) return null;
  const status = WITHDRAWAL_STATUSES.find((candidate) => candidate === w.status);
  const retention = w.retention_basis;
  const reason = w.manual_reason === null ? null : WITHDRAWAL_MANUAL_REASONS.find((candidate) => candidate === w.manual_reason);
  if (
    status === undefined ||
    !isString(w.id) ||
    !isString(w.stripe_subscription_id) ||
    !isNullableString(w.user_id) ||
    !isString(w.consumer_name) ||
    !isString(w.ack_email) ||
    !isString(w.statement_version) ||
    !isLocale(w.locale) ||
    !isString(w.requested_at) ||
    !isString(w.deadline_at) ||
    !(retention === null || retention === "consent" || retention === "no_consent") ||
    reason === undefined ||
    !isNullableString(w.canceled_at) ||
    !isNullableString(w.stripe_invoice_id) ||
    !isNullableOre(w.paid_ore) ||
    !isNullableOre(w.retained_ore) ||
    !isNullableOre(w.refund_ore) ||
    !isNullableOre(w.refund_tax_ore) ||
    !isNullableString(w.stripe_credit_note_id) ||
    !isNullableString(w.refunded_at) ||
    !isNullableString(w.ack_sent_at) ||
    !isNullableString(w.alerted_at) ||
    !isOre(w.attempts) ||
    !isString(subscription.stripe_customer_id) ||
    !isNullableString(subscription.started_at) ||
    !isString(subscription.status)
  ) {
    return null;
  }
  return {
    id: w.id,
    status,
    stripe_subscription_id: w.stripe_subscription_id,
    user_id: w.user_id,
    consumer_name: w.consumer_name,
    ack_email: w.ack_email,
    statement_version: w.statement_version,
    locale: w.locale,
    requested_at: w.requested_at,
    deadline_at: w.deadline_at,
    retention_basis: retention,
    manual_reason: reason,
    canceled_at: w.canceled_at,
    stripe_invoice_id: w.stripe_invoice_id,
    paid_ore: w.paid_ore,
    retained_ore: w.retained_ore,
    refund_ore: w.refund_ore,
    refund_tax_ore: w.refund_tax_ore,
    stripe_credit_note_id: w.stripe_credit_note_id,
    refunded_at: w.refunded_at,
    ack_sent_at: w.ack_sent_at,
    alerted_at: w.alerted_at,
    attempts: w.attempts,
    subscription: {
      stripe_customer_id: subscription.stripe_customer_id,
      started_at: subscription.started_at,
      status: subscription.status,
    },
  };
}

/** `value` as a {@link ConsentMail}, or null when a field is missing or of the wrong type. */
function parseConsentMail(value: unknown): ConsentMail | null {
  const mail = asRecord(value);
  const plan = asRecord(mail?.plan);
  if (mail === null || plan === null) return null;
  const interval = BILLING_INTERVALS.find((candidate) => candidate === plan.billing_interval);
  if (
    interval === undefined ||
    !isOre(plan.amount_ore) ||
    !isString(plan.name) ||
    !isString(mail.checkout_session_id) ||
    !isString(mail.subscription_id) ||
    !isNullableString(mail.user_id) ||
    !isLocale(mail.locale) ||
    !isString(mail.text_version) ||
    !isString(mail.accepted_at) ||
    !isNullableString(mail.started_at)
  ) {
    return null;
  }
  return {
    checkout_session_id: mail.checkout_session_id,
    subscription_id: mail.subscription_id,
    user_id: mail.user_id,
    locale: mail.locale,
    text_version: mail.text_version,
    accepted_at: mail.accepted_at,
    started_at: mail.started_at,
    plan: { billing_interval: interval, amount_ore: plan.amount_ore, name: plan.name },
  };
}

/** A withdrawal writer's `{outcome, withdrawal}` answer, checked. */
function withdrawalAnswer<Outcome extends string>(
  answer: RpcAnswer,
  outcomes: readonly Outcome[],
): { outcome: Outcome; withdrawal: WithdrawalSnapshot } {
  const record = asRecord(answerData(answer));
  const outcome = outcomeOf(record, outcomes);
  const withdrawal = parseWithdrawal(record?.withdrawal);
  if (outcome === null || withdrawal === null) throw invalidResponse(answer.status);
  return { outcome, withdrawal };
}

/**
 * The client's `fetch` (supabase-js `global.fetch`, also used by its Auth
 * client): every request, its response body included, is aborted after
 * {@link PAYMENTS_RPC_TIMEOUT_MS}, and still by a signal the caller passed.
 * supabase-js returns the abort as an error answer, so a timed-out call fails
 * like any other. `base` is the fetch it wraps (the sweep counts subrequests
 * through it).
 */
function paymentsFetch(base: typeof fetch): typeof fetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(PAYMENTS_RPC_TIMEOUT_MS);
    return base(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
  };
}

/**
 * {@link PaymentsRpc} and {@link WithdrawalRpc} over supabase-js with the
 * Supabase secret key (no session, no token refresh). Database arguments go
 * as JSON (PostgREST parameters), never as SQL text. `fetchImpl` stands in
 * for the global fetch (the sweep's subrequest counter).
 */
export function createPaymentsRpc(
  url: string,
  secretKey: string,
  fetchImpl?: typeof fetch,
): PaymentsRpc & WithdrawalRpc {
  const client = createClient<Database>(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: paymentsFetch(fetchImpl ?? ((input, init) => fetch(input, init))) },
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

    async paymentsRecordCheckoutConsent(consent) {
      const answer = await client.rpc("payments_record_checkout_consent", { p_consent: consent });
      const record = asRecord(answerData(answer));
      const outcome = outcomeOf(record, ["recorded", "duplicate"] as const);
      const mail = record?.mail === null ? null : parseConsentMail(record?.mail);
      if (outcome === null || (record?.mail !== null && mail === null)) {
        throw invalidResponse(answer.status);
      }
      return { outcome, mail };
    },

    async paymentsMarkConsentInfoSent(checkoutSessionId, emailId) {
      const answer = await client.rpc("payments_mark_consent_info_sent", {
        p_checkout_session_id: checkoutSessionId,
        p_email_id: emailId,
      });
      const outcome = outcomeOf(asRecord(answerData(answer)), ["stamped", "already"] as const);
      if (outcome === null) throw invalidResponse(answer.status);
      return { outcome };
    },

    async paymentsBeginWithdrawal(input) {
      return withdrawalAnswer(
        await client.rpc("payments_begin_withdrawal", {
          p_user_id: input.userId,
          p_subscription_id: input.subscriptionId,
          p_consumer_name: input.consumerName,
          p_ack_email: input.ackEmail,
          p_statement_version: input.statementVersion,
          p_locale: input.locale,
        }),
        ["created", "existing"] as const,
      );
    },

    async paymentsClaimWithdrawal(withdrawalId, leaseSeconds) {
      return withdrawalAnswer(
        await client.rpc("payments_claim_withdrawal", { p_withdrawal_id: withdrawalId, p_lease_seconds: leaseSeconds }),
        ["claimed", "busy", "done"] as const,
      );
    },

    async paymentsWithdrawalStep(withdrawalId, step, data) {
      return withdrawalAnswer(
        await client.rpc("payments_withdrawal_step", { p_withdrawal_id: withdrawalId, p_step: step, p_data: data }),
        ["applied", "already"] as const,
      );
    },

    async paymentsPendingWork(limit, maxMailAttempts) {
      const answer = await client.rpc("payments_pending_work", { p_limit: limit, p_max_mail_attempts: maxMailAttempts });
      const record = asRecord(answerData(answer));
      const withdrawals = record?.withdrawals;
      const consents = Array.isArray(record?.consents) ? record.consents.map(parseConsentMail) : null;
      if (
        !Array.isArray(withdrawals) ||
        !withdrawals.every(isString) ||
        consents === null ||
        consents.some((mail) => mail === null)
      ) {
        throw invalidResponse(answer.status);
      }
      return { withdrawals, consents: consents.filter((mail) => mail !== null) };
    },

    async getUser(accessToken) {
      const { data, error } = await client.auth.getUser(accessToken).catch(() => {
        throw new PaymentsRpcError("rpc_failed", "invalid_response");
      });
      if (error !== null) {
        const status = error.status ?? 0;
        // Auth refused the token (bad, expired, revoked, user gone); a 429 or 5xx a retry may fix.
        if (status >= 400 && status < 500 && status !== 429) return null;
        throw new PaymentsRpcError("rpc_failed", error.code ?? "unknown", status);
      }
      const user = asRecord(data.user);
      if (!isString(user?.id)) throw invalidResponse();
      return { id: user.id, email: typeof user.email === "string" && user.email !== "" ? user.email : null };
    },

    async getUserEmail(userId) {
      const { data, error } = await client.auth.admin.getUserById(userId).catch(() => {
        throw new PaymentsRpcError("rpc_failed", "invalid_response");
      });
      if (error !== null) {
        if (error.status === 404 && error.code === "user_not_found") return null;
        throw new PaymentsRpcError("rpc_failed", error.code ?? "unknown", error.status ?? null);
      }
      const user = asRecord(data.user);
      if (user?.id !== userId) throw invalidResponse();
      return typeof user.email === "string" && user.email !== "" ? user.email : null;
    },
  };
}
