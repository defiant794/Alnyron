import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { signOut } from "@/app/mylife/(auth)/actions";
import Link from "@/components/ui/Link";
import SubmitButton from "@/components/ui/SubmitButton";
import { AUTH_LOCALE } from "@/config/auth-areas";
import { MYLIFE_HOME_PATH, MYLIFE_LOGIN_PATH } from "@/config/mylife";
import { getMyLifeAccess } from "@/services/auth/require-role";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: AUTH_LOCALE, namespace: "Auth.noAccess" });
  return { title: t("title") };
}

/**
 * `/mylife/no-access`: where `requireMyLife()` sends a signed-in user whose
 * role is not owner or `mylife_user` (e.g. an admin). It renders as a normal
 * page (HTTP 200, not 403), names the account and offers signing out, plus a
 * direct link to the login page for signing in with a different account.
 * Users with MyLife access are sent home, visitors without a session to the
 * login page.
 */
export default async function NoAccessPage() {
  const access = await getMyLifeAccess();
  if (access.status === "anonymous") redirect(MYLIFE_LOGIN_PATH);
  if (access.status === "allowed") redirect(MYLIFE_HOME_PATH);

  const t = await getTranslations({ locale: AUTH_LOCALE, namespace: "Auth" });
  const tMyLife = await getTranslations({ locale: AUTH_LOCALE, namespace: "MyLife" });

  return (
    <>
      <header className="flex flex-col gap-2 text-center">
        <h1 className="text-h2 font-semibold">{t("noAccess.title")}</h1>
        <p>{tMyLife("noAccess.body", { email: access.email })}</p>
        <p className="text-muted">{t("noAccess.help")}</p>
      </header>
      <form action={signOut}>
        <SubmitButton className="w-full">{t("signOut")}</SubmitButton>
      </form>
      <div className="flex justify-center">
        <Link href={MYLIFE_LOGIN_PATH} className="inline-flex min-h-11 items-center">
          {t("noAccess.switchAccount")}
        </Link>
      </div>
    </>
  );
}
