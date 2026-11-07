"use client";

import { useActionState, useId, useState } from "react";
import type { MonitorFormState, MonitorFormValues } from "@/app/monitor/(panel)/actions";
import Field from "@/components/ui/Field";
import LinkButton from "@/components/ui/LinkButton";
import Notice from "@/components/ui/Notice";
import SubmitButton from "@/components/ui/SubmitButton";
import { useFormResultFocus } from "@/hooks/use-form-result-focus";
import { cx } from "@/lib/cx";

type IntervalUnit = "hours" | "days";

export type MonitorFormProps = {
  /** `createMonitorAction`, or `updateMonitorAction` with the monitor in `initialState`. */
  action: (previous: MonitorFormState, formData: FormData) => Promise<MonitorFormState>;
  initialState: MonitorFormState;
  /** The fields' starting values (the monitor being edited, or a URL handed over from elsewhere). */
  initialValues: MonitorFormValues;
  /** Allowed interval values per unit (`MONITOR_INTERVAL_RANGES`). */
  ranges: Record<IntervalUnit, { min: number; max: number }>;
  urlMaxLength: number;
  labelMaxLength: number;
  /** Where "Annullér" leads (the dashboard, or the monitor's page). */
  cancelHref: string;
  labels: {
    url: string;
    urlPlaceholder: string;
    urlHint: string;
    label: string;
    labelPlaceholder: string;
    interval: string;
    intervalValue: string;
    intervalUnit: string;
    units: Record<IntervalUnit, string>;
    submit: string;
    cancel: string;
  };
};

const isUnit = (value: string): value is IntervalUnit => value === "hours" || value === "days";

/** A form control's look, as `FieldFrame` gives its controls. */
const CONTROL =
  "min-h-12 rounded-input border bg-bg px-3 py-control-y text-body text-fg transition-[border-color]";

/**
 * Add/edit monitor form (approved add-monitor mock): URL with its "public
 * pages only" hint, optional name, and the check interval as a number plus
 * hours/days. Posts to a Server Action, so it works without JavaScript; with
 * it the number's bounds follow the chosen unit and the button shows the
 * busy state. A failed save keeps the typed values (echoed by the action);
 * field errors show under their field, the cap above the form, and the
 * first message takes the focus.
 */
export default function MonitorForm({
  action,
  initialState,
  initialValues,
  ranges,
  urlMaxLength,
  labelMaxLength,
  cancelHref,
  labels,
}: MonitorFormProps) {
  const [state, formAction] = useActionState(action, initialState);
  const formRef = useFormResultFocus(state);
  const values = state.values ?? initialValues;
  const [unit, setUnit] = useState<IntervalUnit>(isUnit(values.intervalUnit) ? values.intervalUnit : "days");
  const intervalId = useId();
  const intervalError = state.fieldErrors?.intervalValue ?? state.fieldErrors?.intervalUnit;
  const intervalMessageId = `${intervalId}-message`;
  const intervalControl = cx(
    CONTROL,
    intervalError ? "border-error" : "border-border-input hover:border-muted focus:border-accent",
  );

  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-6">
      {state.error && (
        <Notice tone="error" role="alert" tabIndex={-1} data-form-result>
          {state.error}
        </Notice>
      )}
      <Field
        label={labels.url}
        hint={labels.urlHint}
        name="url"
        type="text"
        inputMode="url"
        autoComplete="url"
        autoCapitalize="none"
        spellCheck={false}
        required
        maxLength={urlMaxLength}
        placeholder={labels.urlPlaceholder}
        defaultValue={values.url}
        error={state.fieldErrors?.url}
      />
      <Field
        label={labels.label}
        name="label"
        type="text"
        maxLength={labelMaxLength}
        placeholder={labels.labelPlaceholder}
        defaultValue={values.label}
        error={state.fieldErrors?.label}
      />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-small font-semibold">{labels.interval}</legend>
        <div className="flex flex-wrap gap-3">
          <label htmlFor={`${intervalId}-value`} className="sr-only">
            {labels.intervalValue}
          </label>
          <input
            id={`${intervalId}-value`}
            name="intervalValue"
            type="number"
            inputMode="numeric"
            required
            step={1}
            min={ranges[unit].min}
            max={ranges[unit].max}
            defaultValue={values.intervalValue}
            aria-invalid={intervalError ? true : undefined}
            aria-describedby={intervalError ? intervalMessageId : undefined}
            className={cx(intervalControl, "w-28")}
          />
          <label htmlFor={`${intervalId}-unit`} className="sr-only">
            {labels.intervalUnit}
          </label>
          <select
            id={`${intervalId}-unit`}
            name="intervalUnit"
            value={unit}
            onChange={(event) => {
              if (isUnit(event.target.value)) setUnit(event.target.value);
            }}
            className={cx(intervalControl, "w-40 cursor-pointer")}
          >
            <option value="days">{labels.units.days}</option>
            <option value="hours">{labels.units.hours}</option>
          </select>
        </div>
        {intervalError && (
          <p id={intervalMessageId} role="alert" className="text-small font-semibold text-error">
            {intervalError}
          </p>
        )}
      </fieldset>
      <div className="flex flex-wrap gap-3">
        <SubmitButton>{labels.submit}</SubmitButton>
        <LinkButton href={cancelHref} variant="secondary">
          {labels.cancel}
        </LinkButton>
      </div>
    </form>
  );
}
