import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import SiteFooter from "@/components/site/SiteFooter";
import SiteHeader from "@/components/site/SiteHeader";
import SkipLink from "@/components/ui/SkipLink";
import { parseSiteEnv } from "@/config/env";
import { routing } from "@/i18n/routing";
import { inter } from "@/styles/fonts";
import "@/styles/globals.css";

/**
 * Header nav and footer come from the DB, so every public page under this
 * layout uses time-based ISR and refreshes within ~5 minutes of a change. This
 * works with KV alone; on the Cloudflare Worker that window is the only
 * refresh, because on-demand (publish) revalidation is a no-op there without a
 * tag cache.
 *
 * TRADE-OFF on Cloudflare's free KV tier: the 1,000 writes/day quota is
 * ACCOUNT-WIDE, shared by every page and Next data-cache key, not per page.
 * Sustained or crawler traffic that hits many keys in every window can exhaust
 * it, after which regenerated pages cannot be stored and stale pages persist
 * until the daily reset. Acceptable for this low-traffic site; the
 * write-efficient, instant fix is a tag cache (cache-infra plan / F2.0).
 */
export const revalidate = 300;

/**
 * Every public page is prerendered and served from the ISR cache (AC-HOME-12):
 * a request-time API (`headers()`, `cookies()`, `searchParams`, ...) anywhere
 * under this layout fails `next build` instead of silently turning the route
 * into a per-request render. A child segment's own `dynamic` or `revalidate`
 * export can still override this, so the build's route table (●, not ƒ) is
 * the proof.
 */
export const dynamic = "error";

type LocaleLayoutProps = Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}>;

/** Prerender every public locale at build time. */
export async function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

/**
 * Site name/description defaults, and `metadataBase` (`NEXT_PUBLIC_SITE_URL`)
 * so pages can give site-relative canonical and hreflang alternates.
 */
export async function generateMetadata({
  params,
}: Pick<LocaleLayoutProps, "params">): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};

  const t = await getTranslations({ locale, namespace: "Metadata" });
  return {
    metadataBase: new URL(parseSiteEnv().NEXT_PUBLIC_SITE_URL),
    title: { default: t("siteName"), template: `%s | ${t("siteName")}` },
    description: t("description"),
  };
}

/**
 * Document root for the public site: `<html lang>` follows the route locale,
 * Inter is applied, the skip link is the first focusable element, and the
 * DB-driven header and footer frame every page.
 */
export default async function LocaleLayout({ children, params }: LocaleLayoutProps) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();

  // Static rendering: hand the locale to next-intl before any translation call.
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "SkipLink" });

  return (
    <html lang={locale} className={inter.variable}>
      <body className="flex min-h-dvh flex-col">
        <SkipLink label={t("label")} />
        {/* Client islands only need the locale; messages stay on the server. */}
        <NextIntlClientProvider messages={null}>
          <SiteHeader locale={locale} />
          <div className="flex flex-1 flex-col pb-16">{children}</div>
          <SiteFooter locale={locale} />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
