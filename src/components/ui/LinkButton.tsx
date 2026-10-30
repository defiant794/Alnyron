import NextLink from "next/link";
import type { ComponentPropsWithRef } from "react";
import { cx } from "@/lib/cx";
import { safeRel } from "@/lib/safe-rel";
import { buttonClassName, type ButtonVariant } from "./button-styles";

export type LinkButtonProps = ComponentPropsWithRef<typeof NextLink> & {
  /** Visual style, shared with Button. Defaults to `"primary"`. */
  variant?: ButtonVariant;
};

/**
 * Navigation that looks like a Button but stays a link (role "link").
 * Use it for "go somewhere"; use Button for "do something".
 */
export default function LinkButton({
  variant = "primary",
  href,
  target,
  rel,
  className,
  ...rest
}: LinkButtonProps) {
  return (
    <NextLink
      {...rest}
      href={href}
      target={target}
      rel={safeRel(href, target, rel)}
      className={cx(buttonClassName(variant), className)}
    />
  );
}
