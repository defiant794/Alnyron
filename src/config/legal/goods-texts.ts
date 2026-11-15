import type { Locale } from "next-intl";
import { fillTemplate } from "@/config/legal/withdrawal-texts";

/**
 * The versioned legal wording of the purchase of a physical 3D figure (køb af
 * varer, forbrugeraftaleloven): the item page's facts line, the Checkout
 * terms-acceptance and submit lines, the withdrawal notice for goods
 * (fortrydelsesvejledning), the return address and instructions, the online
 * withdrawal paragraph, the model withdrawal form, the withdrawal statement,
 * the consumer emails (the order confirmation that is the invoice, the
 * shipped email, withdrawal receipt, the credit notes of a refund and of a
 * cancellation) and the /terms goods sections. The owner's own emails
 * ({@link GOODS_OWNER_EMAIL_TEXTS}, Danish only) are not part of the hashed
 * bundle.
 *
 * Charge on dispatch (amendments A1 and A2): the amount is reserved with the
 * buyer's payment method at Checkout (a card, Klarna or Amazon Pay: the wording
 * never names one) and charged when the goods are sent; a withdrawal before
 * dispatch releases the reservation.
 *
 * DRAFT texts for owner/accountant review before go-live, not a legal
 * guarantee. Every surface renders from this module (the item page, Checkout,
 * /terms, /order/withdraw, the payments Worker's emails), so the wording a
 * consumer saw is identified by {@link GOODS_TEXT_VERSION} plus the sha256 of
 * the locale's bundle ({@link GOODS_TEXT_SHA256}), stored with each order. Any
 * edit of a text in {@link GOODS_TEXTS} MUST bump the version and add the new
 * digests (while the version is an unreleased draft, its digests are re-pinned
 * instead): a unit test recomputes and pins them.
 *
 * Placeholders in braces (`{termsUrl}`) are filled by the caller with
 * {@link fillTemplate}; they are not part of the wording. No string uses an
 * em dash or an en dash.
 */

/** The version of the texts below; an order's `terms_version` and a withdrawal's `statement_version` carry it. */
export const GOODS_TEXT_VERSION = "goods-2026-11-14.1";

/** The legal texts of one language for the purchase of goods. */
export type GoodsTexts = {
  /** The item page's offer block. */
  itemPage: {
    /** Under the price ("inkl. moms og levering i Danmark"). */
    priceNote: string;
    /** The facts line: ships to Denmark only, dispatch time, withdrawal period, return shipping, payment at dispatch. */
    facts: readonly [shipsDkOnly: string, dispatch: string, withdrawal: string, returnShipping: string, payment: string];
    /** The link label to /terms. */
    termsLinkLabel: string;
  };
  /** Stripe Checkout's terms-acceptance checkbox text: a markdown link to `{termsUrl}`. */
  termsAcceptPrefix: string;
  /** Stripe Checkout's line above the pay button (the reservation, dispatch and withdrawal). */
  checkoutSubmit: string;
  /** The withdrawal notice for goods (fortrydelsesvejledning): its title and paragraphs. */
  notice: { title: string; paragraphs: readonly string[] };
  /** Where returned goods go (with the seller's CVR). */
  returnAddress: string;
  /** How to return the goods: address, deadline, who pays, proof of return. */
  returnInstructions: string;
  /** Where to withdraw online (`{withdrawUrl}`, the /order/withdraw page). */
  onlineWithdrawal: string;
  /** The model withdrawal form (standardfortrydelsesformular): title, intro and its lines. */
  modelForm: { title: string; intro: string; lines: readonly string[] };
  /** The withdrawal statement the consumer confirms on /order/withdraw (no placeholders). */
  statement: string;
  /**
   * The order confirmation (durable medium), sent by the payments Worker once the payment is
   * reserved. It is also the order's invoice (a forenklet faktura; invoice number = order number,
   * invoice date = order date).
   */
  confirmationEmail: {
    /** `{orderNumber}`: "Ordrebekræftelse og faktura nr. …", also the heading of the invoice. */
    subject: string;
    intro: string;
    /** `{orderNumber}`, `{orderDate}`: the invoice and order number and date. */
    invoiceLines: readonly string[];
    sellerHeading: string;
    seller: string;
    /** Heads the buyer's name and address (the invoice names the buyer at any amount). */
    buyerHeading: string;
    /** `{itemTitle}`, `{quantity}`, `{total}` (incl. moms and delivery), `{vat}` (the 25 % moms in it). */
    itemLines: readonly string[];
    /** The reservation sentence: reserved when ordering, charged when the goods are sent. */
    payment: string;
    shippingHeading: string;
    dispatch: string;
    /** `{withdrawUrl}`: the order's personal withdraw link. */
    withdrawOnline: string;
    returnHeading: string;
    /** `{termsUrl}`. */
    termsLine: string;
    footer: string;
  };
  /**
   * Sent when the owner marks the order shipped and the payment is charged. Not an invoice: it
   * refers to the invoice in the order confirmation.
   */
  shippedEmail: {
    /** `{orderNumber}`. */
    subject: string;
    /** `{itemTitle}`. */
    intro: string;
    /** `{total}`, `{vat}` (the 25 % moms in it), `{orderNumber}`: the amount now charged and its invoice. */
    charged: string;
    /** `{trackingRef}`; left out without a tracking reference. */
    tracking: string;
    withdrawal: string;
    /** `{withdrawUrl}`. */
    withdrawOnline: string;
    returnHeading: string;
    footer: string;
  };
  /** The withdrawal receipt (kvittering), sent to the order's email when a withdrawal is received. */
  withdrawalAckEmail: {
    /** `{orderNumber}`. */
    subject: string;
    /** `{consumerName}`. */
    greeting: string;
    /** `{requestedAt}`, `{itemTitle}`, `{orderNumber}`. */
    received: string;
    /** The goods were not shipped when the notice came: nothing to return. */
    notShipped: string;
    /** The goods were shipped: return them (followed by the return instructions). */
    shipped: string;
    returnHeading: string;
    /** Refund of shipped goods (`{refundDueDate}`): may wait for the goods; diminished value. */
    refundShipped: string;
    /** Goods never shipped (`{refundDueDate}`): the reservation is released (a payment already charged is refunded). */
    refundNotShipped: string;
    closing: string;
    footer: string;
  };
  /** Sent once the refund is made: the credit note (kreditnota) for the order's invoice. */
  refundReceiptEmail: {
    /** `{orderNumber}`: "Kreditnota til faktura nr. …", also the heading of the credit note. */
    subject: string;
    /** `{consumerName}`. */
    greeting: string;
    /** `{refund}`, `{orderNumber}`. */
    refunded: string;
    /** `{creditDate}`, `{refund}` (incl. moms), `{refundVat}` (the 25 % moms credited). */
    creditLines: readonly string[];
    /** `{deduction}`, `{reason}`: only when an amount was deducted. */
    deduction: string;
    /** The seller as on the invoice. */
    sellerHeading: string;
    seller: string;
    closing: string;
    footer: string;
  };
  /**
   * Sent once the reservation of goods withdrawn before dispatch is released: the credit note
   * (kreditnota) of the whole invoice, nothing was charged.
   */
  cancellationReceiptEmail: {
    /** `{orderNumber}`: "Kreditnota til faktura nr. …", also the heading of the credit note. */
    subject: string;
    /** `{consumerName}`. */
    greeting: string;
    /** `{orderNumber}`, `{itemTitle}`. */
    canceled: string;
    /** `{creditDate}` (the release date), `{total}` (incl. moms), `{vat}` (the 25 % moms credited). */
    creditLines: readonly string[];
    /** The seller as on the invoice. */
    sellerHeading: string;
    seller: string;
    released: string;
    closing: string;
    footer: string;
  };
  /** The /terms goods sections (markdown), rendered after the subscription sections. */
  terms: { goodsSections: string };
};

