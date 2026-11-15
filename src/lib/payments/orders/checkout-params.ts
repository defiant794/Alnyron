/**
 * Stripe Checkout Session parameters for one physical 3D figure (slice S2),
 * built by the payments Worker from the database's purchasable snapshot
 * (`payments_goods_offer`), its env and the main site's origin. Pure: no I/O,
 * no clock. Separate from the subscription builder (../checkout-params.ts):
 * `mode=payment`, an inline price (no Stripe Price per figure), no customer
 * lookup. Charge on dispatch (amendment A1): the payment is only authorized
 * (`capture_method=manual`) and captured when the owner marks the order
 * shipped; Stripe refuses manual capture together with `invoice_creation`, so
 * no Stripe invoice is made (the order confirmation email is the invoice).
 */

import type { Locale } from "next-intl";
import { GOODS_TEXTS, GOODS_TEXT_VERSION, goodsCheckoutConsentMessage } from "@/config/legal/goods-texts";
import { CHECKOUT_SESSION_TTL_SECONDS, GOODS_ORDER_KIND, ORDER_THANKS_PATH, termsPageUrl } from "@/config/payments";

/**
 * A purchasable item as `payments_goods_offer` answers it (snake_case, as
 * the Worker receives it): the active physical offer's price (øre incl. moms
 * and delivery), the title in the requested language and the URL slugs of
 * its page.
 */
export type GoodsOfferSnapshot = {
  item_id: string;
  price_ore: number;
  title: string;
  section_slug: string;
  item_slug: string;
  locale: Locale;
};

/** Tags the session (and, through a metadata copy, its PaymentIntent) for the webhook Worker. */
export type GoodsMetadata = {
  kind: typeof GOODS_ORDER_KIND;
  item_id: string;
  offer_kind: "physical";
  /** The unit price in øre as Stripe metadata (a string). */
  unit_amount_ore: string;
  quantity: "1";
  title: string;
  locale: Locale;
  /** The goods text version shown (terms, withdrawal notice). */
  terms_version: string;
  /** Present only for a signed-in buyer; the webhook trusts it only when it equals `client_reference_id`. */
  user_id?: string;
};

export type GoodsCheckoutInput = {
  offer: GoodsOfferSnapshot;
  locale: Locale;
  /** The main site's origin (`SITE_URL`), where the item page, /terms and /order are served. */
  siteOrigin: string;
  /** The 25 % inclusive Tax Rate (`STRIPE_TAX_RATE_ID`). */
  taxRateId: string;
  /** Unix time now, in seconds. */
  nowSeconds: number;
  /** The signed-in buyer (verified by the Worker from the access token), or null for a guest. */
  account: { userId: string; email: string } | null;
};

/** `POST /v1/checkout/sessions` parameters of a goods purchase. */
export type GoodsCheckoutParams = {
  mode: "payment";
  ui_mode: "hosted_page";
  locale: Locale;
  submit_type: "pay";
  line_items: {
    price_data: { currency: "dkk"; unit_amount: number; product_data: { name: string } };
    quantity: 1;
    tax_rates: string[];
  }[];
  shipping_address_collection: { allowed_countries: ["DK"] };
  phone_number_collection: { enabled: true };
  consent_collection: { terms_of_service: "required" };
  custom_text: {
    terms_of_service_acceptance: { message: string };
    submit: { message: string };
  };
  metadata: GoodsMetadata;
  /** Authorize only: the payment is captured at dispatch ("Markér afsendt"). */
  payment_intent_data: { capture_method: "manual"; metadata: { kind: typeof GOODS_ORDER_KIND } };
  success_url: string;
  cancel_url: string;
  expires_at: number;
  client_reference_id?: string;
  customer_email?: string;
};

/**
 * Checkout Session parameters for `offer` at quantity 1: the offer's price
 * (incl. 25 % moms and delivery) with the inclusive Tax Rate, shipping to
 * Denmark only, phone number, the required terms checkbox (the versioned
 * goods terms, linked in the session's language) and the reservation,
 * dispatch and withdrawal line above the pay button. The payment intent is
 * only authorized (`capture_method=manual`): the amount is charged when the
 * goods are sent. No `invoice_creation` (Stripe refuses it with manual
 * capture). Success goes to /order/thanks, cancel back to the item page; the
 * session expires {@link CHECKOUT_SESSION_TTL_SECONDS} after `nowSeconds`. A
 * signed-in buyer adds `client_reference_id`, `customer_email` and
 * `metadata.user_id`; a guest none of them. No images, shipping options or
 * Stripe customer lookup.
 */
export function buildGoodsCheckoutParams(input: GoodsCheckoutInput): GoodsCheckoutParams {
  const { offer, locale, siteOrigin, taxRateId, nowSeconds, account } = input;
  const metadata: GoodsMetadata = {
    kind: GOODS_ORDER_KIND,
    item_id: offer.item_id,
    offer_kind: "physical",
    unit_amount_ore: String(offer.price_ore),
    quantity: "1",
    title: offer.title,
    locale,
    terms_version: GOODS_TEXT_VERSION,
    ...(account === null ? {} : { user_id: account.userId }),
  };
  return {
    mode: "payment",
    ui_mode: "hosted_page",
    locale,
    submit_type: "pay",
    line_items: [
      {
        price_data: { currency: "dkk", unit_amount: offer.price_ore, product_data: { name: offer.title } },
        quantity: 1,
        tax_rates: [taxRateId],
      },
    ],
    shipping_address_collection: { allowed_countries: ["DK"] },
    phone_number_collection: { enabled: true },
    consent_collection: { terms_of_service: "required" },
    custom_text: {
      terms_of_service_acceptance: { message: goodsCheckoutConsentMessage(locale, termsPageUrl(siteOrigin, locale)) },
      submit: { message: GOODS_TEXTS[locale].checkoutSubmit },
    },
    metadata,
    payment_intent_data: { capture_method: "manual", metadata: { kind: GOODS_ORDER_KIND } },
    success_url: `${siteOrigin}${ORDER_THANKS_PATH}?lang=${locale}`,
    // The item's page: Danish unprefixed, English under /en (the site's as-needed locale prefix).
    cancel_url: `${siteOrigin}${locale === "en" ? "/en" : ""}/${offer.section_slug}/${offer.item_slug}`,
    expires_at: nowSeconds + CHECKOUT_SESSION_TTL_SECONDS,
    ...(account === null ? {} : { client_reference_id: account.userId, customer_email: account.email }),
  };
}
