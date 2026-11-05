"use client";

import type { Locale } from "next-intl";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition, type FormEvent } from "react";
import LocaleTabs, { localePanelId, localeTabId } from "@/components/admin/LocaleTabs";
import MediaManager, {
  type MediaAttachInput,
  type MediaManagerImage,
  type MediaManagerProps,
  type MediaUploadInput,
} from "@/components/admin/MediaManager";
import Button from "@/components/ui/Button";
import { cardClassName } from "@/components/ui/card-styles";
import Field from "@/components/ui/Field";
import FieldFrame from "@/components/ui/FieldFrame";
import LinkButton from "@/components/ui/LinkButton";
import Notice from "@/components/ui/Notice";
import { SWITCH_CLASS } from "@/components/ui/switch-styles";
import TextAreaField from "@/components/ui/TextAreaField";
import { adminItemPath } from "@/config/admin";
import {
  EXTERNAL_LINK_KEYS,
  EXTERNAL_LINK_MAX_LENGTH,
  ITEM_TEXT_LIMITS,
  SLUG_MAX_LENGTH,
  type ExternalLinkKey,
  type PriceType,
} from "@/config/catalog";
import { useFormResultFocus } from "@/hooks/use-form-result-focus";
import { routing } from "@/i18n/routing";
import { cx } from "@/lib/cx";
import { slugify } from "@/lib/slugify";
import type {
  CatalogActionError,
  CatalogActionResult,
  CatalogFailure,
  CatalogSaveResult,
} from "@/services/admin/catalog";
import type { AdminItemTranslation, ContentStatus } from "@/services/admin/catalog-read";
import type { MediaUploadResult } from "@/services/admin/media";

/** The item as the editor starts: a saved item (with `id`) or a new one. */
export type ItemEditorItem = {
  /** Absent for a new item. */
  id?: string;
  categoryId: string;
  status: ContentStatus;
  featured: boolean;
  priceType: PriceType | null;
  priceAmount: number | null;
  externalLinks: Partial<Record<ExternalLinkKey, string>>;
  translations: Record<Locale, AdminItemTranslation | null>;
  media: MediaManagerImage[];
};

/** Field labels of one language tab ("Titel (DA)"). */
export type ItemFieldLabels = {
  title: string;
  slug: string;
  summary: string;
  body: string;
  seoTitle: string;
  seoDescription: string;
};

type PriceChoice = PriceType | "none";

export type ItemEditorProps = {
  item: ItemEditorItem;
  /** Every section, for the section select (changing it on a saved item moves the item there). */
  sections: { id: string; title: string }[];
  /** The published item's public page (Danish); `null` while it is a draft. */
  previewHref: string | null;
  /** Where to go after a delete: the item's section editor (the new one once a move is saved). */
  sectionHref: string;
  save: (input: unknown) => Promise<CatalogSaveResult>;
  setStatus: (itemId: string, status: ContentStatus) => Promise<CatalogActionResult>;
  remove: (itemId: string) => Promise<CatalogActionResult>;
  createUpload: (input: MediaUploadInput) => Promise<MediaUploadResult>;
  attach: (input: MediaAttachInput) => Promise<CatalogSaveResult>;
  detach: (mediaId: string) => Promise<CatalogActionResult>;
  labels: {
    languages: string;
    locales: Record<Locale, string>;
    contentHeading: string;
    sideHeading: string;
    fields: Record<Locale, ItemFieldLabels>;
    slugHint: string;
    bodyHint: string;
    seoTitleHint: string;
    seoDescriptionHint: string;
    enHint: string;
    section: string;
    sectionHint: string;
    priceType: string;
    priceTypes: Record<PriceChoice, string>;
    amount: string;
    amountHint: string;
    links: string;
    linkKeys: Record<ExternalLinkKey, string>;
    featured: string;
    featuredHint: string;
    save: string;
    saveDraft: string;
    publish: string;
    publishHint: string;
    hide: string;
    preview: string;
    previewHint: string;
    newTab: string;
    delete: string;
    confirmDelete: string;
    saved: string;
    savedDraft: string;
    published: string;
    hidden: string;
    errors: Record<CatalogActionError, string>;
    /** MediaManager copy; `counts[n]` is the "n af 8" text. */
    media: Omit<MediaManagerProps["labels"], "countOf"> & { counts: string[] };
  };
};

