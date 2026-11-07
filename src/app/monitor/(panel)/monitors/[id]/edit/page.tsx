import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { updateMonitorAction } from "@/app/monitor/(panel)/actions";
import MonitorFormScreen from "@/components/monitor/MonitorFormScreen";
import MonitorShell from "@/components/monitor/MonitorShell";
import { AUTH_LOCALE } from "@/config/auth-areas";
import { MONITOR_ROBOTS, monitorDetailPath } from "@/config/monitor";
import { minutesToInterval, monitorIdSchema } from "@/lib/validation/monitor";
import { requireMonitor } from "@/services/auth/require-role";
import { getMonitor } from "@/services/monitor/monitors";

type EditMonitorPageProps = { params: Promise<{ id: string }> };

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: AUTH_LOCALE, namespace: "Monitor.monitors.edit" });
  return { title: t("metaTitle"), robots: MONITOR_ROBOTS };
}

/**
 * `/monitor/monitors/<id>/edit`: the add form, filled with the monitor's
 * URL, name and interval. Owner and `monitor_user` only; another account's
 * monitor (hidden by RLS) or an unknown id is a 404.
 */
export default async function EditMonitorPage({ params }: EditMonitorPageProps) {
  const user = await requireMonitor();
  const { id } = await params;
  const monitor = monitorIdSchema.safeParse(id).success ? await getMonitor(id) : null;
  if (!monitor) notFound();

  const t = await getTranslations({ locale: AUTH_LOCALE, namespace: "Monitor.monitors.edit" });
  const interval = minutesToInterval(monitor.interval_minutes);

  return (
    <MonitorShell email={user.email} section="dashboard" sectionPage={false}>
      <MonitorFormScreen
        title={t("title")}
        lead={t("lead")}
        submit={t("submit")}
        action={updateMonitorAction}
        initialState={{ monitorId: monitor.id }}
        initialValues={{
          url: monitor.url,
          label: monitor.label ?? "",
          intervalValue: String(interval.value),
          intervalUnit: interval.unit,
        }}
        cancelHref={monitorDetailPath(monitor.id)}
      />
    </MonitorShell>
  );
}
