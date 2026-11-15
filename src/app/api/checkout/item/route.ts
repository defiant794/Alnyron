import type { Locale } from "next-intl";
import { z } from "zod";
import { ORDER_ERROR_PATH, type OrderErrorReason } from "@/config/payments";
import { siteOrigin } from "@/config/site-origin";
import { orderLocale } from "@/i18n/order-locale";
import { routing } from "@/i18n/routing";
import { callOrderService } from "@/lib/payments/orders/binding";
import type { OrderServiceInput } from "@/lib/payments/orders/service-contract";
import { allowGoodsRequest } from "@/lib/payments/rate-limit";
import { createServerClient } from "@/lib/supabase/server";

/** The only origin a goods Checkout URL may have (Stripe's hosted payment page). */
const STRIPE_CHECKOUT_ORIGIN = "https://checkout.stripe.com";

/** The Buy form's two fields (`ItemOfferBlock`): which item, and the item page's language. */
const buySchema = z.object({
  item_id: z.guid(),
  locale: z.enum(routing.locales),
});

/** A 303 to `location`, so the browser follows the POST with a GET. */
function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location } });
}

/** To `/order/error` in `locale`, with the page's message for `reason` (none: the generic message). */
function orderError(locale: Locale, reason?: OrderErrorReason): Response {
  const query = new URLSearchParams({ lang: locale });
  if (reason !== undefined) query.set("reason", reason);
  return seeOther(`${ORDER_ERROR_PATH}?${query}`);
}

/**
 * The signed-in visitor's access token, or undefined for a guest (no session,
 * or Supabase could not be asked). It is only passed on: the payments Worker
 * verifies it with Supabase Auth before it makes the purchase an account
 * purchase, and a bad token makes it a guest purchase, never an error.
 */
async function accessTokenOrUndefined(): Promise<string | undefined> {
  try {
    const { data } = await (await createServerClient()).auth.getSession();
    return data.session?.access_token;
  } catch {
    return undefined;
  }
}

/**
 * `POST /api/checkout/item`: the item page's Buy button (a native form POST,
 * so the static item page needs no session or JavaScript). In order:
 * 1. `Origin` must be the main site's (`NEXT_PUBLIC_SITE_URL`), else an empty 403.
 * 2. Per-IP rate limit (`goods-checkout:<cf-connecting-ip>`), failing closed:
 *    over it, without the binding or on a limiter error → `/order/error?reason=busy`.
 * 3. The form: `item_id` (a uuid) and `locale` (da|en), else `/order/error` (no reason).
 * 4. The session's access token when there is one (never trusted here).
 * 5. The payments Worker's `OrderService.startCheckout` over the `ORDERS`
 *    binding creates the Stripe Checkout Session (the web app never calls
 *    Stripe and holds no key for goods). Its answer, checked with the shared
 *    contract, leads to Stripe's hosted Checkout only when the URL's origin is
 *    `https://checkout.stripe.com`; an item without an active offer →
 *    `/order/error?reason=not_purchasable`; anything else (no binding, a
 *    failed call, another answer or URL) → `/order/error?reason=unavailable`.
 *
 * Every answer but the 403 is a 303 (`lang` = the form's language, Danish when
 * it has none). Nothing about the buyer is logged or put in a URL.
 */
export async function POST(request: Request): Promise<Response> {
  if (request.headers.get("origin") !== siteOrigin()) return new Response(null, { status: 403 });

  const form = await request.formData().catch(() => null);
  const locale = orderLocale(form?.get("locale"));
  if (!(await allowGoodsRequest("goods-checkout", request.headers.get("cf-connecting-ip")))) {
    return orderError(locale, "busy");
  }

  const fields = buySchema.safeParse({ item_id: form?.get("item_id"), locale: form?.get("locale") });
  if (!fields.success) return orderError(locale);

  const accessToken = await accessTokenOrUndefined();
  const input: OrderServiceInput<"startCheckout"> = {
    itemId: fields.data.item_id,
    locale: fields.data.locale,
    ...(accessToken !== undefined && { accessToken }),
  };
  const result = await callOrderService("startCheckout", (orders) => orders.startCheckout(input));
  if (result !== null && result.ok) {
    // The contract already requires this origin; checked again right where the browser is sent.
    return new URL(result.url).origin === STRIPE_CHECKOUT_ORIGIN
      ? seeOther(result.url)
      : orderError(fields.data.locale, "unavailable");
  }
  const notPurchasable = result !== null && result.reason === "not_purchasable";
  return orderError(fields.data.locale, notPurchasable ? "not_purchasable" : "unavailable");
}
