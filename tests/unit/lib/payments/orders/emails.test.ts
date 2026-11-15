/**
 * Unit tests: src/lib/payments/orders/emails.ts — order email builders
 * Journey: payments-s2-3d-purchase
 * Criteria: S2-WH-1 (email content gates), S2-ADM-14..18 (refund emails),
 *           S2-WD-7 (the buyer's withdrawal receipt and the owner's alert), S2-WD-12 (a late
 *           notice flagged to the owner), S2-SWP-5 (the owner's refund reminder), S2-ADM-17
 *           (the owner's manual-handling alert),
 *           S2-DOC-1..6 (amendments A1/A2 documents: the order confirmation is the invoice, the
 *           shipped email refers to it, the credit notes of a refund and of a cancellation, owner
 *           capture warning / lapsed reservation / refused capture)
 *
 * Coverage:
 *   - buildOrderConfirmationEmail: "Ordrebekræftelse og faktura nr. <n>" (forenklet faktura):
 *     invoice and order number and date, seller + CVR, item, quantity, total incl. moms,
 *     "heraf moms (25 %)", the reservation sentence, shipping address, withdraw link, notice
 *   - buildOrderOwnerEmail: subject, order number, item, amount, buyer name+address+phone+email,
 *     anomaly field if present, reservation expiry when known
 *   - buildOrderShippedEmail: "Din ordre nr. <n> er sendt": the amount now charged with its moms
 *     and the invoice it appears on (no second invoice); tracking ref, withdraw link, returns
 *   - buildOrderWithdrawalAckEmail: exact subject, notice time, return instructions and refund
 *     deadline (shipped), release wording (not shipped)
 *   - buildOrderWithdrawalAlertEmail: exact subject and lines, "SEND IKKE" when not shipped, the
 *     shipped copy, the exact late line only when late
 *   - buildOrderRefundReceiptEmail: "Kreditnota til faktura nr. <n>": date, amount credited,
 *     moms, deduction
 *   - buildOrderCancellationReceiptEmail: "Kreditnota til faktura nr. <n>" for the whole amount,
 *     nothing charged, reservation released
 *   - buildOrderCaptureWarningEmail / buildOrderAuthorizationExpiredEmail /
 *     buildOrderCaptureFailedEmail (owner)
 *   - buildOrderRefundReminderEmail: exact subject with the deadline, the deadline line
 *   - buildOrderManualAlertEmail: subject, each reason's text, runbook, admin link
 *   - All builders return EmailContent with text and html
 *   - No em-dash in any output
 */
import { describe, expect, it } from "vitest";
import {
  buildOrderAuthorizationExpiredEmail,
  buildOrderCancellationReceiptEmail,
  buildOrderCaptureFailedEmail,
  buildOrderCaptureWarningEmail,
  buildOrderConfirmationEmail,
  buildOrderManualAlertEmail,
  buildOrderOwnerEmail,
  buildOrderShippedEmail,
  buildOrderWithdrawalAckEmail,
  buildOrderWithdrawalAlertEmail,
  buildOrderRefundReceiptEmail,
  buildOrderRefundReminderEmail,
} from "@/lib/payments/orders/emails";

// ── Shared fixtures ────────────────────────────────────────────────────────────

const ORDER = {
  orderNumber: 1001,
  itemTitle: "Testfigur DA",
  quantity: 1,
  amountTotalOre: 24995,
  email: "buyer@test.local",
  customerName: "Lars Andersen",
  phone: "+4520123456",
  shippingName: "Lars Andersen",
  shippingAddress: { line1: "Testvej 1", line2: null, postal_code: "7860", city: "Spøttrup", country: "DK" },
  locale: "da" as const,
  paidAt: "2026-11-14T10:00:00Z",
};

const ORDER_EN = { ...ORDER, locale: "en" as const };

const WITHDRAWAL = {
  id: "00000000-0000-0000-0000-000000000001",
  consumerName: "Lars Andersen",
  requestedAt: "2026-11-14T12:00:00Z",
  refundDueAt: "2026-11-28T12:00:00Z",
  late: false,
  shippedBeforeNotice: true,
  deadlineAt: "2026-12-05T23:59:00Z",
  locale: "da" as const,
  refundOre: 24995,
};

