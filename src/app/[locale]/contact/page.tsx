import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { SYSTEM_PAGE_PATHNAMES } from "@/config/system-pages";
import { languageAlternates } from "@/i18n/alternates";
import { pathsInEveryLocale } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { getContactPage, getPageMetadata } from "@/services/content/pages";

type ContactProps = Readonly<{ params: Promise<{ locale: string }> }>;

/** SEO title/description (DB, falling back to the nav label) and hreflang alternates. */
export async function generateMetadata({ params }: ContactProps): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const [seo, t] = await Promise.all([
    getPageMetadata("contact", locale),
    getTranslations({ locale, namespace: "Nav" }),
  ]);
  const paths = pathsInEveryLocale(SYSTEM_PAGE_PATHNAMES.contact);
  return {
    title: seo.title || t("contact"),
    ...(seo.description && { description: seo.description }),
    alternates: { canonical: paths[locale], languages: languageAlternates(paths) },
  };
}

/**
 * Contact page (`/contact`, `/en/contact`; approved contact mock): eyebrow,
 * title and lead, then the response time and languages. All copy comes from
 * the contact system page in the DB (edited under Admin > Sider), with
 * Danish filling blank English fields (marked `lang="da"`). Blank fields are
 * left out.
 */
export default async function Contact({ params }: ContactProps) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  const [page, t] = await Promise.all([
    getContactPage(locale),
    getTranslations({ locale, namespace: "Contact" }),
  ]);
  const { title, lead, content } = page.value;
  const langOf = (key: string) => (page.fallbackKeys.includes(key) ? "da" : undefined);
  const details = [
    { key: "content.responseTime", label: t("responseTime"), value: content.responseTime },
    { key: "content.languages", label: t("languages"), value: content.languages },
  ].filter((detail) => detail.value.trim() !== "");

  return (
    <main
      id="main"
      tabIndex={-1}
      className="mx-auto flex w-full max-w-content flex-col gap-12 px-6 py-16 focus:outline-none md:py-24"
    >
      <header className="flex max-w-2xl flex-col gap-4">
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
          <p lang={langOf("lead")} className="max-w-prose text-h3 text-muted">
            {lead}
          </p>
        )}
      </header>
      {details.length > 0 && (
        <dl className="flex max-w-md flex-col border-t border-border">
          {details.map((detail) => (
            <div key={detail.key} className="flex flex-col gap-1 border-b border-border py-4">
              <dt className="text-small tracking-widest text-muted uppercase">{detail.label}</dt>
              <dd lang={langOf(detail.key)}>{detail.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </main>
  );
}
