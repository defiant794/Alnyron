import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { requestPasswordReset } from "@/app/monitor/(auth)/actions";
import ForgotPasswordForm from "@/components/auth/ForgotPasswordForm";
import MonitorAuthFrame from "@/components/monitor/MonitorAuthFrame";
import MonitorLocaleSwitcher from "@/components/monitor/MonitorLocaleSwitcher";
import Link from "@/components/ui/Link";
import { MONITOR_FORGOT_PASSWORD_PATH, MONITOR_LOGIN_PATH, MONITOR_ROBOTS } from "@/config/monitor";
import { getMonitorLocale } from "@/i18n/monitor-locale";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getMonitorLocale(), namespace: "Auth.forgotPassword" });
  return { title: t("title"), robots: MONITOR_ROBOTS };
}

/** `/monitor/forgot-password`, in the Monitor auth card: request a reset link (no account enumeration). */
export default async function MonitorForgotPasswordPage() {
  const locale = await getMonitorLocale();
  const t = await getTranslations({ locale, namespace: "Auth.forgotPassword" });
  const tMonitor = await getTranslations({ locale, namespace: "Monitor.forgotPassword" });

  return (
    <MonitorAuthFrame
      locale={locale}
      localeSwitcher={<MonitorLocaleSwitcher locale={locale} currentPath={MONITOR_FORGOT_PASSWORD_PATH} />}
    >
      <header className="flex flex-col gap-2 text-center">
        <h1 className="text-h2 font-semibold">{t("title")}</h1>
        <p className="text-muted">{t("lead")}</p>
      </header>
      <ForgotPasswordForm
        action={requestPasswordReset}
        labels={{
          email: t("email"),
          submit: t("submit"),
          sentTitle: tMonitor("confirmationTitle"),
          sent: tMonitor("sent"),
        }}
      />
      <div className="flex justify-center">
        <Link href={MONITOR_LOGIN_PATH} className="inline-flex min-h-11 items-center">
          {t("backToLogin")}
        </Link>
      </div>
    </MonitorAuthFrame>
  );
}
