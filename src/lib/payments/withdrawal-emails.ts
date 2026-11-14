import type { Locale } from "next-intl";
import {
  WITHDRAWAL_ALERT_EMAIL_TEXTS,
  WITHDRAWAL_TEXTS,
  fillTemplate,
  type WithdrawalTexts,
} from "@/config/legal/withdrawal-texts";
import type { BillingInterval } from "@/config/payments";
import { formatKroner } from "@/lib/payments/money";

/**
 * The three emails of a withdrawal (fortrydelse), built from the versioned
 * legal texts: the order confirmation (durable-medium withdrawal
 * information), the withdrawal receipt and the owner's alert. Pure (no env,
 * no I/O), so the payments Worker and tests share it. Every interpolated
 * value is HTML-escaped; dates are Copenhagen dates; money is
 * {@link formatKroner} plus "kr".
 */

export type EmailContent = { subject: string; html: string; text: string };

/** Why a withdrawal needs the owner's manual handling (`manual_reason`). */
export const WITHDRAWAL_MANUAL_REASONS = [
  "subscription_mismatch",
  "invoice_shape",
  "stripe_refused",
  "retries_exhausted",
] as const;

export type WithdrawalManualReason = (typeof WITHDRAWAL_MANUAL_REASONS)[number];

/** A withdrawal's state (`subscription_withdrawals.status`). */
export type WithdrawalStatus = "received" | "canceled" | "completed" | "needs_manual";

/** How long after receiving a withdrawal its refund is due (forbrugeraftaleloven § 22 stk. 1), in calendar days. */
const REFUND_DUE_DAYS = 14;

/** An instant's Copenhagen calendar date, as parts (year, month, day). */
const COPENHAGEN_DAY = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: "Europe/Copenhagen",
});

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escapes `&`, `<`, `>`, `"` and `'` for HTML text and attribute values. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

const DATE_FORMATS: Record<Locale, Intl.DateTimeFormat> = {
  da: new Intl.DateTimeFormat("da-DK", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Copenhagen" }),
  en: new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Copenhagen" }),
};

const DATE_TIME_FORMATS: Record<Locale, Intl.DateTimeFormat> = {
  da: new Intl.DateTimeFormat("da-DK", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Copenhagen" }),
  en: new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Copenhagen" }),
};

/** A date in Copenhagen time ("14. november 2026"; "14 November 2026"). */
export function formatWithdrawalDate(instant: string | number, locale: Locale): string {
  return DATE_FORMATS[locale].format(new Date(instant));
}

/** A date and time in Copenhagen time ("14. november 2026 kl. 11.00"; "14 November 2026 at 11:00"). */
export function formatWithdrawalDateTime(instant: string | number, locale: Locale): string {
  return DATE_TIME_FORMATS[locale].format(new Date(instant));
}

/**
 * The last day of the withdrawal period, as a Copenhagen date, for a
 * deadline (`deadline_at`, the start of the day after the last day): the day
 * of the millisecond before it.
 */
export function formatWithdrawalLastDay(deadlineAt: string, locale: Locale): string {
  return formatWithdrawalDate(Date.parse(deadlineAt) - 1, locale);
}

/**
 * The Copenhagen date `days` calendar days after the Copenhagen date of
 * `instant`, formatted like {@link formatWithdrawalDate}. Date arithmetic,
 * not a span of milliseconds, so a daylight-saving switch in between moves
 * nothing.
 */
function formatCopenhagenDatePlusDays(instant: string, days: number, locale: Locale): string {
  const parts = COPENHAGEN_DAY.formatToParts(new Date(instant));
  const part = (type: "year" | "month" | "day") => Number(parts.find((entry) => entry.type === type)?.value);
  // Noon UTC of the target date is that same date in Copenhagen (UTC+1 or UTC+2).
  return formatWithdrawalDate(Date.UTC(part("year"), part("month") - 1, part("day") + days, 12), locale);
}

/** An amount in øre as "9,67 kr" / "95 kr" ("9.67 kr" in English). */
function kroner(amountOre: number, locale: Locale): string {
  return `${formatKroner(amountOre, locale)} kr`;
}

/** One block of an email: a heading, paragraphs, a quote or plain lines. */
type Block =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; template: string; values?: Readonly<Record<string, string>>; links?: readonly string[] }
  | { kind: "quote"; text: string };

/** `template` filled for HTML: escaped text, escaped values, the `links` placeholders as anchors. */
function htmlLine(template: string, values: Readonly<Record<string, string>>, links: readonly string[]): string {
  const escaped = Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name,
      links.includes(name)
        ? `<a href="${escapeHtml(value)}" style="color:#3346e8;">${escapeHtml(value)}</a>`
        : escapeHtml(value),
    ]),
  );
  return fillTemplate(escapeHtml(template), escaped);
}

