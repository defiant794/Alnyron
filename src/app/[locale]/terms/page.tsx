import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { MARKDOWN_BODY_CLASSES } from "@/components/site/markdown-body";
import LinkButton from "@/components/ui/LinkButton";
import { GOODS_TEXTS, GOODS_TEXT_VERSION } from "@/config/legal/goods-texts";
import { WITHDRAWAL_TEXTS, WITHDRAWAL_TEXT_VERSION, fillTemplate } from "@/config/legal/withdrawal-texts";
import { ORDER_WITHDRAW_PATH } from "@/config/payments";
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
 * checkbox, the billing fine print and the item pages' purchase block.
 * Eyebrow, title and lead come from the terms system page in the DB
 * (Admin › Sider), with Danish filling blank English fields (marked
 * `lang="da"`). The terms themselves are the versioned legal modules,
 * rendered in full. First the Monitor subscription: sections 1 to 6, the
 * withdrawal notice, where to withdraw online and the model withdrawal form
 * (under section 6), sections 7 to 11 and the text version. Then the
 * purchase of goods (3D figures, `GOODS_TEXTS`): its sections, the goods
 * withdrawal notice, the return address and instructions, the model
 * withdrawal form, the link to the online withdrawal function
 * (`/order/withdraw?lang=`, "Fortryd køb af varer") and its text version.
 * Markdown goes through `sanitizeMarkdown` (no raw HTML, safe links only).
 */
export default async function Terms({ params }: TermsProps) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  const [page, t] = await Promise.all([getTermsPage(locale), getTranslations({ locale, namespace: "Order.terms" })]);
  const { title, lead, content } = page.value;
  const langOf = (key: string) => (page.fallbackKeys.includes(key) ? "da" : undefined);
  const texts = WITHDRAWAL_TEXTS[locale];
  const goods = GOODS_TEXTS[locale];
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
        <section aria-label={t("subscriptionModelFormLabel")} className={MARKDOWN_BODY_CLASSES}>
          <h3>{texts.modelForm.title}</h3>
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
      {/* The purchase of goods, after the whole subscription part; its notice, address and form follow its sections. */}
      <div className="flex flex-col gap-4 border-t border-border pt-8">
        <div
          className={MARKDOWN_BODY_CLASSES}
          dangerouslySetInnerHTML={{ __html: sanitizeMarkdown(goods.terms.goodsSections, { breaks: true }) }}
        />
        <section aria-labelledby="terms-goods-notice" className={MARKDOWN_BODY_CLASSES}>
          <h3 id="terms-goods-notice">{t("noticeHeading")}</h3>
          {goods.notice.paragraphs.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </section>
        <section aria-labelledby="terms-goods-return" className={MARKDOWN_BODY_CLASSES}>
          <h3 id="terms-goods-return">{t("returnHeading")}</h3>
          <p>{goods.returnAddress}</p>
          <p>{goods.returnInstructions}</p>
        </section>
        <section aria-label={t("goodsModelFormLabel")} className={MARKDOWN_BODY_CLASSES}>
          <h3>{goods.modelForm.title}</h3>
          <p>{goods.modelForm.intro}</p>
          <ul>
            {goods.modelForm.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
        <LinkButton href={`${ORDER_WITHDRAW_PATH}?${new URLSearchParams({ lang: locale })}`} className="self-start">
          {t("withdrawLink")}
        </LinkButton>
        <p className="text-small text-muted">
          {fillTemplate(texts.terms.versionLine, { version: GOODS_TEXT_VERSION })}
        </p>
      </div>
    </main>
  );
}
