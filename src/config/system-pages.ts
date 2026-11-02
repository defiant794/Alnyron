import type { Database } from "@/types/database";

/** The fixed pages every site has (`pages.system_key`): always published, fixed routes, not deletable. */
export type SystemPageKey = Database["public"]["Enums"]["system_page_key"];

/** Internal next-intl pathname of each system page (`routing.pathnames`). */
export const SYSTEM_PAGE_PATHNAMES = {
  home: "/",
  contact: "/contact",
  privacy: "/privacy",
} as const satisfies Record<SystemPageKey, string>;

/** Whether the page's markdown body (`body_md`) is shown on the site, so the editor offers it. */
export const SYSTEM_PAGE_HAS_BODY: Record<SystemPageKey, boolean> = {
  home: false,
  contact: false,
  privacy: true,
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
