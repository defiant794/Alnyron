import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { BILLING_CARD } from "@/app/monitor/(panel)/billing/card";
import { withdrawSubscription } from "@/app/monitor/(panel)/billing/withdraw/actions";
import MonitorShell from "@/components/monitor/MonitorShell";
import Field from "@/components/ui/Field";
import Link from "@/components/ui/Link";
import Notice from "@/components/ui/Notice";
import SubmitButton from "@/components/ui/SubmitButton";
import { WITHDRAWAL_TEXTS, fillTemplate } from "@/config/legal/withdrawal-texts";
import { MONITOR_ROBOTS } from "@/config/monitor";
import { MONITOR_BILLING_PATH, MONITOR_WITHDRAW_PATH } from "@/config/payments";
import { getMonitorLocale } from "@/i18n/monitor-locale";
import { formatKroner } from "@/lib/payments/money";
import { CONSUMER_NAME_MAX, WITHDRAW_ERROR_CODES, type WithdrawErrorCode } from "@/lib/payments/withdrawal-contract";
import { formatWithdrawalDate, formatWithdrawalDateTime } from "@/lib/payments/withdrawal-emails";
import { computeWithdrawalRefund, type WithdrawalRefund } from "@/lib/payments/withdrawal-refund";
import { requireMonitor } from "@/services/auth/require-role";
import {
  getMyWithdrawalStatus,
  getSubscriptionPlan,
  type MyWithdrawalStatus,
  type WithdrawalState,
} from "@/services/payments/billing";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getMonitorLocale(), namespace: "Payments.withdraw" });
  return { title: t("metaTitle"), robots: MONITOR_ROBOTS };
}

type WithdrawPageProps = {
  /** `error=<code>`: the withdrawal action could not take the withdrawal (a WithdrawResult error code). */
  searchParams?: Promise<{ error?: string | string[] }>;
};

/** Each withdrawal state's label key on the receipt. */
const STATE_LABELS = {
  received: "statusReceived",
  canceled: "statusCanceled",
  needs_manual: "statusNeedsManual",
  completed: "statusCompleted",
} as const satisfies Record<WithdrawalState, string>;

function isErrorCode(value: unknown): value is WithdrawErrorCode {
  return (WITHDRAW_ERROR_CODES as readonly unknown[]).includes(value);
}

/** The failed-submit alert's id: after `?error=invalid_input` the name field is described by it. */
const ERROR_ALERT_ID = "withdraw-error";

/**
 * The refund the withdrawal would give if it were received at `now`, from the
 * subscription's newest paid invoice and its period (the Worker computes the
 * real amount the same way from the moment it receives the withdrawal); null
 * without a paid invoice with a usable period.
 */
function estimateRefund(status: MyWithdrawalStatus, now: number): WithdrawalRefund | null {
  const { invoice } = status;
  if (invoice === null || invoice.period_start === null || invoice.period_end === null) return null;
  try {
    return computeWithdrawalRefund({
      paidOre: invoice.amount_total_ore,
      periodStart: Date.parse(invoice.period_start),
      periodEnd: Date.parse(invoice.period_end),
      requestedAt: now,
      basis: status.has_consent ? "consent" : "no_consent",
    });
  } catch {
    // An empty or reversed period: no estimate rather than a wrong one.
    return null;
  }
}

/**
 * `/monitor/billing/withdraw`: step 2 of 2 of the online withdrawal
 * (fortrydelsesfunktion; step 1 is "Fortryd aftale" on the billing page), in
 * the approved billing page's cards. While the database says the 14-day
 * window is open and nothing has been withdrawn: the agreement (the account
 * email, read-only, the plan, its billing period and the date the agreement
 * was made), the withdrawal statement with that date and what it does (from
 * the versioned legal module, with or without a recorded consent to start at
 * once), the estimated refund, the required name field and "Bekræft
 * fortrydelse" (`withdrawSubscription`). Once a withdrawal exists: its
 * receipt (received at, status, and when completed what was paid, retained
 * and refunded) instead of the form. Without a subscription, or with the
 * window closed: a notice saying so, and no form. After a failed action
 * (`?error=<code>`) an alert says why, unless a withdrawal is recorded by
 * now (the call may have failed after the Worker recorded it): then only its
 * receipt shows; after `invalid_input` the name field is also marked invalid
 * and described by the alert. The estimate's note that the final amount
 * depends on when the withdrawal is received shows only with a recorded
 * consent (without one the whole amount is refunded, whenever it arrives). A
 * back link (at least 44×44px) returns to the billing page. Owner and
 * `monitor_user` only. In the visitor's Monitor language.
 */
