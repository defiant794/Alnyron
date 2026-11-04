"use client";

import type { Locale } from "next-intl";
import { useId, useState, useTransition, type FormEvent } from "react";
import LocaleTabs, { localePanelId, localeTabId } from "@/components/admin/LocaleTabs";
import Button from "@/components/ui/Button";
import Field from "@/components/ui/Field";
import Notice from "@/components/ui/Notice";
import { SWITCH_CLASS } from "@/components/ui/switch-styles";
import TextAreaField from "@/components/ui/TextAreaField";
import { PAGE_TEXT_LIMITS } from "@/config/system-pages";
import { useFormResultFocus } from "@/hooks/use-form-result-focus";
import { routing } from "@/i18n/routing";
import type { AdminPageDetail, PageActionError, PageActionResult } from "@/services/admin/pages";

/** One editable `content` leaf. */
export type ContentField = {
  /** Dotted path inside `content` (`"whatWeDo.eyebrow"`). */
  path: string;
  label: string;
  hint?: string;
  multiline: boolean;
};

/** Content fields shown together; a group with a legend is a fieldset. */
export type ContentFieldGroup = { legend?: string; fields: ContentField[] };

export type PageEditorProps = {
  page: AdminPageDetail;
  /** The `savePage` Server Action. */
  save: (input: unknown) => Promise<PageActionResult>;
  /** Whether the page's markdown body is shown on the site (privacy). */
  hasBody: boolean;
  contentGroups: ContentFieldGroup[];
  labels: {
    languages: string;
    locales: Record<Locale, string>;
    title: string;
    lead: string;
    leadHint: string;
    body: string;
    bodyHint: string;
    seo: string;
    seoTitle: string;
    seoTitleHint: string;
    seoDescription: string;
    seoDescriptionHint: string;
    showInNav: string;
    showInNavHint: string;
    save: string;
    saved: string;
    errors: Record<PageActionError, string>;
  };
};

type Tree = { [key: string]: string | Tree };

/**
 * "Rediger side" form (approved admin mock): Dansk / Engelsk tabs with
 * Titel, Lead, the page's content fields (and Indhold for a page with a
 * markdown body) and a collapsible SEO section per language; "Vis i menuen";
 * Gem.
 *
 * Both languages' fields stay in the form (the inactive tab is only hidden),
 * and every save sends the complete text of both, because `admin_save_page`
 * replaces each language's `content` as a whole. Fields the page does not
 * show (a body on pages without one) are sent back unchanged.
 *
 * Validation is the server's: a blank Danish title switches to the Dansk tab
 * and marks the field; other failures show an alert; success shows "Gemt".
 * The result takes the focus (`useFormResultFocus`), and editing again
 * clears it.
 */
