import type { Metadata } from "next";
import type { Locale } from "next-intl";
import { NextIntlClientProvider } from "next-intl";
import { getTranslations } from "next-intl/server";
import { headers } from "next/headers";
import Logo from "@/components/brand/Logo";
import SiteFooter from "@/components/site/SiteFooter";
import NavigationFocusReset from "@/components/ui/NavigationFocusReset";
import SkipLink from "@/components/ui/SkipLink";
import { ORDER_ROBOTS } from "@/config/payments";
import { getPathname } from "@/i18n/navigation";
import { ORDER_LOCALE_HEADER, orderLocale } from "@/i18n/order-locale";
import { inter } from "@/styles/fonts";
import "@/styles/globals.css";

/** This request's `?lang=`, as the middleware passed it on (`ORDER_LOCALE_HEADER`); Danish without it. */
async function requestLocale(): Promise<Locale> {
  return orderLocale((await headers()).get(ORDER_LOCALE_HEADER));
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await requestLocale(), namespace: "Metadata" });
  return {
    title: { default: t("siteName"), template: `%s | ${t("siteName")}` },
    robots: ORDER_ROBOTS,
  };
}

/**
 * Document root for the goods order pages (`/order/thanks`, `/order/error`,
 * `/order/withdraw`; outside `[locale]`, rendered per request, never
 * indexed). The language is the page's `?lang=` (Danish by default), which
 * only the middleware can read for a layout: `<html lang>`, the skip link and
 * the footer follow it. A slim header holds only the site's ALNYRON lockup,
 * linked to the frontpage in that language (approved order-pages mock: no nav
 * and no language switcher, as the pages have no other-language twin to
 * switch to); the site footer gives the contact email, privacy and terms.
 * The skip link stays the first Tab stop after client-side navigations
 * (`NavigationFocusReset`, e.g. the withdrawal action's redirect).
 */
export default async function OrderLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const locale = await requestLocale();
  const t = await getTranslations({ locale, namespace: "SkipLink" });

  return (
    <html lang={locale} className={inter.variable}>
      <body className="flex min-h-dvh flex-col">
        <SkipLink label={t("label")} />
        <NavigationFocusReset />
        {/* The footer's links only need the locale; messages stay on the server. */}
        <NextIntlClientProvider locale={locale} messages={null}>
          <header className="border-b border-border bg-bg">
            <div className="mx-auto flex h-21 max-w-content items-center px-6">
              <Logo wordmark asLink href={getPathname({ href: "/", locale })} priority className="min-h-11" />
            </div>
          </header>
          <div className="flex flex-1 flex-col bg-surface pb-16">{children}</div>
          <SiteFooter locale={locale} />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
