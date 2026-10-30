import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { routing } from "@/i18n/routing";

type HomeProps = Readonly<{ params: Promise<{ locale: string }> }>;

// Placeholder home: the real design-01 home page arrives with F0.5/F1.
// #main is the SkipLink target; tabIndex -1 lets the skip link move focus here.
export default async function Home({ params }: HomeProps) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "Metadata" });

  return (
    <main
      id="main"
      tabIndex={-1}
      className="mx-auto flex max-w-content flex-col gap-4 px-6 py-24 focus:outline-none"
    >
      <h1 className="text-h1 font-bold">{t("siteName")}</h1>
      <p className="text-muted">{t("description")}</p>
    </main>
  );
}
