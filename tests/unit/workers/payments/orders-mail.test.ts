/**
 * Unit tests: workers/payments/orders/mail.ts — the real goods mailer (createOrderMailer) on a
 * fake fetch: each email's recipient, Resend Idempotency-Key and subject, the personal withdraw
 * link, the two credit note branches and the emails that are not due
 * Journey: payments-s2-3d-purchase
 * Criteria: S2-DOC-1, S2-DOC-2, S2-WD-1 (S2-T-ML-01), S2-DOC-5, S2-DOC-6 (S2-T-ML-02),
 *   S2-WD-7 (S2-T-ML-03), S2-DOC-3, S2-DOC-4 (S2-T-ML-04), S2-ADM-17 (S2-T-ML-05)
 *
 * Coverage:
 *   - buyer emails (confirmation = invoice, shipped) to the order's email in the order's language,
 *     with the withdraw link /order/withdraw?o=<id>&t=<HMAC-SHA256 of "order-link:v1:<id>">&lang=
 *   - owner emails (new order, capture warning, lapsed reservation, refused capture, withdrawal
 *     alert, refund reminder, manual alert) to ORDER_NOTIFY_TO with the admin order link
 *   - the withdrawal receipt to the order's email in the withdrawal's language
 *   - the credit note: of the refund, or of the released reservation; not due → MailNotDueError,
 *     nothing sent
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createOrderMailer, MailNotDueError } from "../../../../workers/payments/orders/mail";
import type { OrderSnapshot, OrderWithdrawalSnapshot } from "../../../../workers/payments/orders/rpc";

// Pre-commit secret scan: the literals live in *_FX constants.
const RESEND_FX = "re_unitordersmail1234";
const LINK_FX = "order-link-unit-fixture-32-characters-long";
const NOTIFY_TO = "info@alnyron.dk";
const BUYER = "delivered+s2-mail@resend.dev";
const ORDER_ID = "00000000-0000-0000-0000-0000000000b1";
const WD_ID = "00000000-0000-0000-0000-0000000000a1";
const ADMIN_LINK = "https://alnyron.dk/admin/orders/1001";

const ORDER: OrderSnapshot = {
  id: ORDER_ID,
  order_number: 1001,
  status: "authorized",
  email: BUYER,
  customer_name: "Lars Andersen",
  phone: "+4520123456",
  shipping_name: "Lars Andersen",
  shipping_address: { line1: "Testvej 1", line2: null, postal_code: "7860", city: "Spøttrup", country: "DK" },
  locale: "da",
  amount_total_ore: 24995,
  amount_refunded_ore: 0,
  paid_at: "2026-11-14T10:00:00.000Z",
  authorization_expires_at: "2026-11-21T10:00:00.000Z",
  captured_at: null,
  cancel_reason: null,
  anomaly: null,
  tracking_ref: null,
  stripe_payment_intent_id: "pi_ordersmail00000001",
  line: { title: "Testfigur", quantity: 1 },
};

const SHIPPED: OrderSnapshot = { ...ORDER, status: "shipped", captured_at: "2026-11-15T10:00:00.000Z", tracking_ref: "GLS123" };

const WITHDRAWAL: OrderWithdrawalSnapshot = {
  id: WD_ID,
  order_id: ORDER_ID,
  status: "received",
  consumer_name: "Lars Andersen",
  locale: "da",
  requested_at: "2026-11-16T10:00:00.000Z",
  refund_due_at: "2026-11-30T10:00:00.000Z",
  deadline_at: null,
  late: false,
  shipped_before_notice: false,
  action: null,
  refund_ore: null,
  deduction_ore: 0,
  deduction_reason: null,
  refunded_at: null,
  authorization_canceled_at: null,
  manual_reason: null,
  attempts: 0,
};

const REFUNDED: OrderWithdrawalSnapshot = {
  ...WITHDRAWAL,
  status: "completed",
  shipped_before_notice: true,
  action: "refund",
  refund_ore: 24995,
  refunded_at: "2026-11-20T10:00:00.000Z",
};

const RELEASED: OrderWithdrawalSnapshot = {
  ...WITHDRAWAL,
  status: "completed",
  action: "cancel_authorization",
  authorization_canceled_at: "2026-11-17T10:00:00.000Z",
};

type Sent = { url: string; key: string | null; auth: string | null; body: { from: string; to: string[]; subject: string; html: string; text: string } };

/** The mailer on a fake Resend: every request recorded, each answered with a fresh id. */
function fakeMailer() {
  const sent: Sent[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    sent.push({
      url: String(input),
      key: headers.get("idempotency-key"),
      auth: headers.get("authorization"),
      body: JSON.parse(String(init?.body)) as Sent["body"],
    });
    return new Response(JSON.stringify({ id: `em-${sent.length}` }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const mailer = createOrderMailer({
    resendApiKey: RESEND_FX,
    mailFrom: "Alnyron <noreply@send.alnyron.dk>",
    siteUrl: "https://alnyron.dk/some/path",
    ordersEnv: { orderLinkSecret: LINK_FX, orderNotifyTo: NOTIFY_TO, stripeTaxRateId: "txr_ordersmail0001" },
    fetchImpl,
  });
  return { mailer, sent };
}

/** The personal withdraw link, computed here with node:crypto (not the code under test). */
function withdrawLink(orderId: string, lang: string): string {
  const token = createHmac("sha256", LINK_FX).update(`order-link:v1:${orderId}`).digest("base64url");
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return `https://alnyron.dk/order/withdraw?o=${orderId}&t=${token}&lang=${lang}`;
}

describe("S2-DOC-1, S2-DOC-2, S2-WD-1 (S2-T-ML-01): the buyer's order emails carry the personal withdraw link", () => {
  it("confirmation (the invoice) → the order's email, order-confirm/<id>, the HMAC link with lang=da", async () => {
    const { mailer, sent } = fakeMailer();
    await expect(mailer.sendConfirmation(ORDER)).resolves.toEqual({ id: "em-1" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      url: "https://api.resend.com/emails",
      key: `order-confirm/${ORDER_ID}`,
      auth: `Bearer ${RESEND_FX}`,
      body: { from: "Alnyron <noreply@send.alnyron.dk>", to: [BUYER], subject: "Ordrebekræftelse og faktura nr. 1001" },
    });
    expect(sent[0]!.body.text).toContain(withdrawLink(ORDER_ID, "da"));
  });

  it("an English order → the English invoice with lang=en", async () => {
    const { mailer, sent } = fakeMailer();
    await mailer.sendConfirmation({ ...ORDER, locale: "en" });
    expect(sent[0]!.body.subject).toBe("Order confirmation and invoice no. 1001");
    expect(sent[0]!.body.text).toContain(withdrawLink(ORDER_ID, "en"));
    expect(sent[0]!.body.text).not.toContain("lang=da");
  });

  it("shipped → the order's email, order-shipped/<id>, the tracking reference and the HMAC link", async () => {
    const { mailer, sent } = fakeMailer();
    await mailer.sendShipped(SHIPPED);
    expect(sent[0]).toMatchObject({ key: `order-shipped/${ORDER_ID}`, body: { to: [BUYER], subject: "Din ordre nr. 1001 er sendt" } });
    expect(sent[0]!.body.text).toContain("GLS123");
    expect(sent[0]!.body.text).toContain(withdrawLink(ORDER_ID, "da"));
  });

  it("a token over the bare order id is not the link's token", async () => {
    const { mailer, sent } = fakeMailer();
    await mailer.sendShipped(SHIPPED);
    const bare = createHmac("sha256", LINK_FX).update(ORDER_ID).digest("base64url");
    expect(sent[0]!.body.text).not.toContain(bare);
  });
});

describe("S2-DOC-5, S2-DOC-6 (S2-T-ML-02): the owner's order emails → ORDER_NOTIFY_TO with the admin link", () => {
  it.each([
    { send: "sendOwnerNewOrder", key: `order-owner/${ORDER_ID}`, subject: "Ny ordre 1001: Testfigur" },
    { send: "sendCaptureWarning", key: `order-capture-warn/${ORDER_ID}`, subject: "Ordre 1001: betalingen udløber 21. november 2026 kl. 11.00" },
    { send: "sendAuthorizationExpired", key: `order-expired/${ORDER_ID}`, subject: "Ordre 1001: betalingen er udløbet" },
    { send: "sendCaptureFailed", key: `order-capture-failed/${ORDER_ID}`, subject: "Ordre 1001: betalingen kunne ikke trækkes" },
  ] as const)("$send → $key", async ({ send, key, subject }) => {
    const { mailer, sent } = fakeMailer();
    await mailer[send](ORDER);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ key, body: { to: [NOTIFY_TO], subject } });
    expect(sent[0]!.body.text).toContain(ADMIN_LINK);
  });

  it("a capture warning without an authorization expiry is not due: MailNotDueError, nothing sent", async () => {
    const { mailer, sent } = fakeMailer();
    await expect(mailer.sendCaptureWarning({ ...ORDER, authorization_expires_at: null })).rejects.toThrow(MailNotDueError);
    expect(sent).toEqual([]);
  });
});

describe("S2-WD-7 (S2-T-ML-03): the withdrawal receipt to the order's email, the owner's alert and reminder to ORDER_NOTIFY_TO", () => {
  it("ack → the order's email (not ORDER_NOTIFY_TO), order-wd-ack/<withdrawal id>, in the withdrawal's language", async () => {
    const { mailer, sent } = fakeMailer();
    await mailer.sendWithdrawalAck(ORDER, WITHDRAWAL);
    await mailer.sendWithdrawalAck(ORDER, { ...WITHDRAWAL, locale: "en" });
    expect(sent.map(({ key, body }) => [key, body.to, body.subject])).toEqual([
      [`order-wd-ack/${WD_ID}`, [BUYER], "Vi har modtaget din fortrydelse (ordre 1001)"],
      [`order-wd-ack/${WD_ID}`, [BUYER], "We have received your withdrawal (order 1001)"],
    ]);
  });

  it("alert → ORDER_NOTIFY_TO, order-wd-alert/<withdrawal id>, 'SEND IKKE VAREN' while not shipped, the admin link", async () => {
    const { mailer, sent } = fakeMailer();
    await mailer.sendWithdrawalAlert(ORDER, WITHDRAWAL);
    expect(sent[0]).toMatchObject({ key: `order-wd-alert/${WD_ID}`, body: { to: [NOTIFY_TO], subject: "Fortrydelse modtaget: ordre 1001" } });
    expect(sent[0]!.body.text).toContain("SEND IKKE VAREN.");
    expect(sent[0]!.body.text).toContain(ADMIN_LINK);
  });

  it("reminder → ORDER_NOTIFY_TO, order-wd-remind/<withdrawal id>, the refund deadline in the subject", async () => {
    const { mailer, sent } = fakeMailer();
    await mailer.sendRefundReminder(ORDER, WITHDRAWAL);
    expect(sent[0]).toMatchObject({
      key: `order-wd-remind/${WD_ID}`,
      body: { to: [NOTIFY_TO], subject: "Påmindelse: tilbagebetal ordre 1001 senest 30. november 2026" },
    });
  });
});

describe("S2-DOC-3, S2-DOC-4 (S2-T-ML-04): the credit note of a completed withdrawal, order-refund/<withdrawal id>", () => {
  it("a completed refund → the refund's credit note to the order's email", async () => {
    const { mailer, sent } = fakeMailer();
    await mailer.sendWithdrawalReceipt(SHIPPED, REFUNDED);
    expect(sent[0]).toMatchObject({ key: `order-refund/${WD_ID}`, body: { to: [BUYER], subject: "Kreditnota til faktura nr. 1001" } });
    expect(sent[0]!.body.text).toContain("Vi har tilbagebetalt");
    expect(sent[0]!.body.text).not.toContain("Vi har annulleret ordre 1001");
  });

  it("a completed release → the cancellation credit note to the order's email", async () => {
    const { mailer, sent } = fakeMailer();
    await mailer.sendWithdrawalReceipt(ORDER, RELEASED);
    expect(sent[0]).toMatchObject({ key: `order-refund/${WD_ID}`, body: { to: [BUYER], subject: "Kreditnota til faktura nr. 1001" } });
    expect(sent[0]!.body.text).toContain("Vi har annulleret ordre 1001 (Testfigur), som du fortrød, før varen blev sendt.");
    expect(sent[0]!.body.text).not.toContain("Vi har tilbagebetalt");
  });

  it.each([
    { label: "received", withdrawal: WITHDRAWAL },
    { label: "approved refund", withdrawal: { ...REFUNDED, status: "approved", refunded_at: null } },
    { label: "completed refund without refunded_at", withdrawal: { ...REFUNDED, refunded_at: null } },
    { label: "completed release without authorization_canceled_at", withdrawal: { ...RELEASED, authorization_canceled_at: null } },
    { label: "needs_manual", withdrawal: { ...REFUNDED, status: "needs_manual", manual_reason: "stripe_refused" } },
  ] satisfies { label: string; withdrawal: OrderWithdrawalSnapshot }[])("not due ($label): MailNotDueError, nothing sent", async ({ withdrawal }) => {
    const { mailer, sent } = fakeMailer();
    await expect(mailer.sendWithdrawalReceipt(ORDER, withdrawal)).rejects.toThrow(MailNotDueError);
    expect(sent).toEqual([]);
  });
});

describe("S2-ADM-17 (S2-T-ML-05): the owner's manual-handling alert, order-wd-manual/<withdrawal id>", () => {
  it.each([
    { reason: "stripe_refused", text: "Årsag: Stripe afviste tilbagebetalingen eller frigivelsen af reservationen." },
    { reason: "retries_exhausted", text: "Årsag: Tilbagebetalingen eller frigivelsen fejlede for mange gange." },
  ] as const)("$reason → ORDER_NOTIFY_TO with the reason, the withdrawal id and the admin link", async ({ reason, text }) => {
    const { mailer, sent } = fakeMailer();
    await mailer.sendManualAlert(SHIPPED, { ...REFUNDED, status: "needs_manual", refunded_at: null, manual_reason: reason });
    expect(sent[0]).toMatchObject({
      key: `order-wd-manual/${WD_ID}`,
      body: { to: [NOTIFY_TO], subject: "Ordre 1001: fortrydelsen kræver manuel behandling" },
    });
    expect(sent[0]!.body.text).toContain(text);
    expect(sent[0]!.body.text).toContain(`Fortrydelse: ${WD_ID}`);
    expect(sent[0]!.body.text).toContain(ADMIN_LINK);
  });

  it.each([
    { label: "an approved withdrawal", withdrawal: { ...REFUNDED, status: "approved", refunded_at: null } },
    { label: "needs_manual without a reason", withdrawal: { ...REFUNDED, status: "needs_manual", refunded_at: null } },
  ] satisfies { label: string; withdrawal: OrderWithdrawalSnapshot }[])("not due ($label): MailNotDueError, nothing sent", async ({ withdrawal }) => {
    const { mailer, sent } = fakeMailer();
    await expect(mailer.sendManualAlert(SHIPPED, withdrawal)).rejects.toThrow(MailNotDueError);
    expect(sent).toEqual([]);
  });
});
