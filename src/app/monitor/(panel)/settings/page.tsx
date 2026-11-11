import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { updatePassword } from "@/app/monitor/(auth)/actions";
import SetPasswordForm from "@/components/auth/SetPasswordForm";
import MonitorShell from "@/components/monitor/MonitorShell";
import { MONITOR_ROBOTS } from "@/config/monitor";
import { getMonitorLocale } from "@/i18n/monitor-locale";
import { MIN_PASSWORD_LENGTH } from "@/lib/validation/auth";
import { requireMonitor } from "@/services/auth/require-role";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getMonitorLocale(), namespace: "Monitor.settings" });
  return { title: t("metaTitle"), robots: MONITOR_ROBOTS };
}

/**
 * `/monitor/settings`: where change notifications go (the login email,
 * read-only: a separate notification address would need its own
 * verification) and a change-password form (the reset page's form, with a
 * repeat field labelled "Gentag ny kode"). "Log ud" is in the top bar.
 * Supabase accepts a new password only from a session signed in within 24
 * hours (`secure_password_change`); an older session is told to use a reset
 * link. Owner and `monitor_user` only. In the visitor's Monitor language.
 */
export default async function MonitorSettingsPage() {
  const user = await requireMonitor();
  const locale = await getMonitorLocale();
  const t = await getTranslations({ locale, namespace: "Monitor.settings" });
  const tPassword = await getTranslations({ locale, namespace: "Auth.setPassword" });

  return (
    <MonitorShell email={user.email} section="settings" locale={locale}>
      <div className="mx-auto flex w-full max-w-160 flex-col gap-8">
        <h1 className="text-h2 font-semibold">{t("title")}</h1>
        <section className="flex flex-col gap-2 rounded-card border border-border bg-bg p-6 shadow-card sm:p-8">
          <h2 className="text-h3 font-semibold">{t("notificationsTitle")}</h2>
          <p className="break-words">{t("notificationsTo", { email: user.email })}</p>
          <p className="text-small text-muted">{t("notificationsNote")}</p>
        </section>
        <section className="flex flex-col gap-6 rounded-card border border-border bg-bg p-6 shadow-card sm:p-8">
          <div className="flex flex-col gap-1">
            <h2 className="text-h3 font-semibold">{t("passwordTitle")}</h2>
            <p className="text-small text-muted">{t("passwordLead")}</p>
          </div>
          <SetPasswordForm
            action={updatePassword}
            email={user.email}
            minLength={MIN_PASSWORD_LENGTH}
            labels={{
              password: tPassword("password"),
              passwordHint: tPassword("passwordHint", { min: MIN_PASSWORD_LENGTH }),
              confirm: t("passwordConfirm"),
              submit: tPassword("submit"),
            }}
          />
        </section>
      </div>
    </MonitorShell>
  );
}
