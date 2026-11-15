import {
  PAYMENTS_SWEEP_CONSENT_SUBREQUESTS,
  PAYMENTS_SWEEP_LIMIT,
  PAYMENTS_SWEEP_ORDER_SUBREQUESTS,
  PAYMENTS_SWEEP_SUBREQUEST_BUDGET,
  PAYMENTS_SWEEP_WITHDRAWAL_SUBREQUESTS,
  WITHDRAWAL_MAX_MAIL_ATTEMPTS,
  WITHDRAWAL_PASS_MAX_SUBREQUESTS,
} from "@/config/payments";
import { sendConsentConfirmation } from "./consent";
import { createWorkerDeps } from "./deps";
import type { PaymentsEnv } from "./env";
import { createOrderDeps } from "./orders/deps";
import { parseOrdersEnv } from "./orders/env";
import { ORDER_SWEEP_LOG_MSG, runOrderPass } from "./orders/sweep";
import { processWithdrawal } from "./withdrawal";

const LOG_MSG = "payments sweep";

/** A fetch that counts its calls: every Stripe, Supabase and Resend request of the sweep goes through it. */
function countingFetch(): { fetch: typeof fetch; count: () => number } {
  let count = 0;
  return {
    fetch: (input, init) => {
      count += 1;
      return fetch(input, init);
    },
    count: () => count,
  };
}

/**
 * The hourly sweep (`scheduled()`): finishes what the withdrawal calls and
 * the checkout webhook left undone. `payments_pending_work` lists at most
 * PAYMENTS_SWEEP_LIMIT withdrawals with work left, the least recently
 * touched first, so one that keeps failing goes to the back (one pass of
 * `processWithdrawal` each: cancel, refund, receipt, owner alert; a
 * withdrawal whose only work left is an email is listed for
 * WITHDRAWAL_MAX_MAIL_ATTEMPTS passes, no more), and order confirmations not yet
 * sent (sent and stamped). Each item is isolated: a failure is logged and the
 * sweep goes on; it never throws. Subrequests are counted as made (every
 * fetch), and an item starts only when its worst case still fits
 * PAYMENTS_SWEEP_SUBREQUEST_BUDGET (45, per contract A8): a withdrawal pass
 * WITHDRAWAL_PASS_MAX_SUBREQUESTS (15; it is charged what it really made, at
 * least PAYMENTS_SWEEP_WITHDRAWAL_SUBREQUESTS, 10), an order confirmation
 * PAYMENTS_SWEEP_CONSENT_SUBREQUESTS (4). While there is a confirmation to
 * send, a withdrawal pass starts only when one confirmation still fits after
 * it (15 + 4), so a full withdrawal list never starves the confirmations;
 * they then take what is left. A run so makes at most 45 subrequests, under
 * the 50 Workers Free allows (per Cloudflare's limits docs as of 2026-11):
 * what is left waits for the next hour. Logs ids, outcomes and counts only.
 *
 * Then the goods pass (orders/sweep.ts `runOrderPass`, slice S2) with what is
 * left of the budget, at most PAYMENTS_SWEEP_ORDER_SUBREQUESTS (12), only with
 * a valid orders env (`parseOrdersEnv` of the Worker's `env`; else skipped and
 * logged `orders_env_unavailable`).
 */
export async function runSweep(config: PaymentsEnv, env: unknown): Promise<void> {
  const counter = countingFetch();
  const deps = createWorkerDeps(config, counter.fetch);
  const log = (fields: Record<string, string | number | boolean | null>) =>
    deps.log(JSON.stringify({ msg: LOG_MSG, ...fields }));
  // Each call is charged what it really fetched, but at least its reserve (the pending-work read 1,
  // a withdrawal 10, a confirmation 4): never under the real count. An item starts only when its
  // worst case still fits, so the real count never passes the budget.
  let charged = 0;
  const fits = (worstCase: number) => charged + worstCase <= PAYMENTS_SWEEP_SUBREQUEST_BUDGET;
  const run = async <T>(reserve: number, call: () => Promise<T>): Promise<T> => {
    const before = counter.count();
    try {
      return await call();
    } finally {
      charged += Math.max(counter.count() - before, reserve);
    }
  };
  // Goods (slice S2) last, so it never starves the passes above: within what they left, at most its
  // own cap. Skipped (logged) without a valid orders env.
  const orderPass = async (): Promise<void> => {
    let ordersEnv;
    try {
      ordersEnv = parseOrdersEnv(env);
    } catch {
      deps.log(JSON.stringify({ msg: ORDER_SWEEP_LOG_MSG, outcome: "skipped", code: "orders_env_unavailable" }));
      return;
    }
    await runOrderPass(createOrderDeps(config, ordersEnv, counter.fetch), {
      limit: Math.min(PAYMENTS_SWEEP_ORDER_SUBREQUESTS, PAYMENTS_SWEEP_SUBREQUEST_BUDGET - charged),
      count: counter.count,
    });
  };

  let work;
  try {
    work = await run(1, () => deps.rpc.paymentsPendingWork(PAYMENTS_SWEEP_LIMIT, WITHDRAWAL_MAX_MAIL_ATTEMPTS));
  } catch {
    log({ outcome: "error", code: "pending_work_failed" });
    return orderPass();
  }

  let withdrawals = 0;
  let consents = 0;
  let budgetStop = false;
  // A pass starts only when its worst case fits and, while a confirmation waits, that confirmation after it.
  const consentSlot = work.consents.length > 0 ? PAYMENTS_SWEEP_CONSENT_SUBREQUESTS : 0;
  for (const id of work.withdrawals) {
    if (!fits(WITHDRAWAL_PASS_MAX_SUBREQUESTS + consentSlot)) {
      budgetStop = true;
      break;
    }
    withdrawals += 1;
    try {
      await run(PAYMENTS_SWEEP_WITHDRAWAL_SUBREQUESTS, () => processWithdrawal(deps, id));
    } catch {
      log({ withdrawal: id, outcome: "error", code: "process_failed" });
    }
  }
  for (const mail of work.consents) {
    if (!fits(PAYMENTS_SWEEP_CONSENT_SUBREQUESTS)) {
      budgetStop = true;
      break;
    }
    consents += 1;
    try {
      const outcome = await run(PAYMENTS_SWEEP_CONSENT_SUBREQUESTS, () => sendConsentConfirmation(deps, mail));
      log({ session: mail.checkout_session_id, outcome, code: null });
    } catch {
      log({ session: mail.checkout_session_id, outcome: "error", code: "confirmation_failed" });
    }
  }
  log({ outcome: "done", withdrawals, consents, budgetStop, subrequests: counter.count() });
  await orderPass();
}
