import type { Locale } from "next-intl";
import { z } from "zod";
import { resolveContent, type ResolvedContent } from "@/lib/i18n/resolve-content";
import { getPublicClient } from "@/lib/supabase/public";

/** Missing text in a stored content block reads as blank (hidden on DA, DA fallback on EN). */
const text = z.string().default("");

/**
 * `page_translations.content` of the home page (seeded in
 * `20261101000300_seed_system_content.sql`). A missing block or field is
 * blank; any other shape is a content error.
 */
const homeContentSchema = z.object({
  whatWeDo: z
    .object({ eyebrow: text, title: text, intro: text, note: text })
    .prefault({}),
  ctaBand: z
    .object({
      title: text,
      /** May contain `{email}`, rendered as the contact email link. */
      text,
    })
    .prefault({}),
});

export type HomeContent = z.infer<typeof homeContentSchema>;

export interface HomePageTranslation {
  title: string;
  lead: string;
  content: HomeContent;
}

/**
 * The home system page for `locale`, with Danish filling every blank field
 * (also inside `content`). `fallbackKeys` lists the dotted paths shown from
 * Danish, which need `lang="da"` on an English page.
 *
 * @throws when the query fails, the Danish row is missing or `content` has
 *   the wrong shape, so a broken read never replaces a good cached page.
 */
export async function getHomePage(locale: Locale): Promise<ResolvedContent<HomePageTranslation>> {
  const locales: Locale[] = locale === "da" ? ["da"] : ["da", locale];
  const { data, error } = await getPublicClient()
    .from("page_translations")
    .select("locale, title, lead, content, pages!inner(system_key)")
    .eq("pages.system_key", "home")
    .in("locale", locales);
  if (error) throw new Error(`Failed to load the home page: ${error.message}`);

  const rows = data ?? [];
  const da = rows.find((row) => row.locale === "da");
  if (!da) throw new Error("Failed to load the home page: no Danish translation");
  const own = locale === "da" ? undefined : rows.find((row) => row.locale === locale);

  return resolveContent(toTranslation(da), own && toTranslation(own), locale);
}

function toTranslation(row: { title: string; lead: string; content: unknown }): HomePageTranslation {
  return { title: row.title, lead: row.lead, content: homeContentSchema.parse(row.content) };
}
