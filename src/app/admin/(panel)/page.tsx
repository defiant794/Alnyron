import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import PageHeader from "@/components/admin/PageHeader";
import { AUTH_LOCALE } from "@/config/auth-areas";
import { requireAdmin } from "@/services/auth/require-admin";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: AUTH_LOCALE, namespace: "Admin.overview" });
  return { title: t("title") };
}

/** `/admin`: the panel home after signing in. */
export default async function AdminOverviewPage() {
  const user = await requireAdmin();
  const t = await getTranslations({ locale: AUTH_LOCALE, namespace: "Admin" });

  return (
    <>
      <PageHeader title={t("overview.title")} description={t("overview.lead")} />
      <p className="max-w-prose">
        {t("overview.signedInAs", { email: user.email, role: t(`account.roles.${user.role}`) })}
      </p>
    </>
  );
}