type SuccessNotice = "saved" | "savedDraft" | "published" | "hidden";
type Result = { ok: true; notice: SuccessNotice } | CatalogFailure;

const PRICE_CHOICES: readonly PriceChoice[] = ["none", "fixed", "from", "contact"];

/** Errors shown at their field; every other one is a form-level alert. */
const FIELD_ERRORS: readonly CatalogActionError[] = ["da-title-required", "price-invalid", "links-invalid", "alt-required"];

/** Errors shown at the URL-slug of the language the server names (a form-level alert when it names none). */
const SLUG_ERRORS: readonly CatalogActionError[] = ["slug-taken", "slug-invalid"];

/**
 * Item editor (approved item-editor mock). Left: Indhold with Dansk /
 * Engelsk tabs (Titel, URL-slug, Resumé, Brødtekst, SEO). Right: the section,
 * Pristype (Ingen pris / Fast / Fra / Kontakt) with the DKK amount, the https
 * links and "Udvalgt". Below: Billeder (MediaManager) and the actions.
 *
 * Every save sends the selected section: a new item is created in it, and a
 * saved item moved to another section is placed last there (its public
 * address changes with the section; the hint says so). The refreshed page
 * then names the new section in the breadcrumb and as the delete target.
 *
 * A blank slug is formed from its title (prefilled when the title loses
 * focus, and again on save). A blank Danish title is reported here without
 * a request; the server validates everything else: the title, slug, amount,
 * links and alt-text errors show at their fields (a slug error under the
 * URL-slug of the language the server names, switching to its tab), the
 * rest as an alert.
 *
 * Actions: a new item has "Gem kladde" (then the editor of the saved item
 * opens) and a disabled "Udgiv" (save first). A draft has "Gem kladde" and
 * "Udgiv" (save, then publish), a published item "Gem" and "Skjul" (hide
 * at once, unsaved edits stay in the form); "Forhåndsvis" opens the
 * published page in a new tab; "Slet element" deletes after a confirm and
 * returns to the section.
 */
