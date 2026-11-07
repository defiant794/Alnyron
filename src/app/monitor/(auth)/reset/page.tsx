import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { updatePassword } from "@/app/monitor/(auth)/actions";
import SetPasswordForm from "@/components/auth/SetPasswordForm";
import { AUTH_LOCALE } from "@/config/auth-areas";
import { MONITOR_ROBOTS } from "@/config/monitor";
import { MIN_PASSWORD_LENGTH } from "@/lib/validation/auth";
import { requireMonitor } from "@/services/auth/require-role";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: AUTH_LOCALE, namespace: "Auth.setPassword" });
  return { title: t("title"), robots: MONITOR_ROBOTS };
}

/**
 * `/monitor/reset`: where Monitor reset links land after `/auth/confirm` has
 * signed the user in (it needs that session; the middleware sends visitors
 * without one to the login page). Owner and `monitor_user` only.
 */
export default async function MonitorResetPage() {
  const user = await requireMonitor();
  const t = await getTranslations({ locale: AUTH_LOCALE, namespace: "Auth.setPassword" });

  return (
    <>
      <header className="flex flex-col gap-2 text-center">
        <h1 className="text-h2 font-semibold">{t("title")}</h1>
        <p className="text-muted">{t("lead")}</p>
      </header>
      <SetPasswordForm
        action={updatePassword}
        email={user.email}
        minLength={MIN_PASSWORD_LENGTH}
        labels={{
          password: t("password"),
          passwordHint: t("passwordHint", { min: MIN_PASSWORD_LENGTH }),
          confirm: t("confirm"),
          submit: t("submit"),
        }}
      />
    </>
  );
}
