import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import HomeView from "@/components/site/HomeView";
import { routing } from "@/i18n/routing";
import { getPublicCategories } from "@/services/content/categories";
import { getHomePage } from "@/services/content/pages";
import { getSiteSettings } from "@/services/content/settings";

/** SSG + ISR (architecture §2): hourly self-healing refresh; publishing revalidates on demand. */
export const revalidate = 3600;

type HomeProps = Readonly<{ params: Promise<{ locale: string }> }>;

/** Home page (`/`, `/en`): DB content through the cookie-less public client, so it stays static. */
export default async function Home({ params }: HomeProps) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  const [home, publicCategories, settings] = await Promise.all([
    getHomePage(locale),
    getPublicCategories(locale),
    getSiteSettings(),
  ]);

  return (
    <HomeView
      locale={locale}
      title={home.value.title}
      lead={home.value.lead}
      content={home.value.content}
      fallbackKeys={home.fallbackKeys}
      publicCategories={publicCategories}
      contactEmail={settings.contactEmail}
    />
  );
}
