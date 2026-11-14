import type { Locale } from "next-intl";
import { WITHDRAWAL_TEXT_VERSION } from "@/config/legal/withdrawal-texts";
import { SUB_ID_REGEX, asRecord } from "@/lib/payments/webhook-mapping";

/**
 * The contract between the web app's withdrawal action and the payments
 * Worker's `WithdrawalService.withdraw` (a Cloudflare service binding RPC):
 * what the web sends and what the Worker answers. Both sides parse what they
 * receive with the functions here. The web never sends a user id: the Worker
 * takes the user (id and email) only from Supabase Auth's answer for the
 * access token.
 */

/** The withdrawal request the web app sends. */
export type WithdrawInput = {
  /** The signed-in user's Supabase access token (JWT), verified by the Worker. */
  accessToken: string;
  /** The subscription being withdrawn from (read server-side, never from the form). */
  subscriptionId: string;
  /** The consumer's name as typed on the confirm page, trimmed. */
  consumerName: string;
  /** The text version of the statement shown ({@link WITHDRAWAL_TEXT_VERSION}). */
  statementVersion: string;
  /** The language the statement was shown in. */
  locale: Locale;
};

/** Why the Worker refused or could not take a withdrawal. */
export const WITHDRAW_ERROR_CODES = [
  "unauthenticated",
  "invalid_input",
  "not_withdrawable",
  "window_expired",
  "unavailable",
] as const;

export type WithdrawErrorCode = (typeof WITHDRAW_ERROR_CODES)[number];

/** A withdrawal that is not finished yet (or awaits manual handling). */
export type WithdrawPendingStatus = "received" | "canceled" | "needs_manual";

/** The Worker's answer. */
export type WithdrawResult =
  | {
      ok: true;
      withdrawalId: string;
      status: "completed";
      requestedAt: string;
      paidOre: number;
      retainedOre: number;
      refundOre: number;
    }
  | { ok: true; withdrawalId: string; status: WithdrawPendingStatus; requestedAt: string }
  | { ok: false; code: WithdrawErrorCode };

/** The most UTF-16 code units an access token may have. */
const ACCESS_TOKEN_MAX = 4096;

/** The most characters (code points) a consumer name may have after trimming. */
export const CONSUMER_NAME_MAX = 200;

/** A control character (C0, DEL or C1). */
const CONTROL_CHAR = /[\u0000-\u001f\u007f-\u009f]/;

const INPUT_KEYS = ["accessToken", "subscriptionId", "consumerName", "statementVersion", "locale"] as const;

/** Whether `record` has exactly the keys `keys` (in any order). */
function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(record);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}

function isLocale(value: unknown): value is Locale {
  return value === "da" || value === "en";
}

/**
 * The consumer name `value` trimmed, or null unless it is a string of 1 to
 * {@link CONSUMER_NAME_MAX} characters after trimming without a control
 * character. The confirm page's action and the Worker check it alike.
 */
export function parseConsumerName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  const length = [...name].length;
  if (length < 1 || length > CONSUMER_NAME_MAX || CONTROL_CHAR.test(name)) return null;
  return name;
}

/**
 * `value` as a {@link WithdrawInput}, or null unless it is an object with
 * exactly its five keys: an access token of 1 to 4096 characters without
 * whitespace, a `sub_` id, a valid consumer name (returned trimmed), the
 * current text version and `da` or `en`.
 */
export function parseWithdrawInput(value: unknown): WithdrawInput | null {
  const input = asRecord(value);
  if (input === null || !hasExactKeys(input, INPUT_KEYS)) return null;
  const { accessToken, subscriptionId, statementVersion, locale } = input;
  const consumerName = parseConsumerName(input.consumerName);
  if (
    typeof accessToken !== "string" ||
    accessToken.length < 1 ||
    accessToken.length > ACCESS_TOKEN_MAX ||
    /\s/.test(accessToken) ||
    typeof subscriptionId !== "string" ||
    !SUB_ID_REGEX.test(subscriptionId) ||
    consumerName === null ||
    statementVersion !== WITHDRAWAL_TEXT_VERSION ||
    !isLocale(locale)
  ) {
    return null;
  }
  return { accessToken, subscriptionId, consumerName, statementVersion, locale };
}

/** A withdrawal id as the Worker reports it (the database's uuid). */
const WITHDRAWAL_ID = /^[A-Za-z0-9_-]{1,64}$/;

function isOre(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isErrorCode(value: unknown): value is WithdrawErrorCode {
  return (WITHDRAW_ERROR_CODES as readonly unknown[]).includes(value);
}

function isPendingStatus(value: unknown): value is WithdrawPendingStatus {
  return value === "received" || value === "canceled" || value === "needs_manual";
}

/**
 * `value` as a {@link WithdrawResult}, or null for any other shape (exact
 * keys, known codes and statuses, whole øre amounts); the web treats null as
 * `unavailable`.
 */
export function parseWithdrawResult(value: unknown): WithdrawResult | null {
  const result = asRecord(value);
  if (result === null) return null;
  if (result.ok === false) {
    return hasExactKeys(result, ["ok", "code"]) && isErrorCode(result.code) ? { ok: false, code: result.code } : null;
  }
  if (result.ok !== true) return null;
  const { withdrawalId, status, requestedAt } = result;
  if (typeof withdrawalId !== "string" || !WITHDRAWAL_ID.test(withdrawalId) || !isTimestamp(requestedAt)) return null;
  if (status === "completed") {
    const { paidOre, retainedOre, refundOre } = result;
    if (
      !hasExactKeys(result, ["ok", "withdrawalId", "status", "requestedAt", "paidOre", "retainedOre", "refundOre"]) ||
      !isOre(paidOre) ||
      !isOre(retainedOre) ||
      !isOre(refundOre) ||
      paidOre !== retainedOre + refundOre
    ) {
      return null;
    }
    return { ok: true, withdrawalId, status, requestedAt, paidOre, retainedOre, refundOre };
  }
  if (!isPendingStatus(status) || !hasExactKeys(result, ["ok", "withdrawalId", "status", "requestedAt"])) return null;
  return { ok: true, withdrawalId, status, requestedAt };
}
