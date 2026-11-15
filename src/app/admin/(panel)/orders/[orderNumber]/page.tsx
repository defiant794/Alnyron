import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import AdminBreadcrumb from "@/components/admin/AdminBreadcrumb";
import OrderRefundForm from "@/components/admin/OrderRefundForm";
import OrderShipForm from "@/components/admin/OrderShipForm";
import OrderTimeline from "@/components/admin/OrderTimeline";
import { ORDER_STATUS_TONES } from "@/components/admin/OrdersTable";
import Badge from "@/components/ui/Badge";
import { cardClassName } from "@/components/ui/card-styles";
import Notice from "@/components/ui/Notice";
import { ADMIN_ORDERS_PATH } from "@/config/admin";
import { AUTH_LOCALE } from "@/config/auth-areas";
import { ORDER_CAPTURE_WARNING_HOURS } from "@/config/payments";
import { loadMessages } from "@/i18n/messages";
import { cx } from "@/lib/cx";
import { formatDateTime } from "@/lib/monitor/format";
import { formatKronerWithOre } from "@/lib/payments/money";
import { getOrderByNumber } from "@/services/admin/orders";
import { requireAdmin } from "@/services/auth/require-admin";

type AdminOrderDetailPageProps = Readonly<{ params: Promise<{ orderNumber: string }> }>;

/** An order number in the URL: a positive whole number without sign, decimals or exponent. */
const ORDER_NUMBER = /^[1-9]\d{0,15}$/;

/** Country names for the delivery address ("DK" → "Danmark"). */
const REGION_NAMES = new Intl.DisplayNames([AUTH_LOCALE], { type: "region" });

const CARD = cx(cardClassName("white", false), "flex flex-col gap-4 p-6");

export async function generateMetadata({ params }: AdminOrderDetailPageProps): Promise<Metadata> {
  const t = await getTranslations({ locale: AUTH_LOCALE, namespace: "Admin.orders.detail" });
  const { orderNumber } = await params;
  return { title: ORDER_NUMBER.test(orderNumber) ? t("title", { number: orderNumber }) : t("metaTitle") };
}

/**
 * `/admin/orders/[orderNumber]` ("Ordre #1001", approved order-detail mock,
 * amendment A1): the buyer and delivery address, the lines with moms, total
 * and refunded amount, the Stripe ids, any anomaly, the timeline (payment
 * reserved, confirmation sent, captured, shipped with tracking, withdrawal
 * with its deadline and lateness, refunded or released, canceled), how long
 * the payment stays reserved (a warning in its last
 * {@link ORDER_CAPTURE_WARNING_HOURS} hours), and the owner's two actions:
 * "Markér afsendt og træk betalingen" for a reserved order without a
 * withdrawal, and the withdrawal's approval while one waits; a reserved or
 * shipped order without a withdrawal offers the same approval as "Registrér
 * fortrydelse", for a notice that came by email or letter (the approval
 * records it, channel `admin`). Read with the admin's own session; a number
 * that is not a positive whole number, or names no order, is a 404.
 */
