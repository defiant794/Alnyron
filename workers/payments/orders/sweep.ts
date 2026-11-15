import { PAYMENTS_SWEEP_LIMIT, WITHDRAWAL_MAX_MAIL_ATTEMPTS } from "@/config/payments";
import type { OrderDeps } from "./deps";
import { deliverOrderMail, deliverWithdrawalMail, failureCode } from "./deliver";
import type { OrderMailNeed, OrderSnapshot, OrderWithdrawalNeed, OrderWithdrawalSnapshot } from "./rpc";
import { processOrderRefund } from "./withdrawal";

/**
 * The most subrequests one `processOrderRefund` pass makes: claim 1 + at most 2 Stripe calls
 * in either branch (cancel and re-retrieve, or refund list and create) + step 1 + email and
 * stamp 2 = 6 (see orders/withdrawal.ts).
 */
const ORDER_REFUND_PASS_SUBREQUESTS = 6;

/** One email of the pass: the send and its stamp, or the send and the failure count (orders/deliver.ts). */
const ORDER_MAIL_SUBREQUESTS = 2;

/** The read of an order or a withdrawal (with its order) that an item's emails are built from. */
const ORDER_READ_SUBREQUESTS = 1;

/** The goods pass's log lines (also its skip line in ../sweep.ts). */
export const ORDER_SWEEP_LOG_MSG = "payments order sweep";

/** The order emails of the sweep, by what `payments_pending_order_work` lists. */
const ORDER_MAILS: Record<OrderMailNeed, (deps: OrderDeps, order: OrderSnapshot) => Promise<{ id: string }>> = {
  confirmation: (deps, order) => deps.mail.sendConfirmation(order),
  owner: (deps, order) => deps.mail.sendOwnerNewOrder(order),
  shipped: (deps, order) => deps.mail.sendShipped(order),
  expired_alert: (deps, order) => deps.mail.sendAuthorizationExpired(order),
};

/** The withdrawal emails of the sweep and the step each records. */
const WITHDRAWAL_MAILS: Record<
  Exclude<OrderWithdrawalNeed, "refund">,
  {
    step: "ack_sent" | "owner_alerted" | "receipt_sent" | "reminder_sent" | "manual_alert_sent";
    send: (deps: OrderDeps, order: OrderSnapshot, withdrawal: OrderWithdrawalSnapshot) => Promise<{ id: string }>;
  }
> = {
  ack: { step: "ack_sent", send: (deps, order, withdrawal) => deps.mail.sendWithdrawalAck(order, withdrawal) },
  owner_alert: { step: "owner_alerted", send: (deps, order, withdrawal) => deps.mail.sendWithdrawalAlert(order, withdrawal) },
  receipt: { step: "receipt_sent", send: (deps, order, withdrawal) => deps.mail.sendWithdrawalReceipt(order, withdrawal) },
  reminder: { step: "reminder_sent", send: (deps, order, withdrawal) => deps.mail.sendRefundReminder(order, withdrawal) },
  manual_alert: { step: "manual_alert_sent", send: (deps, order, withdrawal) => deps.mail.sendManualAlert(order, withdrawal) },
};

/**
 * The hourly sweep's goods pass (slice S2), run after the subscription and
 * withdrawal passes by `runSweep` (../sweep.ts) with what is left of its
 * budget, at most PAYMENTS_SWEEP_ORDER_SUBREQUESTS (`limit`).
 * `payments_pending_order_work` (PAYMENTS_SWEEP_LIMIT of each list, the mail
 * cap WITHDRAWAL_MAX_MAIL_ATTEMPTS) lists, least recently touched first:
 * orders with a missing email (the confirmation = the invoice, the owner's new
 * order, the shipped email, the owner's lapsed-reservation alert), orders
 * whose authorization lapses within 48 hours (the owner's capture warning)
 * and withdrawals with work left (the receipt and the owner's alert, never
 * for a notice the owner recorded; the refund deadline reminder to the owner;
 * the credit note; the owner's manual-handling alert; and the refund or
 * release itself: one `processOrderRefund` pass). Each email is sent and
 * stamped (a failed send is counted, moving the row back and towards the mail
 * cap).
 *
 * Subrequests are counted as made (`count`, every fetch since the pass
 * began): the list 1; an item starts only when its worst case still fits
 * `limit`: per email 2 plus the read of its order or withdrawal 1, a refund
 * pass ORDER_REFUND_PASS_SUBREQUESTS (6). What does not fit waits an hour.
 * Each item is isolated: a failure is logged and the pass goes on; it never
 * throws. Logs one line per email or refund pass and a closing
 * `{msg: "payments order sweep", outcome: "done", orders, warnings,
 * withdrawals, budgetStop, subrequests}`: ids, needs and codes only.
 */
