import type { Locale } from "next-intl";
import { GOODS_OWNER_EMAIL_TEXTS, GOODS_TEXTS, type OrderManualReason } from "@/config/legal/goods-texts";
import { fillTemplate } from "@/config/legal/withdrawal-texts";
import { ORDER_WITHDRAW_PATH, termsPageUrl } from "@/config/payments";
import { formatKroner } from "@/lib/payments/money";
import { inclusiveVatOre } from "@/lib/payments/orders/refund";
import type { OrderShippingAddress } from "@/lib/payments/orders/session";
import {
  formatWithdrawalDate,
  formatWithdrawalDateTime,
  formatWithdrawalLastDay,
  renderEmailBlocks,
  type EmailBlock,
  type EmailContent,
} from "@/lib/payments/withdrawal-emails";

/**
 * The emails of a goods order (slice S2), built from the versioned goods
 * texts. Charge on dispatch (amendments A1 and A2): to the buyer the order
 * confirmation, which is also the invoice (a forenklet faktura with the
 * durable-medium withdrawal information; the amount is only reserved), the
 * shipped email (the amount is now charged; it refers to that invoice), the
 * withdrawal receipt and the credit notes of a refund and of a cancellation
 * (withdrawn before dispatch, the reservation released); to the owner (Danish
 * only) the new order, the warning before a reservation lapses, a lapsed
 * reservation, a refused capture, the withdrawal alert, the refund reminder
 * and the manual-handling alert. Pure (no env, no I/O), so the payments
 * Worker and tests share it. Same layout and escaping as the subscription
 * emails ({@link renderEmailBlocks}): every interpolated value is
 * HTML-escaped; dates are Copenhagen dates; money is kroner plus "kr."; moms
 * is the 25 % included in an amount ({@link inclusiveVatOre}).
 */

export type { EmailContent };

/** The order fields the emails show. */
export type OrderEmailOrder = {
  orderNumber: number;
  /** The order line's title (the item's title at purchase). */
  itemTitle: string;
  /** The order line's quantity. */
  quantity: number;
  amountTotalOre: number;
  email: string;
  customerName: string | null;
  phone: string | null;
  shippingName: string | null;
  shippingAddress: OrderShippingAddress | null;
  /** The language the buyer checked out in: the order emails' language. */
  locale: Locale;
  /** When the order was placed and its payment reserved, ISO. */
  paidAt: string;
  /** When the card reservation lapses, ISO; null or absent without one (owner emails only). */
  authorizationExpiresAt?: string | null;
  /** Comma-joined anomaly codes (owner email only). */
  anomaly?: string | null;
};

/** The withdrawal fields the emails show. */
export type OrderEmailWithdrawal = {
  id: string;
  consumerName: string;
  /** When the notice was received (the database clock), ISO. */
  requestedAt: string;
  /** The refund deadline (requested_at + 14 days), ISO. */
  refundDueAt: string;
  /** Whether the notice came after the withdrawal period. */
  late: boolean;
  /** Whether the goods were shipped when the notice came. */
  shippedBeforeNotice: boolean;
  /** The end of the withdrawal period (exclusive), null when not shipped at notice time. */
  deadlineAt: string | null;
  /** The language the consumer withdrew in: the withdrawal emails' language. */
  locale: Locale;
  refundOre: number | null;
  /** The deduction for diminished value, 0 or absent for none. */
  deductionOre?: number;
  deductionReason?: string | null;
};

/** An amount in øre as "249,95 kr." / "249.95 kr.". */
function kroner(amountOre: number, locale: Locale): string {
  return `${formatKroner(amountOre, locale)} kr.`;
}

/** The address as lines: name, street, optional second line, postcode and city, country (DK named). */
function addressLines(order: OrderEmailOrder, locale: Locale): string[] {
  const address = order.shippingAddress;
  if (address === null) return [];
  const country = address.country === "DK" ? (locale === "da" ? "Danmark" : "Denmark") : address.country;
  const postalCity = [address.postal_code, address.city].filter(Boolean).join(" ");
  return [order.shippingName, address.line1, address.line2, postalCity, country].filter(
    (line): line is string => typeof line === "string" && line !== "",
  );
}