const SELLER = "Alnyron, Nyvej 4, 7860 Spøttrup, Danmark, CVR 46887433, info@alnyron.dk";
const SELLER_EN = "Alnyron, Nyvej 4, 7860 Spøttrup, Denmark, CVR 46887433, info@alnyron.dk";

/** The reservation sentence (amendment A2): method-neutral, as Checkout offers cards, Klarna and Amazon Pay. */
const RESERVATION = "Beløbet reserveres ved bestillingen og trækkes først, når varen sendes.";
const RESERVATION_EN = "The amount is reserved when you order and charged only when the goods are sent.";

const TERMS_GOODS_DA = `## Køb af 3D-figurer
Afsnittene herunder gælder, når du køber en fysisk 3D-figur hos Alnyron.

### Sælger
Alnyron
CVR 46887433
Nyvej 4, 7860 Spøttrup, Danmark
E-mail: info@alnyron.dk

### Varen og aftalen
Varen, dens egenskaber og pris står på varens side. Aftalen indgås, når du har gennemført bestillingen på Stripes betalingsside. Du får en ordrebekræftelse på e-mail. Den er også din faktura og indeholder ordrens indhold, fortrydelsesvejledningen, standardfortrydelsesformularen og et personligt link, hvor du kan fortryde online.

### Priser, betaling og levering
Alle priser er i danske kroner og inkluderer 25 % moms og levering i Danmark. Der kommer ingen gebyrer oven i prisen. Betalingen håndteres af vores betalingsudbyder Stripe, og vi gemmer ikke dine betalingsoplysninger. ${RESERVATION} Vi sender kun til adresser i Danmark. Varen sendes inden for 3 hverdage, og du får en e-mail, når den er sendt.

### Fortrydelsesret
Du har 14 dages fortrydelsesret efter forbrugeraftaleloven. Fristen løber fra den dag, du eller en person, du har udpeget (dog ikke transportøren), får varen i fysisk besiddelse. Fortryder du, før varen er sendt, sender vi den ikke og frigiver reservationen, så du ikke bliver trukket. Du kan fortryde online med "Fortryd aftale her", på e-mail eller med standardfortrydelsesformularen. Fortryder du, efter at varen er sendt, betaler du selv returfragten. Fortrydelsesvejledningen, returadressen og standardfortrydelsesformularen står nedenfor.

### Reklamation
Du har 2 års reklamationsret efter købeloven. Er varen mangelfuld, så skriv til info@alnyron.dk med en beskrivelse af manglen, gerne med et billede, inden for rimelig tid efter, at du har opdaget den. Er reklamationen berettiget, betaler vi de rimelige omkostninger ved at sende varen retur.

### Persondata
Vi bruger dit navn, din adresse, din e-mail og dit telefonnummer til at levere varen og behandle ordren, som beskrevet i vores privatlivspolitik.

### Klageadgang
Vil du klage, så skriv først til os på info@alnyron.dk, så vi kan finde en løsning. Lykkes det ikke, kan du klage til Nævnenes Hus, Center for Klageløsning, via [forbrug.dk](https://www.forbrug.dk). Bor du i et andet EU-land, kan du også kontakte [Forbruger Europa](https://www.forbrugereuropa.dk).

### Lovvalg
Købet er underlagt dansk ret. Det gælder dog ikke, hvis ufravigelige regler i dit bopælsland giver dig en bedre retsstilling.`;

