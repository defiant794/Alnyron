import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { signOut } from "@/app/mylife/(auth)/actions";
import SubmitButton from "@/components/ui/SubmitButton";
import { AUTH_LOCALE } from "@/config/auth-areas";
import { requireMyLife } from "@/services/auth/require-role";

/** "Kommer snart | MyLife": the layout's title template adds the area name. */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: AUTH_LOCALE, namespace: "MyLife.home" });
  return { title: t("metaTitle") };
}

/**
 * `/mylife` (`mylife.alnyron.dk/`): the signed-in landing until the MyLife
 * app itself is served here. Owner and `mylife_user` only.
 */
export default async function MyLifeHomePage() {
  const user = await requireMyLife();
  const t = await getTranslations({ locale: AUTH_LOCALE, namespace: "MyLife.home" });
  const tAuth = await getTranslations({ locale: AUTH_LOCALE, namespace: "Auth" });

  return (
    <>
      <header className="flex flex-col gap-2 text-center">
        <h1 className="text-h2 font-semibold">{t("title")}</h1>
        <p className="text-muted">{t("lead")}</p>
      </header>
      <p className="text-center">{t("signedInAs", { email: user.email })}</p>
      <form action={signOut}>
        <SubmitButton variant="secondary" className="w-full">
          {tAuth("signOut")}
        </SubmitButton>
      </form>
    </>
  );
}