export default function PageEditor({ page, save, hasBody, contentGroups, labels }: PageEditorProps) {
  const [locale, setLocale] = useState<Locale>(routing.defaultLocale);
  const [result, setResult] = useState<PageActionResult | null>(null);
  const [pending, startTransition] = useTransition();
  const formRef = useFormResultFocus(result);
  const baseId = useId();
  const hintId = `${baseId}-show-in-nav-hint`;
  const failure = result && !result.ok ? result.error : null;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const text = (name: string, fallback: string) => {
      const value = form.get(name);
      return typeof value === "string" ? value : fallback;
    };
    const translation = (target: Locale) => {
      const initial = page.translations[target];
      const content: Tree = {};
      for (const { fields } of contentGroups) {
        for (const { path } of fields) {
          setPath(content, path, text(`${target}.content.${path}`, initial.content[path] ?? ""));
        }
      }
      return {
        title: text(`${target}.title`, initial.title),
        lead: text(`${target}.lead`, initial.lead),
        body_md: text(`${target}.body_md`, initial.body_md),
        seo_title: text(`${target}.seo_title`, initial.seo_title),
        seo_description: text(`${target}.seo_description`, initial.seo_description),
        content,
      };
    };
    const input = {
      id: page.id,
      system_key: page.systemKey,
      show_in_nav: form.get("show_in_nav") === "on",
      translations: { da: translation("da"), en: translation("en") },
    };

    startTransition(async () => {
      const saved = await save(input);
      // Committed with the refreshed page, so "Gemt" never shows beside a busy button.
      startTransition(() => {
        if (!saved.ok && saved.error === "da-title-required") setLocale("da");
        setResult(saved);
      });
    });
  }

  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={handleSubmit}
      onChange={() => {
        if (result) setResult(null);
      }}
      className="flex flex-col gap-6"
    >
      {failure && failure !== "da-title-required" && (
        <Notice tone="error" role="alert" tabIndex={-1} data-form-result>
          {labels.errors[failure]}
        </Notice>
      )}

      <LocaleTabs
        baseId={baseId}
        label={labels.languages}
        names={labels.locales}
        selected={locale}
        onSelect={setLocale}
      />

      {routing.locales.map((panelLocale) => {
        const values = page.translations[panelLocale];
        const name = (field: string) => `${panelLocale}.${field}`;
        return (
          <div
            key={panelLocale}
            role="tabpanel"
            id={localePanelId(baseId, panelLocale)}
            aria-labelledby={localeTabId(baseId, panelLocale)}
            hidden={panelLocale !== locale}
            className="flex flex-col gap-6"
          >
            <Field
              label={labels.title}
              name={name("title")}
              defaultValue={values.title}
              maxLength={PAGE_TEXT_LIMITS.title}
              required={panelLocale === "da"}
              autoComplete="off"
              error={panelLocale === "da" && failure === "da-title-required" ? labels.errors[failure] : undefined}
            />
            <TextAreaField
              label={labels.lead}
              hint={labels.leadHint}
              name={name("lead")}
              defaultValue={values.lead}
              maxLength={PAGE_TEXT_LIMITS.lead}
              rows={3}
            />
            {hasBody && (
              <TextAreaField
                label={labels.body}
                hint={labels.bodyHint}
                name={name("body_md")}
                defaultValue={values.body_md}
                maxLength={PAGE_TEXT_LIMITS.body_md}
                rows={16}
              />
            )}
            {contentGroups.map((group, index) => {
              const fields = group.fields.map((field) => {
                const props = {
                  label: field.label,
                  hint: field.hint,
                  name: name(`content.${field.path}`),
                  defaultValue: values.content[field.path] ?? "",
                };
                return field.multiline ? (
                  <TextAreaField key={field.path} {...props} rows={3} />
                ) : (
                  <Field key={field.path} {...props} autoComplete="off" />
                );
              });
              return group.legend ? (
                <fieldset key={group.legend} className="flex flex-col gap-4">
                  <legend className="mb-4 text-h3 font-semibold">{group.legend}</legend>
                  {fields}
                </fieldset>
              ) : (
                <div key={index} className="flex flex-col gap-6">
                  {fields}
                </div>
              );
            })}
            <details className="group border-t border-border pt-2">
              <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 font-semibold [&::-webkit-details-marker]:hidden">
                <span
                  aria-hidden="true"
                  className="text-muted transition-transform group-open:rotate-90 motion-reduce:transition-none"
                >
                  ›
                </span>
                {labels.seo}
              </summary>
              <div className="flex flex-col gap-6 pt-4">
                <Field
                  label={labels.seoTitle}
                  hint={labels.seoTitleHint}
                  name={name("seo_title")}
                  defaultValue={values.seo_title}
                  maxLength={PAGE_TEXT_LIMITS.seo_title}
                  autoComplete="off"
                />
                <TextAreaField
                  label={labels.seoDescription}
                  hint={labels.seoDescriptionHint}
                  name={name("seo_description")}
                  defaultValue={values.seo_description}
                  maxLength={PAGE_TEXT_LIMITS.seo_description}
                  rows={2}
                />
              </div>
            </details>
          </div>
        );
      })}

      <div className="flex flex-col gap-1 border-t border-border pt-6">
        <label className="flex min-h-11 cursor-pointer items-center justify-between gap-4">
          <span className="font-semibold">{labels.showInNav}</span>
          <input
            type="checkbox"
            name="show_in_nav"
            defaultChecked={page.showInNav}
            aria-describedby={hintId}
            className={SWITCH_CLASS}
          />
        </label>
        <p id={hintId} className="text-small text-muted">
          {labels.showInNavHint}
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-4">
        {result?.ok && (
          <Notice tone="success" role="status" tabIndex={-1} data-form-result>
            {labels.saved}
          </Notice>
        )}
        <Button type="submit" loading={pending}>
          {labels.save}
        </Button>
      </div>
    </form>
  );
}

/** Sets the string at a dotted `path` in `tree`, creating the blocks on the way. */
function setPath(tree: Tree, path: string, value: string): void {
  const keys = path.split(".");
  const last = keys.pop();
  if (last === undefined) return;
  let node = tree;
  for (const key of keys) {
    const child = node[key];
    if (typeof child === "object") {
      node = child;
    } else {
      const block: Tree = {};
      node[key] = block;
      node = block;
    }
  }
  node[last] = value;
}