const TERMS_GOODS_EN = `## Purchase of 3D figures
The sections below apply when you buy a physical 3D figure from Alnyron.

### Seller
Alnyron
CVR 46887433
Nyvej 4, 7860 Spøttrup, Denmark
Email: info@alnyron.dk

### The goods and the contract
The goods, their characteristics and price are shown on the item's page. The contract is made when you have completed the order on Stripe's payment page. You receive an order confirmation by email. It is also your invoice and contains the content of the order, the withdrawal information, the model withdrawal form and a personal link where you can withdraw online.

### Prices, payment and delivery
All prices are in Danish kroner and include 25% VAT and delivery in Denmark. No fees are added to the price. Payment is handled by our payment provider Stripe, and we do not store your payment details. ${RESERVATION_EN} We only ship to addresses in Denmark. The goods are dispatched within 3 working days, and you receive an email once they have been sent.

### Right of withdrawal
You have a 14-day right of withdrawal under the Danish Consumer Contracts Act. The period runs from the day on which you, or a person you have named (other than the carrier), take physical possession of the goods. If you withdraw before the goods are sent, we do not send them and release the reservation, so you are not charged. You can withdraw online with "Withdraw from the contract here", by email or with the model withdrawal form. If you withdraw after the goods have been sent, you pay the cost of returning them. The withdrawal information, the return address and the model withdrawal form are shown below.

### Complaints about defects
You have a 2-year right to complain about defects under the Danish Sale of Goods Act. If the goods are defective, write to info@alnyron.dk with a description of the defect, preferably with a photo, within a reasonable time after you discover it. If the complaint is justified, we pay the reasonable cost of returning the goods.

### Personal data
We use your name, address, email and phone number to deliver the goods and handle the order, as described in our privacy policy.

### Complaints
If you want to complain, please write to us first at info@alnyron.dk so we can find a solution. If that does not succeed, you can complain to the Danish Centre for Complaint Resolution (Nævnenes Hus) via [forbrug.dk](https://www.forbrug.dk). If you live in another EU country, you can also contact [the European Consumer Centre Denmark](https://www.forbrugereuropa.dk).

### Governing law
The purchase is governed by Danish law. This does not apply where mandatory rules of your country of residence give you better protection.`;

