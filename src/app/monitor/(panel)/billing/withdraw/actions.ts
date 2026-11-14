"use server";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { WITHDRAWAL_TEXT_VERSION } from "@/config/legal/withdrawal-texts";
import { MONITOR_BILLING_PATH, MONITOR_WITHDRAW_PATH } from "@/config/payments";
import { getMonitorLocale } from "@/i18n/monitor-locale";
import { allowBillingSession } from "@/lib/payments/rate-limit";
import { parseConsumerName, parseWithdrawResult, type WithdrawErrorCode } from "@/lib/payments/withdrawal-contract";
import { createServerClient } from "@/lib/supabase/server";
import { requireMonitor } from "@/services/auth/require-role";
import { getMyWithdrawalStatus } from "@/services/payments/billing";

/** Back to the confirm page, which shows the code's notice. */
function withdrawError(code: WithdrawErrorCode): never {
  redirect(`${MONITOR_WITHDRAW_PATH}?${new URLSearchParams({ error: code })}`);
}

/**
 * The payments Worker's `WithdrawalService` binding, or null when this Worker
 * (or the local dev proxy) has none or there is no Cloudflare context.
 */
function paymentsBinding(): NonNullable<CloudflareEnv["PAYMENTS"]> | null {
  try {
    return getCloudflareContext().env.PAYMENTS ?? null;
  } catch {
    return null;
  }
}

/**
 * "Bekræft fortrydelse" (`/monitor/billing/withdraw`, step 2 of 2): sends the
 * withdrawal to the payments Worker over the `PAYMENTS` service binding,
 * which verifies the user from the access token, records the statement,
 * stops the subscription and refunds. The only field read is the consumer's
 * name (trimmed, 1 to 200 characters, no control characters); the
 * subscription is the one `my_withdrawal_status()` reports for the session,
 * never a form value, and no user id crosses the binding. The access token is
 * the session's own (`auth.getSession()` only forwards it: the Worker checks
 * it with Supabase Auth). Whether the window is still open is the database's
 * decision alone. Afterwards back to the confirm page, which shows the
 * withdrawal's receipt state from the database; on a refusal or failure back
 * there with `?error=<code>`: `unavailable` over the per-user rate limit,
 * without the binding, or for any answer of the wrong shape (a failed or
 * timed-out call included) unless the database then shows the withdrawal
 * recorded (the call can fail after the Worker recorded it: then no error),
 * `invalid_input` for a bad name, `not_withdrawable` without a subscription,
 * else the Worker's code. Owner and `monitor_user` only. Never logs the token
 * or the name.
 */
export async function withdrawSubscription(formData: FormData): Promise<never> {
  const user = await requireMonitor();
  // Before any database or Worker call; fails closed (a throwing limiter counts as a refusal).
  const allowed = await allowBillingSession(user.userId).catch(() => false);
  if (!allowed) withdrawError("unavailable");
  const consumerName = parseConsumerName(formData.get("name"));
  if (consumerName === null) withdrawError("invalid_input");

  const status = await getMyWithdrawalStatus().catch(() => undefined);
  if (status === undefined) withdrawError("unavailable");
  if (status === null) withdrawError("not_withdrawable");
  const supabase = await createServerClient();
  const { data } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token;
  if (accessToken === undefined) withdrawError("unauthenticated");
  const payments = paymentsBinding();
  if (payments === null) withdrawError("unavailable");
  const locale = await getMonitorLocale();

  let answer: unknown = null;
  try {
    answer = await payments.withdraw({
      accessToken,
      subscriptionId: status.subscription_id,
      consumerName,
      statementVersion: WITHDRAWAL_TEXT_VERSION,
      locale,
    });
  } catch {
    // A failed RPC (Worker error, binding unreachable) is an answer of no known shape.
  }
  const result = parseWithdrawResult(answer);
  if (result === null) {
    // No usable answer: the notice may be recorded all the same, so the database decides.
    const after = await getMyWithdrawalStatus().catch(() => null);
    if (after === null || after.withdrawal === null) withdrawError("unavailable");
  } else if (!result.ok) {
    withdrawError(result.code);
  }
  revalidatePath(MONITOR_WITHDRAW_PATH);
  revalidatePath(MONITOR_BILLING_PATH);
  redirect(MONITOR_WITHDRAW_PATH);
}
