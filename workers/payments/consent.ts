import type { Mailer } from "./mail";
import type { ConsentMail, PaymentsRpc } from "./rpc";

export type ConsentMailDeps = {
  rpc: Pick<PaymentsRpc, "getUserEmail" | "paymentsMarkConsentInfoSent">;
  mail: Pick<Mailer, "sendConfirmationEmail">;
};

/**
 * Sends a recorded consent's order confirmation (the withdrawal information
 * on a durable medium) to the account's current email, under the key
 * `withdrawal-info/<checkout session id>`, then stamps the consent's
 * `info_sent_at`, which starts the 14 days (forbrugeraftaleloven § 19 stk. 3):
 * with the email's id, or `idempotent_replay` when the key already sent one
 * (see the mailer). `no_recipient` when the account is gone or has no email
 * (nothing sent, not stamped). Shared by the checkout webhook and the sweep,
 * which resends what a failure left unsent. Throws when the lookup, the send
 * or the stamp fails.
 */
export async function sendConsentConfirmation(deps: ConsentMailDeps, mail: ConsentMail): Promise<"sent" | "no_recipient"> {
  if (mail.user_id === null) return "no_recipient";
  const to = await deps.rpc.getUserEmail(mail.user_id);
  if (to === null) return "no_recipient";
  const sent = await deps.mail.sendConfirmationEmail({
    to,
    mail,
    idempotencyKey: `withdrawal-info/${mail.checkout_session_id}`,
  });
  await deps.rpc.paymentsMarkConsentInfoSent(mail.checkout_session_id, sent.id);
  return "sent";
}
