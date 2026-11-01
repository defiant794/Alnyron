import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getTranslations } from "next-intl/server";
import MyLifeFrame from "@/components/mylife/MyLifeFrame";
import NavigationFocusReset from "@/components/ui/NavigationFocusReset";
import SkipLink from "@/components/ui/SkipLink";
import { AUTH_LOCALE } from "@/config/auth-areas";
import { loadMessages } from "@/i18n/messages";
import { inter } from "@/styles/fonts";
import "@/styles/globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: AUTH_LOCALE, namespace: "MyLife" });
  return {
    title: { default: t("name"), template: `%s | ${t("name")}` },
    // Also sent as an `X-Robots-Tag` header for /mylife/* and every path on
    // the MyLife host (next.config.ts).
    robots: { index: false, follow: false },
  };
}

/**
 * Document root for MyLife (outside `[locale]`, Danish only, never indexed),
 * served at `/mylife/*` and, through the middleware rewrite, at the root of
 * the MyLife host. Every screen sits in the MyLife card frame after the skip
 * link, which stays the first Tab stop after client-side navigations too
 * (`NavigationFocusReset`). Client islands get only the messages they
 * render: the error boundary's copy.
 */
export default async function MyLifeRootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const t = await getTranslations({ locale: AUTH_LOCALE, namespace: "SkipLink" });
  const { Auth } = loadMessages(AUTH_LOCALE);

  return (
    <html lang={AUTH_LOCALE} className={inter.variable}>
      <body className="min-h-dvh bg-surface">
        <SkipLink label={t("label")} />
        <NavigationFocusReset />
        <NextIntlClientProvider locale={AUTH_LOCALE} messages={{ Auth: { error: Auth.error } }}>
          <MyLifeFrame>{children}</MyLifeFrame>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
