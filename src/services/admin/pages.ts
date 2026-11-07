import type { PostgrestError } from "@supabase/supabase-js";
import type { Locale } from "next-intl";
import type { ContentPageKey, SystemPageKey } from "@/config/system-pages";
import { stringAt } from "@/lib/json-path";
import { createServerClient } from "@/lib/supabase/server";
import {
  contentFieldPaths,
  DA_TITLE_REQUIRED,
  isContentPage,
  navOrderSchema,
  pageIdSchema,
  pageNavSchema,
  pageStatusSchema,
  savePageSchema,
} from "@/lib/validation/pages";
import type { Database } from "@/types/database";

export type PageStatus = Database["public"]["Enums"]["content_status"];

/**
 * Why a page mutation failed (the editor maps each to Danish copy):
 * - `invalid`: the input does not match the write schema, or its `system_key` is not the page's.
 * - `da-title-required`: blank Danish title (schema or the `page_translations_da_title` CHECK).
 * - `slug-taken`: 23505, the slug already names another route.
 * - `system-slug`: 23514 from `routes_guard`, system pages have fixed routes.
 * - `missing-slugs`: P0001, a custom page needs a DA and an EN slug before it is published.
 * - `system-always-published`: 23514 from `pages_system_guard`.
 * - `not-found`: P0002, an id that is not a page id at all (22P02), or a save to no system page.
 * - `forbidden`: 42501, the caller is not an admin (RLS / `is_admin()`).
 * - `failed`: anything else (logged).
 */
export type PageActionError =
  | "invalid"
  | "da-title-required"
  | "slug-taken"
  | "system-slug"
  | "missing-slugs"
  | "system-always-published"
  | "not-found"
  | "forbidden"
  | "failed";

export type PageActionResult = { ok: true } | { ok: false; error: PageActionError };

/** One row of the admin pages list. */
export interface AdminPageSummary {
  id: string;
  systemKey: SystemPageKey;
  status: PageStatus;
  showInNav: boolean;
  /** The Danish title (blank only if the Danish row is missing). */
  title: string;
}

/** One locale of a page as the editor shows it. */
export interface AdminPageTranslation {
  title: string;
  lead: string;
  body_md: string;
  seo_title: string;
  seo_description: string;
  /** Every content field of the page by dotted path; blank where the stored content has no text. */
  content: Record<string, string>;
}

/** A system page with editable content, loaded for the editor. */
export interface AdminPageDetail {
  id: string;
  systemKey: ContentPageKey;
  showInNav: boolean;
  translations: Record<Locale, AdminPageTranslation>;
}

type TranslationRow = Omit<AdminPageTranslation, "content"> & { locale: Locale; content: unknown };

/**
 * The system pages for the admin list: home first (the public nav always
 * pins it first), then in nav order. Reads under the admin's RLS rights,
 * which see every page.
 *
 * @throws when the query fails.
 */
export async function listSystemPages(): Promise<AdminPageSummary[]> {
  const supabase = await createServerClient();
  const { data, error } = await supabase
    .from("pages")
    .select("id, system_key, status, show_in_nav, page_translations(locale, title)")
    .not("system_key", "is", null)
    .order("nav_order")
    .order("created_at");
  if (error) throw new Error(`Failed to load the pages: ${error.message}`);

  const pages = (data ?? []).flatMap((page): AdminPageSummary[] =>
    page.system_key
      ? [
          {
            id: page.id,
            systemKey: page.system_key,
            status: page.status,
            showInNav: page.show_in_nav,
            title: page.page_translations.find((row) => row.locale === "da")?.title ?? "",
          },
        ]
      : [],
  );
  return [...pages.filter((page) => page.systemKey === "home"), ...pages.filter((page) => page.systemKey !== "home")];
}

/**
 * A system page with both locales for the editor, or `null` when `id` names
 * no system page (custom pages are not editable yet) or an app area (Monitor:
 * no editable content, only its nav flag in the list). A missing locale row
 * reads as blank fields.
 *
 * @throws when the query fails.
 */
