import type { PostgrestError } from "@supabase/supabase-js";
import type { Locale } from "next-intl";
import {
  BILLING_INTERVALS,
  SUBSCRIPTION_ENDED_STATUSES,
  type BillingInterval,
} from "@/config/payments";
import { getMonitorLocale } from "@/i18n/monitor-locale";
import { routing } from "@/i18n/routing";
import { SUB_ID_REGEX, asRecord } from "@/lib/payments/webhook-mapping";
import { createServerClient } from "@/lib/supabase/server";
import { requireMonitor } from "@/services/auth/require-role";

/*
 * Read-only billing data for the Monitor panel, with the signed-in user's
 * session (`createServerClient`), so RLS applies: active plans for everyone,
 * a user's own `subscriptions` and `billing_customers` rows. Those policies
 * also admit an admin (the owner may use Monitor) to every account's rows, so
 * the per-user reads also filter on the session's own user id
 * (`requireMonitor()`, cached per request), never on a caller's value. The
 * app never writes the payments tables: the Stripe webhooks do.
 */

/** A plan as the billing page offers it (`monitor_plans` + its name in the page's language). */
export type MonitorPlan = {
  id: string;
  stripePriceId: string;
  interval: BillingInterval;
  monitorLimit: number;
  /** The display price in øre, incl. moms (Stripe charges the plan's Price). */
  amountOre: number;
  name: string;
};

/** What Checkout needs of a plan (no name). */
export type MonitorPlanPrice = Omit<MonitorPlan, "name">;

/**
 * The user's subscription that has not ended. The plan fields are null when
 * its plan is no longer active (RLS hides inactive plans; the subscription
 * still runs on it).
 */
export type CurrentSubscription = SubscriptionPlan & {
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
};

/** A subscription's plan, named in the visitor's Monitor language; every field null when the plan is inactive. */
export type SubscriptionPlan = {
  interval: BillingInterval | null;
  amountOre: number | null;
  planName: string | null;
};

/** A withdrawal's state (`subscription_withdrawals.status`). */
export type WithdrawalState = "received" | "canceled" | "completed" | "needs_manual";

/** The user's withdrawal as `my_withdrawal_status()` reports it; the øre amounts are set once it is completed. */
export type MyWithdrawal = {
  id: string;
  status: WithdrawalState;
  requested_at: string;
  paid_ore: number | null;
  retained_ore: number | null;
  refund_ore: number | null;
  refunded_at: string | null;
};

/** The subscription's newest paid invoice (`subscription_invoices`), for the confirm page's refund estimate. */
export type MyWithdrawalInvoice = {
  stripe_invoice_id: string;
  amount_total_ore: number;
  period_start: string | null;
  period_end: string | null;
};

/**
 * `my_withdrawal_status()`, keyed as the database answers it: the user's
 * newest subscription that entitles or has a withdrawal, the end of its
 * withdrawal period (`deadline_at`, the start of the day after the last day;
 * null without a start date), whether a withdrawal may be made now
 * (`window_open`, decided by the database's clock only), whether a consent to
 * start at once was recorded, its withdrawal and its newest paid invoice.
 */
export type MyWithdrawalStatus = {
  subscription_id: string;
  status: string;
  started_at: string | null;
  deadline_at: string | null;
  window_open: boolean;
  has_consent: boolean;
  withdrawal: MyWithdrawal | null;
  invoice: MyWithdrawalInvoice | null;
};

type PlanTranslation = { locale: Locale; name: string };

/** A subscription's `monitor_plans` embed; null when RLS hides an inactive plan. */
type PlanEmbed = {
  billing_interval: string;
  amount_ore: number;
  monitor_plan_translations: readonly PlanTranslation[];
} | null;

/** The subscription columns that name its plan (in every language: the caller picks one). */
const SUBSCRIPTION_PLAN_COLUMNS = "monitor_plans(billing_interval, amount_ore, monitor_plan_translations(locale, name))";

const PLAN_PRICE_COLUMNS = "id, stripe_price_id, billing_interval, monitor_limit, amount_ore";

/** PostgREST's `in` list of the ended statuses: `(canceled,incomplete_expired)`. */
const ENDED_STATUS_LIST = `(${SUBSCRIPTION_ENDED_STATUSES.join(",")})`;

function fail(operation: string, error: PostgrestError): never {
  throw new Error(`Payments ${operation} failed: ${error.code} ${error.message}`);
}

function isBillingInterval(value: string): value is BillingInterval {
  return (BILLING_INTERVALS as readonly string[]).includes(value);
}

