"use server";

import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { MONITOR_DASHBOARD_PATH, MONITOR_HOME_PATH, MONITOR_LIMIT_REACHED, monitorDetailPath } from "@/config/monitor";
import { getMonitorLocale } from "@/i18n/monitor-locale";
import { intervalToMinutes, monitorIdSchema, monitorSchema, type MonitorInput } from "@/lib/validation/monitor";
import { requireMonitor } from "@/services/auth/require-role";
import { monitorTranslator, toMonitorFieldErrors } from "@/services/monitor/form-feedback";
import {
  createMonitor,
  deleteMonitor,
  setMonitorStatus,
  updateMonitor,
  type MonitorStatus,
  type MonitorWrite,
} from "@/services/monitor/monitors";

/** The add/edit form's fields as submitted (echoed so the form keeps them after a failed save). */
export type MonitorFormValues = { url: string; label: string; intervalValue: string; intervalUnit: string };

/** State of the add/edit monitor form. Empty (add) or just `monitorId` (edit) before the first submission. */
export type MonitorFormState = {
  /** The monitor the edit form saves (kept across submissions). */
  monitorId?: string;
  /** What the last submission ran into. */
  type?: "field_error" | "limit_reached";
  /** The first invalid field (`field_error`). */
  field?: keyof MonitorFormValues;
  fieldErrors?: { [Field in keyof MonitorFormValues]?: string };
  /** Form-level message (cap reached), in the visitor's Monitor language. */
  error?: string;
  values?: MonitorFormValues;
};

/** Which monitor a detail-page button acts on (bound to the action by the page). */
export type MonitorTarget = { monitorId: string };

function formValues(formData: FormData): MonitorFormValues {
  const text = (name: keyof MonitorFormValues) => {
    const value = formData.get(name);
    return typeof value === "string" ? value : "";
  };
  return { url: text("url"), label: text("label"), intervalValue: text("intervalValue"), intervalUnit: text("intervalUnit") };
}

/** Validate the form; the columns to write, or the state to show (its messages in the visitor's Monitor language). */
async function parseForm(values: MonitorFormValues): Promise<MonitorWrite | MonitorFormState> {
  const parsed = monitorSchema.safeParse(values);
  if (!parsed.success) {
    const fieldErrors = toMonitorFieldErrors(parsed.error, await getMonitorLocale());
    const field = (["url", "label", "intervalValue", "intervalUnit"] as const).find((name) => fieldErrors[name]);
    return { type: "field_error", field, fieldErrors, values };
  }
  const { url, label, intervalValue, intervalUnit }: MonitorInput = parsed.data;
  return { url, label, interval_minutes: intervalToMinutes(intervalValue, intervalUnit) };
}

const isWrite = (result: MonitorWrite | MonitorFormState): result is MonitorWrite => "interval_minutes" in result;

/** Every Monitor page shows monitors, so a change refreshes the whole area. */
function refreshMonitorPages(): void {
  revalidatePath(MONITOR_HOME_PATH, "layout");
}

/**
 * Add a monitor (`/monitor/monitors/new`). Owner and `monitor_user` only; the
 * monitor belongs to the session's user (the service takes `user_id` from
 * the session, never from the form). Success: the new monitor's page. A user
 * at their cap gets the friendly cap message and nothing is created.
 */
export async function createMonitorAction(
  _previous: MonitorFormState,
  formData: FormData,
): Promise<MonitorFormState> {
  await requireMonitor();

  const values = formValues(formData);
  const write = await parseForm(values);
  if (!isWrite(write)) return write;

  const created = await createMonitor(write);
  if ("error" in created) {
    const error = monitorTranslator(await getMonitorLocale())("form.limitReached");
    return { type: "limit_reached", error, values };
  }

  refreshMonitorPages();
  redirect(monitorDetailPath(created.id));
}

/**
 * Save the edit form (`/monitor/monitors/<id>/edit`). The monitor id travels
 * in the form state; RLS limits the update to the user's own monitors, so an
 * id that is not theirs (or no longer exists) is a 404, like the detail
 * page's buttons. Success: the monitor's page.
 */
export async function updateMonitorAction(
  previous: MonitorFormState,
  formData: FormData,
): Promise<MonitorFormState> {
  await requireMonitor();

  const { monitorId } = previous;
  if (monitorId === undefined || !monitorIdSchema.safeParse(monitorId).success) notFound();

  const values = formValues(formData);
  const write = await parseForm(values);
  if (!isWrite(write)) return { ...write, monitorId };

  if (!(await updateMonitor(monitorId, write))) notFound();

  refreshMonitorPages();
  redirect(monitorDetailPath(monitorId));
}

/**
 * A detail-page button's action: the page binds the monitor
 * (`action.bind(null, { monitorId })`) and the form adds its (unused) FormData.
 */
type MonitorButtonAction = (target: MonitorTarget, formData: FormData) => Promise<void>;

/**
 * Pause or resume, then the monitor's page. A resume the cap refuses changes
 * nothing; the page then says why (`limit=reached`).
 */
async function changeStatus({ monitorId }: MonitorTarget, status: MonitorStatus): Promise<never> {
  await requireMonitor();
  if (!monitorIdSchema.safeParse(monitorId).success) notFound();
  const changed = await setMonitorStatus(monitorId, status);
  if (!changed) notFound();
  if ("error" in changed) {
    redirect(`${monitorDetailPath(monitorId)}?${new URLSearchParams({ limit: MONITOR_LIMIT_REACHED })}`);
  }

  refreshMonitorPages();
  redirect(monitorDetailPath(monitorId));
}

/** Pause a monitor (detail page): it is not checked until resumed. */
export const pauseMonitorAction: MonitorButtonAction = async (target) => changeStatus(target, "paused");

/** Resume a paused monitor (detail page), unless the user's other active monitors reach their cap. */
export const resumeMonitorAction: MonitorButtonAction = async (target) => changeStatus(target, "active");

/**
 * Delete a monitor and its history after the detail page's confirm step;
 * then the dashboard. A monitor that is not the user's (or is gone) is a 404.
 */
export const deleteMonitorAction: MonitorButtonAction = async ({ monitorId }) => {
  await requireMonitor();
  if (!monitorIdSchema.safeParse(monitorId).success) notFound();
  if (!(await deleteMonitor(monitorId))) notFound();

  refreshMonitorPages();
  redirect(MONITOR_DASHBOARD_PATH);
};
