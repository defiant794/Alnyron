import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
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
 * Markdown body styles (no typography plugin): DESIGN.md heading sizes and
 * link treatment for the elements `sanitizeMarkdown` can emit.
 */
const BODY_CLASSES = [
  "flex flex-col gap-4",
  "[&_h1]:mt-8 [&_h1]:text-h2 [&_h1]:font-bold",
  "[&_h2]:mt-8 [&_h2]:text-h3 [&_h2]:font-bold",
  "[&_h3]:mt-4 [&_h3]:font-semibold",
  "[&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_li+li]:mt-1",
  "[&_blockquote]:border-l [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:text-muted",
  "[&_code]:rounded-input [&_code]:bg-surface [&_code]:px-1",
  "[&_pre]:overflow-x-auto [&_pre]:rounded-input [&_pre]:bg-surface [&_pre]:p-4",
  "[&_a]:text-accent [&_a]:underline [&_a]:decoration-accent/40 [&_a]:underline-offset-4 [&_a]:transition-[text-decoration-color] [&_a:focus-visible]:decoration-current [&_a:hover]:decoration-current",
].join(" ");

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
          className={BODY_CLASSES}
          dangerouslySetInnerHTML={{ __html: sanitizeMarkdown(body) }}
        />
      )}
    </main>
  );
}
