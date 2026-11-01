import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { signIn } from "@/app/mylife/(auth)/actions";
import LoginForm from "@/components/auth/LoginForm";
import Badge from "@/components/ui/Badge";
import Link from "@/components/ui/Link";
import { AUTH_LOCALE } from "@/config/auth-areas";
import { MYLIFE_FORGOT_PASSWORD_PATH } from "@/config/mylife";
import { safeNext } from "@/lib/safe-next";
import { loginMetadata, showsLinkInvalid, type LoginSearchParams } from "@/services/auth/login-page";

type LoginPageProps = { searchParams: Promise<LoginSearchParams> };

export async function generateMetadata({ searchParams }: LoginPageProps): Promise<Metadata> {
  return loginMetadata(await searchParams);
}

/**
 * `/mylife/login` (`mylife.alnyron.dk/login`), per the approved MyLife login
 * mock: the MyLife name as the page heading at the mock's 17px wordmark size,
 * the tagline, the "approved users only" pill and example values in the
 * fields. `next` (set by the middleware redirect) is re-checked with
 * `safeNext` for the MyLife area before it reaches the form;
 * `error=link_invalid` (set by `/auth/confirm`) explains a dead invite or
 * reset link. The reset link's accessible name includes the question in
 * front of it ("Glemt adgangskode? Nulstil").
 */
export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const t = await getTranslations({ locale: AUTH_LOCALE, namespace: "Auth.login" });
  const tMyLife = await getTranslations({ locale: AUTH_LOCALE, namespace: "MyLife" });

  return (
    <>
      <header className="flex flex-col items-center gap-2 text-center">
        {/* 17px (1.0625rem) per the MyLife login mock: a MyLife-only size, off the DESIGN.md scale. */}
        <h1 className="text-[1.0625rem] leading-6 font-semibold uppercase tracking-wordmark text-brand-navy">
          {tMyLife("name")}
        </h1>
        <p className="text-small text-muted">{tMyLife("login.tagline")}</p>
        <Badge tone="accent">{tMyLife("login.badge")}</Badge>
      </header>
      <LoginForm
        action={signIn}
        next={safeNext(typeof params.next === "string" ? params.next : null, "mylife")}
        forgotPasswordHref={MYLIFE_FORGOT_PASSWORD_PATH}
        labels={{
          email: t("email"),
          password: t("password"),
          submit: t("submit"),
          resetPassword: t("resetPassword"),
        }}
        placeholders={{
          email: tMyLife("login.emailPlaceholder"),
          password: tMyLife("login.passwordPlaceholder"),
        }}
        initialError={showsLinkInvalid(params) ? t("linkInvalid") : undefined}
      />
      {/* The link's 44px tap target already spaces it from the note, so no gap. */}
      <div className="flex flex-col items-center text-center text-small text-muted">
        <p>
          <span id="mylife-forgot-prompt">{t("forgotPassword")}</span>{" "}
          <Link
            id="mylife-forgot-link"
            href={MYLIFE_FORGOT_PASSWORD_PATH}
            aria-labelledby="mylife-forgot-prompt mylife-forgot-link"
            className="inline-flex min-h-11 min-w-11 items-center justify-center"
          >
            {tMyLife("login.forgotLink")}
          </Link>
        </p>
        <p>{tMyLife("login.noSignup")}</p>
      </div>
    </>
  );
}
