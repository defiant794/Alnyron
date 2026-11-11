import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getTranslations } from "next-intl/server";
import { signUp } from "@/app/monitor/(auth)/actions";
import MonitorAuthFrame from "@/components/monitor/MonitorAuthFrame";
import MonitorLocaleSwitcher from "@/components/monitor/MonitorLocaleSwitcher";
import SignupForm from "@/components/monitor/SignupForm";
import Link from "@/components/ui/Link";
import { MONITOR_LOGIN_PATH, MONITOR_ROBOTS, MONITOR_SIGNUP_PATH } from "@/config/monitor";
import { siteOrigin } from "@/config/site-origin";
import { SYSTEM_PAGE_PATHNAMES } from "@/config/system-pages";
import { loadMessages } from "@/i18n/messages";
import { getMonitorLocale } from "@/i18n/monitor-locale";
import { getPathname } from "@/i18n/navigation";
import { safeNext } from "@/lib/safe-next";
import { MIN_PASSWORD_LENGTH } from "@/lib/validation/auth";

type SignupPageProps = { searchParams: Promise<{ next?: string | string[] }> };

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getMonitorLocale(), namespace: "Monitor.signup" });
  return { title: t("title"), robots: MONITOR_ROBOTS };
}

/**
 * `/monitor/signup` (approved signup mock), in the Monitor auth card: email
 * and password, then "Tjek din e-mail". A privacy note links the main site's
 * privacy page in the page's language by its absolute URL (`siteOrigin`: on
 * the Monitor host a path would stay there). A `next` Monitor path (from the
 * login page) is kept for the "Log ind" link and through a language switch,
 * so someone who already has an account does not lose where they were
 * going. The form formats the confirmation with the typed address itself,
 * so it gets that one message (not the whole catalogue) through its own
 * client provider.
 */
export default async function MonitorSignupPage({ searchParams }: SignupPageProps) {
  const params = await searchParams;
  const next = safeNext(typeof params.next === "string" ? params.next : null, "monitor");
  const locale = await getMonitorLocale();
  const t = await getTranslations({ locale, namespace: "Monitor.signup" });
  const { Monitor } = loadMessages(locale);
  const nextQuery = next ? `?${new URLSearchParams({ next })}` : "";
  const privacyPath = getPathname({ href: SYSTEM_PAGE_PATHNAMES.privacy, locale });

  return (
    <MonitorAuthFrame
      locale={locale}
      localeSwitcher={<MonitorLocaleSwitcher locale={locale} currentPath={`${MONITOR_SIGNUP_PATH}${nextQuery}`} />}
    >
      <header className="flex flex-col gap-2 text-center">
        <h1 className="text-h2 font-semibold">{t("title")}</h1>
        <p className="text-muted">{t("lead")}</p>
      </header>
      <NextIntlClientProvider
        locale={locale}
        messages={{ Monitor: { signup: { confirmationBody: Monitor.signup.confirmationBody } } }}
      >
        <SignupForm
          action={signUp}
          minLength={MIN_PASSWORD_LENGTH}
          labels={{
            email: t("email"),
            emailPlaceholder: t("emailPlaceholder"),
            password: t("password"),
            passwordHint: t("passwordHint", { min: MIN_PASSWORD_LENGTH }),
            submit: t("submit"),
            confirmationTitle: t("confirmationTitle"),
            rateLimited: t("rateLimitedCopy"),
            unavailable: t("unavailableCopy"),
          }}
        />
      </NextIntlClientProvider>
      <div className="flex flex-col items-center gap-2 text-center text-small text-muted">
        <p>
          {t("privacyNote")}{" "}
          <Link href={new URL(privacyPath, siteOrigin()).href}>{t("privacyLinkText")}</Link>
        </p>
        <p>
          {t("haveAccount")}{" "}
          <Link href={`${MONITOR_LOGIN_PATH}${nextQuery}`} className="inline-flex min-h-11 items-center">
            {t("loginLink")}
          </Link>
        </p>
      </div>
    </MonitorAuthFrame>
  );
}
