import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { signOut } from "@/app/monitor/(auth)/actions";
import MonitorAuthFrame from "@/components/monitor/MonitorAuthFrame";
import MonitorLocaleSwitcher from "@/components/monitor/MonitorLocaleSwitcher";
import Link from "@/components/ui/Link";
import SubmitButton from "@/components/ui/SubmitButton";
import { MONITOR_DASHBOARD_PATH, MONITOR_LOGIN_PATH, MONITOR_NO_ACCESS_PATH, MONITOR_ROBOTS } from "@/config/monitor";
import { getMonitorLocale } from "@/i18n/monitor-locale";
import { getMonitorAccess } from "@/services/auth/require-role";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getMonitorLocale(), namespace: "Auth.noAccess" });
  return { title: t("title"), robots: MONITOR_ROBOTS };
}

/**
 * `/monitor/no-access`: where `requireMonitor()` sends a signed-in user whose
 * role is not owner or `monitor_user` (an admin, a MyLife user). It renders
 * as a normal page (HTTP 200, not 403) in the Monitor card, in the visitor's
 * Monitor language, names the account and offers signing out, plus a direct
 * link to the login page for another account. Users with Monitor access are
 * sent to the dashboard, visitors without a session to the login page.
 */
export default async function MonitorNoAccessPage() {
  const access = await getMonitorAccess();
  if (access.status === "anonymous") redirect(MONITOR_LOGIN_PATH);
  if (access.status === "allowed") redirect(MONITOR_DASHBOARD_PATH);

  const locale = await getMonitorLocale();
  const t = await getTranslations({ locale, namespace: "Auth" });
  const tMonitor = await getTranslations({ locale, namespace: "Monitor" });

  return (
    <MonitorAuthFrame
      locale={locale}
      localeSwitcher={<MonitorLocaleSwitcher locale={locale} currentPath={MONITOR_NO_ACCESS_PATH} />}
    >
      <header className="flex flex-col gap-2 text-center">
        <h1 className="text-h2 font-semibold">{t("noAccess.title")}</h1>
        <p>{tMonitor("noAccess.body", { email: access.email })}</p>
        <p className="text-muted">{t("noAccess.help")}</p>
      </header>
      <form action={signOut}>
        <SubmitButton className="w-full">{t("signOut")}</SubmitButton>
      </form>
      <div className="flex justify-center">
        <Link href={MONITOR_LOGIN_PATH} className="inline-flex min-h-11 items-center">
          {t("noAccess.switchAccount")}
        </Link>
      </div>
    </MonitorAuthFrame>
  );
}