const ADMIN_LINK = "https://alnyron.dk/admin/orders/1001";
const SITE_ORIGIN = "https://alnyron.dk";
const TRACKING = "GLS123456";
const WITHDRAW_LINK_DA = `${SITE_ORIGIN}/order/withdraw?o=00000000&t=token&lang=da`;
/** The reservation released 16 Nov 2026, Copenhagen (the cancellation credit note's date). */
const RELEASED_AT = "2026-11-16T09:00:00Z";
/** The card reservation lapses 21 Nov 2026 10:00 UTC = 11.00 in Copenhagen. */
const EXPIRES_AT = "2026-11-21T10:00:00Z";

// ── buildOrderConfirmationEmail (the invoice) ─────────────────────────────────

describe("buildOrderConfirmationEmail: required content", () => {
  it("S2-DOC-1: 'Ordrebekræftelse og faktura nr. <n>' is a forenklet faktura with the reservation sentence", () => {
    const email = buildOrderConfirmationEmail({ order: ORDER, withdrawLink: WITHDRAW_LINK_DA, siteOrigin: SITE_ORIGIN });
    expect(email.subject).toBe("Ordrebekræftelse og faktura nr. 1001");
    for (const line of [
      "Ordrebekræftelse og faktura nr. 1001", // the heading
      "Faktura- og ordrenummer: 1001",
      "Faktura- og ordredato: 14. november 2026", // paid_at
      "Alnyron, Nyvej 4, 7860 Spøttrup, Danmark, CVR 46887433",
      "Vare: Testfigur DA",
      "Antal: 1",
      "I alt inkl. moms og levering: 249,95 kr.",
      "heraf moms (25 %): 49,99 kr.", // inclusiveVatOre(24995) = 4999
      "Beløbet reserveres ved bestillingen og trækkes først, når varen sendes.",
      // The existing order-confirmation content stays
      "Testvej 1",
      "Varen sendes inden for 3 hverdage.",
      "Fortrydelsesret",
      "Send varen til Alnyron, Nyvej 4, 7860 Spøttrup",
      "Standardfortrydelsesformular",
      WITHDRAW_LINK_DA,
    ]) {
      expect(email.text).toContain(line);
    }
    expect(email.text).not.toContain("dit kort");
  });

  it("S2-DOC-1: EN 'Order confirmation and invoice no. <n>'", () => {
    const email = buildOrderConfirmationEmail({ order: ORDER_EN, withdrawLink: WITHDRAW_LINK_DA, siteOrigin: SITE_ORIGIN });
    expect(email.subject).toBe("Order confirmation and invoice no. 1001");
    for (const line of [
      "Invoice and order number: 1001",
      "Invoice and order date: 14 November 2026",
      "Quantity: 1",
      "Total incl. VAT and delivery: 249.95 kr.",
      "of which VAT (25%): 49.99 kr.",
      "The amount is reserved when you order and charged only when the goods are sent.",
    ]) {
      expect(email.text).toContain(line);
    }
    expect(email.text).not.toContain("your card");
  });

  it("S2-DOC-1: the moms line is the 25 % included in the total (inclusiveVatOre), not a stored tax amount", () => {
    const email = buildOrderConfirmationEmail({
      order: { ...ORDER, quantity: 2, amountTotalOre: 50000 },
      withdrawLink: WITHDRAW_LINK_DA,
      siteOrigin: SITE_ORIGIN,
    });
    expect(email.text).toContain("Antal: 2");
    expect(email.text).toContain("I alt inkl. moms og levering: 500 kr.");
    expect(email.text).toContain("heraf moms (25 %): 100 kr.");
  });

  it("S2-DOC-1: the invoice names the buyer and the buyer's address at any amount (a full invoice's parties)", () => {
    const email = buildOrderConfirmationEmail({
      order: { ...ORDER, customerName: "Lars Køber", shippingName: "Mette Modtager" },
      withdrawLink: WITHDRAW_LINK_DA,
      siteOrigin: SITE_ORIGIN,
    });
    const text = email.text;
    // In this order after the seller's CVR: the buyer heading, the name given at Checkout, the
    // address, then the delivery block (whose name is the recipient's). Each is searched from the
    // previous one, so -1 means missing or out of order.
    const labels = ["CVR 46887433", "Køber\n", "Lars Køber", "Testvej 1", "7860 Spøttrup", "Danmark", "Leveringsadresse", "Mette Modtager"];
    const positions: number[] = [];
    for (const label of labels) positions.push(text.indexOf(label, positions.at(-1) ?? 0));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(email.html).toContain("Køber");
  });

  it("S2-DOC-1: the buyer's name falls back to the delivery name, then the email; EN heading 'Buyer'", () => {
    const noName = buildOrderConfirmationEmail({
      order: { ...ORDER_EN, customerName: null, shippingName: null, shippingAddress: null },
      withdrawLink: WITHDRAW_LINK_DA,
      siteOrigin: SITE_ORIGIN,
    });
    expect(noName.text).toContain("Buyer\n");
    expect(noName.text.indexOf("buyer@test.local")).toBeGreaterThan(noName.text.indexOf("Buyer\n"));
    const delivery = buildOrderConfirmationEmail({
      order: { ...ORDER, customerName: null },
      withdrawLink: WITHDRAW_LINK_DA,
      siteOrigin: SITE_ORIGIN,
    });
    expect(delivery.text.indexOf("Lars Andersen")).toBeGreaterThan(delivery.text.indexOf("Køber\n"));
  });

  it("buyer data is never a template: a '{x}' in the name is shown verbatim and escaped in HTML", () => {
    const email = buildOrderConfirmationEmail({
      order: { ...ORDER, shippingName: "<b>{orderNumber}</b>" },
      withdrawLink: WITHDRAW_LINK_DA,
      siteOrigin: SITE_ORIGIN,
    });
    expect(email.text).toContain("<b>{orderNumber}</b>");
    expect(email.html).not.toContain("<b>{orderNumber}</b>");
  });

  it("contains no em-dash", () => {
    const email = buildOrderConfirmationEmail({ order: ORDER, withdrawLink: WITHDRAW_LINK_DA, siteOrigin: SITE_ORIGIN });
    expect(email.text).not.toContain("\u2014");
    expect(email.html).not.toContain("\u2014");
  });
});

