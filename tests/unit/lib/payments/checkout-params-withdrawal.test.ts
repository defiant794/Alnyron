/**
 * Unit tests: src/lib/payments/checkout-params.ts — slice 1d additions
 * Journey: payments-slice1d-withdrawal
 * Criteria: WD-J1-C01, WD-J1-C02, WD-J1-C06
 *
 * Coverage:
 *   - consent_collection: { terms_of_service: "required" } present in every session
 *   - custom_text.terms_of_service_acceptance.message = checkoutConsentMessage(locale, termsUrl)
 *   - custom_text.submit.message = WITHDRAWAL_TEXTS[locale].checkoutSubmit
 *   - metadata.withdrawal_text_version = WITHDRAWAL_TEXT_VERSION
 *   - subscription_data.metadata.withdrawal_text_version = WITHDRAWAL_TEXT_VERSION
 *   - termsUrl = siteOrigin + /terms (DA) or /en/terms (EN)
 */
import { describe, expect, it } from "vitest";
import { buildSubscriptionCheckoutParams } from "@/lib/payments/checkout-params";
import { WITHDRAWAL_TEXT_VERSION, WITHDRAWAL_TEXTS, checkoutConsentMessage } from "@/config/legal/withdrawal-texts";

// ── Shared fixtures ───────────────────────────────────────────────────────────

const USER_ID       = "user-uuid-1234";
const EMAIL         = "sub@test.local";
const PLAN          = { id: "plan-uuid-5678", stripePriceId: "price_yr_test123" };
const TAX_RATE_ID   = "txr_test123";
const MONITOR_ORIGIN = "http://monitor.localhost:3000";
const SITE_ORIGIN    = "https://alnyron.dk";
const NOW_SECONDS    = 1_731_542_400;

function buildDA(extraOpts: Record<string, unknown> = {}) {
  return buildSubscriptionCheckoutParams({
    userId: USER_ID, email: EMAIL, plan: PLAN, taxRateId: TAX_RATE_ID,
    monitorOrigin: MONITOR_ORIGIN, siteOrigin: SITE_ORIGIN,
    locale: "da", stripeCustomerId: null, nowSeconds: NOW_SECONDS,
    ...extraOpts,
  });
}

function buildEN() {
  return buildSubscriptionCheckoutParams({
    userId: USER_ID, email: EMAIL, plan: PLAN, taxRateId: TAX_RATE_ID,
    monitorOrigin: MONITOR_ORIGIN, siteOrigin: SITE_ORIGIN,
    locale: "en", stripeCustomerId: null, nowSeconds: NOW_SECONDS,
  });
}

// ── WD-J1-C01: consent_collection ────────────────────────────────────────────

describe("WD-J1-C01 (WD-T-CO-01): buildSubscriptionCheckoutParams — consent_collection.terms_of_service='required'", () => {
  it("WD-T-CO-01: DA session has consent_collection.terms_of_service='required'", () => {
    const params = buildDA();
    expect(params["consent_collection"]).toEqual({ terms_of_service: "required" });
  });

  it("WD-T-CO-01b: EN session has consent_collection.terms_of_service='required'", () => {
    const params = buildEN();
    expect(params["consent_collection"]).toEqual({ terms_of_service: "required" });
  });
});

describe("WD-J1-C01 (WD-T-CO-02): buildSubscriptionCheckoutParams — custom_text.terms_of_service_acceptance.message", () => {
  it("WD-T-CO-02a: DA message equals checkoutConsentMessage('da', siteOrigin+'/terms')", () => {
    const params = buildDA();
    const expected = checkoutConsentMessage("da", `${SITE_ORIGIN}/terms`);
    expect(params["custom_text"]?.["terms_of_service_acceptance"]?.["message"]).toBe(expected);
  });

  it("WD-T-CO-02b: EN message equals checkoutConsentMessage('en', siteOrigin+'/en/terms')", () => {
    const params = buildEN();
    const expected = checkoutConsentMessage("en", `${SITE_ORIGIN}/en/terms`);
    expect(params["custom_text"]?.["terms_of_service_acceptance"]?.["message"]).toBe(expected);
  });
});

describe("WD-J1-C02 (WD-T-CO-03): buildSubscriptionCheckoutParams — custom_text.submit.message", () => {
  it("WD-T-CO-03a: DA submit message equals WITHDRAWAL_TEXTS.da.checkoutSubmit", () => {
    const params = buildDA();
    expect(params["custom_text"]?.["submit"]?.["message"]).toBe(WITHDRAWAL_TEXTS["da"].checkoutSubmit);
  });

  it("WD-T-CO-03b: EN submit message equals WITHDRAWAL_TEXTS.en.checkoutSubmit", () => {
    const params = buildEN();
    expect(params["custom_text"]?.["submit"]?.["message"]).toBe(WITHDRAWAL_TEXTS["en"].checkoutSubmit);
  });
});

// ── WD-J1-C06: metadata withdrawal_text_version stamps ───────────────────────

describe("WD-J1-C06 (WD-T-CO-04): buildSubscriptionCheckoutParams — withdrawal_text_version in metadata", () => {
  it("WD-T-CO-04a: metadata.withdrawal_text_version = WITHDRAWAL_TEXT_VERSION", () => {
    const params = buildDA();
    expect(params["metadata"]?.["withdrawal_text_version"]).toBe(WITHDRAWAL_TEXT_VERSION);
  });

  it("WD-T-CO-04b: subscription_data.metadata.withdrawal_text_version = WITHDRAWAL_TEXT_VERSION", () => {
    const params = buildDA();
    expect(params["subscription_data"]?.["metadata"]?.["withdrawal_text_version"]).toBe(WITHDRAWAL_TEXT_VERSION);
  });
});

// ── terms URL is locale-aware ─────────────────────────────────────────────────

describe("WD-J1-C01: terms URL in consent message is locale-aware", () => {
  it("DA consent message links to siteOrigin + '/terms'", () => {
    const params = buildDA();
    const msg = String(params["custom_text"]?.["terms_of_service_acceptance"]?.["message"] ?? "");
    expect(msg).toContain(`${SITE_ORIGIN}/terms`);
    expect(msg).not.toContain(`${SITE_ORIGIN}/en/terms`);
  });

  it("EN consent message links to siteOrigin + '/en/terms'", () => {
    const params = buildEN();
    const msg = String(params["custom_text"]?.["terms_of_service_acceptance"]?.["message"] ?? "");
    expect(msg).toContain(`${SITE_ORIGIN}/en/terms`);
  });
});
