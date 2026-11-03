import { createTranslator, type Locale } from "next-intl";
import { useId } from "react";
import { cardClassName } from "@/components/ui/card-styles";
import Link from "@/components/ui/Link";
import LinkButton from "@/components/ui/LinkButton";
import { EXTERNAL_LINK_KEYS, KIND_GLYPH, type ExternalLinkKey } from "@/config/catalog";
import { loadMessages } from "@/i18n/messages";
import { getPathname } from "@/i18n/navigation";
import { cx } from "@/lib/cx";
import { sanitizeMarkdown } from "@/lib/sanitize-markdown";
import type { PublicCatalogItem, PublicCatalogSection } from "@/services/content/catalog";
import ItemGallery from "./ItemGallery";
import { MARKDOWN_BODY_CLASSES } from "./markdown-body";
import PriceText from "./PriceText";

export interface ItemDetailViewProps {
  locale: Locale;
  section: PublicCatalogSection;
  item: PublicCatalogItem;
}

/** Order of the link buttons; the first one present is the primary button (approved mock: demo, then website). */
const LINK_RANK: Record<ExternalLinkKey, number> = {
  demo: 0,
  website: 1,
  app_store: 2,
  google_play: 3,
  download: 4,
};

const LINK_KEYS = EXTERNAL_LINK_KEYS.toSorted((a, b) => LINK_RANK[a] - LINK_RANK[b]);

/**
 * Item page body (approved detail mock): breadcrumb back to the section,
 * gallery beside title, summary, price and link buttons, then the markdown
 * body and the contact call to action. Item text comes from the DB (Danish
 * fallback marked `lang="da"`, blank fields left out); the body is rendered
 * by `sanitizeMarkdown`, which never emits raw HTML or script URLs. Link
 * buttons open in the same tab.
 */
export default function ItemDetailView({ locale, section, item }: ItemDetailViewProps) {
  const t = createTranslator({ locale, messages: loadMessages(locale), namespace: "Catalog" });
  const ctaId = useId();
  const langOf = (key: string) => (item.fallbackKeys.includes(key) ? "da" : undefined);
  const links = LINK_KEYS.flatMap((key) => {
    const url = item.externalLinks[key];
    return url ? [{ key, url }] : [];
  });
  const imageCount = item.media.length;

  return (
    <main
      id="main"
      tabIndex={-1}
      className="mx-auto flex w-full max-w-content flex-col gap-12 px-6 pt-8 pb-16 focus:outline-none md:pb-24"
    >
      <div className="flex flex-col gap-6">
        <nav aria-label={t("breadcrumb")}>
          <ol className="flex flex-wrap items-center gap-x-2 text-small text-muted">
            <li className="flex items-center gap-2">
              <Link
                href={section.href}
                lang={section.fallbackKeys.includes("title") ? "da" : undefined}
                className="inline-flex min-h-11 items-center"
              >
                {section.title}
              </Link>
              <span aria-hidden="true">/</span>
            </li>
            <li>
              <span aria-current="page" lang={langOf("title")}>
                {item.title}
              </span>
            </li>
          </ol>
        </nav>
        <div className="grid items-start gap-12 md:grid-cols-2">
          <ItemGallery
            images={item.media}
            glyph={KIND_GLYPH[section.kind]}
            label={t("gallery.label")}
            thumbnailLabels={item.media.map((_, index) => t("gallery.show", { index: index + 1, count: imageCount }))}
          />
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-4">
              <h1 lang={langOf("title")} className="text-h1 font-bold tracking-tight">
                {item.title}
              </h1>
              {item.summary.trim() !== "" && (
                <p lang={langOf("summary")} className="max-w-prose text-h3 text-muted">
                  {item.summary}
                </p>
              )}
            </div>
            {item.price && <PriceText price={item.price} className="text-h3 font-bold" />}
            {links.length > 0 && (
              <ul aria-label={t("links.label")} className="flex flex-wrap gap-3">
                {links.map(({ key, url }, index) => (
                  <li key={key}>
                    <LinkButton href={url} variant={index === 0 ? "primary" : "secondary"}>
                      {t(`links.${key}`)}
                    </LinkButton>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      {item.bodyMd.trim() !== "" && (
        <div className="max-w-prose border-t border-border pt-8">
          <div
            lang={langOf("bodyMd")}
            className={MARKDOWN_BODY_CLASSES}
            dangerouslySetInnerHTML={{ __html: sanitizeMarkdown(item.bodyMd) }}
          />
        </div>
      )}

      <section
        aria-labelledby={ctaId}
        className={cx(
          cardClassName("surface", false),
          "flex flex-col items-start gap-6 p-6 md:flex-row md:items-center md:justify-between md:p-8",
        )}
      >
        <div className="flex flex-col gap-1">
          <h2 id={ctaId} className="text-h2 font-bold">
            {t("cta.title")}
          </h2>
          <p className="text-small text-muted">{t("cta.text")}</p>
        </div>
        <LinkButton href={getPathname({ href: "/contact", locale })} className="shrink-0">
          {t("cta.button")}
        </LinkButton>
      </section>
    </main>
  );
}
