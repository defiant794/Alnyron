import NextLink from "next/link";
import type { ComponentPropsWithRef } from "react";
import { cx } from "@/lib/cx";
import { safeRel } from "@/lib/safe-rel";

export type LinkProps = ComponentPropsWithRef<typeof NextLink>;

/**
 * Accent text link on top of `next/link`.
 *
 * The underline is always present at low strength and turns solid on
 * hover/focus: accent vs. body text is only ~2.6:1, so colour alone would not
 * set links apart inside running text (WCAG 1.4.1).
 * External `target="_blank"` links get `rel="noopener noreferrer"`.
 */
export default function Link({ href, target, rel, className, ...rest }: LinkProps) {
  return (
    <NextLink
      {...rest}
      href={href}
      target={target}
      rel={safeRel(href, target, rel)}
      className={cx(
        "text-accent underline decoration-accent/40 underline-offset-4 transition-[text-decoration-color] hover:decoration-current focus-visible:decoration-current",
        className,
      )}
    />
  );
}
