import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { MARKDOWN_BODY_CLASSES } from "@/components/site/markdown-body";
import { WITHDRAWAL_TEXTS, WITHDRAWAL_TEXT_VERSION, fillTemplate } from "@/config/legal/withdrawal-texts";
import { SYSTEM_PAGE_PATHNAMES } from "@/config/system-pages";
import { languageAlternates } from "@/i18n/alternates";
import { getPathname, pathsInEveryLocale } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { sanitizeMarkdown } from "@/lib/sanitize-markdown";
import { getPageMetadata, getTermsPage } from "@/services/content/pages";

type TermsProps = Readonly<{ params: Promise<{ locale: string }> }>;

/** SEO title/description (DB, falling back to the nav label) and hreflang alternates. */
export async function generateMetadata({ params }: TermsProps): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const [seo, t] = await Promise.all([
    getPageMetadata("terms", locale),
    getTranslations({ locale, namespace: "Nav" }),
  ]);
  const paths = pathsInEveryLocale(SYSTEM_PAGE_PATHNAMES.terms);
  return {
    title: seo.title || t("terms"),
    ...(seo.description && { description: seo.description }),
    alternates: { canonical: paths[locale], languages: languageAlternates(paths) },
  };
}

/**
 * Terms and conditions (`/terms`, `/en/terms`; handelsbetingelser): the
 * Stripe Dashboard's Terms of Service URL, linked from Checkout's consent
 * checkbox and the billing fine print. Eyebrow, title and lead come from the
 * terms system page in the DB (Admin › Sider), with Danish filling blank
 * English fields (marked `lang="da"`). The terms themselves are the versioned
 * legal module, rendered in full: sections 1 to 6, the withdrawal notice,
 * where to withdraw online and the model withdrawal form (under section 6),
 * sections 7 to 11 and the text version. Markdown goes through
 * `sanitizeMarkdown` (no raw HTML, safe links only).
 */
export default async function Terms({ params }: TermsProps) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  const page = await getTermsPage(locale);
  const { title, lead, content } = page.value;
  const langOf = (key: string) => (page.fallbackKeys.includes(key) ? "da" : undefined);
  const texts = WITHDRAWAL_TEXTS[locale];
  const privacyPath = getPathname({ href: SYSTEM_PAGE_PATHNAMES.privacy, locale });

  return (
    // Inherited overflow-wrap: a word wider than its line (the h1 "Handelsbetingelser" at 320px)
    // breaks inside the word, never widens the page (WCAG 1.4.10 Reflow).
    <main
      id="main"
      tabIndex={-1}
      className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-16 wrap-break-word focus:outline-none md:py-24"
    >
      <header className="flex flex-col gap-4">
        {content.eyebrow.trim() !== "" && (
          <p
            lang={langOf("content.eyebrow")}
            className="text-small font-semibold tracking-widest text-accent uppercase"
          >
            {content.eyebrow}
          </p>
        )}
        <h1 lang={langOf("title")} className="text-h1 font-bold tracking-tight">
          {title}
        </h1>
        {lead.trim() !== "" && (
          <p lang={langOf("lead")} className="text-h3 text-muted">
            {lead}
          </p>
        )}
      </header>
      {/* Each block is its own markdown-styled column; the notice and model form sit under section 6. */}
      <div className="flex flex-col gap-4">
        <div
          className={MARKDOWN_BODY_CLASSES}
          dangerouslySetInnerHTML={{
            __html: sanitizeMarkdown(texts.terms.sectionsBeforeWithdrawal, { breaks: true }),
          }}
        />
        <section aria-labelledby="terms-notice" className={MARKDOWN_BODY_CLASSES}>
          <h3 id="terms-notice">{texts.notice.title}</h3>
          {texts.notice.paragraphs.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
          <p>{texts.onlineWithdrawal}</p>
        </section>
        <section aria-labelledby="terms-model-form" className={MARKDOWN_BODY_CLASSES}>
          <h3 id="terms-model-form">{texts.modelForm.title}</h3>
          <p>{texts.modelForm.intro}</p>
          <ul>
            {texts.modelForm.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
        <div
          className={MARKDOWN_BODY_CLASSES}
          dangerouslySetInnerHTML={{
            __html: sanitizeMarkdown(fillTemplate(texts.terms.sectionsAfterWithdrawal, { privacyPath })),
          }}
        />
        <p className="text-small text-muted">
          {fillTemplate(texts.terms.versionLine, { version: WITHDRAWAL_TEXT_VERSION })}
        </p>
      </div>
    </main>
  );
}
