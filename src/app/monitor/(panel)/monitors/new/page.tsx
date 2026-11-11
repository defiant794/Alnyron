import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { createMonitorAction } from "@/app/monitor/(panel)/actions";
import MonitorFormScreen from "@/components/monitor/MonitorFormScreen";
import MonitorShell from "@/components/monitor/MonitorShell";
import {
  MONITOR_DASHBOARD_PATH,
  MONITOR_DEFAULT_INTERVAL,
  MONITOR_NEW_PATH,
  MONITOR_ROBOTS,
  MONITOR_URL_MAX_LENGTH,
} from "@/config/monitor";
import { getMonitorLocale } from "@/i18n/monitor-locale";
import { requireMonitor } from "@/services/auth/require-role";

type NewMonitorPageProps = { searchParams: Promise<{ url?: string | string[] }> };

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getMonitorLocale(), namespace: "Monitor.monitors.add" });
  return { title: t("metaTitle"), robots: MONITOR_ROBOTS };
}

/**
 * `/monitor/monitors/new` (approved add-monitor mock), in the visitor's
 * Monitor language. `?url=` (the dashboard's first-run field, the landing
 * page's URL field) only fills in the URL field, and stays through a
 * language switch; it is checked like any typed URL when the form is sent.
 * Owner and `monitor_user` only.
 */
export default async function NewMonitorPage({ searchParams }: NewMonitorPageProps) {
  const user = await requireMonitor();
  const { url } = await searchParams;
  const locale = await getMonitorLocale();
  const t = await getTranslations({ locale, namespace: "Monitor.monitors.add" });
  const initialUrl = typeof url === "string" ? url.slice(0, MONITOR_URL_MAX_LENGTH) : "";
  const currentPath = initialUrl ? `${MONITOR_NEW_PATH}?${new URLSearchParams({ url: initialUrl })}` : MONITOR_NEW_PATH;

  return (
    <MonitorShell email={user.email} section="dashboard" locale={locale} currentPath={currentPath}>
      <MonitorFormScreen
        locale={locale}
        title={t("title")}
        lead={t("lead")}
        submit={t("submit")}
        action={createMonitorAction}
        initialState={{}}
        initialValues={{
          url: initialUrl,
          label: "",
          intervalValue: String(MONITOR_DEFAULT_INTERVAL.value),
          intervalUnit: MONITOR_DEFAULT_INTERVAL.unit,
        }}
        cancelHref={MONITOR_DASHBOARD_PATH}
      />
    </MonitorShell>
  );
}
