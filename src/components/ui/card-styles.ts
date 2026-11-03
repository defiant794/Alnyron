import { cx } from "@/lib/cx";

export type CardVariant = "white" | "surface";

const VARIANTS: Record<CardVariant, string> = {
  white: "bg-bg",
  surface: "bg-surface",
};

// Only transform and opacity animate: the shadow sits on a pseudo-element
// whose opacity fades in, so hover never repaints the box-shadow itself.
const INTERACTIVE =
  "relative transition-transform duration-(--duration-base) hover:-translate-y-0.5 focus-within:-translate-y-0.5 after:pointer-events-none after:absolute after:-inset-px after:rounded-card after:opacity-0 after:shadow-card after:transition-opacity after:duration-(--duration-base) hover:after:opacity-100 focus-within:after:opacity-100";

/**
 * Card frame without padding (one source for Card and edge-to-edge cards
 * such as catalog item cards): 1px border, radius 14px, background and, for
 * an interactive card, the 2px lift and the shadow fading in on hover or
 * when something inside has focus.
 */
export function cardClassName(variant: CardVariant, interactive: boolean): string {
  return cx("rounded-card border border-border", VARIANTS[variant], interactive && INTERACTIVE);
}
