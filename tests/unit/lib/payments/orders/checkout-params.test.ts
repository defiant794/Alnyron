/**
 * Unit tests: src/lib/payments/orders/checkout-params.ts — buildGoodsCheckoutParams
 * Journey: payments-s2-3d-purchase
 * Criteria: S2-CHK-1..3 (S2-T-CHK-01..03), S2-CHK-10..11 (S2-T-CHK-04..06)
 *
 * Contract pins — these literals come from the s2-contract.md §2 and §4.4 and amendment A1
 * (charge on dispatch: payment_intent_data.capture_method 'manual', NO invoice_creation), NOT
 * derived from production code (a builder tested against itself proves nothing):
 *   GOODS_TEXT_VERSION  "goods-2026-11-14.1"
 *   GOODS_ORDER_KIND    "goods_order"
 *   CHECKOUT_SESSION_TTL_SECONDS: reused from 1b (not re-pinned here; imported)
 *   The consent message (the terms link per language) and the submit line
 *   (the reservation, dispatch and withdrawal) are written out as literals in
 *   both languages, so the builder is not compared with its own text helpers.
 */
import { describe, expect, it } from "vitest";
import { buildGoodsCheckoutParams, type GoodsCheckoutParams } from "@/lib/payments/orders/checkout-params";
import { CHECKOUT_SESSION_TTL_SECONDS } from "@/config/payments";
import { GOODS_TEXT_VERSION } from "@/config/legal/goods-texts";
import { GOODS_ORDER_KIND, PAYMENTS_SWEEP_ORDER_SUBREQUESTS } from "@/config/payments";

// ── Shared fixtures ────────────────────────────────────────────────────────────

const SITE_ORIGIN = "https://alnyron.dk";
const TAX_RATE_ID = "txr_1Ubdp4FBWtA5MNzbg2ZKznPw";
const NOW_SECONDS = 1_800_000_000;

const OFFER_DA = {
  item_id: "00000000-0000-0000-0000-000000000001",
  price_ore: 24995,
  title: "Testfigur DA",
  section_slug: "figurer",
  item_slug: "testfigur",
  locale: "da" as const,
};

const OFFER_EN = {
  ...OFFER_DA,
  locale: "en" as const,
};

const ACCOUNT = { userId: "user-uuid-1234", email: "buyer@test.local" };

/** The whole parameter object of a Danish guest purchase (contract §5, A1). */
const GUEST_DA: GoodsCheckoutParams = {
  mode: "payment",
  ui_mode: "hosted_page",
  locale: "da",
  submit_type: "pay",
  line_items: [
    {
      price_data: { currency: "dkk", unit_amount: 24995, product_data: { name: "Testfigur DA" } },
      quantity: 1,
      tax_rates: [TAX_RATE_ID],
    },
  ],
  shipping_address_collection: { allowed_countries: ["DK"] },
  phone_number_collection: { enabled: true },
  consent_collection: { terms_of_service: "required" },
  custom_text: {
    terms_of_service_acceptance: {
      message:
        "Jeg accepterer Alnyrons [handelsbetingelser](https://alnyron.dk/terms) for køb af varer, herunder 14 dages fortrydelsesret, hvor jeg selv betaler returfragten.",
    },
    submit: {
      message:
        "Beløbet reserveres ved bestillingen og trækkes først, når varen sendes. Varen sendes inden for 3 hverdage til din adresse i Danmark. Du har 14 dages fortrydelsesret fra den dag, du modtager varen, og du betaler selv returfragten, hvis du fortryder.",
    },
  },
  metadata: {
    kind: "goods_order",
    item_id: "00000000-0000-0000-0000-000000000001",
    offer_kind: "physical",
    unit_amount_ore: "24995",
    quantity: "1",
    title: "Testfigur DA",
    locale: "da",
    terms_version: "goods-2026-11-14.1",
  },
  payment_intent_data: { capture_method: "manual", metadata: { kind: "goods_order" } },
  success_url: "https://alnyron.dk/order/thanks?lang=da",
  cancel_url: "https://alnyron.dk/figurer/testfigur",
  expires_at: NOW_SECONDS + CHECKOUT_SESSION_TTL_SECONDS,
};

