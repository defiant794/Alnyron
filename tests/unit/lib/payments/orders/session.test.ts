/**
 * Unit tests: src/lib/payments/orders/session.ts — normalizeGoodsSession, applyGoodsPaymentIntent
 * Journey: payments-s2-3d-purchase
 * Criteria: S2-CHK-4..9 (S2-T-SES-01..13, S2-T-SES-21), S2-CAP-1 (S2-T-SES-14..20)
 *
 * Amendment A1 (charge on dispatch): Checkout only authorizes the payment, so the spike's
 * completed session reports `payment_status: "unpaid"`, `invoice: null`, `customer: null`. The
 * normaliser answers a draft with `captureCheck: true`; the Worker reads the payment intent
 * (`GET /v1/payment_intents/{pi}?expand[]=latest_charge`) and completes it with
 * applyGoodsPaymentIntent (`requires_capture` + `capture_before`, or `succeeded` with the
 * `captured_at_checkout` anomaly).
 *
 * Coverage:
 *   - not_goods: mode!='payment' or metadata.kind!='goods_order'
 *   - awaiting_payment: session not complete, or payment_status neither unpaid nor paid
 *   - invalid_session: missing/invalid cs_ id, pi_ id, email, amount_total, metadata title
 *   - Every anomaly: amount_mismatch, currency_not_dkk, consent_missing, terms_version_unknown,
 *     shipping_missing, shipping_not_dk, tax_mismatch, user_unverified, captured_at_checkout
 *   - Spike-shaped (A1) completed session → ok:true, captureCheck:true, all fields
 *   - state:"" in shipping address → dropped (not stored)
 *   - Multiple anomalies → comma-joined in GoodsOrderInput.anomaly, in the canonical order
 *   - applyGoodsPaymentIntent: requires_capture (with / without capture_before), succeeded,
 *     other statuses, foreign/invalid payment intent
 */
import { describe, expect, it } from "vitest";
import {
  applyGoodsPaymentIntent,
  normalizeGoodsSession,
  type GoodsOrderDraft,
} from "@/lib/payments/orders/session";
import { GOODS_TEXT_VERSION } from "@/config/legal/goods-texts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fakeEvent(type = "checkout.session.completed") {
  return { id: "evt_s2test0000000001", type, created: 1_800_000_000 };
}

/** A fully valid completed session shaped exactly like the A1 spike (manual capture). */
function validSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "cs_test_s2test0000000001",
    mode: "payment",
    payment_status: "unpaid", // A1 spike: authorized only
    status: "complete",
    currency: "dkk",
    amount_total: 24995,
    // A TEST-mode session with the inclusive 25 % Tax Rate (amendment A3-4): amount_subtotal includes the moms
    amount_subtotal: 24995,
    total_details: { amount_tax: 4999, amount_discount: 0, amount_shipping: 0 },
    payment_intent: "pi_s2test0000000001",
    invoice: null, // A1 spike: no invoice_creation
    customer: null, // A1 spike: no Customer without invoice_creation
    client_reference_id: null,
    consent: { terms_of_service: "accepted", promotions: null },
    collected_information: {
      shipping_details: {
        name: "Spike Køber",
        address: {
          line1: "Testvej 1",
          line2: null,
          postal_code: "7860",
          city: "Spøttrup",
          country: "DK",
          state: "", // spike: state is ""
        },
      },
    },
    customer_details: {
      email: "buyer@test.local",
      name: "Spike Køber",
      phone: "+4520123456",
      address: { state: null },
    },
    metadata: {
      kind: "goods_order",
      item_id: "00000000-0000-0000-0000-000000000001",
      offer_kind: "physical",
      unit_amount_ore: "24995",
      quantity: "1",
      title: "Testfigur",
      locale: "da",
      terms_version: GOODS_TEXT_VERSION,
    },
    ...overrides,
  };
}

/** The draft of the spike session (captureCheck: true). */
function spikeDraft(overrides: Record<string, unknown> = {}): GoodsOrderDraft {
  const result = normalizeGoodsSession(validSession(overrides), fakeEvent());
  if (!result.ok || !result.captureCheck) throw new Error("fixture: expected a capture-check draft");
  return result.order;
}