export default async function AdminOrderDetailPage({ params }: AdminOrderDetailPageProps) {
  await requireAdmin();
  const { orderNumber } = await params;
  if (!ORDER_NUMBER.test(orderNumber)) notFound();
  const order = await getOrderByNumber(Number(orderNumber));
  if (!order) notFound();
  const t = await getTranslations({ locale: AUTH_LOCALE, namespace: "Admin.orders" });
  const { ship, refund, errors, anomaly: anomalyMessages } = loadMessages(AUTH_LOCALE).Admin.orders.detail;

  const kroner = (amountOre: number) => t("amount", { amount: formatKronerWithOre(amountOre, AUTH_LOCALE) });
  const missing = t("detail.buyer.missing");
  const address = order.shippingAddress;
  const country = address?.country ?? null;
  const addressLines = [
    order.shippingName,
    address?.line1,
    address?.line2,
    [address?.postal_code, address?.city].filter(Boolean).join(" "),
    country && /^[A-Z]{2}$/.test(country) ? REGION_NAMES.of(country) : country,
  ].filter((line): line is string => typeof line === "string" && line.trim() !== "");
  const withdrawalBadge =
    order.withdrawal && order.withdrawal.status !== "completed" ? t(`withdrawal.${order.withdrawal.status}`) : null;
  // One reading of the clock for the page: how long the card authorization still holds.
  const reservedUntil =
    order.status === "authorized" && order.capturedAt === null ? order.authorizationExpiresAt : null;
  const msLeft = reservedUntil === null ? null : Date.parse(reservedUntil) - Date.now();
  // A notice by email or letter: an open order without a withdrawal, which the approval creates.
  const offlineNotice = order.withdrawal === null && (order.status === "authorized" || order.status === "shipped");

  return (
    <>
      <div className="flex flex-col gap-2">
        <AdminBreadcrumb
          label={t("detail.breadcrumb")}
          items={[{ label: t("title"), href: ADMIN_ORDERS_PATH }, { label: `#${order.orderNumber}` }]}
        />
        <header className="flex flex-wrap items-center gap-3">
          {/* A string: ICU would group a number's digits ("1.001"). */}
          <h1 className="text-h1 font-semibold break-words">{t("detail.title", { number: String(order.orderNumber) })}</h1>
          <Badge tone={ORDER_STATUS_TONES[order.status]}>{t(`status.${order.status}`)}</Badge>
          {withdrawalBadge && <Badge tone="error">{withdrawalBadge}</Badge>}
        </header>
        {reservedUntil !== null && msLeft !== null && msLeft > 0 && (
          <p>{t("detail.reservation.until", { date: formatDateTime(reservedUntil) })}</p>
        )}
        {msLeft !== null && (msLeft <= 0 || msLeft < ORDER_CAPTURE_WARNING_HOURS * 3_600_000) && (
          <Notice tone="error" className="max-w-prose">
            {msLeft <= 0
              ? t("detail.reservation.expired")
              : t("detail.reservation.expiresSoon", { hours: ORDER_CAPTURE_WARNING_HOURS })}
          </Notice>
        )}
      </div>

      <div className="grid max-w-6xl items-start gap-6 lg:grid-cols-[3fr_2fr]">
        <div className="flex min-w-0 flex-col gap-6">
          <section aria-labelledby="order-buyer" className={CARD}>
            <h2 id="order-buyer" className="text-h3 font-semibold">
              {t("detail.buyer.heading")}
            </h2>
            <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[10rem_1fr]">
              <dt className="text-muted">{t("detail.buyer.name")}</dt>
              <dd>{order.customerName ?? missing}</dd>
              <dt className="text-muted">{t("detail.buyer.email")}</dt>
              <dd className="break-all">{order.email}</dd>
              <dt className="text-muted">{t("detail.buyer.phone")}</dt>
              <dd>{order.phone ?? missing}</dd>
              <dt className="text-muted">{t("detail.buyer.address")}</dt>
              <dd>
                {addressLines.length === 0
                  ? missing
                  : addressLines.map((line, index) => (
                      <span key={index} className="block">
                        {line}
                      </span>
                    ))}
              </dd>
              <dt className="text-muted">{t("detail.buyer.language")}</dt>
              <dd>{t(`detail.buyer.languages.${order.locale}`)}</dd>
            </dl>
          </section>

          <section aria-labelledby="order-lines" className={CARD}>
            <h2 id="order-lines" className="text-h3 font-semibold">
              {t("detail.lines.heading")}
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-border text-small text-muted">
                    <th scope="col" className="py-2 pr-4 font-semibold">{t("detail.lines.item")}</th>
                    <th scope="col" className="py-2 pr-4 text-right font-semibold">{t("detail.lines.quantity")}</th>
                    <th scope="col" className="py-2 text-right font-semibold">{t("detail.lines.amount")}</th>
                  </tr>
                </thead>
                <tbody>
                  {order.lines.map((line, index) => (
                    <tr key={index} className="border-b border-border">
                      <td className="py-2 pr-4">
                        {t("detail.lines.line", { title: line.title, kind: t(`detail.lines.kinds.${line.offerKind}`) })}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">{line.quantity}</td>
                      <td className="py-2 text-right whitespace-nowrap tabular-nums">{kroner(line.amountTotalOre)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-b border-border">
                    <th scope="row" colSpan={2} className="py-2 pr-4 font-normal">{t("detail.lines.tax")}</th>
                    <td className="py-2 text-right whitespace-nowrap tabular-nums">{kroner(order.amountTaxOre)}</td>
                  </tr>
                  <tr className="border-b border-border">
                    <th scope="row" colSpan={2} className="py-2 pr-4 font-semibold">{t("detail.lines.total")}</th>
                    <td className="py-2 text-right font-semibold whitespace-nowrap tabular-nums">
                      {kroner(order.amountTotalOre)}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row" colSpan={2} className="py-2 pr-4 font-normal">{t("detail.lines.refunded")}</th>
                    <td className="py-2 text-right whitespace-nowrap tabular-nums">{kroner(order.amountRefundedOre)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <h3 className="font-semibold">{t("detail.stripe.heading")}</h3>
            <dl className="grid gap-x-4 gap-y-1 text-small sm:grid-cols-[10rem_1fr]">
              <dt className="text-muted">{t("detail.stripe.session")}</dt>
              <dd className="font-mono break-all">{order.stripeCheckoutSessionId}</dd>
              <dt className="text-muted">{t("detail.stripe.paymentIntent")}</dt>
              <dd className="font-mono break-all">{order.stripePaymentIntentId}</dd>
              {order.stripeCustomerId && (
                <>
                  <dt className="text-muted">{t("detail.stripe.customer")}</dt>
                  <dd className="font-mono break-all">{order.stripeCustomerId}</dd>
                </>
              )}
              {order.stripeInvoiceId && (
                <>
                  <dt className="text-muted">{t("detail.stripe.invoice")}</dt>
                  <dd className="font-mono break-all">{order.stripeInvoiceId}</dd>
                </>
              )}
            </dl>
          </section>

          <OrderTimeline order={order} className={CARD} />
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          {order.anomaly && (
            <section aria-labelledby="order-anomaly" className={CARD}>
              <h2 id="order-anomaly" className="text-h3 font-semibold text-error">
                ⚠ {t("detail.anomaly.heading")}
              </h2>
              <p className="text-small text-muted">{t("detail.anomaly.lead")}</p>
              <ul className="flex flex-col gap-2 text-small">
                {order.anomaly.split(",").map((code) => (
                  <li key={code}>
                    <code className="font-mono font-semibold">{code}</code>
                    {Object.hasOwn(anomalyMessages.codes, code) &&
                      `: ${anomalyMessages.codes[code as keyof typeof anomalyMessages.codes]}`}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <NextIntlClientProvider locale={AUTH_LOCALE} messages={{ Admin: { orders: { detail: { ship, refund, errors } } } }}>
            <OrderShipForm
              available={order.status === "authorized" && order.withdrawal === null}
              orderId={order.id}
              orderNumber={order.orderNumber}
              captured={order.capturedAt !== null}
              amountOre={order.amountTotalOre}
            />
            <OrderRefundForm
              available={offlineNotice || (order.withdrawal?.status === "received" && order.status !== "refunded")}
              offline={offlineNotice}
              orderId={order.id}
              orderNumber={order.orderNumber}
              email={order.email}
              shipped={order.shippedAt !== null}
              captured={order.capturedAt !== null}
              availableOre={order.amountTotalOre - order.amountRefundedOre}
            />
          </NextIntlClientProvider>
        </div>
      </div>
    </>
  );
}