export default function ItemEditor({
  item,
  sections,
  previewHref,
  sectionHref,
  save,
  setStatus,
  remove,
  createUpload,
  attach,
  detach,
  labels,
}: ItemEditorProps) {
  const router = useRouter();
  const [locale, setLocale] = useState<Locale>(routing.defaultLocale);
  const [priceChoice, setPriceChoice] = useState<PriceChoice>(item.priceType ?? "none");
  const [result, setResult] = useState<Result | null>(null);
  const [pending, startTransition] = useTransition();
  const formRef = useFormResultFocus(result);
  const slugInputs = useRef(new Map<Locale, HTMLInputElement>());
  const baseId = useId();
  const featuredHintId = `${baseId}-featured-hint`;
  const publishHintId = `${baseId}-publish-hint`;
  const previewHintId = `${baseId}-preview-hint`;
  const contentHeadingId = `${baseId}-content`;
  const sideHeadingId = `${baseId}-side`;
  const failure = result && !result.ok ? result : null;
  const slugLocale = failure && SLUG_ERRORS.includes(failure.error) ? failure.locale : undefined;
  const formError = failure && !FIELD_ERRORS.includes(failure.error) && !slugLocale ? failure.error : null;
  const hasAmount = priceChoice === "fixed" || priceChoice === "from";
  const published = item.status === "published";

  /** Commits an outcome together with the refreshed page (no notice beside a busy button). */
  function finish(outcome: Result) {
    startTransition(() => {
      // The tab of the failed field opens, so the focus can move to it.
      if (!outcome.ok && outcome.error === "da-title-required") setLocale("da");
      else if (!outcome.ok && outcome.locale && SLUG_ERRORS.includes(outcome.error)) setLocale(outcome.locale);
      setResult(outcome);
    });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const publish = submitter?.getAttribute("value") === "publish";
    const form = new FormData(event.currentTarget);
    const text = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" ? value : "";
    };
    const translation = (target: Locale) => {
      const title = text(`${target}.title`);
      return {
        slug: text(`${target}.slug`).trim() || slugify(title),
        title,
        summary: text(`${target}.summary`),
        body_md: text(`${target}.body_md`),
        seo_title: text(`${target}.seo_title`),
        seo_description: text(`${target}.seo_description`),
      };
    };
    const da = translation("da");
    // Mirrors the schema's first check: an empty slug would otherwise be reported before the missing title.
    if (da.title.trim() === "") {
      finish({ ok: false, error: "da-title-required" });
      return;
    }
    const en = translation("en");
    const sendEn = item.translations.en !== null || Object.values(en).some((value) => value.trim() !== "");
    const amountText = text("price_amount").trim();
    const amount = hasAmount && amountText !== "" ? Number(amountText) : null;
    const externalLinks = Object.fromEntries(
      EXTERNAL_LINK_KEYS.map((key) => [key, text(`links.${key}`).trim()]).filter(([, url]) => url !== ""),
    );
    const media = form
      .getAll("media.order")
      .filter((id): id is string => typeof id === "string")
      .map((id, index) => ({
        id,
        alt_da: text(`media.${id}.alt_da`),
        alt_en: text(`media.${id}.alt_en`),
        sort_order: (index + 1) * 10,
      }));

    const input = {
      ...(item.id ? { id: item.id, media } : {}),
      category_id: text("category_id"),
      featured: form.get("featured") === "on",
      price_type: priceChoice === "none" ? null : priceChoice,
      price_amount: amount !== null && Number.isFinite(amount) ? amount : null,
      external_links: externalLinks,
      translations: sendEn ? { da, en } : { da },
    };

    startTransition(async () => {
      const saved = await save(input);
      if (!saved.ok) return finish(saved);
      if (!item.id) {
        router.replace(adminItemPath(saved.id));
        return;
      }
      if (!publish) return finish({ ok: true, notice: published ? "saved" : "savedDraft" });
      const outcome = await setStatus(saved.id, "published");
      finish(outcome.ok ? { ok: true, notice: "published" } : outcome);
    });
  }

  function handleHide() {
    const { id } = item;
    if (!id || pending) return;
    startTransition(async () => {
      const outcome = await setStatus(id, "draft");
      finish(outcome.ok ? { ok: true, notice: "hidden" } : outcome);
    });
  }

  function handleDelete() {
    const { id } = item;
    if (!id || pending || !window.confirm(labels.confirmDelete)) return;
    startTransition(async () => {
      const outcome = await remove(id);
      if (outcome.ok) router.replace(sectionHref);
      else finish(outcome);
    });
  }

  /** Prefills an empty slug from the title when the title loses focus. */
  function prefillSlug(target: Locale, title: string) {
    const input = slugInputs.current.get(target);
    if (input && input.value.trim() === "") input.value = slugify(title);
  }

  const mediaLabels: MediaManagerProps["labels"] = {
    ...labels.media,
    countOf: (count) => labels.media.counts[count] ?? String(count),
  };
  const card = cx(cardClassName("white", false), "flex flex-col gap-6 p-6");

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
      {formError && (
        <Notice tone="error" role="alert" tabIndex={-1} data-form-result>
          {labels.errors[formError]}
        </Notice>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-[3fr_2fr]">
        <section aria-labelledby={contentHeadingId} className={card}>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <h2 id={contentHeadingId} className="text-h3 font-semibold">
              {labels.contentHeading}
            </h2>
            <LocaleTabs
              baseId={baseId}
              label={labels.languages}
              names={labels.locales}
              selected={locale}
              onSelect={setLocale}
            />
          </div>

          {routing.locales.map((panelLocale) => {
            const values = item.translations[panelLocale];
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
                  defaultValue={values?.title ?? ""}
                  maxLength={ITEM_TEXT_LIMITS.title}
                  required={panelLocale === "da"}
                  autoComplete="off"
                  onBlur={(event) => prefillSlug(panelLocale, event.currentTarget.value)}
                  error={
                    panelLocale === "da" && failure?.error === "da-title-required"
                      ? labels.errors[failure.error]
                      : undefined
                  }
                />
                <Field
                  ref={(element) => {
                    if (element) slugInputs.current.set(panelLocale, element);
                    else slugInputs.current.delete(panelLocale);
                  }}
                  label={fieldLabels.slug}
                  hint={labels.slugHint}
                  name={name("slug")}
                  defaultValue={values?.slug ?? ""}
                  maxLength={SLUG_MAX_LENGTH}
                  autoComplete="off"
                  spellCheck={false}
                  error={failure && panelLocale === slugLocale ? labels.errors[failure.error] : undefined}
                />
                <TextAreaField
                  label={fieldLabels.summary}
                  name={name("summary")}
                  defaultValue={values?.summary ?? ""}
                  maxLength={ITEM_TEXT_LIMITS.summary}
                  rows={3}
                />
                <TextAreaField
                  label={fieldLabels.body}
                  hint={labels.bodyHint}
                  name={name("body_md")}
                  defaultValue={values?.body_md ?? ""}
                  maxLength={ITEM_TEXT_LIMITS.body_md}
                  rows={10}
                />
                <Field
                  label={fieldLabels.seoTitle}
                  hint={labels.seoTitleHint}
                  name={name("seo_title")}
                  defaultValue={values?.seo_title ?? ""}
                  maxLength={ITEM_TEXT_LIMITS.seo_title}
                  autoComplete="off"
                />
                <TextAreaField
                  label={fieldLabels.seoDescription}
                  hint={labels.seoDescriptionHint}
                  name={name("seo_description")}
                  defaultValue={values?.seo_description ?? ""}
                  maxLength={ITEM_TEXT_LIMITS.seo_description}
                  rows={2}
                />
              </div>
            );
          })}
        </section>

        <section aria-labelledby={sideHeadingId} className={card}>
          <h2 id={sideHeadingId} className="text-h3 font-semibold">
            {labels.sideHeading}
          </h2>

          <FieldFrame label={labels.section} hint={item.id ? labels.sectionHint : undefined}>
            {(control) => (
              <select
                {...control}
                name="category_id"
                defaultValue={item.categoryId}
                className={cx(control.className, "cursor-pointer")}
              >
                {sections.map((section) => (
                  <option key={section.id} value={section.id}>
                    {section.title}
                  </option>
                ))}
              </select>
            )}
          </FieldFrame>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-small font-semibold">{labels.priceType}</legend>
            <div className="grid grid-cols-2 gap-2">
              {PRICE_CHOICES.map((choice) => (
                <label
                  key={choice}
                  className="flex min-h-11 cursor-pointer items-center gap-2 rounded-input border border-border-input px-3 text-small transition-[background-color,border-color] hover:border-muted has-checked:border-accent has-checked:bg-accent/5 has-checked:font-semibold has-checked:text-accent-hover"
                >
                  <input
                    type="radio"
                    name="price_type"
                    value={choice}
                    checked={priceChoice === choice}
                    onChange={() => setPriceChoice(choice)}
                    className="size-4 shrink-0 cursor-pointer accent-accent"
                  />
                  {labels.priceTypes[choice]}
                </label>
              ))}
            </div>
          </fieldset>

          <Field
            label={labels.amount}
            hint={labels.amountHint}
            name="price_amount"
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            defaultValue={item.priceAmount ?? ""}
            disabled={!hasAmount}
            required={hasAmount}
            error={failure?.error === "price-invalid" ? labels.errors[failure.error] : undefined}
          />

          <fieldset className="flex flex-col gap-4">
            <legend className="mb-2 text-small font-semibold">{labels.links}</legend>
            {EXTERNAL_LINK_KEYS.map((key) => (
              <Field
                key={key}
                label={labels.linkKeys[key]}
                name={`links.${key}`}
                type="url"
                inputMode="url"
                placeholder="https://"
                defaultValue={item.externalLinks[key] ?? ""}
                maxLength={EXTERNAL_LINK_MAX_LENGTH}
                autoComplete="off"
                spellCheck={false}
              />
            ))}
            {failure?.error === "links-invalid" && (
              <p role="alert" tabIndex={-1} data-form-result className="text-small font-semibold text-error">
                {labels.errors[failure.error]}
              </p>
            )}
          </fieldset>

          <div className="flex flex-col gap-1 border-t border-border pt-6">
            <label className="flex min-h-11 cursor-pointer items-center justify-between gap-4">
              <span className="font-semibold">{labels.featured}</span>
              <input
                type="checkbox"
                name="featured"
                defaultChecked={item.featured}
                aria-describedby={featuredHintId}
                className={SWITCH_CLASS}
              />
            </label>
            <p id={featuredHintId} className="text-small text-muted">
              {labels.featuredHint}
            </p>
          </div>
        </section>
      </div>

      <div className={card}>
        <MediaManager
          itemId={item.id}
          images={item.media}
          onCreateUpload={createUpload}
          onAttach={attach}
          onDetach={detach}
          defaultAlt={item.translations.da?.title}
          showAltErrors={failure?.error === "alt-required"}
          labels={mediaLabels}
        />
        {failure?.error === "alt-required" && (
          <p role="alert" tabIndex={-1} data-form-result className="text-small font-semibold text-error">
            {labels.errors[failure.error]}
          </p>
        )}
      </div>

      <div className="flex flex-col-reverse gap-4 sm:flex-row sm:items-start">
        {item.id && (
          <Button variant="danger" disabled={pending} onClick={handleDelete}>
            {labels.delete}
          </Button>
        )}
        <div className="flex flex-col items-end gap-2 sm:ml-auto">
          <div className="flex flex-wrap items-center justify-end gap-3">
            {result?.ok && (
              <Notice tone="success" role="status" tabIndex={-1} data-form-result>
                {labels[result.notice]}
              </Notice>
            )}
            {item.id &&
              (previewHref ? (
                <LinkButton href={previewHref} target="_blank" variant="secondary">
                  {labels.preview}
                  <span className="sr-only"> {labels.newTab}</span>
                </LinkButton>
              ) : (
                <Button variant="secondary" disabled aria-describedby={previewHintId}>
                  {labels.preview}
                </Button>
              ))}
            {published ? (
              <>
                <Button variant="secondary" disabled={pending} onClick={handleHide}>
                  {labels.hide}
                </Button>
                <Button type="submit" value="save" loading={pending}>
                  {labels.save}
                </Button>
              </>
            ) : (
              <>
                <Button type="submit" variant="secondary" value="save" loading={pending}>
                  {labels.saveDraft}
                </Button>
                <Button
                  type="submit"
                  value="publish"
                  disabled={!item.id || pending}
                  aria-describedby={item.id ? undefined : publishHintId}
                >
                  {labels.publish}
                </Button>
              </>
            )}
          </div>
          {!item.id && (
            <p id={publishHintId} className="text-small text-muted">
              {labels.publishHint}
            </p>
          )}
          {item.id && !previewHref && (
            <p id={previewHintId} className="text-small text-muted">
              {labels.previewHint}
            </p>
          )}
        </div>
      </div>
    </form>
  );
}