export async function getSystemPageForEdit(id: string): Promise<AdminPageDetail | null> {
  if (!pageIdSchema.safeParse(id).success) return null;

  const supabase = await createServerClient();
  const { data, error } = await supabase
    .from("pages")
    .select(
      "id, system_key, show_in_nav, page_translations(locale, title, lead, body_md, content, seo_title, seo_description)",
    )
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Failed to load the page: ${error.message}`);
  if (!data?.system_key || !isContentPage(data.system_key)) return null;

  const paths = contentFieldPaths(data.system_key);
  const rows: TranslationRow[] = data.page_translations;
  const translation = (locale: Locale): AdminPageTranslation => {
    const row = rows.find((candidate) => candidate.locale === locale);
    return {
      title: row?.title ?? "",
      lead: row?.lead ?? "",
      body_md: row?.body_md ?? "",
      seo_title: row?.seo_title ?? "",
      seo_description: row?.seo_description ?? "",
      content: Object.fromEntries(paths.map((path) => [path, stringAt(row?.content, path) ?? ""])),
    };
  };

  return {
    id: data.id,
    systemKey: data.system_key,
    showInNav: data.show_in_nav,
    translations: { da: translation("da"), en: translation("en") },
  };
}

/**
 * Saves a system page's flags and both translations through
 * `admin_save_page`. `input` is untrusted (a Server Action argument): it must
 * match {@link savePageSchema}, so the full `content` of each locale is
 * always sent and the RPC's wholesale replace never wipes a block. The
 * `system_key` that picked the content schema must be the stored page's own
 * (immutable, `pages_system_guard`), so one page's content shape is never
 * written over another's: a mismatch is `invalid`, an unknown or custom page
 * `not-found`. Only the keys the RPC reads are passed on.
 */
export async function saveSystemPage(input: unknown): Promise<PageActionResult> {
  const parsed = savePageSchema.safeParse(input);
  if (!parsed.success) {
    const daTitleMissing = parsed.error.issues.some((issue) => issue.message === DA_TITLE_REQUIRED);
    return { ok: false, error: daTitleMissing ? "da-title-required" : "invalid" };
  }

  const { id, system_key, show_in_nav, translations } = parsed.data;
  const supabase = await createServerClient();
  const stored = await supabase.from("pages").select("system_key").eq("id", id).maybeSingle();
  if (stored.error) return failure("pages lookup", stored.error);
  if (!stored.data?.system_key) return { ok: false, error: "not-found" };
  if (stored.data.system_key !== system_key) return { ok: false, error: "invalid" };

  const { error } = await supabase.rpc("admin_save_page", { payload: { id, show_in_nav, translations } });
  return error ? failure("admin_save_page", error) : { ok: true };
}

/** Publishes or unpublishes a page through `admin_set_page_status`. */
export async function savePageStatus(pageId: unknown, status: unknown): Promise<PageActionResult> {
  const parsed = pageStatusSchema.safeParse({ pageId, status });
  if (!parsed.success) return { ok: false, error: "invalid" };

  const supabase = await createServerClient();
  const { error } = await supabase.rpc("admin_set_page_status", {
    p_page_id: parsed.data.pageId,
    p_status: parsed.data.status,
  });
  return error ? failure("admin_set_page_status", error) : { ok: true };
}

/** Stores a new nav order through `admin_reorder_nav` (first id = first place). */
export async function saveNavOrder(pageIds: unknown): Promise<PageActionResult> {
  const parsed = navOrderSchema.safeParse(pageIds);
  if (!parsed.success) return { ok: false, error: "invalid" };

  const supabase = await createServerClient();
  const { error } = await supabase.rpc("admin_reorder_nav", { p_page_ids: parsed.data });
  return error ? failure("admin_reorder_nav", error) : { ok: true };
}

/** Shows (`show = true`) or hides a page in the public nav through `admin_set_page_nav`. */
export async function savePageNav(pageId: unknown, show: unknown): Promise<PageActionResult> {
  const parsed = pageNavSchema.safeParse({ pageId, show });
  if (!parsed.success) return { ok: false, error: "invalid" };

  const supabase = await createServerClient();
  const { error } = await supabase.rpc("admin_set_page_nav", {
    p_page_id: parsed.data.pageId,
    p_show: parsed.data.show,
  });
  return error ? failure("admin_set_page_nav", error) : { ok: true };
}

/**
 * Maps a page query or RPC error to a {@link PageActionError}. 23514 has
 * several sources, told apart by the message (constraint name or trigger text).
 */
function failure(operation: string, error: Pick<PostgrestError, "code" | "message">): PageActionResult {
  const reason = pageActionError(error);
  if (reason === "failed") console.error(`${operation} failed: ${error.code || "unknown"}`);
  return { ok: false, error: reason };
}

function pageActionError({ code, message }: Pick<PostgrestError, "code" | "message">): PageActionError {
  switch (code) {
    case "23505":
      return "slug-taken";
    case "23514":
      if (message.includes("page_translations_da_title")) return "da-title-required";
      if (message.includes("system pages have fixed routes")) return "system-slug";
      if (message.includes("system pages are always published")) return "system-always-published";
      return "invalid";
    case "P0001":
      return message === "missing_slugs" ? "missing-slugs" : "failed";
    case "P0002":
    case "22P02":
      return "not-found";
    case "42501":
      return "forbidden";
    default:
      return "failed";
  }
}