const P = '<p style="margin:0 0 12px;">';
const H2 = '<h2 style="margin:24px 0 8px;font-size:17px;line-height:1.3;color:#0b1d33;">';
const QUOTE = '<blockquote style="margin:0 0 12px;padding:8px 16px;border-left:3px solid #c9d2e0;color:#33445a;">';

/** Wraps blocks in the email layout (inline styles, `lang` of the email) plus a text part. */
function render(locale: Locale, subject: string, blocks: readonly Block[], footer: string): EmailContent {
  const html = blocks
    .map((block) => {
      if (block.kind === "heading") return `${H2}${escapeHtml(block.text)}</h2>`;
      if (block.kind === "quote") return `${QUOTE}${escapeHtml(block.text)}</blockquote>`;
      return `${P}${htmlLine(block.template, block.values ?? {}, block.links ?? [])}</p>`;
    })
    .join("\n");
  const text = blocks
    .map((block) => {
      if (block.kind === "heading") return `\n${block.text}`;
      if (block.kind === "quote") return `"${block.text}"`;
      return fillTemplate(block.template, block.values ?? {});
    })
    .join("\n\n");
  return {
    subject,
    html: `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f6f8fb;color:#0b1d33;font-family:'Segoe UI',Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fb;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid #e5e9f0;border-radius:12px;">
<tr><td style="padding:32px 28px;font-size:15px;line-height:1.55;">
<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#0b1d33;">${escapeHtml(subject)}</h1>
${html}
<p style="margin:28px 0 0;font-size:13px;line-height:1.5;color:#5a6778;">${escapeHtml(footer)}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`,
    text: `${subject}\n\n${text}\n\n${footer}\n`,
  };
}

/** The withdrawal notice, the online-withdrawal paragraph and the model form, as blocks. */
function noticeBlocks(texts: WithdrawalTexts, withdrawLine: Block): Block[] {
  return [
    { kind: "heading", text: texts.notice.title },
    ...texts.notice.paragraphs.map((paragraph): Block => ({ kind: "paragraph", template: paragraph })),
    { kind: "paragraph", template: texts.onlineWithdrawal },
    withdrawLine,
    { kind: "heading", text: texts.modelForm.title },
    { kind: "paragraph", template: texts.modelForm.intro },
    ...texts.modelForm.lines.map((line): Block => ({ kind: "paragraph", template: line })),
  ];
}

export type ConfirmationEmailInput = {
  locale: Locale;
  planName: string;
  /** The plan's price per period in øre, incl. moms. */
  pricePaidOre: number;
  billingInterval: BillingInterval;
  /** When the agreement was made (the subscription's start), ISO. */
  startDate: string;
  /** Absolute URL of the Monitor withdraw page. */
  withdrawUrl: string;
  /** Absolute URL of /terms in the email's language. */
  termsUrl: string;
};

/**
 * The order confirmation sent after Checkout: the agreement (plan, price,
 * start), the consent the consumer gave, the withdrawal notice with where to
 * withdraw online, the model form and the terms link. Sending it stamps the
 * consent's `info_sent_at`, which starts the withdrawal period's 14 days
 * (forbrugeraftaleloven § 19 stk. 3).
 */