/** The texts of {@link GOODS_TEXT_VERSION}, per UI language. */
export const GOODS_TEXTS: Readonly<Record<Locale, GoodsTexts>> = {
  da: {
    itemPage: {
      priceNote: "inkl. moms og levering i Danmark",
      facts: [
        "Sendes kun i Danmark",
        "Sendes inden for 3 hverdage",
        "14 dages fortrydelsesret",
        "Returfragt betales af kunden",
        RESERVATION,
      ],
      termsLinkLabel: "Handelsbetingelser",
    },
    termsAcceptPrefix:
      "Jeg accepterer Alnyrons [handelsbetingelser]({termsUrl}) for køb af varer, herunder 14 dages fortrydelsesret, hvor jeg selv betaler returfragten.",
    checkoutSubmit: `${RESERVATION} Varen sendes inden for 3 hverdage til din adresse i Danmark. Du har 14 dages fortrydelsesret fra den dag, du modtager varen, og du betaler selv returfragten, hvis du fortryder.`,
    notice: {
      title: "Fortrydelsesret",
      paragraphs: [
        "Du har ret til at fortryde denne aftale inden for 14 dage uden at angive nogen grund.",
        "Fortrydelsesfristen udløber 14 dage efter den dag, hvor du eller en tredjemand, bortset fra transportøren, angivet af dig, får varen i fysisk besiddelse.",
        'For at udøve fortrydelsesretten skal du meddele os (Alnyron, Nyvej 4, 7860 Spøttrup, Danmark, CVR 46887433, info@alnyron.dk) din beslutning om at fortryde denne aftale i en utvetydig erklæring, f.eks. med funktionen "Fortryd aftale her" på vores websted, i en e-mail eller i et brev. Du kan bruge standardfortrydelsesformularen nedenfor, men det er ikke obligatorisk.',
        "Fortrydelsesfristen er overholdt, hvis du sender din meddelelse om, at du vil gøre fortrydelsesretten gældende, inden fortrydelsesfristen er udløbet.",
        "Hvis du fortryder denne aftale, tilbagebetaler vi alle betalinger, vi har modtaget fra dig, herunder leveringsomkostninger (vi tilbyder kun standardlevering, og den er med i prisen), uden unødig forsinkelse og senest 14 dage fra den dato, hvor vi har modtaget meddelelse om din beslutning om at fortryde denne aftale. Vi gennemfører tilbagebetalingen med samme betalingsmiddel, som du benyttede ved den oprindelige transaktion, medmindre du udtrykkeligt har indvilget i noget andet. Du kommer under ingen omstændigheder til at betale gebyrer som følge af tilbagebetalingen.",
        "Vi kan tilbageholde tilbagebetalingen, indtil vi har modtaget varen retur, eller du har fremlagt dokumentation for at have returneret den, alt efter hvad der sker først.",
        "Du skal returnere varen til Alnyron, Nyvej 4, 7860 Spøttrup, Danmark, uden unødig forsinkelse og under alle omstændigheder senest 14 dage efter den dag, hvor du har meddelt os, at du ønsker at fortryde denne aftale. Fristen er overholdt, hvis du returnerer varen, inden perioden på 14 dage er udløbet.",
        "Du skal afholde de direkte udgifter i forbindelse med returnering af varen. Du betaler altså selv returfragten.",
        "Du hæfter kun for en eventuel forringelse af varens værdi, som skyldes anden håndtering, end hvad der er nødvendigt for at fastslå varens art, egenskaber og den måde, den fungerer på. Er varens værdi forringet, kan vi trække værdiforringelsen fra det beløb, vi tilbagebetaler.",
      ],
    },
    returnAddress: "Alnyron, Nyvej 4, 7860 Spøttrup, Danmark, CVR 46887433",
    returnInstructions:
      "Send varen til Alnyron, Nyvej 4, 7860 Spøttrup, Danmark, senest 14 dage efter den dag, du har givet os besked om, at du fortryder. Du betaler selv de direkte omkostninger ved at sende varen retur. Pak varen forsvarligt, læg en seddel med dit ordrenummer i pakken, og gem kvitteringen for forsendelsen: den er dokumentation for, at du har sendt varen.",
    onlineWithdrawal:
      'Du kan fortryde online med "Fortryd aftale her" på {withdrawUrl}. Brug det personlige link i din ordrebekræftelse, eller oplys ordrenummeret og den e-mail, du brugte ved købet. Du får en kvittering på e-mail, når vi har modtaget din fortrydelse.',
    modelForm: {
      title: "Standardfortrydelsesformular",
      intro: "(Denne formular udfyldes og returneres kun, hvis fortrydelsesretten gøres gældende)",
      lines: [
        "Til Alnyron, Nyvej 4, 7860 Spøttrup, Danmark, info@alnyron.dk:",
        "Jeg meddeler herved, at jeg ønsker at gøre fortrydelsesretten gældende i forbindelse med min købsaftale om følgende vare: ______",
        "Ordrenummer: ______",
        "Bestilt den: ______ / modtaget den: ______",
        "Forbrugerens navn: ______",
        "Forbrugerens adresse: ______",
        "Forbrugerens underskrift (kun hvis formularens indhold meddeles på papir): ______",
        "Dato: ______",
      ],
    },
    statement: "Jeg meddeler hermed, at jeg fortryder min aftale om køb af varen.",
    confirmationEmail: {
      subject: "Ordrebekræftelse og faktura nr. {orderNumber}",
      intro: "Tak for din bestilling. Her er bekræftelsen af din købsaftale med Alnyron. Den er også din faktura, så gem denne e-mail.",
      invoiceLines: ["Faktura- og ordrenummer: {orderNumber}", "Faktura- og ordredato: {orderDate}"],
      sellerHeading: "Sælger",
      seller: SELLER,
      buyerHeading: "Køber",
      itemLines: ["Vare: {itemTitle}", "Antal: {quantity}", "I alt inkl. moms og levering: {total}", "heraf moms (25 %): {vat}"],
      payment: RESERVATION,
      shippingHeading: "Leveringsadresse",
      dispatch: "Varen sendes inden for 3 hverdage. Du får en e-mail, når den er sendt.",
      withdrawOnline: "Fortryd online med dit personlige link: {withdrawUrl}",
      returnHeading: "Returnering",
      termsLine: "Handelsbetingelser: {termsUrl}",
      footer: SELLER,
    },
    shippedEmail: {
      subject: "Din ordre nr. {orderNumber} er sendt",
      intro: "Vi har sendt {itemTitle} til den adresse, du opgav ved bestillingen.",
      charged:
        "Beløbet på {total} (heraf moms 25 %: {vat}) er nu trukket. Det fremgår af faktura nr. {orderNumber} i din ordrebekræftelse.",
      tracking: "Forsendelsesnummer: {trackingRef}",
      withdrawal: "Din fortrydelsesfrist på 14 dage løber fra den dag, du modtager varen.",
      withdrawOnline: "Fortryd online med dit personlige link: {withdrawUrl}",
      returnHeading: "Returnering",
      footer: SELLER,
    },
    withdrawalAckEmail: {
      subject: "Vi har modtaget din fortrydelse (ordre {orderNumber})",
      greeting: "Kære {consumerName}",
      received:
        "Vi bekræfter, at vi den {requestedAt} har modtaget din meddelelse om, at du fortryder din aftale om køb af {itemTitle} (ordre {orderNumber}).",
      notShipped: "Varen er ikke sendt, og vi sender den ikke. Du skal ikke returnere noget.",
      shipped: "Send varen retur som beskrevet herunder.",
      returnHeading: "Returnering",
      refundShipped:
        "Vi tilbagebetaler alle betalinger fra dig, herunder levering, senest den {refundDueDate} med samme betalingsmiddel, som du brugte ved købet. Vi kan vente med tilbagebetalingen, til vi har fået varen retur, eller du har sendt os dokumentation for, at du har returneret den. Er varens værdi forringet, fordi du har håndteret den mere, end der er nødvendigt for at fastslå dens art, egenskaber og den måde, den fungerer på, kan vi trække værdiforringelsen fra.",
      refundNotShipped:
        "Du bliver ikke trukket for varen: vi frigiver det reserverede beløb senest den {refundDueDate}. Er beløbet allerede trukket, tilbagebetaler vi det senest samme dag med samme betalingsmiddel, som du brugte ved købet.",
      closing: "Har du spørgsmål, så skriv til info@alnyron.dk.",
      footer: SELLER,
    },
    refundReceiptEmail: {
      subject: "Kreditnota til faktura nr. {orderNumber}",
      greeting: "Kære {consumerName}",
      refunded:
        "Vi har tilbagebetalt {refund} inkl. moms for ordre {orderNumber} til det betalingsmiddel, du brugte ved købet. Det kan tage nogle bankdage, før beløbet står på din konto.",
      creditLines: ["Dato: {creditDate}", "Krediteret beløb inkl. moms: {refund}", "heraf moms (25 %): {refundVat}"],
      deduction: "Vi har trukket {deduction} fra for værdiforringelse af varen. Begrundelse: {reason}",
      sellerHeading: "Sælger",
      seller: SELLER,
      closing: "Har du spørgsmål, så skriv til info@alnyron.dk.",
      footer: SELLER,
    },
    cancellationReceiptEmail: {
      subject: "Kreditnota til faktura nr. {orderNumber}",
      greeting: "Kære {consumerName}",
      canceled: "Vi har annulleret ordre {orderNumber} ({itemTitle}), som du fortrød, før varen blev sendt.",
      released:
        "Du er ikke blevet trukket for ordren. Vi har frigivet det reserverede beløb. Det kan tage nogle bankdage, før reservationen forsvinder fra din konto.",
      creditLines: ["Dato: {creditDate}", "Krediteret beløb inkl. moms: {total}", "heraf moms (25 %): {vat}"],
      sellerHeading: "Sælger",
      seller: SELLER,
      closing: "Har du spørgsmål, så skriv til info@alnyron.dk.",
      footer: SELLER,
    },
    terms: { goodsSections: TERMS_GOODS_DA },
  },
  en: {
    itemPage: {
      priceNote: "incl. VAT and delivery in Denmark",
      facts: [
        "Ships to Denmark only",
        "Dispatched within 3 working days",
        "14-day right of withdrawal",
        "Return shipping paid by the customer",
        RESERVATION_EN,
      ],
      termsLinkLabel: "Terms and conditions",
    },
    termsAcceptPrefix:
      "I accept Alnyron's [terms and conditions]({termsUrl}) for the purchase of goods, including the 14-day right of withdrawal, where I pay the cost of returning the goods.",
    checkoutSubmit: `${RESERVATION_EN} The goods are dispatched within 3 working days to your address in Denmark. You have a 14-day right of withdrawal from the day you receive the goods, and you pay the cost of returning them if you withdraw.`,
    notice: {
      title: "Right of withdrawal",
      paragraphs: [
        "You have the right to withdraw from this contract within 14 days without giving any reason.",
        "The withdrawal period expires 14 days after the day on which you, or a third party other than the carrier and indicated by you, take physical possession of the goods.",
        'To exercise the right of withdrawal, you must inform us (Alnyron, Nyvej 4, 7860 Spøttrup, Denmark, CVR 46887433, info@alnyron.dk) of your decision to withdraw from this contract by an unequivocal statement, e.g. with the "Withdraw from the contract here" function on our website, by email or by letter. You may use the model withdrawal form below, but it is not obligatory.',
        "To meet the withdrawal deadline, it is sufficient for you to send your communication concerning your exercise of the right of withdrawal before the withdrawal period has expired.",
        "If you withdraw from this contract, we shall reimburse to you all payments received from you, including the costs of delivery (we only offer standard delivery, and it is included in the price), without undue delay and in any event not later than 14 days from the day on which we are informed about your decision to withdraw from this contract. We will carry out the reimbursement using the same means of payment as you used for the initial transaction, unless you have expressly agreed otherwise. In any event, you will not incur any fees as a result of the reimbursement.",
        "We may withhold reimbursement until we have received the goods back or you have supplied evidence of having sent back the goods, whichever is the earliest.",
        "You shall send back the goods to Alnyron, Nyvej 4, 7860 Spøttrup, Denmark, without undue delay and in any event not later than 14 days from the day on which you communicate your withdrawal from this contract to us. The deadline is met if you send back the goods before the period of 14 days has expired.",
        "You will have to bear the direct cost of returning the goods. In other words, you pay the return shipping yourself.",
        "You are only liable for any diminished value of the goods resulting from handling other than what is necessary to establish the nature, characteristics and functioning of the goods. If the value of the goods is diminished, we may deduct the diminished value from the amount we reimburse.",
      ],
    },
    returnAddress: "Alnyron, Nyvej 4, 7860 Spøttrup, Denmark, CVR 46887433",
    returnInstructions:
      "Send the goods to Alnyron, Nyvej 4, 7860 Spøttrup, Denmark, no later than 14 days after the day you told us that you withdraw. You pay the direct cost of returning the goods. Pack the goods securely, put a note with your order number in the parcel, and keep the receipt for the shipment: it is evidence that you have sent the goods.",
    onlineWithdrawal:
      'You can withdraw online with "Withdraw from the contract here" at {withdrawUrl}. Use the personal link in your order confirmation, or enter the order number and the email you used for the purchase. You will receive a receipt by email once we have received your withdrawal.',
    modelForm: {
      title: "Model withdrawal form",
      intro: "(Complete and return this form only if you wish to withdraw from the contract)",
      lines: [
        "To Alnyron, Nyvej 4, 7860 Spøttrup, Denmark, info@alnyron.dk:",
        "I hereby give notice that I withdraw from my contract of sale of the following goods: ______",
        "Order number: ______",
        "Ordered on: ______ / received on: ______",
        "Name of consumer: ______",
        "Address of consumer: ______",
        "Signature of consumer (only if this form is notified on paper): ______",
        "Date: ______",
      ],
    },
    statement: "I hereby give notice that I withdraw from my contract for the purchase of the goods.",
    confirmationEmail: {
      subject: "Order confirmation and invoice no. {orderNumber}",
      intro: "Thank you for your order. Here is the confirmation of your contract of sale with Alnyron. It is also your invoice, so please keep this email.",
      invoiceLines: ["Invoice and order number: {orderNumber}", "Invoice and order date: {orderDate}"],
      sellerHeading: "Seller",
      seller: SELLER_EN,
      buyerHeading: "Buyer",
      itemLines: ["Item: {itemTitle}", "Quantity: {quantity}", "Total incl. VAT and delivery: {total}", "of which VAT (25%): {vat}"],
      payment: RESERVATION_EN,
      shippingHeading: "Delivery address",
      dispatch: "The goods are dispatched within 3 working days. You will receive an email when they have been sent.",
      withdrawOnline: "Withdraw online with your personal link: {withdrawUrl}",
      returnHeading: "Returns",
      termsLine: "Terms and conditions: {termsUrl}",
      footer: SELLER_EN,
    },
    shippedEmail: {
      subject: "Your order no. {orderNumber} has been sent",
      intro: "We have sent {itemTitle} to the address you gave when you ordered.",
      charged:
        "The amount of {total} (of which VAT 25%: {vat}) has now been charged. It appears on invoice no. {orderNumber} in your order confirmation.",
      tracking: "Tracking number: {trackingRef}",
      withdrawal: "Your 14-day withdrawal period runs from the day you receive the goods.",
      withdrawOnline: "Withdraw online with your personal link: {withdrawUrl}",
      returnHeading: "Returns",
      footer: SELLER_EN,
    },
    withdrawalAckEmail: {
      subject: "We have received your withdrawal (order {orderNumber})",
      greeting: "Dear {consumerName}",
      received:
        "We confirm that on {requestedAt} we received your notice that you withdraw from your contract for the purchase of {itemTitle} (order {orderNumber}).",
      notShipped: "The goods have not been sent, and we will not send them. You do not need to return anything.",
      shipped: "Please return the goods as described below.",
      returnHeading: "Returns",
      refundShipped:
        "We will reimburse all payments received from you, including delivery, no later than {refundDueDate}, using the same means of payment you used for the purchase. We may wait with the reimbursement until we have received the goods back or you have sent us evidence of having returned them. If the value of the goods is diminished because you handled them more than necessary to establish their nature, characteristics and functioning, we may deduct the diminished value.",
      refundNotShipped:
        "You will not be charged for the goods: we release the reserved amount no later than {refundDueDate}. If the amount has already been charged, we will reimburse it by the same date, using the same means of payment you used for the purchase.",
      closing: "If you have questions, write to info@alnyron.dk.",
      footer: SELLER_EN,
    },
    refundReceiptEmail: {
      subject: "Credit note for invoice no. {orderNumber}",
      greeting: "Dear {consumerName}",
      refunded:
        "We have refunded {refund} incl. VAT for order {orderNumber} to the means of payment you used for the purchase. It may take a few banking days before the amount appears in your account.",
      creditLines: ["Date: {creditDate}", "Amount credited incl. VAT: {refund}", "of which VAT (25%): {refundVat}"],
      deduction: "We have deducted {deduction} for diminished value of the goods. Reason: {reason}",
      sellerHeading: "Seller",
      seller: SELLER_EN,
      closing: "If you have questions, write to info@alnyron.dk.",
      footer: SELLER_EN,
    },
    cancellationReceiptEmail: {
      subject: "Credit note for invoice no. {orderNumber}",
      greeting: "Dear {consumerName}",
      canceled: "We have canceled order {orderNumber} ({itemTitle}), which you withdrew from before the goods were sent.",
      released:
        "You have not been charged for the order. We have released the reserved amount. It may take a few banking days before the reservation disappears from your account.",
      creditLines: ["Date: {creditDate}", "Amount credited incl. VAT: {total}", "of which VAT (25%): {vat}"],
      sellerHeading: "Seller",
      seller: SELLER_EN,
      closing: "If you have questions, write to info@alnyron.dk.",
      footer: SELLER_EN,
    },
    terms: { goodsSections: TERMS_GOODS_EN },
  },
};

