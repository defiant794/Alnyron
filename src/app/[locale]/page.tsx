import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import HomeView from "@/components/site/HomeView";
import { SYSTEM_PAGE_PATHNAMES } from "@/config/system-pages";
import { languageAlternates } from "@/i18n/alternates";
import { pathsInEveryLocale } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { getPublicCategories } from "@/services/content/categories";
import { getHomePage, getPageMetadata } from "@/services/content/pages";
import { getSiteSettings } from "@/services/content/settings";

/**
 * SSG + ISR (architecture §2): ~5-minute time-based refresh, like the layout.
 * See the [locale] layout comment for the free-tier KV write-quota trade-off.
 */
export const revalidate = 300;

type HomeProps = Readonly<{ params: Promise<{ locale: string }> }>;

/**
 * SEO title/description from the home page row (Admin > Sider; blank keeps
 * the site defaults) and hreflang alternates.
 */
export async function generateMetadata({ params }: HomeProps): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const seo = await getPageMetadata("home", locale);
  const paths = pathsInEveryLocale(SYSTEM_PAGE_PATHNAMES.home);
  return {
    ...(seo.title && { title: seo.title }),
    ...(seo.description && { description: seo.description }),
    alternates: { canonical: paths[locale], languages: languageAlternates(paths) },
  };
}

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
