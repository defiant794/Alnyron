import { getLocale, getTranslations } from "next-intl/server";
import NotFoundView from "@/components/site/NotFoundView";
import { getPathname } from "@/i18n/navigation";

/** Localized 404 for `notFound()` inside `[locale]`, rendered in the locale layout. */
export default async function LocaleNotFound() {
  const locale = await getLocale();
  const t = await getTranslations({ locale, namespace: "NotFound" });

  return (
    <NotFoundView
      title={t("title")}
      body={t("body")}
      homeLabel={t("home")}
      homeHref={getPathname({ href: "/", locale })}
    />
  );
}
