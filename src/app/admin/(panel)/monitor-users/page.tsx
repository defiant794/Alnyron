import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import MonitorSignupsTable from "@/components/admin/MonitorSignupsTable";
import PageHeader from "@/components/admin/PageHeader";
import Card from "@/components/ui/Card";
import { AUTH_LOCALE } from "@/config/auth-areas";
import { listMonitorSignups } from "@/services/admin/monitor-users";
import { requireAdmin } from "@/services/auth/require-admin";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: AUTH_LOCALE, namespace: "Admin.monitorUsers" });
  return { title: t("title") };
}

const HEADING_ID = "monitor-users-heading";

/**
 * `/admin/monitor-users` ("Monitor-brugere"): everyone who signed up for
 * Monitor, newest first, with the signup time, whether the address is
 * confirmed and the number of monitors. Read-only.
 */
export default async function AdminMonitorUsersPage() {
  await requireAdmin();
  const [rows, t] = await Promise.all([
    listMonitorSignups(),
    getTranslations({ locale: AUTH_LOCALE, namespace: "Admin.monitorUsers" }),
  ]);

  return (
    <>
      <PageHeader title={t("title")} description={t("lead")} />
      <Card className="flex max-w-4xl flex-col gap-4">
        <h2 id={HEADING_ID} className="text-h3 font-semibold">
          {t("table.caption")}
        </h2>
        <MonitorSignupsTable
          rows={rows}
          labelledBy={HEADING_ID}
          labels={{
            email: t("table.email"),
            signedUp: t("table.signedUp"),
            confirmed: t("table.confirmed"),
            monitors: t("table.monitors"),
            yes: t("confirmed.yes"),
            no: t("confirmed.no"),
            empty: t("empty"),
          }}
        />
      </Card>
    </>
  );
}
