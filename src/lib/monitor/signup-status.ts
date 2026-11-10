import { MONITOR_SIGNUP_CONFIRM_WINDOW_MINUTES } from "@/config/monitor";
import type { MonitorSignup } from "@/services/admin/monitor-users";

/**
 * Where a public Monitor signup stands in Admin › Monitor-brugere:
 * - `registered` ("Tilmeldt"): the address is confirmed.
 * - `pending` ("Afventer bekræftelse"): unconfirmed, signed up less than
 *   `MONITOR_SIGNUP_CONFIRM_WINDOW_MINUTES` ago.
 * - `expired` ("Udløbet"): unconfirmed for that long or longer.
 */
export type MonitorSignupStatus = "registered" | "pending" | "expired";

const CONFIRM_WINDOW_MS = MONITOR_SIGNUP_CONFIRM_WINDOW_MINUTES * 60_000;

/**
 * The status of `signup` at `now`. A confirmed signup is `registered` at any
 * age. An unconfirmed one is `pending` while it is younger than the confirm
 * window (a signup time after `now`, e.g. from clock skew, counts as fresh)
 * and `expired` from exactly the window's end on.
 */
export function monitorSignupStatus(
  signup: Pick<MonitorSignup, "confirmed" | "signedUpAt">,
  now: Date,
): MonitorSignupStatus {
  if (signup.confirmed) return "registered";
  const age = now.getTime() - Date.parse(signup.signedUpAt);
  return age < CONFIRM_WINDOW_MS ? "pending" : "expired";
}

/** How many signups have each status (every status present, 0 when none). */
export function countMonitorSignupStatuses(
  statuses: readonly MonitorSignupStatus[],
): Record<MonitorSignupStatus, number> {
  const counts: Record<MonitorSignupStatus, number> = { registered: 0, pending: 0, expired: 0 };
  for (const status of statuses) counts[status] += 1;
  return counts;
}
