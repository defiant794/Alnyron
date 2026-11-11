import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { signIn } from "@/app/monitor/(auth)/actions";
import LoginForm from "@/components/auth/LoginForm";
import MonitorAuthFrame from "@/components/monitor/MonitorAuthFrame";
import MonitorLocaleSwitcher from "@/components/monitor/MonitorLocaleSwitcher";
import Link from "@/components/ui/Link";
import { LOGIN_ERROR_LINK_INVALID } from "@/config/auth-areas";
import { MONITOR_FORGOT_PASSWORD_PATH, MONITOR_LOGIN_PATH, MONITOR_ROBOTS, MONITOR_SIGNUP_PATH } from "@/config/monitor";
import { getMonitorLocale } from "@/i18n/monitor-locale";
import { safeNext } from "@/lib/safe-next";
import { loginMetadata, showsLinkInvalid, type LoginSearchParams } from "@/services/auth/login-page";

type LoginPageProps = { searchParams: Promise<LoginSearchParams> };

export async function generateMetadata({ searchParams }: LoginPageProps): Promise<Metadata> {
  return { ...(await loginMetadata(await searchParams, await getMonitorLocale())), robots: MONITOR_ROBOTS };
}

/**
 * `/monitor/login`, in the Monitor auth card. `next` (set by the middleware
 * redirect or the landing page's URL field) is re-checked with `safeNext`
 * for the Monitor area before it reaches the form, and travels on to the
 * signup link; `error=link_invalid` (set by `/auth/confirm`) explains a dead
 * confirmation or reset link. Both stay on the page through a language
 * switch. The forgot-password link reads its whole prompt ("Glemt
 * adgangskode? Nulstil adgangskode") as one 44px target. Monitor has public
 * signup, so the card links to it instead of the other areas' "no public
 * signup" note.
 */
export default async function MonitorLoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const next = safeNext(typeof params.next === "string" ? params.next : null, "monitor");
  const linkInvalid = showsLinkInvalid(params);
  const locale = await getMonitorLocale();
  const t = await getTranslations({ locale, namespace: "Auth.login" });
  const tMonitor = await getTranslations({ locale, namespace: "Monitor.login" });
  const signupHref = next ? `${MONITOR_SIGNUP_PATH}?${new URLSearchParams({ next })}` : MONITOR_SIGNUP_PATH;
  const query = new URLSearchParams();
  if (next) query.set("next", next);
  if (linkInvalid) query.set("error", LOGIN_ERROR_LINK_INVALID);
  const currentPath = query.size > 0 ? `${MONITOR_LOGIN_PATH}?${query.toString()}` : MONITOR_LOGIN_PATH;

  return (
    <MonitorAuthFrame
      locale={locale}
      localeSwitcher={<MonitorLocaleSwitcher locale={locale} currentPath={currentPath} />}
    >
      <header className="flex flex-col gap-2 text-center">
        <h1 className="text-h2 font-semibold">{t("title")}</h1>
        <p className="text-muted">{tMonitor("lead")}</p>
      </header>
      <LoginForm
        action={signIn}
        next={next}
        forgotPasswordHref={MONITOR_FORGOT_PASSWORD_PATH}
        labels={{
          email: t("email"),
          password: t("password"),
          submit: t("submit"),
          resetPassword: t("resetPassword"),
        }}
        initialError={linkInvalid ? tMonitor("linkInvalid") : undefined}
      />
      <div className="flex flex-col items-center text-center text-small text-muted">
        <Link href={MONITOR_FORGOT_PASSWORD_PATH} className="inline-flex min-h-11 items-center">
          {`${t("forgotPassword")} ${t("resetPassword")}`}
        </Link>
        <p>
          {tMonitor("noAccount")}{" "}
          <Link href={signupHref} className="inline-flex min-h-11 items-center">
            {tMonitor("signupLink")}
          </Link>
        </p>
      </div>
    </MonitorAuthFrame>
  );
}
