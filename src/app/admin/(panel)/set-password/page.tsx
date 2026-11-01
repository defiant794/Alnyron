import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { updatePassword } from "@/app/admin/(panel)/set-password/actions";
import PageHeader from "@/components/admin/PageHeader";
import SetPasswordForm from "@/components/auth/SetPasswordForm";
import Card from "@/components/ui/Card";
import { AUTH_LOCALE } from "@/config/auth-areas";
import { MIN_PASSWORD_LENGTH } from "@/lib/validation/auth";
import { requireAdmin } from "@/services/auth/require-admin";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: AUTH_LOCALE, namespace: "Auth.setPassword" });
  return { title: t("title") };
}

/**
 * `/admin/set-password`: where invite and reset links land after
 * `/auth/confirm` has signed the user in.
 */
export default async function SetPasswordPage() {
  const user = await requireAdmin();
  const t = await getTranslations({ locale: AUTH_LOCALE, namespace: "Auth.setPassword" });

  return (
    <>
      <PageHeader title={t("title")} description={t("lead")} />
      <Card className="max-w-lg">
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
      </Card>
    </>
  );
}
