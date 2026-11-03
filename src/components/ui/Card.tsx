import type { ComponentPropsWithRef } from "react";
import { cx } from "@/lib/cx";
import { cardClassName, type CardVariant } from "./card-styles";

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
      className={cx(cardClassName(variant, interactive), "p-6", className)}
    />
  );
}
