import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import MonitorAuthFrame from "@/components/monitor/MonitorAuthFrame";
import LinkButton from "@/components/ui/LinkButton";
import { AUTH_LOCALE } from "@/config/auth-areas";
import { MONITOR_DASHBOARD_PATH } from "@/config/monitor";
import { monitorNotFoundMetadata } from "@/services/monitor/not-found-metadata";

/** The 404's own title and robots (WCAG 2.4.2). */
export async function generateMetadata(): Promise<Metadata> {
  return monitorNotFoundMetadata();
}

/**
 * 404 inside Monitor: an unknown monitor id, or a monitor of another
 * account (RLS hides it, so it is indistinguishable from a missing one). A
 * way back to the dashboard, whose gate sends visitors without access on.
 */
export default async function MonitorNotFound() {
  const t = await getTranslations({ locale: AUTH_LOCALE, namespace: "Monitor.notFound" });

  return (
    <MonitorAuthFrame>
      <header className="flex flex-col gap-2 text-center">
        <h1 className="text-h2 font-semibold">{t("title")}</h1>
        <p className="text-muted">{t("body")}</p>
      </header>
      <LinkButton href={MONITOR_DASHBOARD_PATH} className="w-full">
        {t("back")}
      </LinkButton>
    </MonitorAuthFrame>
  );
}
