import type { PostgrestError } from "@supabase/supabase-js";
import { createServerClient } from "@/lib/supabase/server";
import { monitorIdSchema } from "@/lib/validation/monitor";
import { requireMonitor } from "@/services/auth/require-role";
import type { Database } from "@/types/database";

type MonitorRow = Database["public"]["Tables"]["monitors"]["Row"];
type MonitorEventRow = Database["public"]["Tables"]["monitor_events"]["Row"];

/** `monitors.status`: checked on schedule, or skipped until resumed. */
export type MonitorStatus = "active" | "paused";

/** What a user sets on a monitor (the only columns their session may write besides `status`). */
export type MonitorWrite = Pick<MonitorRow, "url" | "label" | "interval_minutes">;

const MONITOR_COLUMNS = "id, url, label, status, interval_minutes, last_checked_at, consecutive_errors, created_at";

/** A monitor as the panel shows it. */
export type Monitor = Pick<
  MonitorRow,
  "id" | "url" | "label" | "status" | "interval_minutes" | "last_checked_at" | "consecutive_errors" | "created_at"
>;

/** A dashboard row: the monitor plus when its latest change was detected (`null`: none yet). */
export type MonitorListItem = Monitor & { last_change_at: string | null };

/** One detected change in a monitor's history. */
export type MonitorEvent = Pick<MonitorEventRow, "id" | "detected_at" | "summary">;

/** Monitors held and the most allowed (`null`: no cap, the owner or a NULL `monitor_limit`). */
export type MonitorUsage = { count: number; limit: number | null };

/** A create refused by the per-user cap (`monitors_limit_per_user`). */
export type MonitorLimitReached = { error: "limit_reached" };

/** The cap trigger's refusal: `raise exception 'monitor_limit_reached'` (SQLSTATE P0001). */
const LIMIT_REACHED_CODE = "P0001";
const LIMIT_REACHED_MESSAGE = "monitor_limit_reached";

/** PostgREST code for `.single()` matching zero rows. */
const NO_ROWS = "PGRST116";

function fail(operation: string, error: PostgrestError): never {
  throw new Error(`Monitor ${operation} failed: ${error.code} ${error.message}`);
}

/** Guards an id before it reaches PostgREST (which errors on a non-UUID instead of matching nothing). */
function assertMonitorId(id: string): void {
  if (!monitorIdSchema.safeParse(id).success) throw new Error("Invalid monitor id");
}

/*
 * Every query runs with the signed-in user's session (`createServerClient`),
 * so RLS limits it to that user's own monitors and events, and only for the
 * owner and `monitor_user` roles (`private.is_monitor()`). Callers gate with
 * `requireMonitor()` first; a row that is not the user's reads as missing.
 */

/** The user's monitors, oldest first, each with the detection time of its latest change. */
export async function listMonitors(): Promise<MonitorListItem[]> {
  const supabase = await createServerClient();
  // PostgREST orders and limits the embedded events per monitor: only the newest one is read.
  const { data, error } = await supabase
    .from("monitors")
    .select(`${MONITOR_COLUMNS}, monitor_events(detected_at)`)
    .order("created_at", { ascending: true })
    .order("detected_at", { ascending: false, referencedTable: "monitor_events" })
    .limit(1, { referencedTable: "monitor_events" });
  if (error) fail("list", error);
  return data.map(({ monitor_events: [latest], ...monitor }) => ({
    ...monitor,
    last_change_at: latest?.detected_at ?? null,
  }));
}

/** One of the user's monitors, or null when there is none with that id (or it is someone else's). */
export async function getMonitor(id: string): Promise<Monitor | null> {
  assertMonitorId(id);
  const supabase = await createServerClient();
  const { data, error } = await supabase.from("monitors").select(MONITOR_COLUMNS).eq("id", id).maybeSingle();
  if (error) fail("read", error);
  return data;
}

/** A monitor's detected changes, newest first. */
export async function listMonitorEvents(monitorId: string): Promise<MonitorEvent[]> {
  assertMonitorId(monitorId);
  const supabase = await createServerClient();
  const { data, error } = await supabase
    .from("monitor_events")
    .select("id, detected_at, summary")
    .eq("monitor_id", monitorId)
    .order("detected_at", { ascending: false });
  if (error) fail("history", error);
  return data;
}

/**
 * How many monitors the user holds and their cap (`profiles.monitor_limit`;
 * the owner role is uncapped whatever the column holds, like the trigger).
 */
export async function getMonitorUsage(): Promise<MonitorUsage> {
  const user = await requireMonitor();
  const supabase = await createServerClient();
  // The owner may read every profile, so the row is picked by id.
  const profileQuery = supabase.from("profiles").select("monitor_limit").eq("user_id", user.userId).single();
  const countQuery = supabase.from("monitors").select("id", { count: "exact", head: true });
  const [profile, monitors] = await Promise.all([profileQuery, countQuery]);
  if (profile.error) fail("limit", profile.error);
  if (monitors.error) fail("count", monitors.error);
  return {
    count: monitors.count ?? 0,
    limit: user.role === "owner" ? null : profile.data.monitor_limit,
  };
}

/**
 * Add a monitor for the signed-in user. The owner (`user_id`) is the
 * session's user from `requireMonitor()`, never a caller's value; RLS checks
 * it again. A user at their cap gets `{ error: "limit_reached" }`.
 */
export async function createMonitor(input: MonitorWrite): Promise<Monitor | MonitorLimitReached> {
  const user = await requireMonitor();
  const supabase = await createServerClient();
  const { data, error } = await supabase
    .from("monitors")
    .insert({ url: input.url, label: input.label, interval_minutes: input.interval_minutes, user_id: user.userId })
    .select(MONITOR_COLUMNS)
    .single();
  if (error?.code === LIMIT_REACHED_CODE && error.message === LIMIT_REACHED_MESSAGE) {
    return { error: "limit_reached" };
  }
  if (error) fail("create", error);
  return data;
}

/** Change a monitor's URL, label and interval; null when it is not the user's (or gone). */
export async function updateMonitor(id: string, input: MonitorWrite): Promise<Monitor | null> {
  assertMonitorId(id);
  const supabase = await createServerClient();
  const { data, error } = await supabase
    .from("monitors")
    .update({ url: input.url, label: input.label, interval_minutes: input.interval_minutes })
    .eq("id", id)
    .select(MONITOR_COLUMNS)
    .single();
  if (error?.code === NO_ROWS) return null;
  if (error) fail("update", error);
  return data;
}

/** Pause or resume a monitor; null when it is not the user's (or gone). */
export async function setMonitorStatus(id: string, status: MonitorStatus): Promise<Monitor | null> {
  assertMonitorId(id);
  const supabase = await createServerClient();
  const { data, error } = await supabase
    .from("monitors")
    .update({ status })
    .eq("id", id)
    .select(MONITOR_COLUMNS)
    .single();
  if (error?.code === NO_ROWS) return null;
  if (error) fail("status", error);
  return data;
}

/**
 * Delete a monitor and (by cascade) its history. The deleted monitor's id, or
 * null when there was none with that id (or it is someone else's): then
 * nothing was deleted.
 */
export async function deleteMonitor(id: string): Promise<string | null> {
  assertMonitorId(id);
  const supabase = await createServerClient();
  const { data, error } = await supabase.from("monitors").delete().eq("id", id).select("id").maybeSingle();
  if (error) fail("delete", error);
  return data?.id ?? null;
}
