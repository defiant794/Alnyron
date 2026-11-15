"use server";

import type { Locale } from "next-intl";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ORDER_WITHDRAW_PATH, type OrderWithdrawState } from "@/config/payments";
import { orderLocale } from "@/i18n/order-locale";
import { callOrderService } from "@/lib/payments/orders/binding";
import { parseOrderServiceInput, type OrderServiceInput } from "@/lib/payments/orders/service-contract";
import { allowGoodsRequest } from "@/lib/payments/rate-limit";
import { parseConsumerName } from "@/lib/payments/withdrawal-contract";

/** An order number as the form sends it: digits only (the contract checks the range). */
const ORDER_NUMBER = /^\d{1,16}$/;

/** Back to /order/withdraw showing `state` in `locale`; nothing the buyer entered goes into the URL. */
function withdrawState(state: OrderWithdrawState, locale: Locale): never {
  redirect(`${ORDER_WITHDRAW_PATH}?${new URLSearchParams({ state, lang: locale })}`);
}

/** The text of a form field, or undefined when it is missing or a file. */
function field(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === "string" ? value : undefined;
}

/**
 * The confirm step's fields as `OrderService.withdraw`'s input, checked with
 * the shared contract, or null for any other form. `channel` picks the
 * personal link (`order_id`, `token`) or the order number and the order's
 * email (`order_number`, `email`); `consumer_name` is trimmed;
 * `statement_version` must be the goods text version the page showed;
 * `locale` (the receipt's language) is the page's, Danish when missing.
 */
function withdrawInput(formData: FormData, locale: Locale): OrderServiceInput<"withdraw"> | null {
  const common = {
    consumerName: parseConsumerName(formData.get("consumer_name")),
    statementVersion: field(formData, "statement_version"),
    locale,
  };
  const channel = field(formData, "channel");
  if (channel === "link") {
    return parseOrderServiceInput("withdraw", {
      channel,
      orderId: field(formData, "order_id"),
      token: field(formData, "token"),
      ...common,
    });
  }
  const orderNumber = field(formData, "order_number")?.trim() ?? "";
  if (channel !== "form" || !ORDER_NUMBER.test(orderNumber)) return null;
  return parseOrderServiceInput("withdraw", {
    channel,
    orderNumber: Number(orderNumber),
    email: field(formData, "email")?.trim(),
    ...common,
  });
}

/**
 * "Bekræft fortrydelse" (`/order/withdraw`, step 2 of 2 of the online
 * withdrawal function for goods, Art. 11a): sends the consumer's withdrawal
 * statement to the payments Worker's `OrderService.withdraw` over the
 * `ORDERS` binding, which identifies the order (personal link token, or
 * order number plus the order's email), records the notice whatever the date
 * (lateness is the owner's call) and mails the receipt to the order's email.
 * No account is needed and none is read.
 *
 * Then back to `/order/withdraw?state=<state>&lang=`, never with anything the
 * buyer entered: `busy` over the per-IP rate limit (`order-withdraw:<ip>`,
 * failing closed: no binding or a limiter error counts as over it);
 * `received` for a new or repeated notice; `refused`, one generic state, for
 * an invalid form and for every refusal (no such order, wrong email, bad
 * link, not withdrawable), so the answer never tells which; `unavailable`
 * without the binding, for a failed call or an answer of another shape, and
 * when the Worker says so. Never logs.
 */
export async function withdrawOrder(formData: FormData): Promise<never> {
  const locale = orderLocale(formData.get("locale"));
  const ip = (await headers()).get("cf-connecting-ip");
  if (!(await allowGoodsRequest("order-withdraw", ip))) withdrawState("busy", locale);

  const input = withdrawInput(formData, locale);
  if (input === null) withdrawState("refused", locale);

  const result = await callOrderService("withdraw", (orders) => orders.withdraw(input));
  if (result === null || (!result.ok && result.reason === "unavailable")) withdrawState("unavailable", locale);
  withdrawState(result.ok ? "received" : "refused", locale);
}
