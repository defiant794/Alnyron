import { createTranslator, type Locale } from "next-intl";
import NextLink from "next/link";
import { Fragment, useId, type ReactNode } from "react";
import Card from "@/components/ui/Card";
import Link from "@/components/ui/Link";
import LinkButton from "@/components/ui/LinkButton";
import { loadMessages } from "@/i18n/messages";
import { getPathname } from "@/i18n/navigation";
import type { CatalogKind, PublicCategory } from "@/services/content/categories";
import type { HomeContent } from "@/services/content/pages";

export interface HomeViewProps {
  locale: Locale;
  title: string;
  lead: string;
  content: HomeContent;
  /** Dotted paths rendered from Danish (`"title"`, `"content.whatWeDo.eyebrow"`): get `lang="da"`. */
  fallbackKeys: string[];
  /** Categories visible to the public, in nav order. */
  publicCategories: PublicCategory[];
  /** `site_settings.contact_email`, linked wherever the content says `{email}`. */
  contactEmail: string;
}

/** Decorative card glyph per catalog kind (approved home mock). */
const KIND_GLYPH: Record<CatalogKind, string> = {
  apps: "A",
  websites: "W",
  services: "S",
  models3d: "3D",
};

const EMAIL_TOKEN = "{email}";

/**
 * Home page body (approved home mock): hero, "Hvad vi laver" with one card
 * per public category, and the contact band. DB copy comes in resolved;
 * buttons use UI messages.
 *
 * - "Hvad vi laver" renders only when a category is public (Q-8): an empty
 *   catalog never shows an empty section.
 * - "Se ydelser" renders only when the services category is public.
 * - Text shown from Danish on another locale carries `lang="da"` (WCAG 3.1.2).
 * - Blank DB fields are left out rather than rendered as empty elements.
 */
export default function HomeView({
  locale,
  title,
  lead,
  content,
  fallbackKeys,
  publicCategories,
  contactEmail,
}: HomeViewProps) {
  const t = createTranslator({ locale, messages: loadMessages(locale), namespace: "Home" });
  const whatWeDoId = useId();
  const ctaBandId = useId();
  const langOf = (key: string) => (fallbackKeys.includes(key) ? "da" : undefined);
  const contactHref = getPathname({ href: "/contact", locale });
  const services = publicCategories.find((category) => category.kind === "services");
  const { whatWeDo, ctaBand } = content;

  return (
    <main id="main" tabIndex={-1} className="focus:outline-none">
      {/* Full section rhythm below the hero: it also separates the hero from the contact band when no category is public. */}
      <section className="mx-auto grid max-w-content items-center gap-12 px-6 py-16 md:grid-cols-12 md:py-24">
        <div className="flex flex-col gap-8 md:col-span-7">
          <div className="flex flex-col gap-6">
            <h1 lang={langOf("title")} className="text-h1 font-bold tracking-tight md:text-display">
              {title}
            </h1>
            {hasText(lead) && (
              <p lang={langOf("lead")} className="max-w-xl text-h3 text-muted">
                {lead}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-3">
            <LinkButton href={contactHref}>{t("contactCta")}</LinkButton>
            {services && (
              <LinkButton href={services.href} variant="secondary">
                {t("servicesCta")}
              </LinkButton>
            )}
          </div>
        </div>
        <div
          aria-hidden="true"
          className="relative hidden h-80 overflow-hidden rounded-card border border-border bg-linear-135 from-accent/15 to-accent/5 md:col-span-5 md:block"
        >
          <div className="absolute -right-10 -bottom-16 size-80 rounded-full bg-radial-[at_32%_32%] from-accent/20 to-transparent to-70%" />
        </div>
      </section>

      {publicCategories.length > 0 && (
        <section
          aria-labelledby={hasText(whatWeDo.title) ? whatWeDoId : undefined}
          className="mx-auto flex max-w-content flex-col gap-8 px-6 pb-16 md:pb-24"
        >
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              {hasText(whatWeDo.eyebrow) && (
                <p
                  lang={langOf("content.whatWeDo.eyebrow")}
                  className="text-small font-semibold tracking-widest text-accent uppercase"
                >
                  {whatWeDo.eyebrow}
                </p>
              )}
              {hasText(whatWeDo.title) && (
                <h2 id={whatWeDoId} lang={langOf("content.whatWeDo.title")} className="text-h2 font-bold">
                  {whatWeDo.title}
                </h2>
              )}
            </div>
            {hasText(whatWeDo.intro) && (
              <p lang={langOf("content.whatWeDo.intro")} className="max-w-prose text-muted">
                {whatWeDo.intro}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-6">
            <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {publicCategories.map((category) => (
                <li key={category.id}>
                  <CategoryCard category={category} />
                </li>
              ))}
            </ul>
            {hasText(whatWeDo.note) && (
              <p lang={langOf("content.whatWeDo.note")} className="max-w-prose text-small text-muted">
                {whatWeDo.note}
              </p>
            )}
          </div>
        </section>
      )}

      <section
        aria-labelledby={hasText(ctaBand.title) ? ctaBandId : undefined}
        className="border-y border-border bg-surface"
      >
        <div className="mx-auto flex max-w-content flex-col items-start gap-6 px-6 py-12 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-col gap-2">
            {hasText(ctaBand.title) && (
              <h2 id={ctaBandId} lang={langOf("content.ctaBand.title")} className="text-h2 font-bold">
                {ctaBand.title}
              </h2>
            )}
            {hasText(ctaBand.text) && (
              <p lang={langOf("content.ctaBand.text")} className="max-w-prose text-muted">
                {withEmailLinks(ctaBand.text, contactEmail)}
              </p>
            )}
          </div>
          <LinkButton href={contactHref} className="shrink-0">
            {t("ctaBandButton")}
          </LinkButton>
        </div>
      </section>
    </main>
  );
}

/**
 * One public category: glyph, title linked to the category page (the link
 * covers the whole card) and the short description.
 */
function CategoryCard({ category }: { category: PublicCategory }) {
  const langOf = (key: string) => (category.fallbackKeys.includes(key) ? "da" : undefined);

  return (
    <Card interactive className="flex h-full flex-col gap-4">
      <span
        aria-hidden="true"
        className="flex size-10 items-center justify-center rounded-btn bg-surface font-bold text-accent"
      >
        {KIND_GLYPH[category.kind]}
      </span>
      <div className="flex flex-col gap-2">
        <h3 className="text-h3 font-semibold">
          <NextLink
            href={category.href}
            lang={langOf("title")}
            className="after:absolute after:inset-0 after:rounded-card focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-focus"
          >
            {category.title}
          </NextLink>
        </h3>
        {hasText(category.description) && (
          <p lang={langOf("description")} className="text-small text-muted">
            {category.description}
          </p>
        )}
      </div>
    </Card>
  );
}

/** `text` with each `{email}` replaced by a mailto link to `email`. */
function withEmailLinks(text: string, email: string): ReactNode {
  return text.split(EMAIL_TOKEN).map((part, index) => (
    <Fragment key={index}>
      {index > 0 && <Link href={`mailto:${email}`}>{email}</Link>}
      {part}
    </Fragment>
  ));
}

function hasText(value: string): boolean {
  return value.trim() !== "";
}
