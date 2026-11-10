import { createServerClient } from "@/lib/supabase/server";

/** One public Monitor signup in the admin list. */
export interface MonitorSignup {
  /** The account's user id (what `deleteMonitorUser` takes). */
  userId: string;
  /** The account's profile email. */
  email: string;
  /** When the account was created (ISO timestamp from auth.users). */
  signedUpAt: string;
  /** Whether the address is confirmed. */
  confirmed: boolean;
  /** How many monitors the account has. */
  monitorCount: number;
}

/**
 * Why deleting a signup failed (the admin list maps each to copy):
 * - `not-found`: P0002, no account has that id (already deleted).
 * - `not-monitor-user`: P0001 `not_monitor_user`, the account is not a
 *   Monitor signup (owner, admin, MyLife user or no role); nothing was deleted.
 * - `failed`: anything else (logged by code).
 */
export type DeleteMonitorUserError = "not-found" | "not-monitor-user" | "failed";

/** Result of `deleteMonitorUser`. */
export type DeleteMonitorUserResult = { ok: true } | { ok: false; error: DeleteMonitorUserError };

/**
 * Every `monitor_user` account for Admin › Monitor-brugere, newest signup
 * first (`admin_list_monitor_signups`, admins only: the RPC raises 42501 for
 * anyone else).
 *
 * @throws when the RPC fails.
 */
export async function listMonitorSignups(): Promise<MonitorSignup[]> {
  const supabase = await createServerClient();
  const { data, error } = await supabase.rpc("admin_list_monitor_signups");
  if (error) throw new Error(`Failed to load the Monitor signups: ${error.message}`);

  return (data ?? []).map((row) => ({
    userId: row.user_id,
    email: row.email,
    signedUpAt: row.created_at,
    confirmed: row.confirmed,
    monitorCount: row.monitor_count,
  }));
}

/**
 * Deletes a Monitor signup for good (`admin_delete_monitor_user`): the
 * account, its profile and its monitors with their history. Only
 * `monitor_user` accounts can be deleted, and only by an admin (the RPC
 * raises 42501 for anyone else, reported as `failed`). An unexpected error is
 * logged by its code only, never with the id or address.
 */
export async function deleteMonitorUser(userId: string): Promise<DeleteMonitorUserResult> {
  const supabase = await createServerClient();
  const { error } = await supabase.rpc("admin_delete_monitor_user", { p_user_id: userId });
  if (!error) return { ok: true };

  if (error.code === "P0002") return { ok: false, error: "not-found" };
  if (error.code === "P0001" && error.message === "not_monitor_user") return { ok: false, error: "not-monitor-user" };
  console.error(`admin_delete_monitor_user failed: ${error.code || "unknown"}`);
  return { ok: false, error: "failed" };
}
