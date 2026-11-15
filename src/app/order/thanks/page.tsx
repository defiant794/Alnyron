import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import OrderPage from "@/components/order/OrderPage";
import LinkButton from "@/components/ui/LinkButton";
import { GOODS_TEXTS } from "@/config/legal/goods-texts";
import { getPathname } from "@/i18n/navigation";
import { orderLocale } from "@/i18n/order-locale";

type ThanksPageProps = Readonly<{ searchParams: Promise<{ lang?: string | string[] }> }>;

export async function generateMetadata({ searchParams }: ThanksPageProps): Promise<Metadata> {
  const t = await getTranslations({ locale: orderLocale((await searchParams).lang), namespace: "Order.thanks" });
  return { title: t("metaTitle") };
}

/**
 * `/order/thanks?lang=`: Stripe Checkout's success URL for a goods purchase
 * (approved order-pages mock, amendment A2-1). It shows no order data (the
 * URL carries none): thanks, that the amount is reserved and charged only
 * when the goods are sent, that the order confirmation (also the invoice)
 * comes by email, the dispatch time, and a link to the frontpage. The
 * reservation and dispatch sentences are the versioned legal texts.
 */
export default async function ThanksPage({ searchParams }: ThanksPageProps) {
  const locale = orderLocale((await searchParams).lang);
  const t = await getTranslations({ locale, namespace: "Order" });
  const { confirmationEmail } = GOODS_TEXTS[locale];

  return (
    <OrderPage tone="success" title={t("thanks.title")}>
      <div className="flex flex-col gap-3">
        <p>{confirmationEmail.payment}</p>
        <p>{t("thanks.confirmation")}</p>
        <p>{confirmationEmail.dispatch}</p>
      </div>
      <LinkButton href={getPathname({ href: "/", locale })} className="self-start">
        {t("home")}
      </LinkButton>
    </OrderPage>
  );
}
