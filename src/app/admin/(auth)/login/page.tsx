import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { signIn } from "@/app/admin/(auth)/actions";
import LoginForm from "@/components/auth/LoginForm";
import Link from "@/components/ui/Link";
import { ADMIN_FORGOT_PASSWORD_PATH } from "@/config/admin";
import { AUTH_LOCALE } from "@/config/auth-areas";
import { safeNext } from "@/lib/safe-next";
import { loginMetadata, showsLinkInvalid, type LoginSearchParams } from "@/services/auth/login-page";

type LoginPageProps = { searchParams: Promise<LoginSearchParams> };

export async function generateMetadata({ searchParams }: LoginPageProps): Promise<Metadata> {
  return loginMetadata(await searchParams);
}

/**
 * `/admin/login`. `next` (set by the middleware redirect) is re-checked with
 * `safeNext` for the admin area before it reaches the form; `error=link_invalid`
 * (set by `/auth/confirm`) explains a dead invite or reset link.
 */
export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const t = await getTranslations({ locale: AUTH_LOCALE, namespace: "Auth.login" });
  const tAdmin = await getTranslations({ locale: AUTH_LOCALE, namespace: "AdminAuth" });

  return (
    <>
      <header className="flex flex-col gap-2 text-center">
        <h1 className="text-h1 font-semibold">{t("title")}</h1>
        <p className="text-muted">{tAdmin("login.lead")}</p>
      </header>
      <LoginForm
        action={signIn}
        next={safeNext(typeof params.next === "string" ? params.next : null, "admin")}
        forgotPasswordHref={ADMIN_FORGOT_PASSWORD_PATH}
        labels={{
          email: t("email"),
          password: t("password"),
          submit: t("submit"),
          resetPassword: t("resetPassword"),
        }}
        initialError={showsLinkInvalid(params) ? t("linkInvalid") : undefined}
      />
      {/* The link's 44px tap target already spaces it from the note, so no gap. */}
      <div className="flex flex-col items-center text-center">
        <Link href={ADMIN_FORGOT_PASSWORD_PATH} className="inline-flex min-h-11 items-center">
          {t("forgotPassword")}
        </Link>
        <p className="text-small text-muted">{tAdmin("noSignup")}</p>
      </div>
    </>
  );
}
