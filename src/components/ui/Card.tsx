import type { ComponentPropsWithRef } from "react";
import { cx } from "@/lib/cx";

export type CardVariant = "white" | "surface";

export type CardProps = ComponentPropsWithRef<"div"> & {
  /** Background: page white (default) or the muted surface tone. */
  variant?: CardVariant;
  /**
   * For cards holding a link or control: lifts 2px and fades in the card
   * shadow on hover or when something inside has focus. Marked with
   * `data-interactive`.
   */
  interactive?: boolean;
};

const VARIANTS: Record<CardVariant, string> = {
  white: "bg-bg",
  surface: "bg-surface",
};

// Only transform and opacity animate: the shadow sits on a pseudo-element
// whose opacity fades in, so hover never repaints the box-shadow itself.
const INTERACTIVE =
  "relative transition-transform duration-(--duration-base) hover:-translate-y-0.5 focus-within:-translate-y-0.5 after:pointer-events-none after:absolute after:-inset-px after:rounded-card after:opacity-0 after:shadow-card after:transition-opacity after:duration-(--duration-base) hover:after:opacity-100 focus-within:after:opacity-100";

/** Bordered content panel (radius 14px) for distinct, actionable content. */
export default function Card({
  variant = "white",
  interactive = false,
  className,
  ...rest
}: CardProps) {
  return (
    <div
      {...rest}
      data-interactive={interactive || undefined}
      className={cx(
        "rounded-card border border-border p-6",
        VARIANTS[variant],
        interactive && INTERACTIVE,
        className,
      )}
    />
  );
}
