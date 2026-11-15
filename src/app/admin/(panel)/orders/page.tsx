import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import NextLink from "next/link";
import OrdersTable from "@/components/admin/OrdersTable";
import PageHeader from "@/components/admin/PageHeader";
import Card from "@/components/ui/Card";
import { ADMIN_ORDER_FILTERS, ADMIN_ORDERS_PATH, adminOrdersFilterPath, type AdminOrderFilter } from "@/config/admin";
import { AUTH_LOCALE } from "@/config/auth-areas";
import { cx } from "@/lib/cx";
import { formatKronerWithOre } from "@/lib/payments/money";
import { listOrders, type AdminOrderRow } from "@/services/admin/orders";
import { requireAdmin } from "@/services/auth/require-admin";

type AdminOrdersPageProps = Readonly<{ searchParams: Promise<{ status?: string | string[] }> }>;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: AUTH_LOCALE, namespace: "Admin.orders" });
  return { title: t("title") };
}

/** The filter links in the order the owner works through them: to ship, shipped, withdrawn, closed. */
const FILTER_ORDER: readonly AdminOrderFilter[] = ["authorized", "shipped", "withdrawal", "refunded", "canceled"];

/** Whether `row` is listed under `filter`: `withdrawal` is every order with a withdrawal, else the order's status. */
function inFilter(row: AdminOrderRow, filter: AdminOrderFilter): boolean {
  return filter === "withdrawal" ? row.withdrawal !== null : row.status === filter;
}

const PILL =
  "inline-flex min-h-11 items-center rounded-pill border px-4 text-small transition-[background-color,border-color,color]";

/**
 * `/admin/orders` ("Ordrer", approved admin orders mock): the goods orders,
 * newest first, read once with the admin's own session (orders RLS). Filter
 * links (plain links, `?status=`) with a count each: all, Reserveret (to
 * ship), Afsendt, Fortrydelse (has a withdrawal), Refunderet, Annulleret; the
 * counts and the filtered list come from that one read; an unknown filter
 * shows all. Empty states for no orders at all and for an empty filter.
 */
export default async function AdminOrdersPage({ searchParams }: AdminOrdersPageProps) {
  await requireAdmin();
  const { status } = await searchParams;
  const filter = ADMIN_ORDER_FILTERS.find((candidate) => candidate === status);
  const [all, t] = await Promise.all([
    listOrders(),
    getTranslations({ locale: AUTH_LOCALE, namespace: "Admin.orders" }),
  ]);
  const rows = filter === undefined ? all : all.filter((row) => inFilter(row, filter));
  const filterLinks = [
    { href: ADMIN_ORDERS_PATH, label: t("filters.all", { count: all.length }), current: filter === undefined },
    ...FILTER_ORDER.map((candidate) => ({
      href: adminOrdersFilterPath(candidate),
      label: t(`filters.${candidate}`, { count: all.filter((row) => inFilter(row, candidate)).length }),
      current: filter === candidate,
    })),
  ];

  return (
    <>
      <PageHeader title={t("title")} description={t("lead")} />
      <Card className="flex max-w-6xl flex-col gap-4">
        <nav aria-label={t("filters.label")}>
          <ul className="flex flex-wrap gap-2">
            {filterLinks.map((link) => (
              <li key={link.href}>
                <NextLink
                  href={link.href}
                  aria-current={link.current ? "page" : undefined}
                  className={cx(
                    PILL,
                    link.current
                      ? "border-fg bg-fg font-semibold text-bg"
                      : "border-border text-muted hover:border-muted hover:text-fg",
                  )}
                >
                  {link.label}
                </NextLink>
              </li>
            ))}
          </ul>
        </nav>
        {rows.length === 0 ? (
          <p className="text-muted">{all.length === 0 ? t("empty") : t("emptyFilter")}</p>
        ) : (
          <OrdersTable
            rows={rows}
            caption={t("table.caption")}
            labels={{
              number: t("table.number"),
              date: t("table.date"),
              buyer: t("table.buyer"),
              item: t("table.item"),
              amount: t("table.amount"),
              status: t("table.status"),
              noName: t("noName"),
            }}
            statuses={{
              authorized: t("status.authorized"),
              shipped: t("status.shipped"),
              refunded: t("status.refunded"),
              canceled: t("status.canceled"),
            }}
            withdrawals={{
              received: t("withdrawal.received"),
              approved: t("withdrawal.approved"),
              needs_manual: t("withdrawal.needs_manual"),
            }}
            formatAmount={(amountOre) => t("amount", { amount: formatKronerWithOre(amountOre, AUTH_LOCALE) })}
            formatAnomaly={(codes) => t("anomaly", { codes: codes.split(",").join(", ") })}
          />
        )}
      </Card>
    </>
  );
}