/** A paragraph block of `template` with `values`, the `links` placeholders as anchors. */
function paragraph(
  template: string,
  values?: Readonly<Record<string, string>>,
  links?: readonly string[],
): EmailBlock {
  return { kind: "paragraph", template, values, links };
}

/** Buyer data as paragraphs: always a value, never a template (a "{…}" in it is no placeholder). */
function valueParagraphs(lines: readonly string[]): EmailBlock[] {
  return lines.map((line) => paragraph("{line}", { line }));
}

export type OrderConfirmationEmailInput = {
  order: OrderEmailOrder;
  /** The order's personal withdraw link (`orderWithdrawUrl` of link-token.ts). */
  withdrawLink: string;
  /** The main site's origin, for /terms and the general withdraw page. */
  siteOrigin: string;
};

/**
 * The order confirmation sent once the payment is reserved (the durable
 * medium of forbrugeraftaleloven § 17), which is also the order's invoice
 * ("Ordrebekræftelse og faktura nr." = the order number): the invoice and
 * order number and date (paid_at), the item and quantity, the total incl. moms
 * and delivery and the 25 % moms in it, the reservation sentence, the seller's
 * identity with CVR, the buyer's name (the name given at Checkout, else the
 * delivery name, else the email) and address (the delivery address), so it
 * holds a full invoice's parties at any amount, then the delivery address,
 * dispatch time, the goods withdrawal notice with how to withdraw online, the
 * personal withdraw link, the return instructions, the model form and the
 * terms link.
 */
export function buildOrderConfirmationEmail(input: OrderConfirmationEmailInput): EmailContent {
  const { order, withdrawLink, siteOrigin } = input;
  const { locale } = order;
  const texts = GOODS_TEXTS[locale];
  const mail = texts.confirmationEmail;
  const values = {
    orderNumber: String(order.orderNumber),
    orderDate: formatWithdrawalDate(order.paidAt, locale),
    itemTitle: order.itemTitle,
    quantity: String(order.quantity),
    total: kroner(order.amountTotalOre, locale),
    vat: kroner(inclusiveVatOre(order.amountTotalOre), locale),
  };
  const subject = fillTemplate(mail.subject, values);
  const address = addressLines(order, locale);
  return renderEmailBlocks(
    locale,
    subject,
    [
      paragraph(mail.intro),
      { kind: "heading", text: subject },
      ...mail.invoiceLines.map((line) => paragraph(line, values)),
      ...mail.itemLines.map((line) => paragraph(line, values)),
      paragraph(mail.payment),
      { kind: "heading", text: mail.sellerHeading },
      paragraph(mail.seller),
      // A full invoice names the buyer whatever the amount (a forenklet faktura need not).
      { kind: "heading", text: mail.buyerHeading },
      ...valueParagraphs([
        order.customerName ?? order.shippingName ?? order.email,
        ...addressLines({ ...order, shippingName: null }, locale),
      ]),
      ...(address.length === 0
        ? []
        : [{ kind: "heading", text: mail.shippingHeading } as const, ...valueParagraphs(address)]),
      paragraph(mail.dispatch),
      { kind: "heading", text: texts.notice.title },
      ...texts.notice.paragraphs.map((text) => paragraph(text)),
      paragraph(texts.onlineWithdrawal, { withdrawUrl: `${siteOrigin}${ORDER_WITHDRAW_PATH}?lang=${locale}` }, [
        "withdrawUrl",
      ]),
      paragraph(mail.withdrawOnline, { withdrawUrl: withdrawLink }, ["withdrawUrl"]),
      { kind: "heading", text: mail.returnHeading },
      paragraph(texts.returnInstructions),
      { kind: "heading", text: texts.modelForm.title },
      paragraph(texts.modelForm.intro),
      ...texts.modelForm.lines.map((line) => paragraph(line)),
      paragraph(mail.termsLine, { termsUrl: termsPageUrl(siteOrigin, locale) }, ["termsUrl"]),
    ],
    mail.footer,
  );
}

