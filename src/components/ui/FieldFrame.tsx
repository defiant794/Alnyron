import { useId, type ReactNode } from "react";
import { cx } from "@/lib/cx";

/** What a {@link FieldFrame} hands its control: wiring plus the control's look for the current state. */
export type FieldControlProps = {
  id: string;
  "aria-describedby"?: string;
  className: string;
};

export type FieldFrameProps = {
  /** Visible label, programmatically tied to the control. */
  label: string;
  /** Helper text under the control, announced with it via aria-describedby. */
  hint?: string;
  /** Validation message: red border, announced as an alert. */
  error?: string;
  /** Confirmation message, shown only when there is no error. */
  success?: string;
  id?: string;
  /** Shows the visual-only required marker (the control carries `required` itself). */
  required?: boolean;
  /** Extra ids the control is described by, after the hint and message. */
  describedBy?: string;
  children: (control: FieldControlProps) => ReactNode;
};

/**
 * Label, hint and message around one text control (shared by Field and
 * TextAreaField, so both look and announce the same). The required marker
 * is visual only (`aria-hidden`); the native `required` attribute already
 * tells assistive technology the field is required.
 */
export default function FieldFrame({
  label,
  hint,
  error,
  success,
  id,
  required,
  describedBy,
  children,
}: FieldFrameProps) {
  const autoId = useId();
  const controlId = id ?? autoId;
  const hintId = `${controlId}-hint`;
  const messageId = `${controlId}-message`;
  const hasMessage = Boolean(error || success);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-1">
        <label htmlFor={controlId} className="text-small font-semibold text-fg">
          {label}
        </label>
        {required && (
          <span aria-hidden="true" className="text-small font-semibold text-error">
            *
          </span>
        )}
      </div>
      {children({
        id: controlId,
        "aria-describedby": cx(hint && hintId, hasMessage && messageId, describedBy) || undefined,
        className: cx(
          "w-full rounded-input border bg-bg px-3 py-control-y text-body text-fg transition-[border-color] placeholder:text-muted disabled:cursor-not-allowed disabled:bg-surface disabled:text-muted",
          error
            ? "border-error"
            : success
              ? "border-success"
              : "border-border-input hover:border-muted focus:border-accent disabled:border-border",
        ),
      })}
      {hint && (
        <p id={hintId} className="text-small text-muted">
          {hint}
        </p>
      )}
      {error ? (
        <p id={messageId} role="alert" className="text-small font-semibold text-error">
          {error}
        </p>
      ) : (
        success && (
          <p id={messageId} role="status" className="text-small font-semibold text-success">
            {success}
          </p>
        )
      )}
    </div>
  );
}
