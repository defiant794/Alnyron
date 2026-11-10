import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getTranslations } from "next-intl/server";
import MonitorSignupsTable, { type MonitorSignupRow } from "@/components/admin/MonitorSignupsTable";
import PageHeader from "@/components/admin/PageHeader";
import Card from "@/components/ui/Card";
import { AUTH_LOCALE } from "@/config/auth-areas";
import { MONITOR_SIGNUP_CONFIRM_WINDOW_MINUTES } from "@/config/monitor";
import { loadMessages } from "@/i18n/messages";
import { countMonitorSignupStatuses, monitorSignupStatus } from "@/lib/monitor/signup-status";
import { listMonitorSignups } from "@/services/admin/monitor-users";
import { requireAdmin } from "@/services/auth/require-admin";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: AUTH_LOCALE, namespace: "Admin.monitorUsers" });
  return { title: t("title") };
}

const HEADING_ID = "monitor-users-heading";

/**
 * `/admin/monitor-users` ("Monitor-brugere"): everyone who signed up for
 * Monitor, newest first, with when the account was created, its status
 * (Tilmeldt, Afventer bekræftelse or Udløbet, judged at this request), the
 * number of monitors and a count of each status, and "Slet" to delete a
 * signup with all its monitors. The delete dialog formats its body with the
 * chosen address itself, so the table gets that one message (not the whole
 * catalogue) through its own client provider.
 */
export default async function AdminMonitorUsersPage() {
  await requireAdmin();
  const [signups, t] = await Promise.all([
    listMonitorSignups(),
    getTranslations({ locale: AUTH_LOCALE, namespace: "Admin.monitorUsers" }),
  ]);
  // One clock reading for the whole list, so every status is judged at the same moment.
  const now = new Date();
  const rows = signups.map((signup): MonitorSignupRow => ({ ...signup, status: monitorSignupStatus(signup, now) }));
  const { body } = loadMessages(AUTH_LOCALE).Admin.monitorUsers.delete;

  return (
    <>
      <PageHeader title={t("title")} description={t("lead", { minutes: MONITOR_SIGNUP_CONFIRM_WINDOW_MINUTES })} />
      <Card className="flex max-w-5xl flex-col gap-4">
        <h2 id={HEADING_ID} className="text-h3 font-semibold">
          {t("table.caption")}
        </h2>
        <NextIntlClientProvider locale={AUTH_LOCALE} messages={{ Admin: { monitorUsers: { delete: { body } } } }}>
          <MonitorSignupsTable
            rows={rows}
            labelledBy={HEADING_ID}
            summary={t("summary", countMonitorSignupStatuses(rows.map((row) => row.status)))}
            statuses={{
              registered: t("status.registered"),
              pending: t("status.pending"),
              expired: t("status.expired"),
            }}
            labels={{
              email: t("table.email"),
              signedUp: t("table.signedUp"),
              status: t("table.status"),
              monitors: t("table.monitors"),
              actions: t("table.actions"),
              empty: t("empty"),
              delete: {
                open: t("delete.open"),
                title: t("delete.title"),
                confirm: t("delete.confirm"),
                pending: t("delete.pending"),
                cancel: t("delete.cancel"),
                errors: {
                  failed: t("delete.errors.failed"),
                  notFound: t("delete.errors.notFound"),
                  notMonitorUser: t("delete.errors.notMonitorUser"),
                },
              },
            }}
          />
        </NextIntlClientProvider>
      </Card>
    </>
  );
}