export type OrderOwnerEmailInput = {
  order: OrderEmailOrder;
  /** The order's admin page (`${SITE_URL}/admin/orders/<n>`). */
  adminLink: string;
};

/** The owner's values of an order (Danish): number, item, amount incl. moms. */
function ownerOrderValues(order: OrderEmailOrder): Record<string, string> {
  return {
    orderNumber: String(order.orderNumber),
    itemTitle: order.itemTitle,
    amount: kroner(order.amountTotalOre, "da"),
  };
}

/**
 * The owner's notice of a new order: what to send where, that the amount is
 * reserved and charged at "Markér afsendt", when the reservation lapses (card
 * payments), any anomaly, and the admin link.
 */
export function buildOrderOwnerEmail({ order, adminLink }: OrderOwnerEmailInput): EmailContent {
  const texts = GOODS_OWNER_EMAIL_TEXTS.newOrder;
  const missing = GOODS_OWNER_EMAIL_TEXTS.missing;
  const address = addressLines({ ...order, shippingName: null }, "da");
  const values = {
    ...ownerOrderValues(order),
    name: order.shippingName ?? order.customerName ?? missing,
    address: address.length === 0 ? missing : address.join(", "),
    phone: order.phone ?? missing,
    email: order.email,
  };
  const expiresAt = order.authorizationExpiresAt;
  return renderEmailBlocks(
    "da",
    fillTemplate(texts.subject, values),
    [
      paragraph(texts.intro),
      ...texts.lines.map((line) => paragraph(line, values)),
      ...(expiresAt ? [paragraph(texts.authorization, { expiresAt: formatWithdrawalDateTime(expiresAt, "da") })] : []),
      ...(order.anomaly ? [paragraph(texts.anomaly, { anomaly: order.anomaly })] : []),
      paragraph(texts.adminLink, { adminLink }, ["adminLink"]),
    ],
    GOODS_OWNER_EMAIL_TEXTS.footer,
  );
}

export type OrderCaptureWarningEmailInput = {
  order: OrderEmailOrder & { authorizationExpiresAt: string };
  adminLink: string;
};

/** The owner's warning that an unshipped order's reservation lapses soon: ship and mark it shipped before then. */
export function buildOrderCaptureWarningEmail({ order, adminLink }: OrderCaptureWarningEmailInput): EmailContent {
  const texts = GOODS_OWNER_EMAIL_TEXTS.captureWarning;
  const values = { ...ownerOrderValues(order), expiresAt: formatWithdrawalDateTime(order.authorizationExpiresAt, "da") };
  return renderEmailBlocks(
    "da",
    fillTemplate(texts.subject, values),
    [
      paragraph(texts.intro, values),
      ...texts.lines.map((line) => paragraph(line, values)),
      paragraph(texts.adminLink, { adminLink }, ["adminLink"]),
    ],
    GOODS_OWNER_EMAIL_TEXTS.footer,
  );
}

/** The owner's notice that an order's reservation lapsed (or was canceled): do not send the goods. */
export function buildOrderAuthorizationExpiredEmail({ order, adminLink }: OrderOwnerEmailInput): EmailContent {
  const texts = GOODS_OWNER_EMAIL_TEXTS.authorizationExpired;
  const values = { ...ownerOrderValues(order), email: order.email };
  return renderEmailBlocks(
    "da",
    fillTemplate(texts.subject, values),
    [
      paragraph(texts.intro, values),
      ...texts.lines.map((line) => paragraph(line, values)),
      paragraph(texts.contact),
      paragraph(texts.adminLink, { adminLink }, ["adminLink"]),
    ],
    GOODS_OWNER_EMAIL_TEXTS.footer,
  );
}

/**
 * The owner's alert that Stripe refused to capture an order's payment for
 * another reason than a lapsed reservation (e.g. a decline): the order stays
 * reserved and unshipped; do not send the goods before it is resolved.
 */