export async function runOrderPass(deps: OrderDeps, budget: { limit: number; count: () => number }): Promise<void> {
  const start = budget.count();
  const used = () => budget.count() - start;
  const fits = (worstCase: number) => used() + worstCase <= budget.limit;
  const log = (fields: Record<string, string | number | boolean | null>) =>
    deps.log(JSON.stringify({ msg: ORDER_SWEEP_LOG_MSG, ...fields }));

  if (!fits(ORDER_READ_SUBREQUESTS)) {
    log({ outcome: "skipped", code: "budget_spent" });
    return;
  }
  let work;
  try {
    work = await deps.rpc.pendingOrderWork(PAYMENTS_SWEEP_LIMIT, WITHDRAWAL_MAX_MAIL_ATTEMPTS);
  } catch (error) {
    log({ outcome: "error", code: `pending_order_work_${failureCode(error)}` });
    return;
  }

  let orders = 0;
  let warnings = 0;
  let withdrawals = 0;
  let budgetStop = false;
  const mailWorstCase = (mails: number) => (mails === 0 ? 0 : ORDER_READ_SUBREQUESTS + mails * ORDER_MAIL_SUBREQUESTS);

  /** Logs one email: `sent`, else `failed` with the failure's code. */
  const logMail = (item: { order: string } | { withdrawal: string }, need: string, outcome: string) =>
    log({ ...item, need, outcome: outcome === "sent" ? "sent" : "failed", code: outcome === "sent" ? null : outcome });

  /** Reads what an item's emails are built from; null (logged) when the read failed or found nothing. */
  const read = async <T>(item: { order: string } | { withdrawal: string }, reader: () => Promise<T | null>): Promise<T | null> => {
    try {
      const found = await reader();
      if (found === null) log({ ...item, outcome: "error", code: "not_found" });
      return found;
    } catch (error) {
      log({ ...item, outcome: "error", code: `read_${failureCode(error)}` });
      return null;
    }
  };

  for (const { orderId, needs } of work.ordersMail) {
    if (!fits(mailWorstCase(needs.length))) {
      budgetStop = true;
      break;
    }
    orders += 1;
    const order = await read({ order: orderId }, () => deps.rpc.readOrder(orderId));
    if (order === null) continue;
    for (const need of needs) {
      logMail({ order: orderId }, need, await deliverOrderMail(deps.rpc, orderId, need, () => ORDER_MAILS[need](deps, order)));
    }
  }

  for (const orderId of budgetStop ? [] : work.captureWarnings) {
    if (!fits(mailWorstCase(1))) {
      budgetStop = true;
      break;
    }
    warnings += 1;
    const order = await read({ order: orderId }, () => deps.rpc.readOrder(orderId));
    if (order === null) continue;
    const outcome = await deliverOrderMail(deps.rpc, orderId, "capture_warning", () => deps.mail.sendCaptureWarning(order));
    logMail({ order: orderId }, "capture_warning", outcome);
  }

  for (const { withdrawalId, needs } of budgetStop ? [] : work.withdrawals) {
    const mails = needs.filter((need) => need !== "refund");
    const refund = needs.includes("refund");
    if (!fits(mailWorstCase(mails.length) + (refund ? ORDER_REFUND_PASS_SUBREQUESTS : 0))) {
      budgetStop = true;
      break;
    }
    withdrawals += 1;
    const item = { withdrawal: withdrawalId };
    const found = mails.length === 0 ? null : await read(item, () => deps.rpc.readOrderWithdrawal(withdrawalId));
    if (found !== null) {
      for (const need of mails) {
        const { step, send } = WITHDRAWAL_MAILS[need];
        logMail(item, need, await deliverWithdrawalMail(deps.rpc, withdrawalId, step, () => send(deps, found.order, found.withdrawal)));
      }
    }
    if (refund) {
      try {
        log({ ...item, need: "refund", outcome: await processOrderRefund(deps, withdrawalId), code: null });
      } catch (error) {
        log({ ...item, need: "refund", outcome: "error", code: `claim_${failureCode(error)}` });
      }
    }
  }
  log({ outcome: "done", orders, warnings, withdrawals, budgetStop, subrequests: used() });
}