// ── buildOrderOwnerEmail ──────────────────────────────────────────────────────

describe("buildOrderOwnerEmail: required content", () => {
  it("contains order number, item, amount, buyer details, admin link", () => {
    const email = buildOrderOwnerEmail({ order: ORDER, adminLink: ADMIN_LINK });
    expect(email.text).toContain("1001");
    expect(email.text).toContain("Testfigur DA");
    expect(email.text).toContain("Lars Andersen");
    expect(email.text).toContain("buyer@test.local");
    expect(email.text).toContain(ADMIN_LINK);
  });

  it("includes anomaly when present", () => {
    const email = buildOrderOwnerEmail({
      order: { ...ORDER, anomaly: "consent_missing,tax_mismatch" },
      adminLink: ADMIN_LINK,
    });
    expect(email.text).toContain("consent_missing");
  });

  it("S2-DOC-5: says the amount is reserved, and when the reservation lapses only when known", () => {
    const withExpiry = buildOrderOwnerEmail({ order: { ...ORDER, authorizationExpiresAt: EXPIRES_AT }, adminLink: ADMIN_LINK });
    expect(withExpiry.text).toContain("Beløbet er reserveret og trækkes, når du markerer ordren afsendt.");
    expect(withExpiry.text).toContain("Reservationen udløber 21. november 2026 kl. 11.00.");
    const without = buildOrderOwnerEmail({ order: { ...ORDER, authorizationExpiresAt: null }, adminLink: ADMIN_LINK });
    expect(without.text).not.toContain("Reservationen udløber");
  });

  it("contains no em-dash", () => {
    const email = buildOrderOwnerEmail({ order: ORDER, adminLink: ADMIN_LINK });
    expect(email.text).not.toContain("\u2014");
  });
});

// ── buildOrderShippedEmail (not an invoice) ─────────────────────────────────────

