import { cx } from "@/lib/cx";

export type LoadingStatusProps = {
  /** What is loading ("Indlæser siden …"); the text of the status. */
  label: string;
  /**
   * Hides spinner and text from assistive technology: for the visual of a
   * status that a region elsewhere already carries.
   */
  "aria-hidden"?: boolean;
  className?: string;
};

/**
 * Stand-in for content that is on its way, such as the next page during a
 * navigation: a spinner with its text. It is no live region itself: it fills
 * a `role="status"` region that is always in the DOM, because a live region
 * that appears with its text already in it may not be announced. The spinner
 * (the Button loading spinner, in the accent colour) is decorative; the text
 * carries the meaning.
 */
export default function LoadingStatus({ label, "aria-hidden": ariaHidden, className }: LoadingStatusProps) {
  return (
    <p aria-hidden={ariaHidden || undefined} className={cx("flex items-center gap-3 text-muted", className)}>
      <span
        aria-hidden="true"
        className="size-5 shrink-0 animate-spin rounded-pill border-2 border-accent border-t-transparent"
      />
      {label}
    </p>
  );
}
