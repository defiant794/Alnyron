import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getTranslations } from "next-intl/server";
import NavigationFocusReset from "@/components/ui/NavigationFocusReset";
import SkipLink from "@/components/ui/SkipLink";
import { AUTH_LOCALE } from "@/config/auth-areas";
import { MONITOR_ROBOTS } from "@/config/monitor";
import { loadMessages } from "@/i18n/messages";
import { inter } from "@/styles/fonts";
import "@/styles/globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: AUTH_LOCALE, namespace: "Monitor" });
  return {
    title: { default: t("metaTitle"), template: `%s | ${t("metaTitle")}` },
    robots: MONITOR_ROBOTS,
  };
}

/**
 * Document root for Monitor (outside `[locale]`, Danish only, never
 * indexed): the public landing page, the auth card pages and the signed-in
 * panel, each bringing its own frame (`MonitorAuthFrame`, `MonitorShell`).
 * The skip link stays the first Tab stop after client-side navigations too
 * (`NavigationFocusReset`). Client islands get only the messages they
 * render: the error boundary's copy.
 */
export default async function MonitorRootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const t = await getTranslations({ locale: AUTH_LOCALE, namespace: "SkipLink" });
  const { Auth } = loadMessages(AUTH_LOCALE);

  return (
    <html lang={AUTH_LOCALE} className={inter.variable}>
      <body className="min-h-dvh bg-bg">
        <SkipLink label={t("label")} />
        <NavigationFocusReset />
        <NextIntlClientProvider locale={AUTH_LOCALE} messages={{ Auth: { error: Auth.error } }}>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