describe("buildOrderShippedEmail: required content", () => {
  it("contains tracking ref and withdraw link", () => {
    const email = buildOrderShippedEmail({ order: ORDER, trackingRef: TRACKING, withdrawLink: WITHDRAW_LINK_DA });
    expect(email.text).toContain(TRACKING);
    expect(email.text).toContain(WITHDRAW_LINK_DA);
  });

  it("works without tracking ref", () => {
    const email = buildOrderShippedEmail({ order: ORDER, trackingRef: null, withdrawLink: WITHDRAW_LINK_DA });
    expect(email.text).not.toContain("Forsendelsesnummer");
  });

  it("S2-DOC-2: 'Din ordre nr. <n> er sendt' with the amount now charged and the invoice it appears on, no second invoice", () => {
    const email = buildOrderShippedEmail({ order: ORDER, trackingRef: TRACKING, withdrawLink: WITHDRAW_LINK_DA });
    expect(email.subject).toBe("Din ordre nr. 1001 er sendt");
    for (const line of [
      "Vi har sendt Testfigur DA til den adresse, du opgav ved bestillingen.",
      "Beløbet på 249,95 kr. (heraf moms 25 %: 49,99 kr.) er nu trukket. Det fremgår af faktura nr. 1001 i din ordrebekræftelse.",
      `Forsendelsesnummer: ${TRACKING}`,
      "Din fortrydelsesfrist på 14 dage løber fra den dag, du modtager varen.",
      `Fortryd online med dit personlige link: ${WITHDRAW_LINK_DA}`,
      "Send varen til Alnyron, Nyvej 4, 7860 Spøttrup",
    ]) {
      expect(email.text).toContain(line);
    }
    for (const invoiceOnly of ["Faktura/kvittering", "Fakturanummer", "Fakturadato", "Køber", "ekskl. moms"]) {
      expect(email.text).not.toContain(invoiceOnly);
    }
  });

  it("S2-DOC-2: EN shipped email", () => {
    const email = buildOrderShippedEmail({ order: ORDER_EN, trackingRef: null, withdrawLink: WITHDRAW_LINK_DA });
    expect(email.subject).toBe("Your order no. 1001 has been sent");
    expect(email.text).toContain(
      "The amount of 249.95 kr. (of which VAT 25%: 49.99 kr.) has now been charged. It appears on invoice no. 1001 in your order confirmation.",
    );
    expect(email.text).not.toContain("Invoice/receipt");
  });

  it("contains no em-dash", () => {
    const email = buildOrderShippedEmail({ order: ORDER, trackingRef: TRACKING, withdrawLink: WITHDRAW_LINK_DA });
    expect(email.text).not.toContain("\u2014");
    expect(email.html).not.toContain("\u2014");
  });
});

// ── buildOrderWithdrawalAckEmail ──────────────────────────────────────────────

describe("S2-WD-7: buildOrderWithdrawalAckEmail (the buyer's receipt of the notice)", () => {
  it("shipped: the exact subject, the notice time, the return instructions and the refund deadline", () => {
    const email = buildOrderWithdrawalAckEmail({ order: ORDER, withdrawal: WITHDRAWAL, siteOrigin: SITE_ORIGIN });
    expect(email.subject).toBe("Vi har modtaget din fortrydelse (ordre 1001)");
    for (const line of [
      "Kære Lars Andersen",
      // requestedAt 12:00 UTC = 13.00 in Copenhagen
      "Vi bekræfter, at vi den 14. november 2026 kl. 13.00 har modtaget din meddelelse om, at du fortryder din aftale om køb af Testfigur DA (ordre 1001).",
      "Send varen retur som beskrevet herunder.",
      "Send varen til Alnyron, Nyvej 4, 7860 Spøttrup",
      "Vi tilbagebetaler alle betalinger fra dig, herunder levering, senest den 28. november 2026 med samme betalingsmiddel, som du brugte ved købet.",
    ]) {
      expect(email.text).toContain(line);
    }
    expect(email.text).not.toContain("\u2014");
  });

  it("not shipped: the reservation is released, the buyer is not charged (method-neutral), nothing to return", () => {
    const email = buildOrderWithdrawalAckEmail({
      order: ORDER,
      withdrawal: { ...WITHDRAWAL, shippedBeforeNotice: false },
      siteOrigin: SITE_ORIGIN,
    });
    expect(email.subject).toBe("Vi har modtaget din fortrydelse (ordre 1001)");
    expect(email.text).toContain("Varen er ikke sendt, og vi sender den ikke. Du skal ikke returnere noget.");
    expect(email.text).toContain("Du bliver ikke trukket for varen: vi frigiver det reserverede beløb senest den 28. november 2026.");
    expect(email.text).not.toContain("Send varen retur");
    expect(email.text).not.toContain("dit kort");
  });
});

