/**
 * Unit tests: src/lib/payments/checkout-params.ts — pure param builders.
 * Journey: payments-slice1b-billing PAY1B-AC42; payments-slice1d-withdrawal WD-J1-C01, WD-J1-C06
 *
 * Slice 1d adds: consent_collection, custom_text (consent message + submit line),
 * metadata.withdrawal_text_version and subscription_data.metadata.withdrawal_text_version.
 * Custom-text values are pinned as literals from slice1d-legal-texts-draft.md, NOT derived
 * by calling the production checkoutConsentMessage() — that would test the builder against itself.
 */
import { describe, it, expect } from "vitest";
import { buildSubscriptionCheckoutParams, buildBillingPortalParams } from "@/lib/payments/checkout-params";
import { CHECKOUT_SESSION_TTL_SECONDS } from "@/config/payments";
// No import from @/config/legal/withdrawal-texts — literals below are from the legal draft.

// ── Shared fixtures ───────────────────────────────────────────────────────────

const USER_ID = "user-uuid-1234";
const EMAIL = "sub@test.local";
const PLAN = { id: "plan-uuid-5678", stripePriceId: "price_yr_test123" };
const TAX_RATE_ID = "txr_test123";
const MONITOR_ORIGIN = "http://monitor.localhost:3000";
// 1d: siteOrigin is the main site, used for /terms URLs in consent params (distinct from monitorOrigin).
const SITE_ORIGIN = "https://alnyron.dk";
const NOW_SECONDS = 1_700_000_000;

// ── 1d literal pins (from slice1d-legal-texts-draft.md, never derived from production code) ─────
const WITHDRAWAL_TEXT_VERSION_LITERAL = "2026-11-14.1";
// DA consent message: termsAcceptPrefix + " " + consent (markdown link; termsUrl = SITE_ORIGIN+/terms)
const DA_CONSENT_MESSAGE =
  "Jeg accepterer Alnyrons [handelsbetingelser](https://alnyron.dk/terms). " +
  "Jeg anmoder om, at Alnyron påbegynder Monitor-abonnementet med det samme, inden fortrydelsesfristen " +
  "på 14 dage udløber. Jeg er indforstået med, at jeg stadig kan fortryde inden for 14 dage, men at " +
  "jeg i så fald betaler et forholdsmæssigt beløb for den periode, abonnementet har været aktivt.";
// DA checkoutSubmit
const DA_SUBMIT_MESSAGE =
  "Du har 14 dages fortrydelsesret. Du kan fortryde online under Abonnement i Monitor, " +
  "og du får fortrydelsesvejledningen på e-mail.";

// ── PAY1B-AC42: buildSubscriptionCheckoutParams ───────────────────────────────