// ── S2-CHK-1 (S2-T-CHK-01): exact shape — guest, DA ──────────────────────────

describe("S2-CHK-1 (S2-T-CHK-01): buildGoodsCheckoutParams guest DA — the exact parameter object", () => {
  it("equals the whole object: no reference fields, no invoice_creation, the Danish consent and submit lines", () => {
    const result = buildGoodsCheckoutParams({
      offer: OFFER_DA,
      locale: "da",
      siteOrigin: SITE_ORIGIN,
      taxRateId: TAX_RATE_ID,
      nowSeconds: NOW_SECONDS,
      account: null,
    });

    // Strict: a key set to undefined (a guest's reference fields) would fail too.
    expect(result).toStrictEqual(GUEST_DA);
  });
});

// ── S2-CHK-2 (S2-T-CHK-02): account buyer ────────────────────────────────────

describe("S2-CHK-2 (S2-T-CHK-02): buildGoodsCheckoutParams — account buyer adds reference fields", () => {
  it("equals the guest object plus client_reference_id, customer_email and metadata.user_id", () => {
    const result = buildGoodsCheckoutParams({
      offer: OFFER_DA,
      locale: "da",
      siteOrigin: SITE_ORIGIN,
      taxRateId: TAX_RATE_ID,
      nowSeconds: NOW_SECONDS,
      account: ACCOUNT,
    });

    expect(result).toStrictEqual({
      ...GUEST_DA,
      metadata: { ...GUEST_DA.metadata, user_id: "user-uuid-1234" },
      client_reference_id: "user-uuid-1234",
      customer_email: "buyer@test.local",
    });
  });
});

// ── S2-CHK-3 (S2-T-CHK-03): EN locale ────────────────────────────────────────

describe("S2-CHK-3 (S2-T-CHK-03): buildGoodsCheckoutParams EN locale — the exact parameter object", () => {
  it("lang=en success URL, /en/ cancel URL, locale en, the English consent line linking /en/terms and the English submit line", () => {
    const result = buildGoodsCheckoutParams({
      offer: OFFER_EN,
      locale: "en",
      siteOrigin: SITE_ORIGIN,
      taxRateId: TAX_RATE_ID,
      nowSeconds: NOW_SECONDS,
      account: null,
    });

    expect(result).toStrictEqual({
      ...GUEST_DA,
      locale: "en",
      custom_text: {
        terms_of_service_acceptance: {
          message:
            "I accept Alnyron's [terms and conditions](https://alnyron.dk/en/terms) for the purchase of goods, including the 14-day right of withdrawal, where I pay the cost of returning the goods.",
        },
        submit: {
          message:
            "The amount is reserved when you order and charged only when the goods are sent. The goods are dispatched within 3 working days to your address in Denmark. You have a 14-day right of withdrawal from the day you receive the goods, and you pay the cost of returning them if you withdraw.",
        },
      },
      metadata: { ...GUEST_DA.metadata, locale: "en" },
      success_url: "https://alnyron.dk/order/thanks?lang=en",
      cancel_url: "https://alnyron.dk/en/figurer/testfigur",
    });
  });
});

// ── S2-CHK-10 (S2-T-CHK-04..05): constant pins ───────────────────────────────

describe("S2-CHK-10 (S2-T-CHK-04..05): GOODS_ORDER_KIND and GOODS_TEXT_VERSION constants", () => {
  it("S2-T-CHK-04: GOODS_ORDER_KIND === 'goods_order'", () => {
    expect(GOODS_ORDER_KIND).toBe("goods_order");
  });

  it("S2-T-CHK-05: GOODS_TEXT_VERSION === 'goods-2026-11-14.1'", () => {
    expect(GOODS_TEXT_VERSION).toBe("goods-2026-11-14.1");
  });
});

// ── S2-CHK-11 (S2-T-CHK-06): PAYMENTS_SWEEP_ORDER_SUBREQUESTS pin ────────────

describe("S2-CHK-11 (S2-T-CHK-06): PAYMENTS_SWEEP_ORDER_SUBREQUESTS === 12", () => {
  it("PAYMENTS_SWEEP_ORDER_SUBREQUESTS === 12", () => {
    expect(PAYMENTS_SWEEP_ORDER_SUBREQUESTS).toBe(12);
  });
});