export function buildOrderCaptureFailedEmail({ order, adminLink }: OrderOwnerEmailInput): EmailContent {
  const texts = GOODS_OWNER_EMAIL_TEXTS.captureFailed;
  const values = { ...ownerOrderValues(order), email: order.email };
  return renderEmailBlocks(
    "da",
    fillTemplate(texts.subject, values),
    [
      paragraph(texts.intro, values),
      ...texts.lines.map((line) => paragraph(line, values)),
      paragraph(texts.contact),
      paragraph(texts.adminLink, { adminLink }, ["adminLink"]),
    ],
    GOODS_OWNER_EMAIL_TEXTS.footer,
  );
}

export type OrderShippedEmailInput = {
  order: OrderEmailOrder;
  /** The tracking reference the owner entered, null for none. */
  trackingRef: string | null;
  /** The order's personal withdraw link. */
  withdrawLink: string;
};

/**
 * The buyer's shipped email, sent once the payment is captured. Not a second
 * invoice: the amount now charged and the 25 % moms in it, with a reference to
 * the invoice in the order confirmation (faktura nr. = the order number); the
 * tracking reference, when the withdrawal period starts, the withdraw link and
 * how to return.
 */
export function buildOrderShippedEmail({ order, trackingRef, withdrawLink }: OrderShippedEmailInput): EmailContent {
  const { locale } = order;
  const texts = GOODS_TEXTS[locale];
  const mail = texts.shippedEmail;
  const values = {
    orderNumber: String(order.orderNumber),
    itemTitle: order.itemTitle,
    total: kroner(order.amountTotalOre, locale),
    vat: kroner(inclusiveVatOre(order.amountTotalOre), locale),
  };
  return renderEmailBlocks(
    locale,
    fillTemplate(mail.subject, values),
    [
      paragraph(mail.intro, values),
      paragraph(mail.charged, values),
      ...(trackingRef ? [paragraph(mail.tracking, { trackingRef })] : []),
      paragraph(mail.withdrawal),
      paragraph(mail.withdrawOnline, { withdrawUrl: withdrawLink }, ["withdrawUrl"]),
      { kind: "heading", text: mail.returnHeading },
      paragraph(texts.returnInstructions),
    ],
    mail.footer,
  );
}

export type OrderWithdrawalEmailInput = {
  order: OrderEmailOrder;
  withdrawal: OrderEmailWithdrawal;
  /** The main site's origin, for the terms link. */
  siteOrigin: string;
};

/**
 * The withdrawal receipt (kvittering, forbrugeraftaleloven § 20 a), in the
 * language of the withdrawal: when the notice was received and for which
 * order; goods not yet shipped are not sent (nothing to return) and their
 * reservation is released, shipped goods go back as the return instructions
 * say; when the refund or release is due and that a refund may wait for the
 * goods.
 */
export function buildOrderWithdrawalAckEmail({ order, withdrawal, siteOrigin }: OrderWithdrawalEmailInput): EmailContent {
  const { locale } = withdrawal;
  const texts = GOODS_TEXTS[locale];
  const mail = texts.withdrawalAckEmail;
  const values = {
    orderNumber: String(order.orderNumber),
    itemTitle: order.itemTitle,
    consumerName: withdrawal.consumerName,
    requestedAt: formatWithdrawalDateTime(withdrawal.requestedAt, locale),
    refundDueDate: formatWithdrawalDate(withdrawal.refundDueAt, locale),
  };
  const outcome: EmailBlock[] = withdrawal.shippedBeforeNotice
    ? [
        paragraph(mail.shipped),
        { kind: "heading", text: mail.returnHeading },
        paragraph(texts.returnInstructions),
        paragraph(mail.refundShipped, values),
      ]
    : [paragraph(mail.notShipped), paragraph(mail.refundNotShipped, values)];
  return renderEmailBlocks(
    locale,
    fillTemplate(mail.subject, values),
    [
      paragraph(mail.greeting, values),
      paragraph(mail.received, values),
      ...outcome,
      paragraph(mail.closing),
      paragraph(texts.confirmationEmail.termsLine, { termsUrl: termsPageUrl(siteOrigin, locale) }, ["termsUrl"]),
    ],
    mail.footer,
  );
}

