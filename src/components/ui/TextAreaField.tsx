import type { ComponentPropsWithRef } from "react";
import { cx } from "@/lib/cx";
import FieldFrame from "./FieldFrame";

export type TextAreaFieldProps = Omit<ComponentPropsWithRef<"textarea">, "children"> & {
  /** Visible label, programmatically tied to the text area. */
  label: string;
  /** Helper text under the text area, announced with it via aria-describedby. */
  hint?: string;
  /** Validation message: red border, `aria-invalid`, announced as an alert. */
  error?: string;
  /** Confirmation message, shown only when there is no error. */
  success?: string;
};

/**
 * Labelled multi-line text input: the text-area twin of Field (same frame,
 * states and messages). Vertically resizable.
 */
export default function TextAreaField({
  label,
  hint,
  error,
  success,
  id,
  required,
  className,
  "aria-describedby": ariaDescribedBy,
  ...rest
}: TextAreaFieldProps) {
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
        <textarea
          {...rest}
          id={control.id}
          required={required}
          aria-invalid={error ? true : rest["aria-invalid"]}
          aria-describedby={control["aria-describedby"]}
          className={cx(control.className, "resize-y", className)}
        />
      )}
    </FieldFrame>
  );
}
