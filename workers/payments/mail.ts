import { monitorSiteOrigin } from "@/config/monitor";
import { MONITOR_WITHDRAW_PATH, termsPageUrl } from "@/config/payments";
import { sendEmail, type SendFailure } from "@/lib/email/resend";
import {
  buildConfirmationEmail,
  buildOwnerAlertEmail,
  buildReceiptEmail,
  type EmailContent,
  type WithdrawalManualReason,
} from "@/lib/payments/withdrawal-emails";
import type { ConsentMail, WithdrawalSnapshot } from "./rpc";

/**
 * The payments Worker's three emails, sent through Resend: the order
 * confirmation after Checkout (the withdrawal information on a durable
 * medium), the withdrawal receipt to the account email, and the owner's
 * alert about a withdrawal that needs manual handling. Each send carries the
 * caller's idempotency key (`withdrawal-info/<session>`, `withdrawal-ack/<id>`,
 * `withdrawal-alert/<id>`), so a retry within Resend's 24 hours (per Resend's
 * docs as of 2026-11) sends nothing twice. Each resolves with the email's
 * Resend id, the id the caller stamps; with {@link REPLAYED_EMAIL_ID} when
 * Resend answers that the key was already used with another body (the body
 * follows the state it is built from, which may have changed since a send
 * whose stamp failed): nothing is sent again, and the email of that earlier
 * request is taken to have gone out (inferred: Resend's docs as of 2026-11 do
 * not say whether a refused first request keeps its key; the README runbook
 * notes it). Any other failed send throws a {@link MailError}. Nothing here
 * logs.
 */
export type Mailer = {
  /** The order confirmation of a recorded consent, to the account email `to`. */
  sendConfirmationEmail(input: { to: string; mail: ConsentMail; idempotencyKey: string }): Promise<{ id: string }>;
  /** The withdrawal receipt, to the withdrawal's `ack_email`, in its locale and state. */
  sendReceiptEmail(input: { withdrawal: WithdrawalSnapshot; idempotencyKey: string }): Promise<{ id: string }>;
  /**
   * The owner's alert (ids and the reason only) for a withdrawal that needs manual handling; it
   * says whether the consumer's receipt is out (`ack_sent_at`).
   */
  sendOwnerAlertEmail(input: {
    withdrawal: WithdrawalSnapshot;
    reason: WithdrawalManualReason;
    idempotencyKey: string;
  }): Promise<{ id: string }>;
};

/**
 * The id a send resolves with when its key was already used with another body (Resend's 409
 * `invalid_idempotent_request`, `replayed`): the stamp of an email taken to have gone out before.
 */
export const REPLAYED_EMAIL_ID = "idempotent_replay";

/** A send Resend refused or could not take: `code` is `mail_<Resend failure class>`, the log and `last_error` code. */
export class MailError extends Error {
  readonly code: `mail_${Exclude<SendFailure, "replayed">}`;

  constructor(kind: Exclude<SendFailure, "replayed">) {
    super(`mail_${kind}`);
    this.name = "MailError";
    this.code = `mail_${kind}`;
  }
}

export type MailerConfig = {
  resendApiKey: string;
  mailFrom: string;
  withdrawalAlertTo: string;
  /** The main site (https), whose /terms and Monitor withdraw page the emails link. */
  siteUrl: string;
  /** Stands in for the global fetch (the sweep's subrequest counter). */
  fetchImpl?: typeof fetch;
};

/** A {@link Mailer} sending from `mailFrom` with the Resend key. */
export function createMailer(config: MailerConfig): Mailer {
  const siteOrigin = new URL(config.siteUrl).origin;
  const withdrawUrl = `${monitorSiteOrigin(config.siteUrl)}${MONITOR_WITHDRAW_PATH}`;

  const send = async (to: string, content: EmailContent, idempotencyKey: string): Promise<{ id: string }> => {
    const result = await sendEmail(
      config.resendApiKey,
      { from: config.mailFrom, to, subject: content.subject, html: content.html, text: content.text },
      idempotencyKey,
      config.fetchImpl,
    );
    if (!result.ok) {
      if (result.kind === "replayed") return { id: REPLAYED_EMAIL_ID };
      throw new MailError(result.kind);
    }
    // Resend answered 2xx without an id: the stamp still needs one (1 to 200 characters).
    return { id: result.id === "" ? "unknown" : result.id };
  };

  return {
    sendConfirmationEmail({ to, mail, idempotencyKey }) {
      return send(
        to,
        buildConfirmationEmail({
          locale: mail.locale,
          planName: mail.plan.name,
          pricePaidOre: mail.plan.amount_ore,
          billingInterval: mail.plan.billing_interval,
          startDate: mail.started_at ?? mail.accepted_at,
          withdrawUrl,
          termsUrl: termsPageUrl(siteOrigin, mail.locale),
        }),
        idempotencyKey,
      );
    },

    sendReceiptEmail({ withdrawal, idempotencyKey }) {
      const common = {
        locale: withdrawal.locale,
        consumerName: withdrawal.consumer_name,
        requestedAt: withdrawal.requested_at,
        startDate: withdrawal.subscription.started_at ?? withdrawal.requested_at,
      };
      const { paid_ore: paidOre, retained_ore: retainedOre, refund_ore: refundOre } = withdrawal;
      const content =
        withdrawal.status === "completed" && paidOre !== null && retainedOre !== null && refundOre !== null
          ? buildReceiptEmail({ ...common, status: "completed", paidOre, retainedOre, refundOre })
          : buildReceiptEmail({ ...common, status: withdrawal.status === "completed" ? "received" : withdrawal.status });
      return send(withdrawal.ack_email, content, idempotencyKey);
    },

    sendOwnerAlertEmail({ withdrawal, reason, idempotencyKey }) {
      return send(
        config.withdrawalAlertTo,
        buildOwnerAlertEmail({
          withdrawalId: withdrawal.id,
          subscriptionId: withdrawal.stripe_subscription_id,
          requestedAt: withdrawal.requested_at,
          reason,
          canceled: withdrawal.canceled_at !== null,
          receiptSent: withdrawal.ack_sent_at !== null,
        }),
        idempotencyKey,
      );
    },
  };
}
