"use client";

import NextLink from "next/link";
import type { ComponentPropsWithRef } from "react";
import { useCurrentPath } from "@/i18n/current-route";
import { cx } from "@/lib/cx";

/** Current page (approved mock): navy, semibold, 2px accent rule under the label. */
const CURRENT =
  "aria-[current=page]:font-semibold aria-[current=page]:text-fg aria-[current=page]:underline aria-[current=page]:decoration-accent aria-[current=page]:decoration-2 aria-[current=page]:underline-offset-8";

export type NavLinkProps = Omit<ComponentPropsWithRef<typeof NextLink>, "href"> & {
  /** Locale-aware path (`/kontakt`, `/en/apps`), as built on the server. */
  href: string;
};

/**
 * Site navigation link that marks itself `aria-current="page"` on the page it
 * points to and styles that state (header nav, footer). The mark is
 * server-rendered too (the current route is known while prerendering), so it
 * needs no JavaScript.
 */
export default function NavLink({ href, className, ...rest }: NavLinkProps) {
  const isCurrent = useCurrentPath() === href;
  return (
    <NextLink
      {...rest}
      href={href}
      aria-current={isCurrent ? "page" : undefined}
      className={cx(className, CURRENT)}
    />
  );
}