/** The spike's payment intent after Checkout (expanded latest_charge), as the A1 spike recorded it. */
const CAPTURE_BEFORE = 1_800_000_000 + 604_800;
function spikeIntent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "pi_s2test0000000001",
    object: "payment_intent",
    status: "requires_capture",
    amount: 24995,
    amount_capturable: 24995,
    amount_received: 0,
    latest_charge: {
      id: "ch_s2test0000000001",
      captured: false,
      payment_method_details: { type: "card", card: { brand: "visa", capture_before: CAPTURE_BEFORE } },
    },
    ...overrides,
  };
}

// ── S2-CHK-5 (S2-T-SES-02): not_goods ────────────────────────────────────────

describe("S2-CHK-5 (S2-T-SES-02): normalizeGoodsSession — not_goods", () => {
  it.each([
    { label: "mode=subscription",             session: validSession({ mode: "subscription" }) },
    { label: "metadata.kind=subscription",    session: validSession({ metadata: { ...validSession().metadata as object, kind: "subscription" } }) },
    { label: "metadata null",                 session: validSession({ metadata: null }) },
  ])("$label → {ok:false, reason:'not_goods'}", ({ session }) => {
    const result = normalizeGoodsSession(session, fakeEvent());
    expect(result).toEqual({ ok: false, reason: "not_goods" });
  });
});

// ── S2-CHK-6 (S2-T-SES-03): awaiting_payment ─────────────────────────────────

describe("S2-CHK-6 (S2-T-SES-03): normalizeGoodsSession — awaiting_payment only for a session that is not complete", () => {
  it("status=open (not complete) → {ok:false, reason:'awaiting_payment'}", () => {
    const result = normalizeGoodsSession(validSession({ status: "open" }), fakeEvent());
    expect(result).toEqual({ ok: false, reason: "awaiting_payment" });
  });

  it("status missing → {ok:false, reason:'awaiting_payment'}", () => {
    const result = normalizeGoodsSession(validSession({ status: undefined }), fakeEvent());
    expect(result).toEqual({ ok: false, reason: "awaiting_payment" });
  });

  it("payment_status=no_payment_required → {ok:false, reason:'awaiting_payment'}", () => {
    const result = normalizeGoodsSession(validSession({ payment_status: "no_payment_required" }), fakeEvent());
    expect(result).toEqual({ ok: false, reason: "awaiting_payment" });
  });
});

// ── S2-CHK-7 (S2-T-SES-04): invalid_session ──────────────────────────────────

describe("S2-CHK-7 (S2-T-SES-04): normalizeGoodsSession — invalid_session", () => {
  it.each([
    { label: "missing session id",           session: validSession({ id: undefined }) },
    { label: "invalid cs_ id (no prefix)",   session: validSession({ id: "sess_notcs" }) },
    { label: "missing payment_intent",       session: validSession({ payment_intent: undefined }) },
    { label: "invalid pi_ id",               session: validSession({ payment_intent: "ch_notpi" }) },
    { label: "missing email",                session: validSession({ customer_details: { ...validSession().customer_details as object, email: null } }) },
    { label: "invalid email (no @)",         session: validSession({ customer_details: { ...validSession().customer_details as object, email: "notanemail" } }) },
    { label: "amount_total zero",            session: validSession({ amount_total: 0 }) },
    { label: "amount_total null",            session: validSession({ amount_total: null }) },
    { label: "missing metadata title",       session: validSession({ metadata: { ...validSession().metadata as object, title: undefined } }) },
  ])("$label → {ok:false, reason:'invalid_session'}", ({ session }) => {
    const result = normalizeGoodsSession(session, fakeEvent());
    expect(result).toEqual({ ok: false, reason: "invalid_session" });
  });
});

// ── S2-CHK-8 (S2-T-SES-05..12): anomalies ────────────────────────────────────