export function buildConfirmationEmail(input: ConfirmationEmailInput): EmailContent {
  const { locale } = input;
  const texts = WITHDRAWAL_TEXTS[locale];
  const mail = texts.confirmationEmail;
  const agreementValues = {
    planName: input.planName,
    price: kroner(input.pricePaidOre, locale),
    intervalWord: mail.intervalWords[input.billingInterval],
    startDate: formatWithdrawalDate(input.startDate, locale),
  };
  return render(
    locale,
    mail.subject,
    [
      { kind: "paragraph", template: mail.intro },
      { kind: "heading", text: mail.agreementHeading },
      ...mail.agreementLines.map((line): Block => ({ kind: "paragraph", template: line, values: agreementValues })),
      { kind: "heading", text: mail.consentHeading },
      { kind: "paragraph", template: mail.consentIntro },
      { kind: "quote", text: texts.consent },
      ...noticeBlocks(texts, {
        kind: "paragraph",
        template: mail.withdrawOnline,
        values: { withdrawUrl: input.withdrawUrl },
        links: ["withdrawUrl"],
      }),
      { kind: "paragraph", template: mail.termsLine, values: { termsUrl: input.termsUrl }, links: ["termsUrl"] },
    ],
    mail.footer,
  );
}

export type ReceiptEmailInput = {
  locale: Locale;
  consumerName: string;
  /** When the withdrawal was received, ISO. */
  requestedAt: string;
  /** When the agreement was made, ISO. */
  startDate: string;
} & (
  | { status: "completed"; paidOre: number; retainedOre: number; refundOre: number }
  | { status: "received" | "canceled" | "needs_manual" }
);

/**
 * The withdrawal receipt (forbrugeraftaleloven § 20 a): when the notice was
 * received and for which agreement, then the refund once the withdrawal is
 * completed (refunded amount with what was paid and kept, or nothing to
 * refund when nothing was paid), else that it is being processed.
 */
export function buildReceiptEmail(input: ReceiptEmailInput): EmailContent {
  const { locale } = input;
  const mail = WITHDRAWAL_TEXTS[locale].receiptEmail;
  let status: Block;
  if (input.status !== "completed") {
    status = { kind: "paragraph", template: mail.statusInProgress };
  } else if (input.paidOre === 0) {
    status = { kind: "paragraph", template: mail.statusNothing };
  } else {
    status = {
      kind: "paragraph",
      template: mail.statusRefunded,
      values: {
        refund: kroner(input.refundOre, locale),
        paid: kroner(input.paidOre, locale),
        retained: kroner(input.retainedOre, locale),
      },
    };
  }
  return render(
    locale,
    mail.subject,
    [
      { kind: "paragraph", template: mail.greeting, values: { consumerName: input.consumerName } },
      {
        kind: "paragraph",
        template: mail.received,
        values: {
          requestedAt: formatWithdrawalDateTime(input.requestedAt, locale),
          startDate: formatWithdrawalDate(input.startDate, locale),
        },
      },
      status,
      { kind: "paragraph", template: mail.closing },
    ],
    mail.footer,
  );
}

export type OwnerAlertEmailInput = {
  withdrawalId: string;
  subscriptionId: string;
  /** When the withdrawal was received, ISO. */
  requestedAt: string;
  reason: WithdrawalManualReason;
  /** Whether the subscription is stopped (canceled in Stripe). */
  canceled: boolean;
  /** Whether the consumer's receipt has been sent (`ack_sent_at`). */
  receiptSent: boolean;
};

/**
 * The owner's alert for a withdrawal that needs manual handling: ids, the
 * reason, whether the subscription is stopped, whether the consumer has the
 * receipt (else to send it by hand), and the refund deadline (the Copenhagen
 * date 14 calendar days after the notice's). No consumer name or email: the
 * ids are enough to look them up.
 */
export function buildOwnerAlertEmail(input: OwnerAlertEmailInput): EmailContent {
  const texts = WITHDRAWAL_ALERT_EMAIL_TEXTS;
  const values = {
    withdrawalId: input.withdrawalId,
    subscriptionId: input.subscriptionId,
    requestedAt: formatWithdrawalDateTime(input.requestedAt, "da"),
    reason: input.reason,
    canceledYesNo: input.canceled ? texts.yes : texts.no,
    refundDeadline: formatCopenhagenDatePlusDays(input.requestedAt, REFUND_DUE_DAYS, "da"),
  };
  return render(
    "da",
    fillTemplate(texts.subject, { reason: input.reason }),
    [
      { kind: "paragraph", template: texts.intro },
      ...texts.lines.map((line): Block => ({ kind: "paragraph", template: line, values })),
      { kind: "paragraph", template: input.receiptSent ? texts.receiptSent : texts.receiptNotSent },
      { kind: "paragraph", template: texts.refundDeadline, values },
      { kind: "paragraph", template: texts.runbook },
    ],
    "Alnyron",
  );
}