/** A plan's interval, checked (the column's CHECK allows only month and year). */
function planInterval(value: string): BillingInterval {
  if (!isBillingInterval(value)) throw new Error("Payments plan has an unknown billing interval");
  return value;
}

/** A plan's display price, checked: a positive whole number of øre that JavaScript holds exactly. */
function planAmount(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Payments plan has an invalid amount");
  return value;
}

/** The plan's name in `locale`, else in Danish (the complete source language). */
function planName(translations: readonly PlanTranslation[], locale: Locale): string {
  const name = (
    translations.find((translation) => translation.locale === locale) ??
    translations.find((translation) => translation.locale === routing.defaultLocale)
  )?.name;
  if (name === undefined) throw new Error("Payments plan has no name");
  return name;
}

/** A subscription's plan from its `monitor_plans` embed, named in `locale`. */
function toSubscriptionPlan(plan: PlanEmbed, locale: Locale): SubscriptionPlan {
  return {
    interval: plan ? planInterval(plan.billing_interval) : null,
    amountOre: plan ? planAmount(plan.amount_ore) : null,
    planName: plan ? planName(plan.monitor_plan_translations, locale) : null,
  };
}

function toPlanPrice(row: {
  id: string;
  stripe_price_id: string;
  billing_interval: string;
  monitor_limit: number;
  amount_ore: number;
}): MonitorPlanPrice {
  return {
    id: row.id,
    stripePriceId: row.stripe_price_id,
    interval: planInterval(row.billing_interval),
    monitorLimit: row.monitor_limit,
    amountOre: planAmount(row.amount_ore),
  };
}

/**
 * The active plans, in `sort_order` (then id, so equal sort orders keep one
 * order everywhere), each named in `locale` (Danish when it has no such name).
 */
export async function listMonitorPlans(locale: Locale): Promise<MonitorPlan[]> {
  const supabase = await createServerClient();
  const { data, error } = await supabase
    .from("monitor_plans")
    .select(`${PLAN_PRICE_COLUMNS}, monitor_plan_translations(locale, name)`)
    .eq("active", true)
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });
  if (error) fail("plans", error);
  return data.map((row) => ({ ...toPlanPrice(row), name: planName(row.monitor_plan_translations, locale) }));
}

/**
 * The active plan billed every `interval`, or null when there is none. Should
 * two be active (e.g. while a price is replaced), the first in the order of
 * {@link listMonitorPlans}: the one the billing page offers.
 */
export async function getMonitorPlanByInterval(interval: BillingInterval): Promise<MonitorPlanPrice | null> {
  const supabase = await createServerClient();
  const { data, error } = await supabase
    .from("monitor_plans")
    .select(PLAN_PRICE_COLUMNS)
    .eq("active", true)
    .eq("billing_interval", interval)
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) fail("plan", error);
  return data === null ? null : toPlanPrice(data);
}

/**
 * The user's most recent subscription that has not ended (any status but
 * canceled and incomplete_expired), its plan named in the visitor's Monitor
 * language; null when there is none.
 */
export async function getCurrentSubscription(): Promise<CurrentSubscription | null> {
  const [user, locale, supabase] = await Promise.all([requireMonitor(), getMonitorLocale(), createServerClient()]);
  const { data, error } = await supabase
    .from("subscriptions")
    .select(`status, current_period_end, cancel_at_period_end, ${SUBSCRIPTION_PLAN_COLUMNS}`)
    .eq("user_id", user.userId)
    .not("status", "in", ENDED_STATUS_LIST)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) fail("subscription", error);
  if (data === null) return null;
  return {
    status: data.status,
    // Typed as always present (plan_id is NOT NULL), but RLS hides an inactive plan: null then.
    ...toSubscriptionPlan(data.monitor_plans ?? null, locale),
    currentPeriodEnd: data.current_period_end,
    cancelAtPeriodEnd: data.cancel_at_period_end,
  };
}

/**
 * The plan of the user's own subscription `stripeSubscriptionId` (any
 * status), named in the visitor's Monitor language; null when the user has no
 * such subscription. The withdrawal page names the plan of exactly the
 * subscription `my_withdrawal_status()` reports.
 */
