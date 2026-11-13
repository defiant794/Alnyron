import type { Metadata } from "next";
import type { Locale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { openBillingPortal, startSubscriptionCheckout } from "@/app/monitor/(panel)/billing/actions";
import MonitorShell from "@/components/monitor/MonitorShell";
import Badge from "@/components/ui/Badge";
import Link from "@/components/ui/Link";
import Notice from "@/components/ui/Notice";
import SubmitButton from "@/components/ui/SubmitButton";
import { MONITOR_ROBOTS } from "@/config/monitor";
import {
  BILLING_CHECKOUT_DONE,
  BILLING_DEFAULT_INTERVAL,
  BILLING_ERROR_CHECKOUT,
  BILLING_ERROR_PORTAL,
  MONITOR_BILLING_PATH,
  isEntitlingStatus,
  type BillingInterval,
} from "@/config/payments";
import { getMonitorLocale } from "@/i18n/monitor-locale";
import { formatKroner } from "@/lib/payments/money";
import { requireMonitor } from "@/services/auth/require-role";
import { getMonitorUsage } from "@/services/monitor/monitors";
import { getCurrentSubscription, listMonitorPlans } from "@/services/payments/billing";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getMonitorLocale(), namespace: "Payments.billing" });
  return { title: t("metaTitle"), robots: MONITOR_ROBOTS };
}

type BillingPageProps = {
  /** `checkout=done`: back from Stripe's Checkout; `error=checkout|portal`: an action could not open Stripe. */
  searchParams?: Promise<{ checkout?: string | string[]; error?: string | string[] }>;
};

