import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getTranslations } from "next-intl/server";
import NavigationFocusReset from "@/components/ui/NavigationFocusReset";
import SkipLink from "@/components/ui/SkipLink";
import { MONITOR_ROBOTS } from "@/config/monitor";
import { loadMessages } from "@/i18n/messages";
import { getMonitorLocale } from "@/i18n/monitor-locale";
import { inter } from "@/styles/fonts";
import "@/styles/globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getMonitorLocale(), namespace: "Monitor" });
  return {
    title: { default: t("metaTitle"), template: `%s | ${t("metaTitle")}` },
    robots: MONITOR_ROBOTS,
  };
}

/**
 * Document root for Monitor (outside `[locale]`, never indexed): the public
 * landing page, the auth card pages and the signed-in panel, each bringing
 * its own frame (`MonitorAuthFrame`, `MonitorShell`). The language is the
 * visitor's Monitor choice (`getMonitorLocale()`, Danish until switched), so
 * `<html lang>`, the skip link and the client copy follow it. The skip link
 * stays the first Tab stop after client-side navigations too
 * (`NavigationFocusReset`). Client islands get only the messages they
 * render: the error boundary's copy.
 */
export default async function MonitorRootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const locale = await getMonitorLocale();
  const t = await getTranslations({ locale, namespace: "SkipLink" });
  const { Auth } = loadMessages(locale);

  return (
    <html lang={locale} className={inter.variable}>
      <body className="min-h-dvh bg-bg">
        <SkipLink label={t("label")} />
        <NavigationFocusReset />
        <NextIntlClientProvider locale={locale} messages={{ Auth: { error: Auth.error } }}>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