/**
 * Why a goods withdrawal's refund or release needs the owner's manual handling
 * (`order_withdrawals.manual_reason`).
 */
export type OrderManualReason = "stripe_refused" | "retries_exhausted";

/**
 * The owner's emails about goods orders (internal, Danish only), sent to
 * ORDER_NOTIFY_TO: a new order, the warning before an order's payment
 * reservation lapses, a lapsed reservation, a capture Stripe refused, a
 * received withdrawal, the refund reminder and a refund or release that needs
 * manual handling. Not part of the hashed consumer bundle.
 */
export const GOODS_OWNER_EMAIL_TEXTS = {
  newOrder: {
    /** `{orderNumber}`, `{itemTitle}`. */
    subject: "Ny ordre {orderNumber}: {itemTitle}",
    intro:
      "Der er kommet en ny ordre. Beløbet er reserveret og trækkes, når du markerer ordren afsendt. Send varen inden for 3 hverdage.",
    /** `{orderNumber}`, `{itemTitle}`, `{amount}`, `{name}`, `{address}`, `{phone}`, `{email}`. */
    lines: [
      "Ordre: {orderNumber}",
      "Vare: {itemTitle}",
      "Beløb: {amount} inkl. moms",
      "Navn: {name}",
      "Leveringsadresse: {address}",
      "Telefon: {phone}",
      "E-mail: {email}",
    ],
    /** `{expiresAt}`: only when the reservation has an expiry (a card payment). */
    authorization: "Reservationen udløber {expiresAt}. Markér ordren afsendt inden da.",
    /** `{anomaly}`: only when the order was recorded with an anomaly. */
    anomaly: "Afvigelse: {anomaly}. Tjek ordren, før du sender varen.",
    /** `{adminLink}`. */
    adminLink: "Se ordren: {adminLink}",
  },
  captureWarning: {
    /** `{orderNumber}`, `{expiresAt}`. */
    subject: "Ordre {orderNumber}: betalingen udløber {expiresAt}",
    /** `{orderNumber}`, `{expiresAt}`. */
    intro:
      "Betalingen for ordre {orderNumber} er kun reserveret og udløber {expiresAt}. Send varen, og markér ordren afsendt inden da, ellers bortfalder betalingen.",
    /** `{orderNumber}`, `{itemTitle}`, `{amount}`. */
    lines: ["Ordre: {orderNumber}", "Vare: {itemTitle}", "Beløb: {amount} inkl. moms"],
    /** `{adminLink}`. */
    adminLink: "Se ordren: {adminLink}",
  },
  authorizationExpired: {
    /** `{orderNumber}`. */
    subject: "Ordre {orderNumber}: betalingen er udløbet",
    /** `{orderNumber}`. */
    intro: "Betalingen for ordre {orderNumber} er udløbet; send ikke varen. Køberen er ikke blevet trukket.",
    /** `{orderNumber}`, `{itemTitle}`, `{amount}`, `{email}`. */
    lines: ["Ordre: {orderNumber}", "Vare: {itemTitle}", "Beløb: {amount} inkl. moms", "Køberens e-mail: {email}"],
    contact: "Kontakt køberen, hvis handlen stadig skal gennemføres.",
    /** `{adminLink}`. */
    adminLink: "Se ordren: {adminLink}",
  },
  captureFailed: {
    /** `{orderNumber}`. */
    subject: "Ordre {orderNumber}: betalingen kunne ikke trækkes",
    /** `{orderNumber}`. */
    intro: "Betalingen for ordre {orderNumber} kunne ikke trækkes. Send ikke varen, før det er løst.",
    /** `{orderNumber}`, `{itemTitle}`, `{amount}`, `{email}`. */
    lines: ["Ordre: {orderNumber}", "Vare: {itemTitle}", "Beløb: {amount} inkl. moms", "Køberens e-mail: {email}"],
    contact:
      "Ordren er ikke markeret som afsendt. Tjek betalingen i Stripe, og kontakt køberen, hvis den ikke kan gennemføres.",
    /** `{adminLink}`. */
    adminLink: "Se ordren: {adminLink}",
  },
  withdrawalAlert: {
    /** `{orderNumber}`. */
    subject: "Fortrydelse modtaget: ordre {orderNumber}",
    /** The goods were not shipped when the notice came. */
    doNotShip:
      "SEND IKKE VAREN. Kunden har fortrudt, før varen blev sendt. Godkend fortrydelsen på ordresiden, så reservationen frigives.",
    /** The goods were shipped. */
    shipped:
      "Varen er sendt. Godkend tilbagebetalingen på ordresiden, når varen er kommet retur, eller kunden har vist, at den er sendt.",
    /** `{deadline}`: the notice came after the withdrawal period (accepted and recorded, the owner decides). */
    late: "OBS: Fortrydelsen kom for sent (fristen udløb {deadline}). Vurdér den, før du tilbagebetaler.",
    /** `{orderNumber}`, `{itemTitle}`, `{consumerName}`, `{requestedAt}`. */
    lines: ["Ordre: {orderNumber}", "Vare: {itemTitle}", "Kundens navn: {consumerName}", "Modtaget: {requestedAt}"],
    /** `{refundDueDate}`. */
    refundDeadline: "Tilbagebetal eller frigiv reservationen senest {refundDueDate}, 14 dage efter modtagelsen.",
    /** `{adminLink}`. */
    adminLink: "Se ordren: {adminLink}",
  },
  refundReminder: {
    /** `{orderNumber}`, `{refundDueDate}`. */
    subject: "Påmindelse: tilbagebetal ordre {orderNumber} senest {refundDueDate}",
    intro: "En fortrydelse venter stadig på, at du godkender tilbagebetalingen eller frigivelsen af reservationen.",
    /** `{orderNumber}`, `{itemTitle}`, `{consumerName}`, `{requestedAt}`. */
    lines: ["Ordre: {orderNumber}", "Vare: {itemTitle}", "Kundens navn: {consumerName}", "Modtaget: {requestedAt}"],
    /** `{refundDueDate}`. */
    refundDeadline: "Tilbagebetal eller frigiv reservationen senest {refundDueDate}, 14 dage efter modtagelsen.",
    /** `{adminLink}`. */
    adminLink: "Se ordren: {adminLink}",
  },
  manualAlert: {
    /** `{orderNumber}`. */
    subject: "Ordre {orderNumber}: fortrydelsen kræver manuel behandling",
    intro: "En tilbagebetaling eller frigivelse af en reservation kunne ikke gennemføres automatisk.",
    /** What each manual reason means. */
    reasons: {
      stripe_refused: "Stripe afviste tilbagebetalingen eller frigivelsen af reservationen.",
      retries_exhausted: "Tilbagebetalingen eller frigivelsen fejlede for mange gange.",
    } satisfies Record<OrderManualReason, string>,
    /** `{orderNumber}`, `{withdrawalId}`, `{reasonText}`. */
    lines: ["Ordre: {orderNumber}", "Fortrydelse: {withdrawalId}", "Årsag: {reasonText}"],
    runbook: 'Fremgangsmåde: workers/payments/README.md, afsnittet "Ordrer: manuel behandling".',
    /** `{adminLink}`. */
    adminLink: "Se ordren: {adminLink}",
  },
  /** Shown for an order field the buyer left empty or Stripe did not send. */
  missing: "(mangler)",
  footer: "Alnyron",
} as const;

