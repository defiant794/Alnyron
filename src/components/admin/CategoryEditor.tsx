"use client";

import type { Locale } from "next-intl";
import { useId, useState, useTransition, type FormEvent } from "react";
import LocaleTabs, { localePanelId, localeTabId } from "@/components/admin/LocaleTabs";
import Button from "@/components/ui/Button";
import Field from "@/components/ui/Field";
import Notice from "@/components/ui/Notice";
import { SWITCH_CLASS } from "@/components/ui/switch-styles";
import TextAreaField from "@/components/ui/TextAreaField";
import { CATEGORY_TEXT_LIMITS } from "@/config/catalog";
import { useFormResultFocus } from "@/hooks/use-form-result-focus";
import { routing } from "@/i18n/routing";
import type { CatalogActionError, CatalogActionResult, CatalogSaveResult } from "@/services/admin/catalog";
import type { AdminCategoryTranslation, ContentStatus } from "@/services/admin/catalog-read";

/** Field labels of one language tab ("Titel (DA)"). */
export type CategoryFieldLabels = {
  title: string;
  description: string;
  slug: string;
  seoTitle: string;
  seoDescription: string;
};

export type CategoryEditorProps = {
  category: {
    id: string;
    status: ContentStatus;
    translations: Record<Locale, AdminCategoryTranslation>;
  };
  /** The `saveCategory` Server Action. */
  save: (input: unknown) => Promise<CatalogSaveResult>;
  /** The `setCategoryStatus` Server Action. */
  setStatus: (categoryId: string, status: ContentStatus) => Promise<CatalogActionResult>;
  labels: {
    languages: string;
    locales: Record<Locale, string>;
    fields: Record<Locale, CategoryFieldLabels>;
    slugHint: string;
    seoTitleHint: string;
    seoDescriptionHint: string;
    enHint: string;
    visible: string;
    visibleHint: string;
    cancel: string;
    save: string;
    saved: string;
    errors: Record<CatalogActionError, string>;
  };
};

type Result = { ok: true } | { ok: false; error: CatalogActionError };

/**
 * "Sektionstekst" form of the section editor (approved mock): Dansk /
 * Engelsk tabs with Titel, Beskrivelse, the read-only URL-slug and the SEO
 * texts; the "Synlig" switch; Annuller (back to the stored values) and Gem.
 *
 * Gem sends both languages' text (`saveCategory` keeps the routes: no slug
 * is sent, the four sections' addresses are fixed), then, if the switch
 * changed, the new status (`setCategoryStatus`). A blank Danish title
 * switches to the Dansk tab and marks the field; other failures show an
 * alert; success shows "Sektionen er gemt." The result takes the focus,
 * and editing again clears it.
 */
export default function CategoryEditor({ category, save, setStatus, labels }: CategoryEditorProps) {
  const [locale, setLocale] = useState<Locale>(routing.defaultLocale);
  const [result, setResult] = useState<Result | null>(null);
  const [pending, startTransition] = useTransition();
  const formRef = useFormResultFocus(result);
  const baseId = useId();
  const visibleHintId = `${baseId}-visible-hint`;
  const failure = result && !result.ok ? result.error : null;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const text = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" ? value : "";
    };
    const translation = (target: Locale) => ({
      title: text(`${target}.title`),
      description: text(`${target}.description`),
      seo_title: text(`${target}.seo_title`),
      seo_description: text(`${target}.seo_description`),
    });
    const status: ContentStatus = form.get("visible") === "on" ? "published" : "draft";

    startTransition(async () => {
      const saved = await save({ id: category.id, translations: { da: translation("da"), en: translation("en") } });
      const outcome: Result =
        saved.ok && status !== category.status ? await setStatus(category.id, status) : saved;
      // Committed with the refreshed page, so the notice never shows beside a busy button.
      startTransition(() => {
        if (!outcome.ok && outcome.error === "da-title-required") setLocale("da");
        setResult(outcome.ok ? { ok: true } : outcome);
      });
    });
  }

  function handleCancel() {
    formRef.current?.reset();
    setResult(null);
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

      <LocaleTabs baseId={baseId} label={labels.languages} names={labels.locales} selected={locale} onSelect={setLocale} />

      {routing.locales.map((panelLocale) => {
        const values = category.translations[panelLocale];
        const fieldLabels = labels.fields[panelLocale];
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
            {panelLocale !== routing.defaultLocale && <p className="text-small text-muted">{labels.enHint}</p>}
            <Field
              label={fieldLabels.title}
              name={name("title")}
              defaultValue={values.title}
              maxLength={CATEGORY_TEXT_LIMITS.title}
              required={panelLocale === "da"}
              autoComplete="off"
              error={panelLocale === "da" && failure === "da-title-required" ? labels.errors[failure] : undefined}
            />
            <TextAreaField
              label={fieldLabels.description}
              name={name("description")}
              defaultValue={values.description}
              maxLength={CATEGORY_TEXT_LIMITS.description}
              rows={4}
            />
            <Field
              label={fieldLabels.slug}
              hint={labels.slugHint}
              name={name("slug")}
              defaultValue={values.slug ?? ""}
              readOnly
              className="read-only:border-border read-only:bg-surface read-only:text-muted"
            />
            <Field
              label={fieldLabels.seoTitle}
              hint={labels.seoTitleHint}
              name={name("seo_title")}
              defaultValue={values.seo_title}
              maxLength={CATEGORY_TEXT_LIMITS.seo_title}
              autoComplete="off"
            />
            <TextAreaField
              label={fieldLabels.seoDescription}
              hint={labels.seoDescriptionHint}
              name={name("seo_description")}
              defaultValue={values.seo_description}
              maxLength={CATEGORY_TEXT_LIMITS.seo_description}
              rows={2}
            />
          </div>
        );
      })}

      <div className="flex flex-col gap-1 border-t border-border pt-6">
        <label className="flex min-h-11 cursor-pointer items-center justify-between gap-4">
          <span className="font-semibold">{labels.visible}</span>
          <input
            type="checkbox"
            name="visible"
            defaultChecked={category.status === "published"}
            aria-describedby={visibleHintId}
            className={SWITCH_CLASS}
          />
        </label>
        <p id={visibleHintId} className="text-small text-muted">
          {labels.visibleHint}
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-4">
        {result?.ok && (
          <Notice tone="success" role="status" tabIndex={-1} data-form-result>
            {labels.saved}
          </Notice>
        )}
        <Button variant="secondary" disabled={pending} onClick={handleCancel}>
          {labels.cancel}
        </Button>
        <Button type="submit" loading={pending}>
          {labels.save}
        </Button>
      </div>
    </form>
  );
}