export default async function WithdrawPage({ searchParams }: WithdrawPageProps) {
  const user = await requireMonitor();
  const locale = await getMonitorLocale();
  const [status, query, t] = await Promise.all([
    getMyWithdrawalStatus(),
    searchParams,
    getTranslations({ locale, namespace: "Payments.withdraw" }),
  ]);
  // A recorded withdrawal makes a failed submit's notice wrong: the receipt alone shows then.
  const withdrawn = status !== null && status.withdrawal !== null;
  const errorCode = isErrorCode(query?.error) && !withdrawn ? query.error : null;
  const nameInvalid = errorCode === "invalid_input";
  const amount = (ore: number) => t("amount", { amount: formatKroner(ore, locale) });

  let content: ReactNode;
  let confirming = false;
  if (status === null) {
    content = <Notice tone="error">{t("noSubscription")}</Notice>;
  } else if (status.withdrawal !== null) {
    const { withdrawal } = status;
    const completed = withdrawal.status === "completed";
    content = (
      <section aria-labelledby="withdraw-receipt" className={BILLING_CARD}>
        <h2 id="withdraw-receipt" className="text-h3 font-semibold">
          {t("receiptHeading")}
        </h2>
        <dl className="flex flex-col gap-3">
          <Detail term={t("requestedAt")}>{formatWithdrawalDateTime(withdrawal.requested_at, locale)}</Detail>
          <Detail term={t("status")}>{t(STATE_LABELS[withdrawal.status])}</Detail>
          {completed && withdrawal.paid_ore !== null && <Detail term={t("paid")}>{amount(withdrawal.paid_ore)}</Detail>}
          {completed && withdrawal.retained_ore !== null && (
            <Detail term={t("retained")}>{amount(withdrawal.retained_ore)}</Detail>
          )}
          {completed && withdrawal.refund_ore !== null && (
            <Detail term={t("refunded")}>{amount(withdrawal.refund_ore)}</Detail>
          )}
        </dl>
        <p className="text-small text-muted">{t("receiptNote")}</p>
      </section>
    );
  } else if (!status.window_open || status.started_at === null) {
    content = <Notice tone="error">{t("windowClosed")}</Notice>;
  } else {
    confirming = true;
    const texts = WITHDRAWAL_TEXTS[locale];
    const startDate = formatWithdrawalDate(status.started_at, locale);
    const plan = await getSubscriptionPlan(status.subscription_id);
    const estimate = estimateRefund(status, Date.now());
    content = (
      <>
        <section aria-labelledby="withdraw-contract" className={BILLING_CARD}>
          <h2 id="withdraw-contract" className="text-h3 font-semibold">
            {t("contractHeading")}
          </h2>
          <dl className="flex flex-col gap-3">
            <Detail term={t("account")}>{user.email}</Detail>
            {plan !== null && plan.planName !== null && <Detail term={t("plan")}>{plan.planName}</Detail>}
            {plan !== null && plan.interval !== null && (
              <Detail term={t("interval")}>{t(plan.interval === "year" ? "intervalYear" : "intervalMonth")}</Detail>
            )}
            <Detail term={t("startDate")}>{startDate}</Detail>
          </dl>
        </section>
        <section aria-labelledby="withdraw-statement" className={BILLING_CARD}>
          <h2 id="withdraw-statement" className="text-h3 font-semibold">
            {t("statementHeading")}
          </h2>
          <div className="flex flex-col gap-2">
            <p className="font-semibold">{fillTemplate(texts.statement, { startDate })}</p>
            <p className="text-muted">{status.has_consent ? texts.statementEffect : texts.statementEffectNoConsent}</p>
          </div>
          {estimate !== null && (
            <div className="flex flex-col gap-1">
              <p className="font-semibold">
                {t("estimate", {
                  refund: formatKroner(estimate.refundOre, locale),
                  paid: formatKroner(estimate.paidOre, locale),
                })}
              </p>
              {status.has_consent && <p className="text-small text-muted">{t("estimateNote")}</p>}
            </div>
          )}
          <form action={withdrawSubscription} className="flex flex-col gap-4">
            <Field
              name="name"
              label={t("nameLabel")}
              hint={t("nameHint")}
              autoComplete="name"
              required
              maxLength={CONSUMER_NAME_MAX}
              aria-invalid={nameInvalid || undefined}
              aria-describedby={nameInvalid ? ERROR_ALERT_ID : undefined}
            />
            <SubmitButton className="w-full">{t("submit")}</SubmitButton>
          </form>
        </section>
      </>
    );
  }

  return (
    <MonitorShell email={user.email} section="billing" locale={locale} currentPath={MONITOR_WITHDRAW_PATH}>
      {/* Inherited overflow-wrap, as on the billing page: a long word breaks, never widens the page. */}
      <div className="flex flex-col gap-6 wrap-break-word">
        <Link href={MONITOR_BILLING_PATH} className="inline-flex min-h-11 min-w-11 items-center self-start text-small">
          <span aria-hidden="true">‹&nbsp;</span>
          {t("back")}
        </Link>
        <header className="flex flex-col gap-1">
          {confirming && <p className="text-small text-muted">{t("step")}</p>}
          <h1 className="text-h2 font-semibold">{t("title")}</h1>
          {confirming && <p className="text-muted">{t("lead")}</p>}
        </header>
        {errorCode !== null && (
          <Notice id={ERROR_ALERT_ID} tone="error" role="alert" className="max-w-140">
            {t(`errors.${errorCode}`)}
          </Notice>
        )}
        {content}
      </div>
    </MonitorShell>
  );
}

/** One term of a card's description list: a muted label over its value. */
function Detail({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-small text-muted">{term}</dt>
      <dd className="font-semibold">{children}</dd>
    </div>
  );
}