/**
 * The sha256 (hex) of `JSON.stringify(GOODS_TEXTS[locale])` (the canonical
 * serialization of one language's texts) per text version and language: an
 * order stores the digest of the texts its buyer was shown. Earlier versions
 * stay listed, so an order recorded under them still resolves after the texts
 * change. Look up a version from outside (Stripe metadata) with
 * {@link goodsTextDigest}.
 */
export const GOODS_TEXT_SHA256 = {
  "goods-2026-11-14.1": {
    da: "de7a3eb44e13372843ac858165953b479ece1007fe336ee2577f20b2904df715",
    en: "06f12ffa6070837de72873eac9a1d9615dc9068de396ca820b1877bc82d745bb",
  },
} as const satisfies Readonly<Record<string, Readonly<Record<Locale, string>>>>;

/** The digest of `version`'s texts in `locale`, or null when `version` is not a known goods text version. */
export function goodsTextDigest(version: string, locale: Locale): string | null {
  const digests: Readonly<Record<string, Readonly<Record<Locale, string>>>> = GOODS_TEXT_SHA256;
  return Object.hasOwn(digests, version) ? (digests[version]?.[locale] ?? null) : null;
}

/**
 * Stripe Checkout's terms-acceptance checkbox text for goods
 * (`custom_text.terms_of_service_acceptance.message`, markdown): the
 * acceptance sentence linking `termsUrl`.
 */
export function goodsCheckoutConsentMessage(locale: Locale, termsUrl: string): string {
  return fillTemplate(GOODS_TEXTS[locale].termsAcceptPrefix, { termsUrl });
}