// ── buildOrderWithdrawalAlertEmail ────────────────────────────────────────────

describe("S2-WD-7: buildOrderWithdrawalAlertEmail (the owner's alert of a notice)", () => {
  it("the exact subject, the notice lines, the refund or release deadline and the admin link", () => {
    const email = buildOrderWithdrawalAlertEmail({ order: ORDER, withdrawal: WITHDRAWAL, adminLink: ADMIN_LINK });
    expect(email.subject).toBe("Fortrydelse modtaget: ordre 1001");
    for (const line of [
      "Ordre: 1001",
      "Vare: Testfigur DA",
      "Kundens navn: Lars Andersen",
      "Modtaget: 14. november 2026 kl. 13.00",
      "Tilbagebetal eller frigiv reservationen senest 28. november 2026, 14 dage efter modtagelsen.",
      `Se ordren: ${ADMIN_LINK}`,
    ]) {
      expect(email.text).toContain(line);
    }
    expect(email.text).not.toContain("\u2014");
  });

  it("not shipped: 'SEND IKKE VAREN' and that approving releases the reservation, not the shipped copy", () => {
    const email = buildOrderWithdrawalAlertEmail({
      order: ORDER,
      withdrawal: { ...WITHDRAWAL, shippedBeforeNotice: false },
      adminLink: ADMIN_LINK,
    });
    expect(email.text).toContain(
      "SEND IKKE VAREN. Kunden har fortrudt, før varen blev sendt. Godkend fortrydelsen på ordresiden, så reservationen frigives.",
    );
    expect(email.text).not.toContain("Varen er sendt.");
  });

  it("shipped: approve the refund once the goods are back, no 'SEND IKKE'", () => {
    const email = buildOrderWithdrawalAlertEmail({ order: ORDER, withdrawal: WITHDRAWAL, adminLink: ADMIN_LINK });
    expect(email.text).toContain(
      "Varen er sendt. Godkend tilbagebetalingen på ordresiden, når varen er kommet retur, eller kunden har vist, at den er sendt.",
    );
    expect(email.text).not.toContain("SEND IKKE");
  });
});

describe("S2-WD-12: the owner's alert flags a late notice", () => {
  /** The period ends at the start of 14 Nov 2026 in Copenhagen: its last day is 13 November. */
  const DEADLINE_AT = "2026-11-13T23:00:00Z";

  it("late: the exact 'OBS' line with the period's last day", () => {
    const email = buildOrderWithdrawalAlertEmail({
      order: ORDER,
      withdrawal: { ...WITHDRAWAL, late: true, deadlineAt: DEADLINE_AT },
      adminLink: ADMIN_LINK,
    });
    expect(email.text).toContain(
      "OBS: Fortrydelsen kom for sent (fristen udløb 13. november 2026). Vurdér den, før du tilbagebetaler.",
    );
  });

  it("on time: no late line", () => {
    const email = buildOrderWithdrawalAlertEmail({
      order: ORDER,
      withdrawal: { ...WITHDRAWAL, late: false, deadlineAt: DEADLINE_AT },
      adminLink: ADMIN_LINK,
    });
    expect(email.text).not.toContain("OBS:");
    expect(email.text).not.toContain("kom for sent");
  });
});

// ── buildOrderRefundReceiptEmail (the credit note) ────────────────────────────

