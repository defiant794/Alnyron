import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import LanguageSwitcher from "@/components/site/LanguageSwitcher";
import SkipLink from "@/components/ui/SkipLink";
import { routing } from "@/i18n/routing";
import { inter } from "@/styles/fonts";
import "@/styles/globals.css";

type LocaleLayoutProps = Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}>;

/** Prerender every public locale at build time. */
export async function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: Pick<LocaleLayoutProps, "params">): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};

  const t = await getTranslations({ locale, namespace: "Metadata" });
  return {
    title: { default: t("siteName"), template: `%s | ${t("siteName")}` },
    description: t("description"),
  };
}

/**
 * Document root for the public site: `<html lang>` follows the route locale,
 * Inter is applied, and the skip link is the first focusable element.
 */
export default async function LocaleLayout({ children, params }: LocaleLayoutProps) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();

  // Static rendering: hand the locale to next-intl before any translation call.
  setRequestLocale(locale);
  const t = await getTranslations({ locale });

  return (
    <html lang={locale} className={inter.variable}>
      <body>
        <SkipLink label={t("SkipLink.label")} />
        {/* Client islands only need the locale; messages stay on the server. */}
        <NextIntlClientProvider messages={null}>
          <header className="border-b border-border">
            <div className="mx-auto flex max-w-content justify-end px-6 py-3">
              <LanguageSwitcher
                label={t("LanguageSwitcher.label")}
                localeNames={{ da: t("LanguageSwitcher.da"), en: t("LanguageSwitcher.en") }}
              />
            </div>
          </header>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
