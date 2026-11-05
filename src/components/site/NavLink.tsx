"use client";

import NextLink from "next/link";
import type { ComponentPropsWithRef } from "react";
import { useCurrentPath } from "@/i18n/current-route";
import { getPathname } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { cx } from "@/lib/cx";

/** Current page or section (approved mocks): navy, semibold, 2px accent rule under the label. */
const CURRENT =
  "aria-[current]:font-semibold aria-[current]:text-fg aria-[current]:underline aria-[current]:decoration-accent aria-[current]:decoration-2 aria-[current]:underline-offset-8";

/** Each locale's home path (`/`, `/en`): every page lies below one, so a home link never marks a section. */
const HOME_PATHS = new Set<string>(routing.locales.map((locale) => getPathname({ href: "/", locale })));

export type NavLinkProps = Omit<ComponentPropsWithRef<typeof NextLink>, "href"> & {
  /** Locale-aware path (`/contact`, `/en/apps`), as built on the server. */
  href: string;
};

/**
 * Site navigation link that marks itself `aria-current="page"` on the page it
 * points to, and `aria-current="true"` on a page below it (a catalog section
 * while one of its items is shown), and styles both (header nav, footer).
 * The two values follow WAI-ARIA: `page` is the current page itself, `true`
 * the current item of a set. On an item page the item is the current page
 * (its breadcrumb entry carries `page`), so the section link must not claim
 * it too. The mark is server-rendered too (the current route is known while
 * prerendering), so it needs no JavaScript.
 */
export default function NavLink({ href, className, ...rest }: NavLinkProps) {
  const currentPath = useCurrentPath();
  const current =
    currentPath === href ? "page" : !HOME_PATHS.has(href) && currentPath.startsWith(`${href}/`) ? "true" : undefined;
  return (
    <NextLink
      {...rest}
      href={href}
      aria-current={current}
      className={cx(className, CURRENT)}
    />
  );
}