export type OrderRefundReceiptEmailInput = {
  order: OrderEmailOrder;
  /** The completed refund: its amount and when it was made (the credit note's date), ISO. */
  withdrawal: OrderEmailWithdrawal & { refundOre: number; refundedAt: string };
  /** The main site's origin, for the terms link. */
  siteOrigin: string;
};

/**
 * The buyer's refund receipt, which is the credit note for the order's
 * invoice ("Kreditnota til faktura nr." = the order number): the amount
 * refunded, its date, the amount credited incl. moms and the 25 % moms in it,
 * when one was made, the deduction and its reason, and the seller as on the
 * invoice.
 */
export function buildOrderRefundReceiptEmail({ order, withdrawal, siteOrigin }: OrderRefundReceiptEmailInput): EmailContent {
  const { locale } = withdrawal;
  const texts = GOODS_TEXTS[locale];
  const mail = texts.refundReceiptEmail;
  const values = {
    orderNumber: String(order.orderNumber),
    consumerName: withdrawal.consumerName,
    refund: kroner(withdrawal.refundOre, locale),
    refundVat: kroner(inclusiveVatOre(withdrawal.refundOre), locale),
    creditDate: formatWithdrawalDate(withdrawal.refundedAt, locale),
  };
  const subject = fillTemplate(mail.subject, values);
  const deduction = withdrawal.deductionOre ?? 0;
  return renderEmailBlocks(
    locale,
    subject,
    [
      paragraph(mail.greeting, values),
      paragraph(mail.refunded, values),
      { kind: "heading", text: subject },
      ...mail.creditLines.map((line) => paragraph(line, values)),
      ...(deduction > 0
        ? [paragraph(mail.deduction, { deduction: kroner(deduction, locale), reason: withdrawal.deductionReason ?? "" })]
        : []),
      { kind: "heading", text: mail.sellerHeading },
      paragraph(mail.seller),
      paragraph(mail.closing),
      paragraph(texts.confirmationEmail.termsLine, { termsUrl: termsPageUrl(siteOrigin, locale) }, ["termsUrl"]),
    ],
    mail.footer,
  );
}

export type OrderCancellationReceiptEmailInput = {
  order: OrderEmailOrder;
  /** The completed release: when the reservation was released (the credit note's date), ISO. */
  withdrawal: OrderEmailWithdrawal & { canceledAt: string };
  /** The main site's origin, for the terms link. */
  siteOrigin: string;
};

/**
 * The buyer's cancellation receipt once the reservation of goods withdrawn
 * before dispatch is released: the credit note for the whole invoice
 * ("Kreditnota til faktura nr." = the order number) with the release date,
 * the total incl. moms and the 25 % moms in it, the seller as on the invoice,
 * that the order is canceled, nothing was charged and the reservation is
 * released.
 */
export function buildOrderCancellationReceiptEmail({
  order,
  withdrawal,
  siteOrigin,
}: OrderCancellationReceiptEmailInput): EmailContent {
  const { locale } = withdrawal;
  const texts = GOODS_TEXTS[locale];
  const mail = texts.cancellationReceiptEmail;
  const values = {
    orderNumber: String(order.orderNumber),
    itemTitle: order.itemTitle,
    consumerName: withdrawal.consumerName,
    total: kroner(order.amountTotalOre, locale),
    vat: kroner(inclusiveVatOre(order.amountTotalOre), locale),
    creditDate: formatWithdrawalDate(withdrawal.canceledAt, locale),
  };
  const subject = fillTemplate(mail.subject, values);
  return renderEmailBlocks(
    locale,
    subject,
    [
      paragraph(mail.greeting, values),
      paragraph(mail.canceled, values),
      paragraph(mail.released),
      { kind: "heading", text: subject },
      ...mail.creditLines.map((line) => paragraph(line, values)),
      { kind: "heading", text: mail.sellerHeading },
      paragraph(mail.seller),
      paragraph(mail.closing),
      paragraph(texts.confirmationEmail.termsLine, { termsUrl: termsPageUrl(siteOrigin, locale) }, ["termsUrl"]),
    ],
    mail.footer,
  );
}

