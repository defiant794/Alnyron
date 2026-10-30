import type { ComponentPropsWithRef } from "react";
import { cx } from "@/lib/cx";
import { buttonClassName, type ButtonVariant } from "./button-styles";

export type ButtonProps = ComponentPropsWithRef<"button"> & {
  /** Visual style. Defaults to `"primary"`. */
  variant?: ButtonVariant;
  /**
   * Busy state for a running action: shows a spinner, sets `aria-busy` and
   * disables the button so it cannot be activated twice. The label (and so the
   * accessible name) stays unchanged.
   */
  loading?: boolean;
};

/**
 * Native `<button>` in the Alnyron primary/secondary style.
 * Defaults to `type="button"` so it never submits a form by accident.
 */
export default function Button({
  variant = "primary",
  loading = false,
  disabled = false,
  type = "button",
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        buttonClassName(variant),
        loading ? "disabled:cursor-wait" : "disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
    >
      {loading && (
        <span
          aria-hidden="true"
          className="size-4 shrink-0 animate-spin rounded-pill border-2 border-current border-t-transparent"
        />
      )}
      {children}
    </button>
  );
}
