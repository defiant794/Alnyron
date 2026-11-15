import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import OrderPage from "@/components/order/OrderPage";
import OrderWithdrawForm from "@/components/order/OrderWithdrawForm";
import LinkButton from "@/components/ui/LinkButton";
import Notice from "@/components/ui/Notice";
import { GOODS_TEXTS, GOODS_TEXT_VERSION } from "@/config/legal/goods-texts";
import { ORDER_ROBOTS, ORDER_WITHDRAW_PATH, ORDER_WITHDRAW_STATES } from "@/config/payments";
import { getPathname } from "@/i18n/navigation";
import { orderLocale } from "@/i18n/order-locale";
import { CONSUMER_NAME_MAX } from "@/lib/payments/withdrawal-contract";

type QueryValue = string | string[] | undefined;

type WithdrawPageProps = Readonly<{
  /**
   * `o` + `t`: the personal link's order id and token (from the order emails);
   * `lang`: da|en; `state`: the result of "Bekræft fortrydelse".
   */
  searchParams: Promise<{ o?: QueryValue; t?: QueryValue; lang?: QueryValue; state?: QueryValue }>;
}>;

/** A personal link's shape (`orderWithdrawUrl`): an order uuid and a base64url token. Only the Worker verifies it. */
const linkSchema = z.object({
  orderId: z.guid(),
  token: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
});

export async function generateMetadata({ searchParams }: WithdrawPageProps): Promise<Metadata> {
  const t = await getTranslations({ locale: orderLocale((await searchParams).lang), namespace: "Order.withdraw" });
  return { title: t("metaTitle"), robots: ORDER_ROBOTS };
}

/**
 * `/order/withdraw` (`?o=&t=&lang=`): the online withdrawal function for goods
 * (Art. 11a, "Fortryd aftale her"; approved order-withdraw mock), linked from
 * /terms and the order emails. No account and no database read: the payments
 * Worker identifies the order when the notice is sent.
 *
 * Without `state`: step 1 and 2 (`OrderWithdrawForm`). A personal link of a
 * valid shape asks only for the name; otherwise the order number and the
 * order's email too. Below: the return instructions (address, deadline,
 * return costs) and the full goods withdrawal notice behind a disclosure.
 *
 * With `state` (after "Bekræft fortrydelse"): `received` confirms the notice,
 * that the receipt goes to the order's email, and how to return the goods;
 * `refused` (one message for every identification failure), `busy` and
 * `unavailable` explain and offer to try again. Nothing in the URL but the
 * whitelisted state is shown. Never indexed.
 */
export default async function WithdrawPage({ searchParams }: WithdrawPageProps) {
  const query = await searchParams;
  const locale = orderLocale(query.lang);
  const t = await getTranslations({ locale, namespace: "Order" });
  const goods = GOODS_TEXTS[locale];
  const state = ORDER_WITHDRAW_STATES.find((candidate) => candidate === query.state);

  const returns = (
    <section aria-labelledby="withdraw-return" className="flex flex-col gap-2">
      <h2 id="withdraw-return" className="text-h3 font-semibold">
        {t("withdraw.returnHeading")}
      </h2>
      {state === "received" && <p>{t("withdraw.receivedNotShipped")}</p>}
      <p>{goods.returnInstructions}</p>
    </section>
  );

  if (state === "received") {
    return (
      <OrderPage tone="success" title={t("withdraw.receivedTitle")}>
        <p className="font-semibold">{t("withdraw.receivedReceipt")}</p>
        {returns}
        <LinkButton href={getPathname({ href: "/", locale })} className="self-start">
          {t("home")}
        </LinkButton>
      </OrderPage>
    );
  }

  if (state !== undefined) {
    return (
      <OrderPage title={t("withdraw.title")}>
        <Notice tone="error" role="alert">
          {t(`withdraw.${state}`)}
        </Notice>
        <LinkButton href={`${ORDER_WITHDRAW_PATH}?${new URLSearchParams({ lang: locale })}`} className="self-start">
          {t("withdraw.retry")}
        </LinkButton>
      </OrderPage>
    );
  }

  const parsedLink = linkSchema.safeParse({ orderId: query.o, token: query.t });
  const link = parsedLink.success ? parsedLink.data : null;
  return (
    <OrderPage title={t("withdraw.title")}>
      <p className="text-muted">{t(link === null ? "withdraw.leadForm" : "withdraw.leadLink")}</p>
      <OrderWithdrawForm
        locale={locale}
        link={link}
        statement={goods.statement}
        statementVersion={GOODS_TEXT_VERSION}
        nameMaxLength={CONSUMER_NAME_MAX}
        labels={{
          orderNumber: t("withdraw.orderNumber"),
          email: t("withdraw.email"),
          name: t("withdraw.name"),
          nameHint: t("withdraw.nameHint"),
          nameMissing: t("withdraw.nameMissing"),
          start: t("withdraw.start"),
          confirmTitle: t("withdraw.confirmTitle"),
          summaryName: t("withdraw.summaryName"),
          summaryOrderNumber: t("withdraw.summaryOrderNumber"),
          summaryEmail: t("withdraw.summaryEmail"),
          summaryOrder: t("withdraw.summaryOrder"),
          summaryOrderLink: t("withdraw.summaryOrderLink"),
          confirm: t("withdraw.confirm"),
          back: t("withdraw.back"),
          sending: t("withdraw.sending"),
        }}
      />
      {returns}
      <details className="flex flex-col gap-2">
        <summary className="inline-flex min-h-11 cursor-pointer items-center font-semibold text-accent">
          {t("withdraw.noticeToggle")}
        </summary>
        <div className="flex flex-col gap-2 text-small">
          <h2 className="text-body font-semibold">{goods.notice.title}</h2>
          {goods.notice.paragraphs.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </div>
      </details>
    </OrderPage>
  );
}