describe("PAY1B-AC42: buildSubscriptionCheckoutParams — no stripeCustomerId (customer_email path)", () => {
  it("PAY1B-AC42a: exact shape when stripeCustomerId is null (da locale)", () => {
    const result = buildSubscriptionCheckoutParams({
      userId: USER_ID,
      email: EMAIL,
      locale: "da",
      plan: PLAN,
      stripeCustomerId: null,
      taxRateId: TAX_RATE_ID,
      monitorOrigin: MONITOR_ORIGIN,
      siteOrigin: SITE_ORIGIN,
      nowSeconds: NOW_SECONDS,
    });

    expect(result).toEqual({
      mode: "subscription",
      ui_mode: "hosted_page",
      locale: "da",
      line_items: [{ price: PLAN.stripePriceId, quantity: 1 }],
      consent_collection: { terms_of_service: "required" },
      custom_text: {
        terms_of_service_acceptance: { message: DA_CONSENT_MESSAGE },
        submit: { message: DA_SUBMIT_MESSAGE },
      },
      subscription_data: {
        default_tax_rates: [TAX_RATE_ID],
        metadata: {
          kind: "monitor_subscription",
          user_id: USER_ID,
          plan_id: PLAN.id,
          locale: "da",
          withdrawal_text_version: WITHDRAWAL_TEXT_VERSION_LITERAL,
        },
      },
      metadata: {
        kind: "monitor_subscription",
        user_id: USER_ID,
        plan_id: PLAN.id,
        locale: "da",
        withdrawal_text_version: WITHDRAWAL_TEXT_VERSION_LITERAL,
      },
      client_reference_id: USER_ID,
      customer_email: EMAIL,
      success_url: `${MONITOR_ORIGIN}/monitor/billing?checkout=done`,
      cancel_url: `${MONITOR_ORIGIN}/monitor/billing`,
      billing_address_collection: "required",
      expires_at: NOW_SECONDS + CHECKOUT_SESSION_TTL_SECONDS,
    });
  });

  it("PAY1B-AC42b: no 'customer' key when stripeCustomerId is null", () => {
    const result = buildSubscriptionCheckoutParams({
      userId: USER_ID,
      email: EMAIL,
      locale: "da",
      plan: PLAN,
      stripeCustomerId: null,
      taxRateId: TAX_RATE_ID,
      monitorOrigin: MONITOR_ORIGIN,
      siteOrigin: SITE_ORIGIN,
      nowSeconds: NOW_SECONDS,
    });
    expect(result).not.toHaveProperty("customer");
  });

  it("PAY1B-AC42c: no 'payment_method_types' key", () => {
    const result = buildSubscriptionCheckoutParams({
      userId: USER_ID, email: EMAIL, locale: "da", plan: PLAN,
      stripeCustomerId: null, taxRateId: TAX_RATE_ID,
      monitorOrigin: MONITOR_ORIGIN, siteOrigin: SITE_ORIGIN, nowSeconds: NOW_SECONDS,
    });
    expect(result).not.toHaveProperty("payment_method_types");
  });

  it("PAY1B-AC42d: no price_data or amount keys", () => {
    const result = buildSubscriptionCheckoutParams({
      userId: USER_ID, email: EMAIL, locale: "da", plan: PLAN,
      stripeCustomerId: null, taxRateId: TAX_RATE_ID,
      monitorOrigin: MONITOR_ORIGIN, siteOrigin: SITE_ORIGIN, nowSeconds: NOW_SECONDS,
    });
    expect(result).not.toHaveProperty("price_data");
    expect(result).not.toHaveProperty("amount");
  });
});

describe("PAY1B-AC42: buildSubscriptionCheckoutParams — with stripeCustomerId (customer path)", () => {
  it("PAY1B-AC42e: exact shape when stripeCustomerId is provided", () => {
    const result = buildSubscriptionCheckoutParams({
      userId: USER_ID,
      email: EMAIL,
      locale: "da",
      plan: PLAN,
      stripeCustomerId: "cus_test_abc123",
      taxRateId: TAX_RATE_ID,
      monitorOrigin: MONITOR_ORIGIN,
      siteOrigin: SITE_ORIGIN,
      nowSeconds: NOW_SECONDS,
    });

    expect(result).toEqual({
      mode: "subscription",
      ui_mode: "hosted_page",
      locale: "da",
      line_items: [{ price: PLAN.stripePriceId, quantity: 1 }],
      consent_collection: { terms_of_service: "required" },
      custom_text: {
        terms_of_service_acceptance: { message: DA_CONSENT_MESSAGE },
        submit: { message: DA_SUBMIT_MESSAGE },
      },
      subscription_data: {
        default_tax_rates: [TAX_RATE_ID],
        metadata: {
          kind: "monitor_subscription",
          user_id: USER_ID,
          plan_id: PLAN.id,
          locale: "da",
          withdrawal_text_version: WITHDRAWAL_TEXT_VERSION_LITERAL,
        },
      },
      metadata: {
        kind: "monitor_subscription",
        user_id: USER_ID,
        plan_id: PLAN.id,
        locale: "da",
        withdrawal_text_version: WITHDRAWAL_TEXT_VERSION_LITERAL,
      },
      client_reference_id: USER_ID,
      customer: "cus_test_abc123",
      success_url: `${MONITOR_ORIGIN}/monitor/billing?checkout=done`,
      cancel_url: `${MONITOR_ORIGIN}/monitor/billing`,
      billing_address_collection: "required",
      expires_at: NOW_SECONDS + CHECKOUT_SESSION_TTL_SECONDS,
    });
  });

  it("PAY1B-AC42f: no 'customer_email' key when stripeCustomerId is provided", () => {
    const result = buildSubscriptionCheckoutParams({
      userId: USER_ID, email: EMAIL, locale: "da", plan: PLAN,
      stripeCustomerId: "cus_test_abc123", taxRateId: TAX_RATE_ID,
      monitorOrigin: MONITOR_ORIGIN, siteOrigin: SITE_ORIGIN, nowSeconds: NOW_SECONDS,
    });
    expect(result).not.toHaveProperty("customer_email");
  });
});

