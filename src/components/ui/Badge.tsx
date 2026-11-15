import type { ComponentPropsWithRef } from "react";
import { cx } from "@/lib/cx";

export type BadgeTone = "draft" | "published" | "neutral" | "success" | "error" | "accent" | "info";

export type BadgeProps = ComponentPropsWithRef<"span"> & {
  /** Status colour. The text label always carries the meaning, never colour alone. */
  tone?: BadgeTone;
};

// Tinted pills as in the approved admin mock (published = success tint,
// draft = error tint), in the small text style. The lighter 4% success tint
// keeps green labels readable on both white and surface backgrounds. The
// error and accent tones retain their 8% tints. The accent pill is the MyLife
// login mock's "Kun for godkendte brugere" in that mock's 12px type; a 20px
// line keeps the pill at the mock's ~24px height. Info is the same accent tint as a status tone in
// the small text style (e.g. "Afventer bekræftelse" in Admin › Monitor-brugere).
const TONES: Record<BadgeTone, string> = {
  draft: "text-small bg-error/8 text-error",
  published: "text-small bg-success/4 text-success",
  neutral: "text-small bg-surface text-muted ring-1 ring-inset ring-border",
  success: "text-small bg-success/4 text-success",
  error: "text-small bg-error/8 text-error",
  accent: "text-xs leading-5 bg-accent/8 text-accent",
  info: "text-small bg-accent/8 text-accent",
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
