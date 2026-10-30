import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { routing } from "@/i18n/routing";

type ContactProps = Readonly<{ params: Promise<{ locale: string }> }>;

export async function generateMetadata({ params }: ContactProps): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: "Nav" });
  return { title: t("contact") };
}

// Placeholder contact page (`/kontakt`, `/en/contact`): the real page with
// the contact form arrives with F1.
export default async function Contact({ params }: ContactProps) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "Nav" });

  return (
    <main id="main" tabIndex={-1} className="mx-auto max-w-content px-6 py-24 focus:outline-none">
      <h1 className="text-h1 font-bold">{t("contact")}</h1>
    </main>
  );
}
