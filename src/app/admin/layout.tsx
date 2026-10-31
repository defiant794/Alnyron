import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getTranslations } from "next-intl/server";
import SkipLink from "@/components/ui/SkipLink";
import { ADMIN_LOCALE } from "@/config/admin";
import { loadMessages } from "@/i18n/messages";
import { inter } from "@/styles/fonts";
import "@/styles/globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: ADMIN_LOCALE, namespace: "Admin" });
  return {
    title: { default: t("metaTitle"), template: `%s | ${t("metaTitle")}` },
    // Also sent as an `X-Robots-Tag` header for /admin/* and /auth/* (next.config.ts).
    robots: { index: false, follow: false },
  };
}

/**
 * Document root for the admin (outside `[locale]`, Danish only, never
 * indexed). Client islands get only the messages they render: the error
 * boundary's copy.
 */
export default async function AdminRootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const t = await getTranslations({ locale: ADMIN_LOCALE, namespace: "SkipLink" });
  const { Admin } = loadMessages(ADMIN_LOCALE);

  return (
    <html lang={ADMIN_LOCALE} className={inter.variable}>
      <body className="min-h-dvh bg-surface">
        <SkipLink label={t("label")} />
        <NextIntlClientProvider locale={ADMIN_LOCALE} messages={{ Admin: { error: Admin.error } }}>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
