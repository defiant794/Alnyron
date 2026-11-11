import { createTranslator, type Locale } from "next-intl";
import type { MonitorFormState, MonitorFormValues } from "@/app/monitor/(panel)/actions";
import MonitorForm from "@/components/monitor/MonitorForm";
import Link from "@/components/ui/Link";
import {
  MONITOR_DASHBOARD_PATH,
  MONITOR_INTERVAL_RANGES,
  MONITOR_LABEL_MAX_LENGTH,
  MONITOR_URL_MAX_LENGTH,
} from "@/config/monitor";
import { loadMessages } from "@/i18n/messages";

export type MonitorFormScreenProps = {
  /** The page's UI language (`getMonitorLocale()`). */
  locale: Locale;
  title: string;
  lead: string;
  submit: string;
  action: (previous: MonitorFormState, formData: FormData) => Promise<MonitorFormState>;
  initialState: MonitorFormState;
  initialValues: MonitorFormValues;
  cancelHref: string;
};

/**
 * The add and edit monitor screens (approved add-monitor mock): "Tilbage til
 * oversigt", then one focused card with the heading, a lead and the form,
 * at most 640px wide. Synchronous, so pages render it like any element.
 */
export default function MonitorFormScreen({
  locale,
  title,
  lead,
  submit,
  action,
  initialState,
  initialValues,
  cancelHref,
}: MonitorFormScreenProps) {
  const t = createTranslator({ locale, messages: loadMessages(locale), namespace: "Monitor.form" });

  return (
    <div className="mx-auto flex w-full max-w-160 flex-col gap-4">
      <Link href={MONITOR_DASHBOARD_PATH} className="inline-flex min-h-11 items-center self-start text-small">
        <span aria-hidden="true">‹&nbsp;</span>
        {t("back")}
      </Link>
      <section className="flex flex-col gap-6 rounded-card border border-border bg-bg p-6 shadow-card sm:p-8">
        <header className="flex flex-col gap-1">
          <h1 className="text-h2 font-semibold">{title}</h1>
          <p className="text-small text-muted">{lead}</p>
        </header>
        <MonitorForm
          action={action}
          initialState={initialState}
          initialValues={initialValues}
          ranges={MONITOR_INTERVAL_RANGES}
          urlMaxLength={MONITOR_URL_MAX_LENGTH}
          labelMaxLength={MONITOR_LABEL_MAX_LENGTH}
          cancelHref={cancelHref}
          labels={{
            url: t("url"),
            urlPlaceholder: t("urlPlaceholder"),
            urlHint: t("urlHint"),
            label: t("label"),
            labelPlaceholder: t("labelPlaceholder"),
            interval: t("interval"),
            intervalValue: t("intervalValue"),
            intervalUnit: t("intervalUnit"),
            units: { hours: t("units.hours"), days: t("units.days") },
            submit,
            cancel: t("cancel"),
          }}
        />
      </section>
    </div>
  );
}
