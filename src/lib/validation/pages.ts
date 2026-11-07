import { z } from "zod";
import { PAGE_TEXT_LIMITS, SYSTEM_PAGE_IS_AREA, type ContentPageKey, type SystemPageKey } from "@/config/system-pages";

/**
 * Write schemas for the admin pages editor (F1.2).
 *
 * `admin_save_page` replaces a translation's `content` WHOLESALE, so a save
 * must carry every block and every key of the page's content: a missing one
 * would be wiped in the DB. These schemas are therefore strict (all keys
 * required, no unknown keys). The lenient read schemas in
 * `services/content/pages.ts` are derived from {@link PAGE_CONTENT_SCHEMAS},
 * so the site, the editor and a save always agree on a page's content keys.
 */

/** Issue message for a blank Danish title (mirrors the `page_translations_da_title` CHECK). */
export const DA_TITLE_REQUIRED = "da-title-required";

/** A `pages.id` (any UUID-shaped string; PostgREST rejects other ids with an error, not an empty result). */
export const pageIdSchema = z.guid();

/**
 * `content` of each content system page, every leaf a required string: the
 * single source of the content shape. The editor's fields and the public read
 * schemas are derived from it. App areas ({@link isContentPage}) have none.
 */
export const PAGE_CONTENT_SCHEMAS = {
  home: z.strictObject({
    whatWeDo: z.strictObject({ eyebrow: z.string(), title: z.string(), intro: z.string(), note: z.string() }),
    ctaBand: z.strictObject({
      title: z.string(),
      /** May contain `{email}`, rendered as the contact email link. */
      text: z.string(),
    }),
  }),
  contact: z.strictObject({
    eyebrow: z.string(),
    responseTime: z.string(),
    languages: z.string(),
    /** Company details row; may contain `{cvr}`, rendered as `site_settings.cvr`. */
    company: z.string(),
  }),
  privacy: z.strictObject({ eyebrow: z.string() }),
} satisfies Record<ContentPageKey, z.ZodObject>;

/**
 * Whether `key` names a page with editable content: not an app area
 * (`SYSTEM_PAGE_IS_AREA`), so it has a content schema, an editor and a
 * next-intl route.
 */
export function isContentPage(key: SystemPageKey): key is ContentPageKey {
  return !SYSTEM_PAGE_IS_AREA[key];
}

/** One locale's text columns, limited like the `page_translations` CHECK constraints. */
function translationSchema<Content extends z.ZodType>(content: Content, title: z.ZodString) {
  return z.object({
    title,
    lead: z.string().max(PAGE_TEXT_LIMITS.lead),
    body_md: z.string().max(PAGE_TEXT_LIMITS.body_md),
    seo_title: z.string().max(PAGE_TEXT_LIMITS.seo_title),
    seo_description: z.string().max(PAGE_TEXT_LIMITS.seo_description),
    content,
  });
}

const titleSchema = z.string().max(PAGE_TEXT_LIMITS.title);
const daTitleSchema = titleSchema.refine((title) => title.trim() !== "", { error: DA_TITLE_REQUIRED });

/**
 * A save of one system page. Danish content is complete; English content is
 * complete too, or `{}` (no English text: every field shows the Danish one).
 * Unknown keys (e.g. a `slug`: system pages have fixed routes) are dropped.
 */
function systemPageSchema<Key extends ContentPageKey, Content extends z.ZodObject>(key: Key, content: Content) {
  return z.object({
    id: pageIdSchema,
    system_key: z.literal(key),
    show_in_nav: z.boolean(),
    translations: z.object({
      da: translationSchema(content, daTitleSchema),
      en: translationSchema(z.union([content, z.strictObject({})]), titleSchema),
    }),
  });
}

export const savePageSchema = z.discriminatedUnion("system_key", [
  systemPageSchema("home", PAGE_CONTENT_SCHEMAS.home),
  systemPageSchema("contact", PAGE_CONTENT_SCHEMAS.contact),
  systemPageSchema("privacy", PAGE_CONTENT_SCHEMAS.privacy),
]);

export type SavePageInput = z.infer<typeof savePageSchema>;

export const pageStatusSchema = z.object({
  pageId: pageIdSchema,
  status: z.enum(["draft", "published"]),
});

/** Showing (`true`) or hiding a page in the public nav. */
export const pageNavSchema = z.object({
  pageId: pageIdSchema,
  show: z.boolean(),
});

/** Page ids in their new nav order: at least one, no repeats. */
export const navOrderSchema = z
  .array(pageIdSchema)
  .min(1)
  .refine((ids) => new Set(ids).size === ids.length, { error: "duplicate-page-id" });

/** Dotted paths of every content field of `key`'s page, in form order (`"whatWeDo.eyebrow"`, ...). */
export function contentFieldPaths(key: ContentPageKey): string[] {
  const walk = (schema: z.ZodObject, prefix: string): string[] =>
    Object.entries(schema.shape).flatMap(([name, child]) => {
      const path = prefix === "" ? name : `${prefix}.${name}`;
      return child instanceof z.ZodObject ? walk(child, path) : [path];
    });
  return walk(PAGE_CONTENT_SCHEMAS[key], "");
}
