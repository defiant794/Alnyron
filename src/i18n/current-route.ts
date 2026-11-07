import { useLocale } from "next-intl";
import { useParams, useSelectedLayoutSegments } from "next/navigation";
import { getPathname, type RouteHref } from "./navigation";
import { routing } from "./routing";

/** Route params as `useParams` returns them (`{ locale: "da", slug: "apps" }`). */
type RouteParams = Record<string, string | string[] | undefined>;

/** A dynamic segment (`[slug]`) of an internal pathname. */
const DYNAMIC_SEGMENT = /\[([^\]]+)\]/g;

/**
 * The internal pathnames of {@link routing}, most dynamic segments first. A
 * dynamic template only fills from the params of a route that has those
 * segments, so this order picks `/[slug]` for a page whose slug is `contact`
 * and still `/contact` for the contact page (which has no `slug` param).
 */
const TEMPLATES = Object.keys(routing.pathnames).sort(
  (a, b) => b.split("[").length - a.split("[").length,
);

/** `template` with each `[name]` replaced by the route's `name` param (left as is when missing). */
function fillTemplate(template: string, params: RouteParams): string {
  return template.replace(DYNAMIC_SEGMENT, (segment, name: string) => {
    const value = params[name];
    return typeof value === "string" ? value : segment;
  });
}

/**
 * The current route as a next-intl href (`/contact`, `/[slug]` + `{ slug }`),
 * ready for `getPathname` in any locale.
 *
 * Built from the internal route (the active segments below the `[locale]`
 * layout), not from the URL: while a page is prerendered, `usePathname`
 * returns the rewrite target (`/da/contact` for `/contact`), which next-intl
 * does not map back to the unprefixed path, so the static HTML linked to
 * `/en/[slug]` until hydration. The segments are the same on the server and
 * in the browser.
 *
 * Client components rendered by the `[locale]` layout (site header and
 * footer): `useSelectedLayoutSegments` is relative to the calling layout, so
 * inside a page it would miss the page's own segments. One caller renders
 * outside `[locale]`: SiteFooter's privacy `NavLink` under the raw `/monitor`
 * area (the landing page and `MonitorShell`), with the locale from the
 * monitor layout's `NextIntlClientProvider`. There the route is built from
 * Monitor's own segments, and no Monitor route equals `/privacy`, so the
 * footer's current-page mark stays inert.
 */
export function useCurrentRoute(): RouteHref {
  const params = useParams<RouteParams>();
  // [] on the home page, ["contact"] on /contact and /en/contact.
  const path = `/${useSelectedLayoutSegments().join("/")}`;
  const pathname = TEMPLATES.find((template) => fillTemplate(template, params) === path) ?? path;
  // The template and params describe the same route; the pathname union
  // needs this one cast.
  return { pathname, params } as RouteHref;
}

/**
 * Locale-aware path of the current page (`/`, `/en`, `/contact`,
 * `/en/apps`): the same form as server-built nav hrefs, so equality marks the
 * current page. Client components rendered by the `[locale]` layout, plus
 * SiteFooter's `NavLink` under `/monitor`, where it never marks (see
 * {@link useCurrentRoute}).
 */
export function useCurrentPath(): string {
  const href = useCurrentRoute();
  return getPathname({ href, locale: useLocale() });
}
