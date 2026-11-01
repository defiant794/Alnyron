import type { ComponentPropsWithRef } from "react";
import { cx } from "@/lib/cx";

export type BadgeTone = "draft" | "published" | "neutral" | "success" | "error" | "accent";

export type BadgeProps = ComponentPropsWithRef<"span"> & {
  /** Status colour. The text label always carries the meaning, never colour alone. */
  tone?: BadgeTone;
};

// Tinted pills as in the approved admin mock (published = success tint,
// draft = error tint), in the small text style. 8% tints keep the text at
// >= 4.66:1 (success), >= 5.2:1 (error) and 5.8:1 (accent) on white; neutral
// is 5.4:1. The accent pill is the MyLife login mock's "Kun for godkendte
// brugere" in that mock's 12px type; a 20px line keeps the pill at the mock's
// ~24px height.
const TONES: Record<BadgeTone, string> = {
  draft: "text-small bg-error/8 text-error",
  published: "text-small bg-success/8 text-success",
  neutral: "text-small bg-surface text-muted ring-1 ring-inset ring-border",
  success: "text-small bg-success/8 text-success",
  error: "text-small bg-error/8 text-error",
  accent: "text-xs leading-5 bg-accent/8 text-accent",
};

/** Small status pill, e.g. Kladde / Udgivet in admin lists. */
export default function Badge({ tone = "neutral", className, ...rest }: BadgeProps) {
  return (
    <span
      {...rest}
      className={cx(
        "inline-flex items-center whitespace-nowrap rounded-pill px-pill-x py-pill-y font-semibold",
        TONES[tone],
        className,
      )}
    />
  );
}
