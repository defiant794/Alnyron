import { useLocale } from "next-intl";
import { useParams } from "next/navigation";
import { getPathname, usePathname } from "./navigation";

/** A next-intl href: internal pathname template plus the params that fill it. */
export type RouteHref = Parameters<typeof getPathname>[0]["href"];

/**
 * The current route as a next-intl href (`/contact`, `/[slug]` + `{ slug }`),
 * ready for `getPathname` in any locale. Client components only.
 */
export function useCurrentRoute(): RouteHref {
  // Both always describe the current route, so the template and params match;
  // the pathname union needs this one cast.
  return { pathname: usePathname(), params: useParams() } as RouteHref;
}

/**
 * Locale-aware path of the current page (`/`, `/en`, `/kontakt`,
 * `/en/apps`): the same form as server-built nav hrefs, so equality marks the
 * current page. Client components only.
 */
export function useCurrentPath(): string {
  const href = useCurrentRoute();
  return getPathname({ href, locale: useLocale() });
}
