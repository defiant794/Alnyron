import { parseSiteEnv } from "@/config/env";

/**
 * Origin of the main site: `NEXT_PUBLIC_SITE_URL` without path or trailing
 * slash (`https://alnyron.dk`, `http://localhost:3000`), read at call time.
 * Pages served on the Monitor host link back to the main site with it (the
 * lockup, the privacy links): there a path would stay on the Monitor host.
 *
 * @throws when `NEXT_PUBLIC_SITE_URL` is missing or not a URL (`parseSiteEnv`).
 */
export function siteOrigin(): string {
  return new URL(parseSiteEnv().NEXT_PUBLIC_SITE_URL).origin;
}
