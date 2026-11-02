import type { Locale } from "next-intl";
import { cache } from "react";
import { z } from "zod";
import type { SystemPageKey } from "@/config/system-pages";
import { resolveContent, type ResolvedContent } from "@/lib/i18n/resolve-content";
import { getPublicClient } from "@/lib/supabase/public";
import { PAGE_CONTENT_SCHEMAS } from "@/lib/validation/pages";
import { getSiteSettings } from "./settings";

/** {@link readSchema} of `Schema`: every block prefaulted, every leaf a string defaulting to blank. */
type ReadSchema<Schema extends z.ZodObject> = z.ZodObject<{
  [Key in keyof Schema["shape"]]: Schema["shape"][Key] extends z.ZodObject
    ? z.ZodPrefault<ReadSchema<Schema["shape"][Key]>>
    : z.ZodDefault<z.ZodString>;
}>;

/**
 * The read schema of a page's stored `content`, derived from its strict write
 * schema in {@link PAGE_CONTENT_SCHEMAS} (seeded in
 * `20261101000300_seed_system_content.sql`), so the site reads exactly the
 * keys the editor shows and saves. A missing block or field is blank (hidden
 * on DA, DA fallback on EN), unknown keys are dropped, and any other shape is
 * a content error.
 */
function readSchema<Schema extends z.ZodObject>(schema: Schema): ReadSchema<Schema> {
  const shape = Object.fromEntries(
    Object.entries(schema.shape).map(([name, field]) => [
      name,
      field instanceof z.ZodObject ? readSchema(field).prefault({}) : z.string().default(""),
    ]),
  );
  return z.object(shape) as ReadSchema<Schema>;
}

/** `content` of the home page: the "what we do" intro and the CTA band (`ctaBand.text` may contain `{email}`). */
const homeContentSchema = readSchema(PAGE_CONTENT_SCHEMAS.home);

/** `content` of the contact page: the eyebrow over the title and the detail rows beside the lead. */
const contactContentSchema = readSchema(PAGE_CONTENT_SCHEMAS.contact);

/** `content` of the privacy page: the eyebrow over the title (the policy itself is `body_md`). */
const privacyContentSchema = readSchema(PAGE_CONTENT_SCHEMAS.privacy);

export type HomeContent = z.infer<typeof homeContentSchema>;
export type ContactContent = z.infer<typeof contactContentSchema>;
export type PrivacyContent = z.infer<typeof privacyContentSchema>;

export interface HomePageTranslation {
  title: string;
  lead: string;
  content: HomeContent;
}

/** A system page's text fields: `body_md` is the markdown body, `content` its structured blocks. */
export interface SystemPageTranslation<Content> {
  title: string;
  lead: string;
  body_md: string;
  content: Content;
}

export type ContactPageTranslation = SystemPageTranslation<ContactContent>;
export type PrivacyPageTranslation = SystemPageTranslation<PrivacyContent>;

/** SEO overrides of a system page (`seo_title`, `seo_description`); blank = use the page defaults. */
export interface PageMetadataTranslation {
  title: string;
  description: string;
}

/** In seeded copy, stands for `site_settings.contact_email`. */
const EMAIL_TOKEN = "{email}";

/**
 * The Danish row and the `locale` row (absent for Danish, or when it was
 * never created) of one system page. Cached per request, so a page and its
 * `generateMetadata` share one query.
 *
 * @throws when the query fails or the Danish row is missing, so a broken read
 *   never replaces a good cached page.
 */
const loadTranslations = cache(async (key: SystemPageKey, locale: Locale) => {
  const locales: Locale[] = locale === "da" ? ["da"] : ["da", locale];
  const { data, error } = await getPublicClient()
    .from("page_translations")
    .select("locale, title, lead, body_md, content, seo_title, seo_description, pages!inner(system_key)")
    .eq("pages.system_key", key)
    .in("locale", locales);
  if (error) throw new Error(`Failed to load the ${key} page: ${error.message}`);

  const rows = data ?? [];
  const da = rows.find((row) => row.locale === "da");
  if (!da) throw new Error(`Failed to load the ${key} page: no Danish translation`);
  const own = locale === "da" ? undefined : rows.find((row) => row.locale === locale);
  return { da, own };
});

/**
 * The home system page for `locale`, with Danish filling every blank field
 * (also inside `content`). `fallbackKeys` lists the dotted paths shown from
 * Danish, which need `lang="da"` on an English page.
 *
 * @throws when the query fails, the Danish row is missing or `content` has
 *   the wrong shape, so a broken read never replaces a good cached page.
 */
export async function getHomePage(locale: Locale): Promise<ResolvedContent<HomePageTranslation>> {
  const { da, own } = await loadTranslations("home", locale);
  const toTranslation = (row: { title: string; lead: string; content: unknown }): HomePageTranslation => ({
    title: row.title,
    lead: row.lead,
    content: homeContentSchema.parse(row.content),
  });
  return resolveContent(toTranslation(da), own && toTranslation(own), locale);
}

/**
 * The contact system page (`/kontakt`, `/en/contact`) for `locale`, with the
 * same per-field Danish fallback as {@link getHomePage}.
 *
 * @throws like {@link getHomePage}.
 */
export async function getContactPage(locale: Locale): Promise<ResolvedContent<ContactPageTranslation>> {
  const { da, own } = await loadTranslations("contact", locale);
  const toTranslation = bodyPageParser(contactContentSchema);
  return resolveContent(toTranslation(da), own && toTranslation(own), locale);
}

/**
 * The privacy system page (`/privatliv`, `/en/privacy`) for `locale`, with
 * the same per-field Danish fallback as {@link getHomePage}. Each `{email}` in
 * `body_md` becomes a markdown autolink to `site_settings.contact_email`, so
 * the rendered policy links the current contact address.
 *
 * @throws like {@link getHomePage}, or when the site settings cannot be read.
 */
export async function getPrivacyPage(locale: Locale): Promise<ResolvedContent<PrivacyPageTranslation>> {
  const [{ da, own }, settings] = await Promise.all([
    loadTranslations("privacy", locale),
    getSiteSettings(),
  ]);
  const toTranslation = bodyPageParser(privacyContentSchema);
  const { value, fallbackKeys } = resolveContent(toTranslation(da), own && toTranslation(own), locale);
  const body = value.body_md.replaceAll(EMAIL_TOKEN, `<${settings.contactEmail}>`);
  return { value: { ...value, body_md: body }, fallbackKeys };
}

/**
 * SEO title and description of a system page for `locale`, Danish filling
 * blank fields. Blank results mean "use the page's default".
 *
 * @throws like {@link getHomePage}.
 */
export async function getPageMetadata(key: SystemPageKey, locale: Locale): Promise<PageMetadataTranslation> {
  const { da, own } = await loadTranslations(key, locale);
  const toMetadata = (row: { seo_title: string; seo_description: string }) => ({
    title: row.seo_title,
    description: row.seo_description,
  });
  return resolveContent(toMetadata(da), own && toMetadata(own), locale).value;
}

/** Row → translation for a page with a markdown body; `content` is parsed with `schema`. */
function bodyPageParser<Content>(schema: z.ZodType<Content>) {
  return (row: { title: string; lead: string; body_md: string; content: unknown }): SystemPageTranslation<Content> => ({
    title: row.title,
    lead: row.lead,
    body_md: row.body_md,
    content: schema.parse(row.content),
  });
}
