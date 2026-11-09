import { monitorSiteOrigin } from "@/config/monitor";
import type { Database } from "@/types/database";

/** The fixed pages every site has (`pages.system_key`): always published, fixed routes, not deletable. */
export type SystemPageKey = Database["public"]["Enums"]["system_page_key"];

/**
 * App areas among the system pages (Monitor): served outside the CMS and the
 * `[locale]` routing, so their row only carries the nav flag and order. They
 * have no editor, no content schema and no sitemap entry; the Sider list
 * switches their nav flag in place.
 */
export const SYSTEM_PAGE_IS_AREA = {
  home: false,
  contact: false,
  privacy: false,
  monitor: true,
} as const satisfies Record<SystemPageKey, boolean>;

/** A system page with editable copy and a next-intl route: every key {@link SYSTEM_PAGE_IS_AREA} does not mark. */
export type ContentPageKey = {
  [Key in SystemPageKey]: (typeof SYSTEM_PAGE_IS_AREA)[Key] extends true ? never : Key;
}[SystemPageKey];

/** An app area among the system pages: every key {@link SYSTEM_PAGE_IS_AREA} marks. */
export type AreaPageKey = Exclude<SystemPageKey, ContentPageKey>;

/**
 * Path of each system page: the internal next-intl pathname (`routing.pathnames`)
 * of a content page, the raw path of an app area on the main host (the same on
 * every locale, never passed to `getPathname`), which redirects to the area's
 * own host ({@link SYSTEM_PAGE_AREA_ORIGIN}).
 */
export const SYSTEM_PAGE_PATHNAMES = {
  home: "/",
  contact: "/contact",
  privacy: "/privacy",
  monitor: "/monitor",
} as const satisfies Record<SystemPageKey, string>;

/**
 * Origin of the host each app area is served on, derived from the main site's
 * URL (`NEXT_PUBLIC_SITE_URL`, read by the caller at call time): the site nav
 * links its root, the Sider list names its host.
 */
export const SYSTEM_PAGE_AREA_ORIGIN = {
  monitor: monitorSiteOrigin,
} as const satisfies Record<AreaPageKey, (siteUrl: string) => string>;

/** Whether the page's markdown body (`body_md`) is shown on the site, so the editor offers it. */
export const SYSTEM_PAGE_HAS_BODY: Record<SystemPageKey, boolean> = {
  home: false,
  contact: false,
  privacy: true,
  monitor: false,
};

/** Content fields (dotted `content` paths) edited in a multi-line text area. */
export const MULTILINE_CONTENT_FIELDS: Readonly<Record<string, true>> = {
  "whatWeDo.intro": true,
  "whatWeDo.note": true,
  "ctaBand.text": true,
};

/** Max lengths of the `page_translations` text columns (their CHECK constraints). */
export const PAGE_TEXT_LIMITS = {
  title: 160,
  lead: 600,
  body_md: 50_000,
  seo_title: 70,
  seo_description: 160,
} as const;
