import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { signOut } from "@/app/admin/(auth)/actions";
import Link from "@/components/ui/Link";
import SubmitButton from "@/components/ui/SubmitButton";
import { ADMIN_HOME_PATH, ADMIN_LOGIN_PATH } from "@/config/admin";
import { AUTH_LOCALE } from "@/config/auth-areas";
import { getAdminAccess } from "@/services/auth/require-admin";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: AUTH_LOCALE, namespace: "Auth.noAccess" });
  return { title: t("title") };
}

/**
 * `/admin/no-access`: where `requireAdmin()` sends a signed-in user without
 * an admin role. It renders as a normal page (HTTP 200, not 403), names the
 * account and offers signing out, plus a direct link to the login page for
 * signing in with a different account (signing in there replaces this
 * session). Admins are sent to the panel, visitors without a session to the
 * login page.
 */
export default async function NoAccessPage() {
  const access = await getAdminAccess();
  if (access.status === "anonymous") redirect(ADMIN_LOGIN_PATH);
  if (access.status === "admin") redirect(ADMIN_HOME_PATH);

  const t = await getTranslations({ locale: AUTH_LOCALE, namespace: "Auth" });
  const tAdmin = await getTranslations({ locale: AUTH_LOCALE, namespace: "AdminAuth" });

  return (
    <>
      <header className="flex flex-col gap-2 text-center">
        <h1 className="text-h1 font-semibold">{t("noAccess.title")}</h1>
        <p>{tAdmin("noAccess.body", { email: access.email })}</p>
        <p className="text-muted">{t("noAccess.help")}</p>
      </header>
      <form action={signOut}>
        <SubmitButton className="w-full">{t("signOut")}</SubmitButton>
      </form>
      <div className="flex justify-center">
        <Link href={ADMIN_LOGIN_PATH} className="inline-flex min-h-11 items-center">
          {t("noAccess.switchAccount")}
        </Link>
      </div>
    </>
  );
}
