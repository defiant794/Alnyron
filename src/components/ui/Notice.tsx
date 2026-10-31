import type { ComponentPropsWithRef } from "react";
import { cx } from "@/lib/cx";

export type NoticeTone = "error" | "success";

export type NoticeProps = ComponentPropsWithRef<"p"> & {
  tone: NoticeTone;
};

const TONES: Record<NoticeTone, string> = {
  error: "border-error bg-error/5 text-error",
  success: "border-success bg-success/5 text-success",
};

/**
 * Form-level message box (e.g. "wrong email or password", "check your
 * email"). The wording carries the meaning; the colour only supports it.
 * Pass `role="alert"` for a message that appears after an action, or render
 * it inside a persistent `role="status"` region.
 */
export default function Notice({ tone, className, ...rest }: NoticeProps) {
  return (
    <p
      {...rest}
      className={cx(
        "rounded-input border px-3 py-control-y text-small font-semibold",
        TONES[tone],
        className,
      )}
    />
  );
}
