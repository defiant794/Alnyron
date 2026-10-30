import { cx } from "@/lib/cx";

export type ButtonVariant = "primary" | "secondary";

/**
 * Shared look of Button and LinkButton (one source for both).
 * Height is 48px (26px line + 2 x 10px padding + 2 x 1px border), above the
 * 44px touch target. Hover/active never apply to a disabled button;
 * focus-visible uses the global 2px focus ring.
 */
const BASE =
  "inline-flex min-h-11 cursor-pointer select-none items-center justify-center gap-2 rounded-btn border px-btn-x py-control-y text-body font-semibold transition-[background-color,border-color,color,translate] not-disabled:active:translate-y-px";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "border-transparent bg-accent text-accent-ink not-disabled:hover:bg-accent-hover not-disabled:active:bg-accent-hover",
  secondary:
    "border-border bg-bg text-fg not-disabled:hover:bg-surface not-disabled:active:bg-surface",
};

/** Class list for a button-styled element of the given variant. */
export function buttonClassName(variant: ButtonVariant): string {
  return cx(BASE, VARIANTS[variant]);
}