describe("buildOrderRefundReceiptEmail: required content", () => {
  const REFUNDED_AT = "2026-11-25T12:00:00Z";

  it("contains refund amount", () => {
    const email = buildOrderRefundReceiptEmail({
      order: ORDER,
      withdrawal: { ...WITHDRAWAL, refundOre: 24995, refundedAt: REFUNDED_AT },
      siteOrigin: SITE_ORIGIN,
    });
    expect(email.text).toContain("249,95 kr.");
    expect(email.text).not.toContain("\u2014");
  });

  it("S2-DOC-3: is 'Kreditnota til faktura nr. <order_number>' with the date, the amount credited, its moms and the deduction", () => {
    // 24995 − 5000 deduction → 19995 refunded; moms inclusiveVatOre(19995) = 3999
    const email = buildOrderRefundReceiptEmail({
      order: ORDER,
      withdrawal: {
        ...WITHDRAWAL,
        refundOre: 19995,
        refundedAt: REFUNDED_AT,
        deductionOre: 5000,
        deductionReason: "Ridser i lakken",
      },
      siteOrigin: SITE_ORIGIN,
    });
    expect(email.subject).toBe("Kreditnota til faktura nr. 1001");
    for (const line of [
      "Kreditnota til faktura nr. 1001",
      "Dato: 25. november 2026",
      "Krediteret beløb inkl. moms: 199,95 kr.",
      "\nSælger\n\nAlnyron, Nyvej 4, 7860 Spøttrup, Danmark, CVR 46887433", // the seller as on the invoice
      "heraf moms (25 %): 39,99 kr.",
      "Vi har trukket 50 kr. fra for værdiforringelse af varen. Begrundelse: Ridser i lakken", // formatKroner: whole kroner without ",00"
    ]) {
      expect(email.text).toContain(line);
    }
  });

  it("S2-DOC-3: EN credit note", () => {
    const email = buildOrderRefundReceiptEmail({
      order: ORDER_EN,
      withdrawal: { ...WITHDRAWAL, locale: "en", refundOre: 24995, refundedAt: REFUNDED_AT },
      siteOrigin: SITE_ORIGIN,
    });
    expect(email.subject).toBe("Credit note for invoice no. 1001");
    expect(email.text).toContain("Amount credited incl. VAT: 249.95 kr.");
    expect(email.text).toContain("\nSeller\n\nAlnyron, Nyvej 4, 7860 Spøttrup, Denmark, CVR 46887433");
    expect(email.text).toContain("of which VAT (25%): 49.99 kr.");
    expect(email.text).not.toContain("diminished value of the goods. Reason");
  });
});

// ── buildOrderCancellationReceiptEmail (the credit note of a release) ──────────

describe("S2-DOC-4: buildOrderCancellationReceiptEmail: withdrawn before dispatch, the credit note for the whole amount", () => {
  it("DA: 'Kreditnota til faktura nr. <n>', canceled order, not charged, reservation released", () => {
    const email = buildOrderCancellationReceiptEmail({
      order: ORDER,
      withdrawal: { ...WITHDRAWAL, shippedBeforeNotice: false, refundOre: null, canceledAt: RELEASED_AT },
      siteOrigin: SITE_ORIGIN,
    });
    expect(email.subject).toBe("Kreditnota til faktura nr. 1001");
    for (const line of [
      "Kære Lars Andersen",
      "Vi har annulleret ordre 1001 (Testfigur DA)",
      "Du er ikke blevet trukket for ordren.",
      "Vi har frigivet det reserverede beløb.",
      "Kreditnota til faktura nr. 1001",
      "Dato: 16. november 2026", // the release date
      "Krediteret beløb inkl. moms: 249,95 kr.",
      "\nSælger\n\nAlnyron, Nyvej 4, 7860 Spøttrup, Danmark, CVR 46887433", // the seller as on the invoice
      "heraf moms (25 %): 49,99 kr.",
    ]) {
      expect(email.text).toContain(line);
    }
    expect(email.text).not.toContain("dit kort");
    expect(email.text).not.toContain("\u2014");
  });

  it("EN: follows the withdrawal's language", () => {
    const email = buildOrderCancellationReceiptEmail({
      order: ORDER,
      withdrawal: { ...WITHDRAWAL, locale: "en", shippedBeforeNotice: false, refundOre: null, canceledAt: RELEASED_AT },
      siteOrigin: SITE_ORIGIN,
    });
    expect(email.subject).toBe("Credit note for invoice no. 1001");
    expect(email.text).toContain("You have not been charged for the order.");
    expect(email.text).toContain("Amount credited incl. VAT: 249.95 kr.");
    expect(email.text).toContain("of which VAT (25%): 49.99 kr.");
  });
});

// ── Owner: capture warning, lapsed reservation and refused capture ─────────────