describe("PAY1B-AC42: buildSubscriptionCheckoutParams — expires_at and locale", () => {
  it("PAY1B-AC42g: expires_at = nowSeconds + CHECKOUT_SESSION_TTL_SECONDS (1860)", () => {
    const now = 1_700_100_000;
    const result = buildSubscriptionCheckoutParams({
      userId: USER_ID, email: EMAIL, locale: "da", plan: PLAN,
      stripeCustomerId: null, taxRateId: TAX_RATE_ID,
      monitorOrigin: MONITOR_ORIGIN, siteOrigin: SITE_ORIGIN, nowSeconds: now,
    });
    expect(result.expires_at).toBe(now + 1860);
    expect(CHECKOUT_SESSION_TTL_SECONDS).toBe(1860);
  });

  it("PAY1B-AC42h: en locale is threaded through all locale fields", () => {
    const result = buildSubscriptionCheckoutParams({
      userId: USER_ID, email: EMAIL, locale: "en", plan: PLAN,
      stripeCustomerId: null, taxRateId: TAX_RATE_ID,
      monitorOrigin: MONITOR_ORIGIN, siteOrigin: SITE_ORIGIN, nowSeconds: NOW_SECONDS,
    });
    expect(result.locale).toBe("en");
    expect(result.subscription_data.metadata.locale).toBe("en");
    expect(result.metadata.locale).toBe("en");
  });

  it("PAY1B-AC42i: success_url and cancel_url use the given monitorOrigin", () => {
    const origin = "https://monitor.alnyron.dk";
    const result = buildSubscriptionCheckoutParams({
      userId: USER_ID, email: EMAIL, locale: "da", plan: PLAN,
      stripeCustomerId: null, taxRateId: TAX_RATE_ID,
      monitorOrigin: origin, siteOrigin: SITE_ORIGIN, nowSeconds: NOW_SECONDS,
    });
    expect(result.success_url).toBe(`${origin}/monitor/billing?checkout=done`);
    expect(result.cancel_url).toBe(`${origin}/monitor/billing`);
  });
});

// ── PAY1B-AC42: buildBillingPortalParams ─────────────────────────────────────

describe("PAY1B-AC42: buildBillingPortalParams — exact shape", () => {
  it("PAY1B-AC42j: returns customer, configuration, locale, return_url", () => {
    const result = buildBillingPortalParams({
      stripeCustomerId: "cus_portal_test",
      locale: "da",
      configurationId: "bpc_test123",
      monitorOrigin: MONITOR_ORIGIN,
    });
    expect(result).toEqual({
      customer: "cus_portal_test",
      configuration: "bpc_test123",
      locale: "da",
      return_url: `${MONITOR_ORIGIN}/monitor/billing`,
    });
  });

  it("PAY1B-AC42k: return_url uses monitorOrigin correctly", () => {
    const result = buildBillingPortalParams({
      stripeCustomerId: "cus_1",
      locale: "en",
      configurationId: "bpc_1",
      monitorOrigin: "https://monitor.alnyron.dk",
    });
    expect(result.return_url).toBe("https://monitor.alnyron.dk/monitor/billing");
  });
});
