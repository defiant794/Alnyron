import type { ComponentPropsWithRef } from "react";
import { cx } from "@/lib/cx";
import FieldFrame from "./FieldFrame";

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
 * Labelled text input with hint, error and success messages (layout and
 * messages from {@link FieldFrame}).
 */
export default function Field({
  label,
  hint,
  error,
  success,
  id,
  required,
  className,
  "aria-describedby": ariaDescribedBy,
  ...rest
}: FieldProps) {
  return (
    <FieldFrame
      label={label}
      hint={hint}
      error={error}
      success={success}
      id={id}
      required={required}
      describedBy={ariaDescribedBy}
    >
      {(control) => (
        <input
          {...rest}
          id={control.id}
          required={required}
          aria-invalid={error ? true : rest["aria-invalid"]}
          aria-describedby={control["aria-describedby"]}
          className={cx(control.className, className)}
        />
      )}
    </FieldFrame>
  );
}