describe("S2-DOC-5: owner capture warning and authorization-expired emails (Danish)", () => {
  it("capture warning: when the reservation lapses, what to do, admin link", () => {
    const email = buildOrderCaptureWarningEmail({
      order: { ...ORDER, authorizationExpiresAt: EXPIRES_AT },
      adminLink: ADMIN_LINK,
    });
    expect(email.subject).toBe("Ordre 1001: betalingen udløber 21. november 2026 kl. 11.00");
    expect(email.text).toContain("Send varen, og markér ordren afsendt inden da, ellers bortfalder betalingen.");
    expect(email.text).toContain("Beløb: 249,95 kr. inkl. moms");
    expect(email.text).toContain(ADMIN_LINK);
    expect(email.text).not.toContain("\u2014");
  });

  it("authorization expired: do not send the goods, nothing was charged, buyer's email, admin link", () => {
    const email = buildOrderAuthorizationExpiredEmail({ order: ORDER, adminLink: ADMIN_LINK });
    expect(email.subject).toBe("Ordre 1001: betalingen er udløbet");
    expect(email.text).toContain("Betalingen for ordre 1001 er udløbet; send ikke varen.");
    expect(email.text).toContain("Køberens e-mail: buyer@test.local");
    expect(email.text).toContain(ADMIN_LINK);
    expect(email.text).not.toContain("\u2014");
  });
});

describe("S2-DOC-6: owner alert for a capture Stripe refused (amendment A2-3, Danish)", () => {
  it("do not send the goods before it is resolved, not marked shipped, buyer's email, admin link", () => {
    const email = buildOrderCaptureFailedEmail({ order: ORDER, adminLink: ADMIN_LINK });
    expect(email.subject).toBe("Ordre 1001: betalingen kunne ikke trækkes");
    for (const line of [
      "Betalingen for ordre 1001 kunne ikke trækkes. Send ikke varen, før det er løst.",
      "Beløb: 249,95 kr. inkl. moms",
      "Køberens e-mail: buyer@test.local",
      "Ordren er ikke markeret som afsendt.",
      ADMIN_LINK,
    ]) {
      expect(email.text).toContain(line);
    }
    expect(email.text).not.toContain("\u2014");
  });
});

// ── buildOrderRefundReminderEmail ─────────────────────────────────────────────

describe("S2-SWP-5: buildOrderRefundReminderEmail (the owner's reminder)", () => {
  it("the exact subject with the deadline, the notice lines, the deadline line and the admin link", () => {
    const email = buildOrderRefundReminderEmail({ order: ORDER, withdrawal: WITHDRAWAL, adminLink: ADMIN_LINK });
    expect(email.subject).toBe("Påmindelse: tilbagebetal ordre 1001 senest 28. november 2026");
    for (const line of [
      "En fortrydelse venter stadig på, at du godkender tilbagebetalingen eller frigivelsen af reservationen.",
      "Ordre: 1001",
      "Kundens navn: Lars Andersen",
      "Modtaget: 14. november 2026 kl. 13.00",
      "Tilbagebetal eller frigiv reservationen senest 28. november 2026, 14 dage efter modtagelsen.",
      `Se ordren: ${ADMIN_LINK}`,
    ]) {
      expect(email.text).toContain(line);
    }
    expect(email.text).not.toContain("\u2014");
  });
});

// ── buildOrderManualAlertEmail ────────────────────────────────────────────────

describe("S2-ADM-17: buildOrderManualAlertEmail (a refund or release that needs manual handling)", () => {
  it.each([
    ["stripe_refused", "Årsag: Stripe afviste tilbagebetalingen eller frigivelsen af reservationen."],
    ["retries_exhausted", "Årsag: Tilbagebetalingen eller frigivelsen fejlede for mange gange."],
  ] as const)("%s: the subject, the order and withdrawal, the reason's text, the runbook and the admin link", (reason, reasonLine) => {
    const email = buildOrderManualAlertEmail({ order: ORDER, withdrawalId: WITHDRAWAL.id, reason, adminLink: ADMIN_LINK });
    expect(email.subject).toBe("Ordre 1001: fortrydelsen kræver manuel behandling");
    for (const line of [
      "En tilbagebetaling eller frigivelse af en reservation kunne ikke gennemføres automatisk.",
      "Ordre: 1001",
      "Fortrydelse: 00000000-0000-0000-0000-000000000001",
      reasonLine,
      'Fremgangsmåde: workers/payments/README.md, afsnittet "Ordrer: manuel behandling".',
      `Se ordren: ${ADMIN_LINK}`,
    ]) {
      expect(email.text).toContain(line);
    }
    expect(email.html).toContain(`<a href="${ADMIN_LINK}"`);
    expect(email.text).not.toContain("\u2014");
  });
});
