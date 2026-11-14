import { WorkerEntrypoint } from "cloudflare:workers";
import { parseWithdrawInput, type WithdrawErrorCode, type WithdrawResult } from "@/lib/payments/withdrawal-contract";
import { createWorkerDeps } from "./deps";
import { parsePaymentsEnv, type PaymentsEnv } from "./env";
import { isDatabaseRefusal } from "./refusal";
import type { WithdrawalSnapshot } from "./rpc";
import { processWithdrawal } from "./withdrawal";

const LOG_MSG = "payments withdraw";

/** The answer for a withdrawal recorded in the database, whatever this call got done of it. */
function recorded(withdrawal: WithdrawalSnapshot): WithdrawResult {
  const { id: withdrawalId, requested_at: requestedAt, paid_ore: paidOre, retained_ore: retainedOre, refund_ore: refundOre } =
    withdrawal;
  // A completed row always has its amounts (the table's CHECKs); without them it is reported as in progress.
  if (withdrawal.status === "completed" && paidOre !== null && retainedOre !== null && refundOre !== null) {
    return { ok: true, withdrawalId, status: "completed", requestedAt, paidOre, retainedOre, refundOre };
  }
  return { ok: true, withdrawalId, status: withdrawal.status === "completed" ? "received" : withdrawal.status, requestedAt };
}

/**
 * The named entrypoint the web app's `withdrawSubscription` action calls over
 * the Cloudflare service binding `PAYMENTS` (root wrangler.jsonc `services`).
 * Not reachable from the internet: routes reach only the default `fetch`.
 * The web app sends the user's access token and never a user id: the user
 * (id and the receipt address, the account email) comes only from Supabase
 * Auth's answer for the token.
 */
export class WithdrawalService extends WorkerEntrypoint<unknown> {
  /**
   * Withdraws `input` ({@link parseWithdrawInput}; else `invalid_input`): the
   * token's user (`unauthenticated` when Auth refuses it), then
   * `payments_begin_withdrawal`, which records the notice with the database's
   * time and checks ownership and the window (`not_withdrawable`,
   * `window_expired`; a repeated submit resumes the recorded withdrawal),
   * then one pass of `processWithdrawal` (cancel, refund, receipt). Once the
   * notice is recorded the answer is always `ok: true` with the withdrawal's
   * state: what is left the hourly sweep finishes. `unavailable` for a bad
   * environment or a failed Auth or database call before that. Logs one JSON
   * line with the withdrawal id and outcome (two when the pass fails after
   * the notice is recorded: `process_failed`, then the begin outcome), never
   * the token, the name or an email.
   */
  async withdraw(input: unknown): Promise<WithdrawResult> {
    const log = (outcome: string, code: string | null, withdrawal: string | null = null) =>
      console.log(JSON.stringify({ msg: LOG_MSG, withdrawal, outcome, code }));
    const refuse = (code: WithdrawErrorCode, reason: string | null = null): WithdrawResult => {
      log("refused", reason ?? code);
      return { ok: false, code };
    };

    const parsed = parseWithdrawInput(input);
    if (parsed === null) return refuse("invalid_input");
    let config: PaymentsEnv;
    try {
      config = parsePaymentsEnv(this.env);
    } catch {
      return refuse("unavailable", "invalid_env");
    }
    const deps = createWorkerDeps(config);

    let user;
    try {
      user = await deps.rpc.getUser(parsed.accessToken);
    } catch {
      return refuse("unavailable", "auth_failed");
    }
    if (user === null) return refuse("unauthenticated");
    if (user.email === null) return refuse("unavailable", "no_email");

    let begun;
    try {
      begun = await deps.rpc.paymentsBeginWithdrawal({
        userId: user.id,
        subscriptionId: parsed.subscriptionId,
        consumerName: parsed.consumerName,
        ackEmail: user.email,
        statementVersion: parsed.statementVersion,
        locale: parsed.locale,
      });
    } catch (error) {
      if (isDatabaseRefusal(error, "not_withdrawable")) return refuse("not_withdrawable");
      if (isDatabaseRefusal(error, "window_expired")) return refuse("window_expired");
      return refuse("unavailable", "begin_failed");
    }

    let withdrawal = begun.withdrawal;
    try {
      withdrawal = await processWithdrawal(deps, withdrawal.id);
    } catch {
      // Recorded already: the sweep finishes it.
      log("process_failed", "rpc_failed", withdrawal.id);
    }
    log(begun.outcome, null, withdrawal.id);
    return recorded(withdrawal);
  }
}
