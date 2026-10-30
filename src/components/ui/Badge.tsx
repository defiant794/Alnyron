import type { ComponentPropsWithRef } from "react";
import { cx } from "@/lib/cx";

export type BadgeTone = "draft" | "published" | "neutral" | "success" | "error";

export type BadgeProps = ComponentPropsWithRef<"span"> & {
  /** Status colour. The text label always carries the meaning, never colour alone. */
  tone?: BadgeTone;
};

// Tinted pills as in the approved admin mock (published = success tint,
// draft = error tint). 8% tints keep the text at >= 4.66:1 (success) and
// >= 5.2:1 (error) on white; neutral is 5.4:1.
const TONES: Record<BadgeTone, string> = {
  draft: "bg-error/8 text-error",
  published: "bg-success/8 text-success",
  neutral: "bg-surface text-muted ring-1 ring-inset ring-border",
  success: "bg-success/8 text-success",
  error: "bg-error/8 text-error",
};

/** Small status pill, e.g. Kladde / Udgivet in admin lists. */
export default function Badge({ tone = "neutral", className, ...rest }: BadgeProps) {
  return (
    <span
      {...rest}
      className={cx(
        "inline-flex items-center whitespace-nowrap rounded-pill px-pill-x py-pill-y text-small font-semibold",
        TONES[tone],
        className,
      )}
    />
  );
}
