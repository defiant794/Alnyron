import { getTranslations } from "next-intl/server";
import NotFoundView from "@/components/site/NotFoundView";
import SkipLink from "@/components/ui/SkipLink";
import { routing } from "@/i18n/routing";
import { inter } from "@/styles/fonts";
import "@/styles/globals.css";

/**
 * 404 for paths no route matches. It renders outside `[locale]` under the
 * passthrough root layout, so it owns the document and uses the default
 * locale (Danish).
 */
export default async function RootNotFound() {
  const locale = routing.defaultLocale;
  const t = await getTranslations({ locale });

  return (
    <html lang={locale} className={inter.variable}>
      <body>
        <SkipLink label={t("SkipLink.label")} />
        <NotFoundView
          title={t("NotFound.title")}
          body={t("NotFound.body")}
          homeLabel={t("NotFound.home")}
          homeHref="/"
        />
      </body>
    </html>
  );
}
