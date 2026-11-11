import type { Metadata } from "next";
import NextLink from "next/link";
import { getTranslations } from "next-intl/server";
import MonitorShell from "@/components/monitor/MonitorShell";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import LinkButton from "@/components/ui/LinkButton";
import { MONITOR_NEW_PATH, MONITOR_ROBOTS, MONITOR_URL_MAX_LENGTH, monitorDetailPath } from "@/config/monitor";
import { getMonitorLocale } from "@/i18n/monitor-locale";
import { cx } from "@/lib/cx";
import { describeInterval, displayUrl, formatRelative, monitorHealth, type MonitorHealth } from "@/lib/monitor/format";
import { requireMonitor } from "@/services/auth/require-role";
import { getMonitorUsage, listMonitors } from "@/services/monitor/monitors";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getMonitorLocale(), namespace: "Monitor.dashboard" });
  return { title: t("metaTitle"), robots: MONITOR_ROBOTS };
}

/** A change detected this recently is marked (brief: "the one with a recent change gets a subtle marker"). */
const RECENT_CHANGE_MS = 7 * 24 * 3600 * 1000;

const DOT: Record<MonitorHealth, string> = {
  active: "bg-success",
  paused: "bg-muted",
  error: "bg-error",
};

/**
 * `/monitor/dashboard` (approved dashboard mock): the user's monitors as one
 * card of rows (status dot, name and URL, interval or pause, last change),
 * each row opening the monitor; "Tilføj overvågning"; the usage pill
 * ("1 / 2 overvågninger brugt", or just the count when uncapped). Without
 * monitors a first-run card takes a URL and opens the add form with it.
 * Owner and `monitor_user` only; RLS returns only the user's own monitors.
 * In the visitor's Monitor language.
 */
export default async function MonitorDashboardPage() {
  const user = await requireMonitor();
  const [monitors, usage, locale] = await Promise.all([listMonitors(), getMonitorUsage(), getMonitorLocale()]);
  const t = await getTranslations({ locale, namespace: "Monitor" });
  const now = Date.now();
  const atLimit = usage.limit !== null && usage.count >= usage.limit;

  return (
    <MonitorShell email={user.email} section="dashboard" locale={locale}>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-h2 font-semibold">{t("dashboard.title")}</h1>
          <p className="text-small text-muted">{t("dashboard.lead")}</p>
        </div>
        <LinkButton href={MONITOR_NEW_PATH}>
          <span aria-hidden="true">+</span>
          {t("dashboard.addButton")}
        </LinkButton>
      </header>

      {monitors.length === 0 ? (
        <section className="flex flex-col gap-4 rounded-card border border-border bg-surface p-6 sm:p-8">
          <div className="flex flex-col gap-1">
            <h2 className="text-h3 font-semibold">{t("dashboard.emptyTitle")}</h2>
            <p className="max-w-prose text-muted">{t("dashboard.emptyBody")}</p>
          </div>
          <form action={MONITOR_NEW_PATH} method="get" className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex flex-1 flex-col gap-2">
              <label htmlFor="monitor-quick-url" className="text-small font-semibold">
                {t("dashboard.emptyUrlLabel")}
              </label>
              <input
                id="monitor-quick-url"
                name="url"
                type="text"
                inputMode="url"
                autoComplete="url"
                autoCapitalize="none"
                spellCheck={false}
                required
                maxLength={MONITOR_URL_MAX_LENGTH}
                placeholder={t("form.urlPlaceholder")}
                className="min-h-12 w-full rounded-input border border-border-input bg-bg px-3 py-control-y text-body text-fg transition-[border-color] placeholder:text-muted hover:border-muted focus:border-accent"
              />
            </div>
            <Button type="submit" variant="secondary">
              {t("dashboard.emptySubmit")}
            </Button>
          </form>
        </section>
      ) : (
        <ul
          aria-label={t("dashboard.listLabel")}
          className="overflow-hidden rounded-card border border-border bg-bg shadow-card"
        >
          {monitors.map((monitor) => {
            const health = monitorHealth(monitor);
            const changed = monitor.last_change_at;
            const interval = describeInterval(monitor.interval_minutes);
            const url = displayUrl(monitor.url);
            return (
              <li key={monitor.id} className="border-b border-border last:border-b-0">
                <NextLink
                  href={monitorDetailPath(monitor.id)}
                  className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1 px-6 py-4 -outline-offset-2 transition-colors hover:bg-surface sm:grid-cols-[auto_1fr_auto_auto_auto] sm:gap-x-6"
                >
                  <span aria-hidden="true" className={cx("size-2.5 rounded-pill", DOT[health])} />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-semibold">{monitor.label ?? url}</span>
                    {monitor.label && <span className="truncate text-small text-muted">{url}</span>}
                    {/* The dot's meaning in words; paused and failing rows say it visibly below. */}
                    {health === "active" && <span className="sr-only">{t("status.active")}</span>}
                  </span>
                  <span className="col-start-2 flex flex-col text-small text-muted sm:col-start-auto sm:text-right">
                    <span className="text-xs uppercase tracking-wide">
                      {t(health === "paused" ? "dashboard.statusLabel" : "dashboard.intervalLabel")}
                    </span>
                    {health === "paused" ? t("status.paused") : t(`interval.${interval.key}`, { count: interval.count })}
                  </span>
                  <span
                    className={cx(
                      "col-start-2 text-small sm:col-start-auto sm:text-right",
                      health === "error"
                        ? "font-semibold text-error"
                        : changed && now - Date.parse(changed) < RECENT_CHANGE_MS
                          ? "font-semibold text-success"
                          : "text-muted",
                    )}
                  >
                    {health === "error"
                      ? t("status.error")
                      : changed
                        ? t("dashboard.changed", { when: formatRelative(changed, locale, now) })
                        : t("dashboard.noChanges")}
                  </span>
                  <span aria-hidden="true" className="hidden text-h3 text-muted sm:block">
                    ›
                  </span>
                </NextLink>
              </li>
            );
          })}
        </ul>
      )}

      <footer className="flex flex-wrap items-center justify-between gap-2 text-small text-muted">
        <Badge>
          {usage.limit === null
            ? t("dashboard.usageUnlimited", { count: usage.count })
            : t("dashboard.usage", { count: usage.count, limit: usage.limit })}
        </Badge>
        {usage.limit !== null && <span>{atLimit ? t("dashboard.limitReached") : t("dashboard.upgradeNote")}</span>}
      </footer>
    </MonitorShell>
  );
}
