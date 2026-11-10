import { createServerClient } from "@/lib/supabase/server";

/** One public Monitor signup in the admin list. */
export interface MonitorSignup {
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
    email: row.email,
    signedUpAt: row.created_at,
    confirmed: row.confirmed,
    monitorCount: row.monitor_count,
  }));
}
