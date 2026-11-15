import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import OrderPage from "@/components/order/OrderPage";
import LinkButton from "@/components/ui/LinkButton";
import { ORDER_ERROR_REASONS, type OrderErrorReason } from "@/config/payments";
import { getPathname } from "@/i18n/navigation";
import { orderLocale } from "@/i18n/order-locale";

type ErrorPageProps = Readonly<{ searchParams: Promise<{ lang?: string | string[]; reason?: string | string[] }> }>;

/** The message key of each `?reason=`; `unavailable` (and anything unknown) gets the generic message. */
const MESSAGES = {
  busy: "error.busy",
  not_purchasable: "error.notPurchasable",
  unavailable: "error.generic",
} as const satisfies Record<OrderErrorReason, string>;

export async function generateMetadata({ searchParams }: ErrorPageProps): Promise<Metadata> {
  const t = await getTranslations({ locale: orderLocale((await searchParams).lang), namespace: "Order.error" });
  return { title: t("metaTitle") };
}

/**
 * `/order/error?lang=&reason=`: where the Buy route sends the buyer when no
 * Checkout could be started (approved order-pages mock). Nothing was charged.
 * The message follows `reason` (over the rate limit, item not for sale);
 * any other or no reason, `unavailable` included, shows the generic message.
 * Only the whitelisted reason keys are read: nothing from the URL is shown.
 * A link leads to the frontpage.
 */
export default async function ErrorPage({ searchParams }: ErrorPageProps) {
  const { lang, reason } = await searchParams;
  const locale = orderLocale(lang);
  const t = await getTranslations({ locale, namespace: "Order" });
  const known = ORDER_ERROR_REASONS.find((candidate) => candidate === reason);

  return (
    <OrderPage tone="error" title={t("error.title")}>
      <p>{t(known === undefined ? "error.generic" : MESSAGES[known])}</p>
      <LinkButton href={getPathname({ href: "/", locale })} className="self-start">
        {t("home")}
      </LinkButton>
    </OrderPage>
  );
}