export async function getSubscriptionPlan(stripeSubscriptionId: string): Promise<SubscriptionPlan | null> {
  const [user, locale, supabase] = await Promise.all([requireMonitor(), getMonitorLocale(), createServerClient()]);
  const { data, error } = await supabase
    .from("subscriptions")
    .select(SUBSCRIPTION_PLAN_COLUMNS)
    .eq("user_id", user.userId)
    .eq("stripe_subscription_id", stripeSubscriptionId)
    .maybeSingle();
  if (error) fail("subscription plan", error);
  return data === null ? null : toSubscriptionPlan(data.monitor_plans ?? null, locale);
}

/** The user's Stripe customer id (`billing_customers`), or null before their first subscription. */
export async function getBillingCustomerId(): Promise<string | null> {
  const [user, supabase] = await Promise.all([requireMonitor(), createServerClient()]);
  const { data, error } = await supabase
    .from("billing_customers")
    .select("stripe_customer_id")
    .eq("user_id", user.userId)
    .maybeSingle();
  if (error) fail("customer", error);
  return data?.stripe_customer_id ?? null;
}

const WITHDRAWAL_STATES: readonly WithdrawalState[] = ["received", "canceled", "completed", "needs_manual"];

function isWithdrawalState(value: unknown): value is WithdrawalState {
  return (WITHDRAWAL_STATES as readonly unknown[]).includes(value);
}

/** An ISO timestamp as the database's jsonb carries it. */
function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/** A whole, non-negative number of øre. */
function isOre(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function orNull<T>(value: unknown, isT: (value: unknown) => value is T): value is T | null {
  return value === null || isT(value);
}

/** `value` as a {@link MyWithdrawal}, or undefined for any other shape. */
function toWithdrawal(value: unknown): MyWithdrawal | undefined {
  const row = asRecord(value);
  if (row === null) return undefined;
  const { id, status, requested_at, paid_ore, retained_ore, refund_ore, refunded_at } = row;
  if (
    typeof id !== "string" ||
    !isWithdrawalState(status) ||
    !isTimestamp(requested_at) ||
    !orNull(paid_ore, isOre) ||
    !orNull(retained_ore, isOre) ||
    !orNull(refund_ore, isOre) ||
    !orNull(refunded_at, isTimestamp)
  ) {
    return undefined;
  }
  return { id, status, requested_at, paid_ore, retained_ore, refund_ore, refunded_at };
}

/** `value` as a {@link MyWithdrawalInvoice}, or undefined for any other shape. */
function toInvoice(value: unknown): MyWithdrawalInvoice | undefined {
  const row = asRecord(value);
  if (row === null) return undefined;
  const { stripe_invoice_id, amount_total_ore, period_start, period_end } = row;
  if (
    typeof stripe_invoice_id !== "string" ||
    !isOre(amount_total_ore) ||
    !orNull(period_start, isTimestamp) ||
    !orNull(period_end, isTimestamp)
  ) {
    return undefined;
  }
  return { stripe_invoice_id, amount_total_ore, period_start, period_end };
}

/** `value` as a {@link MyWithdrawalStatus} (only its documented keys), or null for any other shape. */
function toWithdrawalStatus(value: unknown): MyWithdrawalStatus | null {
  const row = asRecord(value);
  if (row === null) return null;
  const { subscription_id, status, started_at, deadline_at, window_open, has_consent } = row;
  const withdrawal = row.withdrawal === null ? null : toWithdrawal(row.withdrawal);
  const invoice = row.invoice === null ? null : toInvoice(row.invoice);
  if (
    typeof subscription_id !== "string" ||
    !SUB_ID_REGEX.test(subscription_id) ||
    typeof status !== "string" ||
    !orNull(started_at, isTimestamp) ||
    !orNull(deadline_at, isTimestamp) ||
    typeof window_open !== "boolean" ||
    typeof has_consent !== "boolean" ||
    withdrawal === undefined ||
    invoice === undefined
  ) {
    return null;
  }
  return { subscription_id, status, started_at, deadline_at, window_open, has_consent, withdrawal, invoice };
}

/**
 * The signed-in user's withdrawal status (`my_withdrawal_status()`, with the
 * user's own session: the function answers for `auth.uid()` only), or null
 * when the user has no subscription that entitles or has a withdrawal. An
 * answer of any other shape is treated as null and logged without its values.
 */
export async function getMyWithdrawalStatus(): Promise<MyWithdrawalStatus | null> {
  const supabase = await createServerClient();
  const { data, error } = await supabase.rpc("my_withdrawal_status");
  if (error) fail("withdrawal status", error);
  if (data === null) return null;
  const status = toWithdrawalStatus(data);
  if (status === null) console.error("Payments withdrawal status malformed");
  return status;
}
