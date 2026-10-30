import { useId, type ComponentPropsWithRef } from "react";
import { cx } from "@/lib/cx";

export type FieldProps = Omit<ComponentPropsWithRef<"input">, "children"> & {
  /** Visible label, programmatically tied to the input. */
  label: string;
  /** Helper text under the input, announced with it via aria-describedby. */
  hint?: string;
  /** Validation message: red border, `aria-invalid`, announced as an alert. */
  error?: string;
  /** Confirmation message, shown only when there is no error. */
  success?: string;
};

/**
 * Labelled text input with hint, error and success messages.
 * The required marker is visual only (`aria-hidden`); the native `required`
 * attribute already tells assistive technology the field is required.
 */
export default function Field({
  label,
  hint,
  error,
  success,
  id,
  required,
  disabled,
  className,
  "aria-describedby": ariaDescribedBy,
  ...rest
}: FieldProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const hintId = `${inputId}-hint`;
  const messageId = `${inputId}-message`;
  const hasMessage = Boolean(error || success);
  const describedBy = cx(hint && hintId, hasMessage && messageId, ariaDescribedBy) || undefined;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-1">
        <label htmlFor={inputId} className="text-small font-semibold text-fg">
          {label}
        </label>
        {required && (
          <span aria-hidden="true" className="text-small font-semibold text-error">
            *
          </span>
        )}
      </div>
      <input
        {...rest}
        id={inputId}
        required={required}
        disabled={disabled}
        aria-invalid={error ? true : rest["aria-invalid"]}
        aria-describedby={describedBy}
        className={cx(
          "w-full rounded-input border bg-bg px-3 py-control-y text-body text-fg transition-[border-color] placeholder:text-muted disabled:cursor-not-allowed disabled:bg-surface disabled:text-muted",
          error
            ? "border-error"
            : success
              ? "border-success"
              : "border-border-input hover:border-muted focus:border-accent disabled:border-border",
          className,
        )}
      />
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
