import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { savePage } from "@/app/admin/(panel)/pages/actions";
import PageEditor, { type ContentField, type ContentFieldGroup } from "@/components/admin/PageEditor";
import PageHeader from "@/components/admin/PageHeader";
import Card from "@/components/ui/Card";
import Link from "@/components/ui/Link";
import LinkButton from "@/components/ui/LinkButton";
import { ADMIN_PAGES_PATH } from "@/config/admin";
import { AUTH_LOCALE } from "@/config/auth-areas";
import {
  MULTILINE_CONTENT_FIELDS,
  SYSTEM_PAGE_HAS_BODY,
  SYSTEM_PAGE_PATHNAMES,
  type ContentPageKey,
} from "@/config/system-pages";
import { loadMessages } from "@/i18n/messages";
import { getPathname } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { stringAt } from "@/lib/json-path";
import { contentFieldPaths } from "@/lib/validation/pages";
import { getSystemPageForEdit } from "@/services/admin/pages";
import { requireAdmin } from "@/services/auth/require-admin";

type EditPageProps = Readonly<{ params: Promise<{ id: string }> }>;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: AUTH_LOCALE, namespace: "Admin.pages.editor" });
  return { title: t("metaTitle") };
}

/**
 * `/admin/pages/[id]` ("Rediger side"): the editor for one system page, with
 * "Forhåndsvis" opening the published page (Danish) in a new tab. Ids that
 * name no system page, or an app area without content (Monitor), are a 404.
 */
export default async function EditPagePage({ params }: EditPageProps) {
  await requireAdmin();
  const { id } = await params;
  const page = await getSystemPageForEdit(id);
  if (!page) notFound();

  const [t, tNav] = await Promise.all([
    getTranslations({ locale: AUTH_LOCALE, namespace: "Admin.pages.editor" }),
    getTranslations({ locale: AUTH_LOCALE, namespace: "Nav" }),
  ]);
  const { errors } = loadMessages(AUTH_LOCALE).Admin.pages;
  const previewHref = getPathname({ href: SYSTEM_PAGE_PATHNAMES[page.systemKey], locale: routing.defaultLocale });

  return (
    <>
      <div className="flex max-w-3xl flex-col gap-2">
        <Link href={ADMIN_PAGES_PATH} className="inline-flex min-h-11 items-center gap-2 self-start">
          <span aria-hidden="true">←</span>
          {t("back")}
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <PageHeader title={t("title", { name: tNav(page.systemKey) })} description={t("lead")} />
          <LinkButton href={previewHref} target="_blank" variant="secondary">
            {t("preview")}
            <span className="sr-only"> {t("newTab")}</span>
          </LinkButton>
        </div>
      </div>
      <Card className="max-w-3xl">
        <PageEditor
          page={page}
          save={savePage}
          hasBody={SYSTEM_PAGE_HAS_BODY[page.systemKey]}
          contentGroups={contentGroups(page.systemKey)}
          labels={{
            languages: t("languages"),
            locales: { da: t("locales.da"), en: t("locales.en") },
            title: t("fields.title"),
            lead: t("fields.lead"),
            leadHint: t("fields.leadHint"),
            body: t("fields.body"),
            bodyHint: t("fields.bodyHint"),
            seo: t("fields.seo"),
            seoTitle: t("fields.seoTitle"),
            seoTitleHint: t("fields.seoTitleHint"),
            seoDescription: t("fields.seoDescription"),
            seoDescriptionHint: t("fields.seoDescriptionHint"),
            showInNav: t("fields.showInNav"),
            showInNavHint: t("fields.showInNavHint"),
            save: t("save"),
            saved: t("saved"),
            errors,
          }}
        />
      </Card>
    </>
  );
}

/**
 * The page's content fields in schema order (`contentFieldPaths`), labelled
 * from `Admin.pages.editor.content`; the fields of one block (`whatWeDo.*`)
 * form a group with the block's `legend`. Read as raw messages, since the
 * keys are paths: a hint may contain a literal `{email}`.
 *
 * @throws when a field has no label, so a schema change cannot ship an unlabelled input.
 */
function contentGroups(key: ContentPageKey): ContentFieldGroup[] {
  const { content, contentHints } = loadMessages(AUTH_LOCALE).Admin.pages.editor;
  const groups: ContentFieldGroup[] = [];
  for (const path of contentFieldPaths(key)) {
    const label = stringAt(content, `${key}.${path}`);
    if (!label) throw new Error(`Missing label Admin.pages.editor.content.${key}.${path}`);
    const field: ContentField = {
      path,
      label,
      hint: stringAt(contentHints, `${key}.${path}`),
      multiline: MULTILINE_CONTENT_FIELDS[path] === true,
    };
    const dot = path.lastIndexOf(".");
    const legend = dot === -1 ? undefined : stringAt(content, `${key}.${path.slice(0, dot)}.legend`);
    const last = groups.at(-1);
    if (last && last.legend === legend) last.fields.push(field);
    else groups.push({ legend, fields: [field] });
  }
  return groups;
}
