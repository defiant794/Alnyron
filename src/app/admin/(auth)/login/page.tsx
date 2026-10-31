import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import LoginForm from "@/components/admin/LoginForm";
import Link from "@/components/ui/Link";
import Notice from "@/components/ui/Notice";
import {
  ADMIN_FORGOT_PASSWORD_PATH,
  ADMIN_LOCALE,
  LOGIN_ERROR_LINK_INVALID,
} from "@/config/admin";
import { safeNext } from "@/lib/safe-next";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: ADMIN_LOCALE, namespace: "AdminAuth.login" });
  return { title: t("title") };
}

type LoginPageProps = {
  searchParams: Promise<{ next?: string | string[]; error?: string | string[] }>;
};

/**
 * `/admin/login`. `next` (set by the middleware redirect) is re-checked with
 * `safeNext` before it reaches the form; `error=link_invalid` (set by
 * `/auth/confirm`) explains a dead invite or reset link.
 */
export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { next, error } = await searchParams;
  const t = await getTranslations({ locale: ADMIN_LOCALE, namespace: "AdminAuth" });

  return (
    <>
      <header className="flex flex-col gap-2 text-center">
        <h1 className="text-h1 font-semibold">{t("login.title")}</h1>
        <p className="text-muted">{t("login.lead")}</p>
      </header>
      {error === LOGIN_ERROR_LINK_INVALID && <Notice tone="error">{t("login.linkInvalid")}</Notice>}
      <LoginForm
        next={safeNext(typeof next === "string" ? next : null)}
        labels={{
          email: t("login.email"),
          password: t("login.password"),
          submit: t("login.submit"),
        }}
      />
      {/* The link's 44px tap target already spaces it from the note, so no gap. */}
      <div className="flex flex-col items-center text-center">
        <Link href={ADMIN_FORGOT_PASSWORD_PATH} className="inline-flex min-h-11 items-center">
          {t("login.forgotPassword")}
        </Link>
        <p className="text-small text-muted">{t("noSignup")}</p>
      </div>
    </>
  );
}
