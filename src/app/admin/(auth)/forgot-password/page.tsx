import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import ForgotPasswordForm from "@/components/admin/ForgotPasswordForm";
import Link from "@/components/ui/Link";
import { ADMIN_LOCALE, ADMIN_LOGIN_PATH } from "@/config/admin";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: ADMIN_LOCALE, namespace: "AdminAuth.forgotPassword" });
  return { title: t("title") };
}

/** `/admin/forgot-password`: request a reset link (no account enumeration). */
export default async function ForgotPasswordPage() {
  const t = await getTranslations({ locale: ADMIN_LOCALE, namespace: "AdminAuth.forgotPassword" });

  return (
    <>
      <header className="flex flex-col gap-2 text-center">
        <h1 className="text-h1 font-semibold">{t("title")}</h1>
        <p className="text-muted">{t("lead")}</p>
      </header>
      <ForgotPasswordForm labels={{ email: t("email"), submit: t("submit"), sent: t("sent") }} />
      <div className="flex justify-center">
        <Link href={ADMIN_LOGIN_PATH} className="inline-flex min-h-11 items-center">
          {t("backToLogin")}
        </Link>
      </div>
    </>
  );
}
