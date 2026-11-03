import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { MARKDOWN_BODY_CLASSES } from "@/components/site/markdown-body";
import { routing } from "@/i18n/routing";
import { sanitizeMarkdown } from "@/lib/sanitize-markdown";
import { getPageMetadata, getPrivacyPage } from "@/services/content/pages";

type PrivacyProps = Readonly<{ params: Promise<{ locale: string }> }>;

export async function generateMetadata({ params }: PrivacyProps): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const [seo, t] = await Promise.all([
    getPageMetadata("privacy", locale),
    getTranslations({ locale, namespace: "Nav" }),
  ]);
  return { title: seo.title || t("privacy"), ...(seo.description && { description: seo.description }) };
}

/**
 * Privacy policy (`/privatliv`, `/en/privacy`; approved privacy mock):
 * eyebrow, title, optional lead and the policy text. All copy comes from the
 * privacy system page in the DB (edited under Admin > Sider), with Danish
 * filling blank English fields (marked `lang="da"`). The body is markdown,
 * rendered by `sanitizeMarkdown`, which never emits raw HTML, event handlers
 * or script URLs.
 */
export default async function Privacy({ params }: PrivacyProps) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  const page = await getPrivacyPage(locale);
  const { title, lead, body_md: body, content } = page.value;
  const langOf = (key: string) => (page.fallbackKeys.includes(key) ? "da" : undefined);

  return (
    <main
      id="main"
      tabIndex={-1}
      className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-16 focus:outline-none md:py-24"
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
      {body.trim() !== "" && (
        <div
          lang={langOf("body_md")}
          className={MARKDOWN_BODY_CLASSES}
          dangerouslySetInnerHTML={{ __html: sanitizeMarkdown(body) }}
        />
      )}
    </main>
  );
}
