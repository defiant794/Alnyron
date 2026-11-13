import type { PostgrestError } from "@supabase/supabase-js";
import type { Locale } from "next-intl";
import {
  BILLING_INTERVALS,
  SUBSCRIPTION_ENDED_STATUSES,
  type BillingInterval,
} from "@/config/payments";
import { getMonitorLocale } from "@/i18n/monitor-locale";
import { routing } from "@/i18n/routing";
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
export type CurrentSubscription = {
  status: string;
  interval: BillingInterval | null;
  amountOre: number | null;
  planName: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
};

type PlanTranslation = { locale: Locale; name: string };

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
    .select(
      "status, current_period_end, cancel_at_period_end, monitor_plans(billing_interval, amount_ore, monitor_plan_translations(locale, name))",
    )
    .eq("user_id", user.userId)
    .not("status", "in", ENDED_STATUS_LIST)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) fail("subscription", error);
  if (data === null) return null;
  // Typed as always present (plan_id is NOT NULL), but RLS hides an inactive plan: null then.
  const plan: typeof data.monitor_plans | null = data.monitor_plans ?? null;
  return {
    status: data.status,
    interval: plan ? planInterval(plan.billing_interval) : null,
    amountOre: plan ? planAmount(plan.amount_ore) : null,
    planName: plan ? planName(plan.monitor_plan_translations, locale) : null,
    currentPeriodEnd: data.current_period_end,
    cancelAtPeriodEnd: data.cancel_at_period_end,
  };
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