/** A renewal or end date ("1. juni 2027"; "1 June 2027"), in Copenhagen time. */
const DATE_FORMATS: Record<Locale, Intl.DateTimeFormat> = {
  da: new Intl.DateTimeFormat("da-DK", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Copenhagen" }),
  en: new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Copenhagen" }),
};

/** The page's cards: white, bordered, at most 560px wide (approved billing mock). */
const CARD = "flex w-full max-w-140 flex-col gap-6 rounded-card border border-border bg-bg p-6 shadow-card sm:p-8";

/** A plan's price as its two parts ("95 kr", "/ år") and as one phrase ("95 kr / år"). */
type PriceText = { amount: string; per: string; text: string };

/** One option of the upgrade form. */
type IntervalOption = { id: string; interval: BillingInterval; price: PriceText; saveTag: string | null };

/**
 * `/monitor/billing` (approved billing mock): the Monitor Plus subscription.
 * In order of precedence: an account without a cap is told it has none; a
 * user with a subscription that has not ended sees its plan, price and
 * renewal (or end) date, a warning when a payment failed or it is not active,
 * and "Administrér abonnement" (Stripe's Billing Portal); back from Checkout
 * before the webhook has recorded the subscription (`?checkout=done`), a
 * pending notice with a refresh link; without active plans, that Monitor Plus
 * is not available yet; otherwise the upgrade card: the plan, one option per
 * billing period of the active plans (yearly preselected, tagged with its
 * saving over twelve monthly payments) and "Opgradér" (Stripe's hosted
 * Checkout). After a failed action (`?error=checkout|portal`) an alert says
 * so above the card. Nothing here writes: the subscription appears once
 * Stripe's webhook has recorded it. Owner and `monitor_user` only. In the
 * visitor's Monitor language.
 */
export default async function BillingPage({ searchParams }: BillingPageProps) {
  const user = await requireMonitor();
  const locale = await getMonitorLocale();
  const [usage, subscription, plans, query, t] = await Promise.all([
    getMonitorUsage(),
    getCurrentSubscription(),
    listMonitorPlans(locale),
    searchParams,
    getTranslations({ locale }),
  ]);
  const checkoutDone = query?.checkout === BILLING_CHECKOUT_DONE;
  const error =
    query?.error === BILLING_ERROR_CHECKOUT
      ? t("Payments.billing.errorCheckout")
      : query?.error === BILLING_ERROR_PORTAL
        ? t("Payments.billing.errorPortal")
        : null;
  const priceText = (amountOre: number, interval: BillingInterval): PriceText => {
    const amount = t("Payments.billing.price", { amount: formatKroner(amountOre, locale) });
    const per = t(interval === "year" ? "Payments.billing.perYear" : "Payments.billing.perMonth");
    return { amount, per, text: `${amount} ${per}` };
  };

  let lead: string;
  let content: ReactNode = null;
  if (usage.limit === null) {
    lead = t("Payments.billing.unlimited");
  } else if (subscription !== null) {
    lead = t("Payments.billing.leadSubscribed");
    const entitling = isEntitlingStatus(subscription.status);
    const periodEnd =
      subscription.currentPeriodEnd === null ? null : DATE_FORMATS[locale].format(new Date(subscription.currentPeriodEnd));
    content = (
      <>
        {checkoutDone && entitling && (
          <Notice tone="success" role="status" className="max-w-140">
            {t("Payments.billing.activated", { limit: usage.limit })}
          </Notice>
        )}
        <section aria-labelledby="billing-plan" className={CARD}>
          <div className="flex flex-col gap-1">
            {/* An inactive plan is hidden from the user (RLS): its name and price then stay unknown. */}
            <h2 id="billing-plan" className="text-h3 font-semibold">
              {subscription.planName ?? t("Payments.billing.title")}
            </h2>
            {subscription.amountOre !== null && subscription.interval !== null && (
              <p className="text-muted">{priceText(subscription.amountOre, subscription.interval).text}</p>
            )}
            {entitling && periodEnd !== null && (
              <p className="text-small text-muted">
                {subscription.cancelAtPeriodEnd
                  ? t("Payments.billing.ends", { date: periodEnd })
                  : t("Payments.billing.renews", { date: periodEnd })}
              </p>
            )}
          </div>
          {subscription.status === "past_due" && <Notice tone="error">{t("Payments.billing.pastDue")}</Notice>}
          {!entitling && <Notice tone="error">{t("Payments.billing.inactive")}</Notice>}
          <form action={openBillingPortal}>
            <SubmitButton className="w-full">{t("Payments.billing.manage")}</SubmitButton>
          </form>
        </section>
      </>
    );
  } else if (checkoutDone) {
    lead = t("Payments.billing.lead", { limit: usage.limit });
    content = (
      <div role="status" className={CARD}>
        <div className="flex flex-col gap-1">
          <h2 className="text-h3 font-semibold">{t("Payments.billing.pendingTitle")}</h2>
          <p className="text-muted">{t("Payments.billing.pendingBody")}</p>
        </div>
        <Link
          href={`${MONITOR_BILLING_PATH}?checkout=${BILLING_CHECKOUT_DONE}`}
          className="inline-flex min-h-11 items-center self-start"
        >
          {t("Payments.billing.pendingRefresh")}
        </Link>
      </div>
    );
  } else if (plans.length === 0) {
    lead = t("Payments.billing.lead", { limit: usage.limit });
    content = (
      <div className={CARD}>
        <p className="font-semibold">{t("Payments.billing.unavailable")}</p>
      </div>
    );
  } else {
    lead = t("Payments.billing.lead", { limit: usage.limit });
    // One option per billing period: should two plans of a period be active (e.g. while a price
    // is replaced), the first, which is also the one "Opgradér" charges (getMonitorPlanByInterval).
    const offered = plans.filter((plan, index) => plans.findIndex((other) => other.interval === plan.interval) === index);
    // The plan shown is the preselected one (yearly); every active plan is the same product.
    const preselected = offered.find((plan) => plan.interval === BILLING_DEFAULT_INTERVAL) ?? offered[0]!;
    const yearly = offered.find((plan) => plan.interval === "year");
    const monthly = offered.find((plan) => plan.interval === "month");
    // The yearly price against twelve monthly payments, in whole percent.
    const saving = yearly && monthly ? Math.round((1 - yearly.amountOre / (12 * monthly.amountOre)) * 100) : 0;
    content = (
      <UpgradeCard
        name={preselected.name}
        sub={t("Payments.billing.planSub", { limit: preselected.monitorLimit })}
        legend={t("Payments.billing.intervalLegend")}
        options={offered.map((plan) => ({
          id: plan.id,
          interval: plan.interval,
          price: priceText(plan.amountOre, plan.interval),
          saveTag: plan === yearly && saving > 0 ? t("Payments.billing.saveTag", { pct: saving }) : null,
        }))}
        preselected={preselected.interval}
        upgrade={t("Payments.billing.upgrade")}
        finePrint={t("Payments.billing.finePrint")}
      />
    );
  }

  return (
    <MonitorShell email={user.email} section="billing" locale={locale}>
      {/* Inherited overflow-wrap: a word wider than its line (2× text at 320px) breaks, never widens the page. */}
      <div className="flex flex-col gap-6 wrap-break-word">
        <header className="flex flex-col gap-1">
          <h1 className="text-h2 font-semibold">{t("Payments.billing.title")}</h1>
          <p className="text-muted">{lead}</p>
        </header>
        <p className="inline-flex items-center gap-2 self-start rounded-pill border border-border bg-bg px-4 py-2 text-small">
          <span aria-hidden="true" className="size-2 rounded-pill bg-accent" />
          {usage.limit === null
            ? t("Monitor.dashboard.usageUnlimited", { count: usage.count })
            : t("Monitor.dashboard.usage", { count: usage.count, limit: usage.limit })}
        </p>
        {error !== null && (
          <Notice tone="error" role="alert" className="max-w-140">
            {error}
          </Notice>
        )}
        {content}
      </div>
    </MonitorShell>
  );
}

type UpgradeCardProps = {
  name: string;
  sub: string;
  legend: string;
  options: IntervalOption[];
  preselected: BillingInterval;
  upgrade: string;
  finePrint: string;
};

/**
 * The upgrade card (approved billing mock): the plan's name and cap, one
 * native radio option per billing period styled as a selectable row (the
 * preselected one checked), "Opgradér" and the fine print. The form sends
 * only the chosen `interval`.
 */
function UpgradeCard({ name, sub, legend, options, preselected, upgrade, finePrint }: UpgradeCardProps) {
  return (
    <section aria-labelledby="billing-plan" className={CARD}>
      <div className="flex flex-col gap-1">
        <h2 id="billing-plan" className="text-h3 font-semibold">
          {name}
        </h2>
        <p className="text-small text-muted">{sub}</p>
      </div>
      <form action={startSubscriptionCheckout} className="flex flex-col gap-4">
        <fieldset className="flex flex-col gap-3">
          <legend className="sr-only">{legend}</legend>
          {options.map((option) => (
            <label
              key={option.id}
              className="flex min-h-14 cursor-pointer items-center justify-between gap-4 rounded-input border border-border px-4 py-3 transition-[border-color,box-shadow] hover:border-muted has-checked:border-accent has-checked:ring-1 has-checked:ring-inset has-checked:ring-accent"
            >
              {/* Price and tag share a line (8px apart, as in the mock) until it is too narrow; then the
                  tag drops under the price. With enlarged text the tag can be wider than the row on its
                  own, so its words may wrap, centred, inside the pill (Badge itself never wraps). */}
              <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                {/* Read as one phrase; shown with the amount in bold and the period muted. */}
                <span className="sr-only">{option.price.text}</span>
                <span aria-hidden="true">
                  <span className="text-h3 font-bold">{option.price.amount}</span>{" "}
                  <span className="text-small text-muted">{option.price.per}</span>
                </span>
                {option.saveTag !== null && (
                  <Badge tone="success">
                    <span className="whitespace-normal text-center">{option.saveTag}</span>
                  </Badge>
                )}
              </span>
              <input
                type="radio"
                name="interval"
                value={option.interval}
                defaultChecked={option.interval === preselected}
                className="size-5 shrink-0 cursor-pointer accent-accent"
              />
            </label>
          ))}
        </fieldset>
        <SubmitButton className="w-full">{upgrade}</SubmitButton>
      </form>
      <p className="text-small text-muted">{finePrint}</p>
    </section>
  );
}
