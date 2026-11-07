import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { deleteMonitorAction, pauseMonitorAction, resumeMonitorAction } from "@/app/monitor/(panel)/actions";
import DeleteMonitorDialog from "@/components/monitor/DeleteMonitorDialog";
import MonitorShell from "@/components/monitor/MonitorShell";
import Link from "@/components/ui/Link";
import LinkButton from "@/components/ui/LinkButton";
import SubmitButton from "@/components/ui/SubmitButton";
import { AUTH_LOCALE } from "@/config/auth-areas";
import { MONITOR_DASHBOARD_PATH, MONITOR_ROBOTS, monitorEditPath } from "@/config/monitor";
import { cx } from "@/lib/cx";
import { describeInterval, displayUrl, formatDateTime, formatRelative, monitorHealth } from "@/lib/monitor/format";
import { monitorIdSchema } from "@/lib/validation/monitor";
import { requireMonitor } from "@/services/auth/require-role";
import { getMonitor, listMonitorEvents } from "@/services/monitor/monitors";

type MonitorDetailPageProps = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: MonitorDetailPageProps): Promise<Metadata> {
  const { id } = await params;
  const monitor = monitorIdSchema.safeParse(id).success ? await getMonitor(id) : null;
  return { title: monitor ? (monitor.label ?? displayUrl(monitor.url)) : undefined, robots: MONITOR_ROBOTS };
}

const DOT = { active: "bg-success", paused: "bg-muted", error: "bg-error" } as const;

/** One timeline entry: when (relative, then date and time) beside what happened. */
function TimelineEntry({ at, now, children }: { at: string; now: number; children: React.ReactNode }) {
  return (
    <li className="grid gap-x-4 gap-y-1 border-b border-border py-4 last:border-b-0 sm:grid-cols-[10rem_1fr]">
      <time dateTime={at} className="flex flex-col text-small text-muted">
        <span>{formatRelative(at, now)}</span>
        <span>{formatDateTime(at)}</span>
      </time>
      <div className="flex flex-col gap-1">{children}</div>
    </li>
  );
}

/**
 * `/monitor/monitors/<id>` (approved monitor-detail mock): the monitor's
 * name and URL, its status (active, paused or failing), interval and last
 * check; Pause/Genoptag, Rediger and Slet (with a confirm step); and its
 * change history, newest first, ending with "Overvågning oprettet" (below
 * which a monitor without changes says "Ingen ændringer endnu"). Owner and
 * `monitor_user` only; another account's monitor (hidden by RLS) or an
 * unknown id is a 404.
 */
export default async function MonitorDetailPage({ params }: MonitorDetailPageProps) {
  const user = await requireMonitor();
  const { id } = await params;
  const monitor = monitorIdSchema.safeParse(id).success ? await getMonitor(id) : null;
  if (!monitor) notFound();

  const [events, t] = await Promise.all([
    listMonitorEvents(monitor.id),
    getTranslations({ locale: AUTH_LOCALE, namespace: "Monitor" }),
  ]);
  const now = Date.now();
  const health = monitorHealth(monitor);
  const interval = describeInterval(monitor.interval_minutes);
  const url = displayUrl(monitor.url);
  const name = monitor.label ?? url;
  const target = { monitorId: monitor.id };
  const statusParts = [
    t(`status.${health}`),
    t("detail.checksEvery", { interval: t(`interval.${interval.key}`, { count: interval.count }) }),
    monitor.last_checked_at
      ? t("detail.lastChecked", { when: formatRelative(monitor.last_checked_at, now) })
      : t("detail.notCheckedYet"),
  ];

  return (
    <MonitorShell email={user.email} section="dashboard" sectionPage={false}>
      <div className="mx-auto flex w-full max-w-205 flex-col gap-8">
        <header className="flex flex-col gap-4">
          <Link href={MONITOR_DASHBOARD_PATH} className="inline-flex min-h-11 items-center self-start text-small">
            <span aria-hidden="true">‹&nbsp;</span>
            {t("detail.back")}
          </Link>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-1">
              <h1 className="text-h2 font-semibold break-words">{name}</h1>
              <Link href={monitor.url} rel="noreferrer" className="self-start text-small break-all">
                {url}
              </Link>
            </div>
            <div role="group" aria-label={t("detail.actionsLabel")} className="flex flex-wrap gap-2">
              <form action={(health === "paused" ? resumeMonitorAction : pauseMonitorAction).bind(null, target)}>
                <SubmitButton variant="secondary">
                  {health === "paused" ? t("detail.resume") : t("detail.pause")}
                </SubmitButton>
              </form>
              <LinkButton href={monitorEditPath(monitor.id)} variant="secondary">
                {t("detail.edit")}
              </LinkButton>
              <DeleteMonitorDialog
                action={deleteMonitorAction.bind(null, target)}
                labels={{
                  open: t("detail.delete"),
                  title: t("detail.deleteTitle"),
                  body: t("detail.deleteBody", { name }),
                  confirm: t("detail.deleteConfirm"),
                  cancel: t("detail.deleteCancel"),
                }}
              />
            </div>
          </div>
          <p className="flex flex-wrap items-center gap-x-2 text-small text-muted">
            <span aria-hidden="true" className={cx("size-2.5 rounded-pill", DOT[health])} />
            {statusParts.map((part, index) => (
              <span key={part} className="inline-flex items-center gap-x-2">
                {index > 0 && <span aria-hidden="true">·</span>}
                <span className={cx(index === 0 && health === "error" && "font-semibold text-error")}>{part}</span>
              </span>
            ))}
          </p>
        </header>

        <section className="flex flex-col gap-3">
          <h2 className="text-h3 font-semibold">{t("detail.historyTitle")}</h2>
          <ol className="rounded-card border border-border bg-bg px-6 shadow-card">
            {events.map((event) => (
              <TimelineEntry key={event.id} at={event.detected_at} now={now}>
                <p className="font-semibold">{event.summary ?? t("detail.changedEntry")}</p>
              </TimelineEntry>
            ))}
            <TimelineEntry at={monitor.created_at} now={now}>
              <p className="font-semibold">{t("detail.createdEntry")}</p>
            </TimelineEntry>
            {events.length === 0 && (
              <li className="flex flex-col gap-1 py-4">
                <p className="font-semibold">{t("detail.noChanges")}</p>
                <p className="text-small text-muted">{t("detail.noChangesBody")}</p>
              </li>
            )}
          </ol>
        </section>
      </div>
    </MonitorShell>
  );
}