describe("S2-CHK-8 (S2-T-SES-05..12): normalizeGoodsSession — anomalies recorded, ok:true", () => {
  it("S2-T-SES-05: amount_mismatch — metadata unit_amount_ore mismatches amount_total", () => {
    const session = validSession({ metadata: { ...validSession().metadata as object, unit_amount_ore: "99999" } });
    const result = normalizeGoodsSession(session, fakeEvent());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.anomaly).toBe("amount_mismatch");
  });

  it("S2-T-SES-06: currency_not_dkk — session currency is 'eur'", () => {
    const result = normalizeGoodsSession(validSession({ currency: "eur" }), fakeEvent());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.anomaly).toBe("currency_not_dkk");
    expect(result.order.currency).toBe("eur");
  });

  it("S2-T-SES-07: consent_missing — consent.terms_of_service != 'accepted'", () => {
    const result = normalizeGoodsSession(
      validSession({ consent: { terms_of_service: null, promotions: null } }),
      fakeEvent(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.anomaly).toBe("consent_missing");
    expect(result.order.stripe_consent).toBeNull();
  });

  it("S2-T-SES-08: terms_version_unknown — version not in GOODS_TEXT_SHA256", () => {
    const result = normalizeGoodsSession(
      validSession({ metadata: { ...validSession().metadata as object, terms_version: "goods-unknown-version" } }),
      fakeEvent(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.anomaly).toBe("terms_version_unknown");
    expect(result.order.terms_sha256).toBeNull();
  });

  it("S2-T-SES-09: shipping_missing — no collected_information.shipping_details.address", () => {
    const result = normalizeGoodsSession(
      validSession({ collected_information: { shipping_details: { name: "X", address: null } } }),
      fakeEvent(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.anomaly).toBe("shipping_missing");
  });

  it("S2-T-SES-10: shipping_not_dk — country is 'SE'", () => {
    const result = normalizeGoodsSession(
      validSession({
        collected_information: {
          shipping_details: {
            name: "SE Køber",
            address: { line1: "Sveavägen 1", postal_code: "11234", city: "Stockholm", country: "SE", state: null },
          },
        },
      }),
      fakeEvent(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.anomaly).toBe("shipping_not_dk");
  });

  it("S2-T-SES-11: tax_mismatch — total_details.amount_tax doesn't match amount_total−round(amount_total/1.25)", () => {
    // 24995 → expected tax = 24995 - round(24995/1.25) = 24995 - 19996 = 4999; we pass 1234
    const result = normalizeGoodsSession(
      validSession({ total_details: { amount_tax: 1234, amount_discount: 0, amount_shipping: 0 } }),
      fakeEvent(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.anomaly).toBe("tax_mismatch");
  });

  it("S2-T-SES-12: user_unverified — metadata.user_id present but != client_reference_id", () => {
    const result = normalizeGoodsSession(
      validSession({
        metadata: { ...validSession().metadata as object, user_id: "00000000-0000-0000-0000-000000000099" },
        client_reference_id: "00000000-0000-0000-0000-000000000001", // different id
      }),
      fakeEvent(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.anomaly).toBe("user_unverified");
    // Order recorded as guest
    expect(result.order.user_id).toBeNull();
  });

  it("S2-T-SES-21: several anomalies are comma-joined in the canonical order, whatever order they occur in", () => {
    // eur + no consent + a Swedish address
    const three = normalizeGoodsSession(
      validSession({
        currency: "eur",
        consent: { terms_of_service: null, promotions: null },
        collected_information: {
          shipping_details: {
            name: "SE Køber",
            address: { line1: "Sveavägen 1", postal_code: "11234", city: "Stockholm", country: "SE", state: null },
          },
        },
      }),
      fakeEvent(),
    );
    expect(three.ok).toBe(true);
    if (!three.ok) return;
    expect(three.order.anomaly).toBe("currency_not_dkk,consent_missing,shipping_not_dk");

    // Every session anomaly at once (shipping_missing and shipping_not_dk exclude each other)
    const all = normalizeGoodsSession(
      validSession({
        currency: "eur",
        consent: null,
        total_details: { amount_tax: 1234, amount_discount: 0, amount_shipping: 0 },
        collected_information: { shipping_details: { name: "X", address: null } },
        client_reference_id: "00000000-0000-0000-0000-000000000001",
        metadata: {
          ...(validSession().metadata as object),
          unit_amount_ore: "99999",
          terms_version: "goods-unknown-version",
          user_id: "00000000-0000-0000-0000-000000000099",
        },
      }),
      fakeEvent(),
    );
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.order.anomaly).toBe(
      "amount_mismatch,currency_not_dkk,consent_missing,terms_version_unknown,shipping_missing,tax_mismatch,user_unverified",
    );
  });
});

// ── S2-CHK-9 (S2-T-SES-13): state:"" dropped ─────────────────────────────────

describe("S2-CHK-9 (S2-T-SES-13): normalizeGoodsSession — spike state:'' is dropped", () => {
  it("shipping_address does not contain a state field when input state is ''", () => {
    const result = normalizeGoodsSession(validSession(), fakeEvent());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const addr = result.order.shipping_address;
    expect(addr).not.toHaveProperty("state");
  });
});

// ── S2-CHK-4 (S2-T-SES-01): spike-shaped completed session ───────────────────

describe("S2-CHK-4 (S2-T-SES-01): normalizeGoodsSession — A1 spike payload → capture-check draft, all fields", () => {
  it("the authorized (unpaid) spike session normalizes to a complete draft with captureCheck:true", () => {
    const result = normalizeGoodsSession(validSession(), fakeEvent());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.captureCheck).toBe(true);

    const o = result.order;
    expect(o.stripe_checkout_session_id).toBe("cs_test_s2test0000000001");
    expect(o.stripe_payment_intent_id).toBe("pi_s2test0000000001");
    expect(o.stripe_invoice_id).toBeNull(); // A1: no invoice
    expect(o.stripe_customer_id).toBeNull(); // A1: no Customer
    expect(o.email).toBe("buyer@test.local");
    expect(o.customer_name).toBe("Spike Køber");
    expect(o.phone).toBe("+4520123456");
    expect(o.shipping_name).toBe("Spike Køber");
    expect(o.shipping_address).toMatchObject({
      line1: "Testvej 1",
      postal_code: "7860",
      city: "Spøttrup",
      country: "DK",
    });
    expect(o.shipping_address).not.toHaveProperty("state"); // spike state:"" dropped
    expect(o.locale).toBe("da");
    expect(o.currency).toBe("dkk");
    expect(o.amount_total_ore).toBe(24995);
    expect(o.amount_tax_ore).toBe(4999);
    expect(o.amount_subtotal_ore).toBe(24995);
    expect(o.stripe_consent).toBe("accepted");
    expect(o.terms_version).toBe(GOODS_TEXT_VERSION);
    expect(o.anomaly).toBeNull();
    expect(o.paid_at).toBe(new Date(1_800_000_000 * 1000).toISOString());
    expect(o.user_id).toBeNull(); // guest (client_reference_id null)
    // A draft: the capture fields come from the payment intent, not the session
    expect(o).not.toHaveProperty("capture_state");
    expect(o).not.toHaveProperty("authorization_expires_at");
    expect(o.lines).toHaveLength(1);
    expect(o.lines[0]).toMatchObject({
      line_no: 1,
      offer_kind: "physical",
      title: "Testfigur",
      quantity: 1,
      unit_amount_ore: 24995,
    });
  });

  it("the subtotal is stored as Stripe reports it; without one, the total (Stripe's subtotal includes the inclusive moms)", () => {
    const reported = normalizeGoodsSession(validSession({ amount_subtotal: 25995 }), fakeEvent());
    expect(reported.ok && reported.order.amount_subtotal_ore).toBe(25995);
    const session = validSession();
    delete session.amount_subtotal;
    const missing = normalizeGoodsSession(session, fakeEvent());
    expect(missing.ok && missing.order.amount_subtotal_ore).toBe(24995);
  });
});

// ── S2-CAP-1 (S2-T-SES-14..15): unpaid → capture check; paid → captured at Checkout ──

describe("S2-CAP-1 (S2-T-SES-14..15): normalizeGoodsSession — payment_status decides the capture check", () => {
  it("S2-T-SES-14: complete + payment_status=unpaid → {ok:true, captureCheck:true} (also for async_payment_succeeded)", () => {
    for (const type of ["checkout.session.completed", "checkout.session.async_payment_succeeded"]) {
      const result = normalizeGoodsSession(validSession(), fakeEvent(type));
      expect(result).toMatchObject({ ok: true, captureCheck: true });
    }
  });

  it("S2-T-SES-15: complete + payment_status=paid → captureCheck:false, capture_state succeeded, captured_at_checkout anomaly", () => {
    const result = normalizeGoodsSession(
      validSession({ payment_status: "paid", total_details: { amount_tax: 1234 } }),
      fakeEvent(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.captureCheck) throw new Error("expected a complete order");
    expect(result.order.capture_state).toBe("succeeded");
    expect(result.order.authorization_expires_at).toBeNull();
    // Canonical order: the session's anomalies first, captured_at_checkout last
    expect(result.order.anomaly).toBe("tax_mismatch,captured_at_checkout");
  });
});

// ── S2-CAP-1 (S2-T-SES-16..20): applyGoodsPaymentIntent ─────────────────────

describe("S2-CAP-1 (S2-T-SES-16..20): applyGoodsPaymentIntent — the payment intent completes the draft", () => {
  it("S2-T-SES-16: requires_capture with card capture_before → requires_capture + authorization_expires_at (ISO)", () => {
    const result = applyGoodsPaymentIntent(spikeDraft(), spikeIntent());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.capture_state).toBe("requires_capture");
    expect(result.order.authorization_expires_at).toBe(new Date(CAPTURE_BEFORE * 1000).toISOString());
    expect(result.order.anomaly).toBeNull();
    expect(result.order.stripe_checkout_session_id).toBe("cs_test_s2test0000000001");
  });

  it.each([
    { label: "latest_charge not expanded (a ch_ id)", latest: "ch_s2test0000000001" },
    { label: "a non-card method (no card details)", latest: { id: "ch_x", payment_method_details: { type: "klarna", klarna: {} } } },
    { label: "capture_before not a Unix time", latest: { id: "ch_x", payment_method_details: { card: { capture_before: "soon" } } } },
  ])("S2-T-SES-17: requires_capture, $label → authorization_expires_at null", ({ latest }) => {
    const result = applyGoodsPaymentIntent(spikeDraft(), spikeIntent({ latest_charge: latest }));
    expect(result).toMatchObject({ ok: true, order: { capture_state: "requires_capture", authorization_expires_at: null } });
  });

  it("S2-T-SES-18: succeeded (captured at Checkout) → capture_state succeeded + captured_at_checkout appended in order", () => {
    const draft = spikeDraft({ consent: { terms_of_service: null } });
    expect(draft.anomaly).toBe("consent_missing");
    const result = applyGoodsPaymentIntent(draft, spikeIntent({ status: "succeeded", amount_received: 24995 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.capture_state).toBe("succeeded");
    expect(result.order.authorization_expires_at).toBeNull();
    expect(result.order.anomaly).toBe("consent_missing,captured_at_checkout");
  });

  it.each(["processing", "requires_action", "requires_payment_method", "canceled", undefined])(
    "S2-T-SES-19: status %s → {ok:false, reason:'awaiting_payment'}",
    (status) => {
      expect(applyGoodsPaymentIntent(spikeDraft(), spikeIntent({ status }))).toEqual({
        ok: false,
        reason: "awaiting_payment",
      });
    },
  );

  it.each([
    { label: "another payment intent's id", intent: spikeIntent({ id: "pi_other0000000001" }) },
    { label: "null", intent: null },
    { label: "an array", intent: [spikeIntent()] },
  ])("S2-T-SES-20: $label → {ok:false, reason:'invalid_payment_intent'}", ({ intent }) => {
    expect(applyGoodsPaymentIntent(spikeDraft(), intent)).toEqual({ ok: false, reason: "invalid_payment_intent" });
  });
});
