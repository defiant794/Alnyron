import type { StripeResult } from "@/lib/payments/stripe";
import { MailError } from "../mail";
import { MailNotDueError } from "./mail";
import { OrderRpcError, type OrderMailKind, type OrderRpc, type OrderWithdrawalStep } from "./rpc";

/**
 * Sending and recording the goods emails, shared by the webhook, the
 * OrderService and the sweep: each send is followed by its stamp, so the sweep
 * (`payments_pending_order_work`) lists only what has not gone out. At most
 * two subrequests each: the send and its stamp, or the send and the failure
 * count (`failed` / `mail_failed`, which moves the row towards the sweep's
 * mail cap) when the send fails. A stamp that fails after a sent email is not
 * counted as a failed send: the next sweep sends again under the same
 * idempotency key, which Resend answers without a second email.
 */

/**
 * The log code of a failure: a mail failure's (`mail_transient`, …,
 * `mail_not_due`), the database's refusal or `rpc_<code>`, else `unexpected`.
 * Never a message of the failure, which may echo a value.
 */
export function failureCode(error: unknown): string {
  if (error instanceof MailError) return error.code;
  if (error instanceof MailNotDueError) return error.message;
  if (error instanceof OrderRpcError) return error.refusal ?? `rpc_${error.code}`;
  return "unexpected";
}

/** The log code of a failed Stripe call: `stripe_network`, `stripe_invalid_response` or `stripe_http_<status>`. */
export function stripeFailure(result: Exclude<StripeResult<unknown>, { ok: true }>): string {
  return result.kind === "http" ? `stripe_http_${result.status}` : `stripe_${result.kind}`;
}

/**
 * Sends an order email with `send` and stamps it as `kind`
 * (`payments_order_mail_sent`): `sent`, or the failure's code (a failed send
 * also counts `failed`, best effort). Never throws.
 */
export async function deliverOrderMail(
  rpc: Pick<OrderRpc, "orderMailSent">,
  orderId: string,
  kind: Exclude<OrderMailKind, "failed">,
  send: () => Promise<{ id: string }>,
): Promise<string> {
  let sent: { id: string };
  try {
    sent = await send();
  } catch (error) {
    await rpc.orderMailSent(orderId, "failed", "").catch(() => undefined);
    return failureCode(error);
  }
  try {
    await rpc.orderMailSent(orderId, kind, sent.id);
    return "sent";
  } catch (error) {
    return failureCode(error);
  }
}

/**
 * Sends a withdrawal email with `send` and records `step`
 * (`payments_order_withdrawal_step`; `email_id` with it, but for
 * `reminder_sent`): `sent`, or the failure's code (a failed send also records
 * `mail_failed`, best effort). Never throws.
 */
export async function deliverWithdrawalMail(
  rpc: Pick<OrderRpc, "orderWithdrawalStep">,
  withdrawalId: string,
  step: Extract<OrderWithdrawalStep, "ack_sent" | "owner_alerted" | "receipt_sent" | "reminder_sent" | "manual_alert_sent">,
  send: () => Promise<{ id: string }>,
): Promise<string> {
  let sent: { id: string };
  try {
    sent = await send();
  } catch (error) {
    await rpc.orderWithdrawalStep(withdrawalId, "mail_failed", {}).catch(() => undefined);
    return failureCode(error);
  }
  try {
    await rpc.orderWithdrawalStep(withdrawalId, step, step === "reminder_sent" ? {} : { email_id: sent.id });
    return "sent";
  } catch (error) {
    return failureCode(error);
  }
}