export type OrderOwnerWithdrawalEmailInput = {
  order: OrderEmailOrder;
  withdrawal: OrderEmailWithdrawal;
  /** The order's admin page. */
  adminLink: string;
};

/** Values shared by the owner's withdrawal alert and reminder (Danish). */
function ownerWithdrawalValues(order: OrderEmailOrder, withdrawal: OrderEmailWithdrawal): Record<string, string> {
  return {
    orderNumber: String(order.orderNumber),
    itemTitle: order.itemTitle,
    consumerName: withdrawal.consumerName,
    requestedAt: formatWithdrawalDateTime(withdrawal.requestedAt, "da"),
    refundDueDate: formatWithdrawalDate(withdrawal.refundDueAt, "da"),
  };
}

/**
 * The owner's alert of a received withdrawal: "SEND IKKE VAREN" first when
 * the goods were not shipped (approve it so the reservation is released),
 * else to await the return; the late flag (with the period's last day) when
 * the notice came after the period, which is accepted and left to the owner;
 * the refund or release deadline and the admin link.
 */
export function buildOrderWithdrawalAlertEmail({ order, withdrawal, adminLink }: OrderOwnerWithdrawalEmailInput): EmailContent {
  const texts = GOODS_OWNER_EMAIL_TEXTS.withdrawalAlert;
  const values = ownerWithdrawalValues(order, withdrawal);
  return renderEmailBlocks(
    "da",
    fillTemplate(texts.subject, values),
    [
      paragraph(withdrawal.shippedBeforeNotice ? texts.shipped : texts.doNotShip),
      ...(withdrawal.late && withdrawal.deadlineAt !== null
        ? [paragraph(texts.late, { deadline: formatWithdrawalLastDay(withdrawal.deadlineAt, "da") })]
        : []),
      ...texts.lines.map((line) => paragraph(line, values)),
      paragraph(texts.refundDeadline, values),
      paragraph(texts.adminLink, { adminLink }, ["adminLink"]),
    ],
    GOODS_OWNER_EMAIL_TEXTS.footer,
  );
}

/** The owner's reminder that a received withdrawal's refund or release is due soon. */
export function buildOrderRefundReminderEmail({ order, withdrawal, adminLink }: OrderOwnerWithdrawalEmailInput): EmailContent {
  const texts = GOODS_OWNER_EMAIL_TEXTS.refundReminder;
  const values = ownerWithdrawalValues(order, withdrawal);
  return renderEmailBlocks(
    "da",
    fillTemplate(texts.subject, values),
    [
      paragraph(texts.intro),
      ...texts.lines.map((line) => paragraph(line, values)),
      paragraph(texts.refundDeadline, values),
      paragraph(texts.adminLink, { adminLink }, ["adminLink"]),
    ],
    GOODS_OWNER_EMAIL_TEXTS.footer,
  );
}

export type OrderManualAlertEmailInput = {
  order: OrderEmailOrder;
  withdrawalId: string;
  reason: OrderManualReason;
  adminLink: string;
};

/** The owner's alert that a goods refund or release needs manual handling, with the runbook. */
export function buildOrderManualAlertEmail({ order, withdrawalId, reason, adminLink }: OrderManualAlertEmailInput): EmailContent {
  const texts = GOODS_OWNER_EMAIL_TEXTS.manualAlert;
  const values = { orderNumber: String(order.orderNumber), withdrawalId, reasonText: texts.reasons[reason] };
  return renderEmailBlocks(
    "da",
    fillTemplate(texts.subject, values),
    [
      paragraph(texts.intro),
      ...texts.lines.map((line) => paragraph(line, values)),
      paragraph(texts.runbook),
      paragraph(texts.adminLink, { adminLink }, ["adminLink"]),
    ],
    GOODS_OWNER_EMAIL_TEXTS.footer,
  );
}
