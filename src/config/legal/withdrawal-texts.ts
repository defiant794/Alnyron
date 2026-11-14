import type { Locale } from "next-intl";

/**
 * The versioned legal wording of the Monitor subscription's right of
 * withdrawal (fortrydelsesret, forbrugeraftaleloven): the withdrawal notice,
 * the model withdrawal form, the express-consent text shown in Stripe
 * Checkout, the billing page's fine print, the withdrawal statement, both
 * emails to the consumer, the owner's alert, and the /terms body.
 *
 * DRAFT texts for owner/accountant review before go-live, not a legal
 * guarantee. Every surface renders from this module (Checkout, /terms, the
 * billing pages, the payments Worker's emails), so the wording a consumer saw
 * is identified by {@link WITHDRAWAL_TEXT_VERSION} plus the sha256 of the
 * locale's bundle ({@link WITHDRAWAL_TEXT_SHA256}), stored with each recorded
 * consent. Any edit of a text MUST bump the version and add the new digests:
 * a unit test recomputes and pins them.
 *
 * Placeholders in braces (`{termsUrl}`) are filled by the caller with
 * {@link fillTemplate}; they are not part of the wording. No string uses an
 * em dash or an en dash.
 */

/** The version of the texts below; a recorded consent and a withdrawal statement carry it. */
export const WITHDRAWAL_TEXT_VERSION = "2026-11-14.1";

/** The legal texts of one language. */
export type WithdrawalTexts = {
  /** The withdrawal notice (fortrydelsesvejledning): its title and five paragraphs. */
  notice: { title: string; paragraphs: readonly [string, string, string, string, string] };
  /** Where to withdraw online; shown right after the notice everywhere. */
  onlineWithdrawal: string;
  /** The model withdrawal form: title, intro and its seven lines. */
  modelForm: {
    title: string;
    intro: string;
    lines: readonly [string, string, string, string, string, string, string];
  };
  /** The express request to start at once (the Checkout checkbox's text after the prefix). */
  consent: string;
  /** The Checkout checkbox's first sentence: a markdown link to `{termsUrl}`. */
  termsAcceptPrefix: string;
  /** Stripe Checkout's line above the pay button. */
  checkoutSubmit: string;
  /** The billing page's fine print and its link label (to /terms). */
  billingFinePrint: { text: string; termsLinkLabel: string };
  /** The withdrawal statement on the confirm page (`{startDate}`). */
  statement: string;
  /** Under the statement when a consent was recorded (pro rata payment). */
  statementEffect: string;
  /** Under the statement without a recorded consent (full refund). */
  statementEffectNoConsent: string;
  /** The order confirmation (durable medium), sent by the payments Worker. */
  confirmationEmail: {
    subject: string;
    intro: string;
    agreementHeading: string;
    /** `{planName}`, `{price}`, `{intervalWord}`, `{startDate}`. */
    agreementLines: readonly [string, string, string, string];
    /** The word `{intervalWord}` stands for, per billing interval. */
    intervalWords: { month: string; year: string };
    consentHeading: string;
    consentIntro: string;
    /** `{withdrawUrl}`. */
    withdrawOnline: string;
    /** `{termsUrl}`. */
    termsLine: string;
    footer: string;
  };
  /** The withdrawal receipt, sent to the account email. */
  receiptEmail: {
    subject: string;
    /** `{consumerName}`. */
    greeting: string;
    /** `{requestedAt}`, `{startDate}`. */
    received: string;
    /** Completed with a refund: `{refund}`, `{paid}`, `{retained}`. */
    statusRefunded: string;
    /** Completed with nothing to refund. */
    statusNothing: string;
    /** Received, canceled or awaiting manual handling. */
    statusInProgress: string;
    closing: string;
    footer: string;
  };
  /** The /terms body: markdown before and after the notice, online withdrawal and model form. */
  terms: {
    /** Sections 1 to 6. */
    sectionsBeforeWithdrawal: string;
    /** Sections 7 to 11 (`{privacyPath}`). */
    sectionsAfterWithdrawal: string;
    /** The page's last line (`{version}`). */
    versionLine: string;
  };
};

const SELLER_FOOTER = "Alnyron, Nyvej 4, 7860 Spøttrup, CVR 46887433, info@alnyron.dk";

const TERMS_DA_BEFORE = `## 1. Sælger
Alnyron
CVR 46887433
Nyvej 4, 7860 Spøttrup
E-mail: info@alnyron.dk

## 2. Ydelsen
Monitor er en tjeneste, der overvåger de websteder, du tilføjer, og giver dig besked, når et websted ikke svarer. Du kan bruge Monitor gratis med et begrænset antal websteder. Med abonnementet Monitor Plus kan du overvåge flere websteder. Det antal, abonnementet giver, står på siden Abonnement i Monitor, før du betaler.

## 3. Aftalen
Aftalen indgås, når du har gennemført betalingen på Stripes betalingsside. Abonnementet er knyttet til din Monitor-konto og starter med det samme. Du får en bekræftelse på e-mail med aftalens indhold, fortrydelsesvejledningen og standardfortrydelsesformularen.

## 4. Priser og betaling
Alle priser er i danske kroner og inkluderer 25 % moms. Prisen står på siden Abonnement, før du betaler. Abonnementet betales forud for hver periode (en måned eller et år). Betalingen håndteres af vores betalingsudbyder Stripe, og vi gemmer ikke dine kortoplysninger. Du kan se dine betalinger under "Administrér abonnement" på siden Abonnement.

## 5. Fornyelse og opsigelse
Abonnementet fornyes automatisk ved udløbet af hver betalte periode, indtil du opsiger det. Du kan opsige når som helst under "Administrér abonnement" på siden Abonnement. Opsigelsen får virkning ved udløbet af den betalte periode, og du betaler ikke for nye perioder. Ved opsigelse tilbagebetaler vi ikke for resten af en betalt periode; det gælder ikke, når du bruger fortrydelsesretten (punkt 6). Kan en betaling ved fornyelse ikke gennemføres, kan abonnementet ophøre. Så går din konto tilbage til det gratis antal websteder, og de nyeste overvågninger ud over det antal sættes på pause.

## 6. Fortrydelsesret
Du har 14 dages fortrydelsesret efter forbrugeraftaleloven. Fortrydelsesvejledningen og standardfortrydelsesformularen står nedenfor. Du kan fortryde online med "Fortryd aftale" på siden Abonnement, så længe fristen løber, eller ved at skrive til info@alnyron.dk.`;

const TERMS_DA_AFTER = `## 7. Reklamation
Er tjenesten mangelfuld, kan du reklamere efter købelovens regler om digitale ydelser. Skriv til info@alnyron.dk med en beskrivelse af problemet så hurtigt som muligt, efter du har opdaget det.

## 8. Persondata
Vi behandler dine personoplysninger som beskrevet i vores [privatlivspolitik]({privacyPath}).

## 9. Klageadgang
Vil du klage, så skriv først til os på info@alnyron.dk, så vi kan finde en løsning. Lykkes det ikke, kan du klage til Nævnenes Hus, Center for Klageløsning, via [forbrug.dk](https://www.forbrug.dk). Bor du i et andet EU-land, kan du også kontakte [Forbruger Europa](https://www.forbrugereuropa.dk).

## 10. Lovvalg og værneting
Aftalen er underlagt dansk ret, og tvister afgøres ved de danske domstole. Det gælder dog ikke, hvis ufravigelige regler i dit bopælsland giver dig en bedre retsstilling.

## 11. Ændringer
Vi kan ændre betingelserne. Væsentlige ændringer får du besked om på e-mail mindst 30 dage før, de gælder for dit abonnement, så du kan nå at opsige det.`;

const TERMS_EN_BEFORE = `## 1. Seller
Alnyron
CVR 46887433
Nyvej 4, 7860 Spøttrup, Denmark
Email: info@alnyron.dk

## 2. The service
Monitor is a service that monitors the websites you add and notifies you when a website does not respond. You can use Monitor free of charge with a limited number of websites. With the Monitor Plus subscription you can monitor more websites. The number the subscription gives is shown on the Subscription page in Monitor before you pay.

## 3. The agreement
The agreement is made when you have completed payment on Stripe's payment page. The subscription is linked to your Monitor account and starts immediately. You receive a confirmation by email with the content of the agreement, the withdrawal information and the model withdrawal form.

## 4. Prices and payment
All prices are in Danish kroner and include 25% VAT. The price is shown on the Subscription page before you pay. The subscription is paid in advance for each period (one month or one year). Payment is handled by our payment provider Stripe, and we do not store your card details. You can see your payments under "Manage subscription" on the Subscription page.

## 5. Renewal and cancellation
The subscription renews automatically at the end of each paid period until you cancel it. You can cancel at any time under "Manage subscription" on the Subscription page. Cancellation takes effect at the end of the paid period, and you do not pay for new periods. On cancellation we do not refund the rest of a paid period; this does not apply when you use the right of withdrawal (section 6). If a renewal payment cannot be completed, the subscription may end. Your account then returns to the free number of websites, and the newest monitors beyond that number are paused.

## 6. Right of withdrawal
You have a 14-day right of withdrawal under the Danish Consumer Contracts Act. The withdrawal information and the model withdrawal form are shown below. You can withdraw online with "Withdraw from agreement" on the Subscription page while the period runs, or by writing to info@alnyron.dk.`;

const TERMS_EN_AFTER = `## 7. Complaints about defects
If the service is defective, you can complain under the rules of the Danish Sale of Goods Act on digital services. Write to info@alnyron.dk with a description of the problem as soon as possible after you discover it.

## 8. Personal data
We process your personal data as described in our [privacy policy]({privacyPath}).

## 9. Complaints
If you want to complain, please write to us first at info@alnyron.dk so we can find a solution. If that does not succeed, you can complain to the Danish Centre for Complaint Resolution (Nævnenes Hus) via [forbrug.dk](https://www.forbrug.dk). If you live in another EU country, you can also contact [the European Consumer Centre Denmark](https://www.forbrugereuropa.dk).

## 10. Governing law and venue
The agreement is governed by Danish law, and disputes are settled by the Danish courts. This does not apply where mandatory rules of your country of residence give you better protection.

## 11. Changes
We may change these terms. You will be notified by email of material changes at least 30 days before they apply to your subscription, so you have time to cancel it.`;

/** The texts of {@link WITHDRAWAL_TEXT_VERSION}, per UI language. */
export const WITHDRAWAL_TEXTS: Readonly<Record<Locale, WithdrawalTexts>> = {
  da: {
    notice: {
      title: "Fortrydelsesret",
      paragraphs: [
        "Du har ret til at fortryde din aftale om Monitor-abonnement uden begrundelse inden for 14 dage.",
        "Fortrydelsesfristen udløber 14 dage efter den dag, hvor du indgik abonnementsaftalen.",
        "For at udøve fortrydelsesretten skal du meddele os (Alnyron, Nyvej 4, 7860 Spøttrup, CVR 46887433, info@alnyron.dk) din beslutning om at fortryde i en utvetydig erklæring (f.eks. en e-mail). Du kan bruge standardfortrydelsesformularen nedenfor, men det er ikke et krav. Fortrydelsesfristen er overholdt, hvis du sender din meddelelse, inden fristen udløber.",
        "Hvis du har bedt os om at påbegynde abonnementet, inden fortrydelsesfristen udløber, skal du betale et forholdsmæssigt beløb for den periode, abonnementet har været aktivt, indtil du meddeler os, at du fortryder.",
        "Hvis du fortryder aftalen, tilbagebetaler vi det beløb, vi har modtaget fra dig (fratrukket et eventuelt forholdsmæssigt beløb som nævnt ovenfor), uden unødig forsinkelse og senest 14 dage fra den dag, hvor vi har modtaget din meddelelse om fortrydelse. Vi gennemfører tilbagebetalingen med samme betalingsmiddel, som du brugte ved den oprindelige betaling, medmindre du udtrykkeligt har aftalt andet med os. Du betaler ikke gebyr som følge af tilbagebetalingen.",
      ],
    },
    onlineWithdrawal:
      'Du kan også fortryde online: Log ind på Monitor, gå til Abonnement og vælg "Fortryd aftale", så længe fristen løber. Du får en kvittering på e-mail, når vi har modtaget din fortrydelse.',
    modelForm: {
      title: "Standardfortrydelsesformular",
      intro: "(Denne formular udfyldes og returneres kun, hvis fortrydelsesretten gøres gældende)",
      lines: [
        "Til Alnyron, Nyvej 4, 7860 Spøttrup, CVR 46887433, info@alnyron.dk:",
        "Jeg meddeler herved, at jeg ønsker at gøre fortrydelsesretten gældende i forbindelse med min aftale om Monitor-abonnement.",
        "Aftalen blev indgået den: ______",
        "Forbrugerens navn: ______",
        "Forbrugerens adresse: ______",
        "Forbrugerens e-mail (konto): ______",
        "Dato: ______",
      ],
    },
    consent:
      "Jeg anmoder om, at Alnyron påbegynder Monitor-abonnementet med det samme, inden fortrydelsesfristen på 14 dage udløber. Jeg er indforstået med, at jeg stadig kan fortryde inden for 14 dage, men at jeg i så fald betaler et forholdsmæssigt beløb for den periode, abonnementet har været aktivt.",
    termsAcceptPrefix: "Jeg accepterer Alnyrons [handelsbetingelser]({termsUrl}).",
    checkoutSubmit:
      "Du har 14 dages fortrydelsesret. Du kan fortryde online under Abonnement i Monitor, og du får fortrydelsesvejledningen på e-mail.",
    billingFinePrint: {
      text: "Priserne er inkl. 25 % moms. Abonnementet fornyes automatisk og kan opsiges når som helst til udløbet af den betalte periode. Du har 14 dages fortrydelsesret: fortryder du, betaler du kun for den tid, abonnementet har været aktivt.",
      termsLinkLabel: "Læs handelsbetingelserne og fortrydelsesretten",
    },
    statement: "Jeg meddeler herved, at jeg fortryder min aftale om Monitor-abonnement, indgået den {startDate}.",
    statementEffect:
      "Når du bekræfter, stopper abonnementet med det samme. Vi tilbagebetaler det beløb, du har betalt, fratrukket betaling for den tid, abonnementet har været aktivt, senest 14 dage fra i dag.",
    statementEffectNoConsent:
      "Når du bekræfter, stopper abonnementet med det samme, og vi tilbagebetaler hele det beløb, du har betalt, senest 14 dage fra i dag.",
    confirmationEmail: {
      subject: "Bekræftelse af dit Monitor-abonnement",
      intro: "Tak for dit køb. Her er bekræftelsen af din aftale med Alnyron.",
      agreementHeading: "Din aftale",
      agreementLines: [
        "Abonnement: {planName}",
        "Pris: {price} pr. {intervalWord} inkl. 25 % moms",
        "Aftalen blev indgået den: {startDate}",
        "Abonnementet fornyes automatisk, indtil du opsiger det. Du kan opsige når som helst til udløbet af den betalte periode.",
      ],
      intervalWords: { month: "måned", year: "år" },
      consentHeading: "Dit samtykke",
      consentIntro:
        "Ved betalingen bad du om, at abonnementet startede med det samme, og accepterede, at du ved fortrydelse betaler et forholdsmæssigt beløb for den periode, abonnementet har været aktivt. Du bekræftede denne tekst:",
      withdrawOnline: "Fortryd online: {withdrawUrl}",
      termsLine: "Handelsbetingelser: {termsUrl}",
      footer: SELLER_FOOTER,
    },
    receiptEmail: {
      subject: "Vi har modtaget din fortrydelse",
      greeting: "Kære {consumerName}",
      received:
        "Vi bekræfter, at vi den {requestedAt} har modtaget din meddelelse om, at du fortryder din aftale om Monitor-abonnement, indgået den {startDate}.",
      statusRefunded:
        "Abonnementet er stoppet. Vi har tilbagebetalt {refund} inkl. moms til det betalingsmiddel, du brugte. Du har betalt {paid}, og {retained} dækker den tid, abonnementet var aktivt. Det kan tage nogle bankdage, før beløbet står på din konto.",
      statusNothing:
        "Abonnementet er stoppet. Du har ikke betalt noget for abonnementet, så der er intet at tilbagebetale.",
      statusInProgress:
        "Abonnementet stoppes, og vi tilbagebetaler det beløb, du har ret til, senest 14 dage fra den dag, vi modtog din meddelelse. Du får besked på e-mail, hvis vi har brug for noget fra dig.",
      closing: "Har du spørgsmål, så skriv til info@alnyron.dk.",
      footer: SELLER_FOOTER,
    },
    terms: {
      sectionsBeforeWithdrawal: TERMS_DA_BEFORE,
      sectionsAfterWithdrawal: TERMS_DA_AFTER,
      versionLine: "Version {version}.",
    },
  },
  en: {
    notice: {
      title: "Right of withdrawal",
      paragraphs: [
        "You have the right to withdraw from your Monitor subscription agreement, without giving any reason, within 14 days.",
        "The withdrawal period expires 14 days after the day on which you entered into the subscription agreement.",
        "To exercise the right of withdrawal, you must inform us (Alnyron, Nyvej 4, 7860 Spøttrup, CVR 46887433, info@alnyron.dk) of your decision to withdraw by an unequivocal statement (e.g. an email). You may use the model withdrawal form below, but it is not required. The withdrawal deadline is met if you send your communication before the period expires.",
        "If you asked us to begin the subscription before the withdrawal period expired, you must pay a proportionate amount for the period during which the subscription was active, up until you inform us that you withdraw.",
        "If you withdraw, we will refund the amount we received from you (less any proportionate amount as stated above) without undue delay and no later than 14 days from the day on which we receive your notice of withdrawal. We will make the refund using the same means of payment you used for the original transaction, unless you have expressly agreed otherwise. You will not incur any fees as a result of the refund.",
      ],
    },
    onlineWithdrawal:
      'You can also withdraw online: sign in to Monitor, go to Subscription and choose "Withdraw from agreement" while the period runs. You will receive a receipt by email once we have received your withdrawal.',
    modelForm: {
      title: "Model withdrawal form",
      intro: "(Complete and return this form only if you wish to withdraw from the contract)",
      lines: [
        "To Alnyron, Nyvej 4, 7860 Spøttrup, CVR 46887433, info@alnyron.dk:",
        "I hereby give notice that I withdraw from my agreement for the Monitor subscription.",
        "Agreement entered into on: ______",
        "Consumer's name: ______",
        "Consumer's address: ______",
        "Consumer's email (account): ______",
        "Date: ______",
      ],
    },
    consent:
      "I request that Alnyron begins the Monitor subscription immediately, before the 14-day withdrawal period expires. I understand that I can still withdraw within 14 days, but that if I do, I will pay a proportionate amount for the period during which the subscription was active.",
    termsAcceptPrefix: "I accept Alnyron's [terms and conditions]({termsUrl}).",
    checkoutSubmit:
      "You have a 14-day right of withdrawal. You can withdraw online under Subscription in Monitor, and you will receive the withdrawal information by email.",
    billingFinePrint: {
      text: "Prices include 25% VAT. The subscription renews automatically and can be cancelled at any time to the end of the paid period. You have a 14-day right of withdrawal: if you withdraw, you only pay for the time the subscription was active.",
      termsLinkLabel: "Read the terms and the right of withdrawal",
    },
    statement:
      "I hereby give notice that I withdraw from my agreement for the Monitor subscription, entered into on {startDate}.",
    statementEffect:
      "When you confirm, the subscription stops at once. We refund what you paid, less payment for the time the subscription was active, no later than 14 days from today.",
    statementEffectNoConsent:
      "When you confirm, the subscription stops at once, and we refund the full amount you paid no later than 14 days from today.",
    confirmationEmail: {
      subject: "Confirmation of your Monitor subscription",
      intro: "Thank you for your purchase. Here is the confirmation of your agreement with Alnyron.",
      agreementHeading: "Your agreement",
      agreementLines: [
        "Subscription: {planName}",
        "Price: {price} per {intervalWord} incl. 25% VAT",
        "Agreement entered into on: {startDate}",
        "The subscription renews automatically until you cancel it. You can cancel at any time to the end of the paid period.",
      ],
      intervalWords: { month: "month", year: "year" },
      consentHeading: "Your consent",
      consentIntro:
        "At payment you asked for the subscription to start immediately and accepted that if you withdraw, you pay a proportionate amount for the period during which the subscription was active. You confirmed this text:",
      withdrawOnline: "Withdraw online: {withdrawUrl}",
      termsLine: "Terms and conditions: {termsUrl}",
      footer: SELLER_FOOTER,
    },
    receiptEmail: {
      subject: "We have received your withdrawal",
      greeting: "Dear {consumerName}",
      received:
        "We confirm that on {requestedAt} we received your notice that you withdraw from your agreement for the Monitor subscription, entered into on {startDate}.",
      statusRefunded:
        "The subscription has stopped. We have refunded {refund} incl. VAT to the means of payment you used. You paid {paid}, and {retained} covers the time the subscription was active. It may take a few banking days before the amount appears in your account.",
      statusNothing:
        "The subscription has stopped. You have not paid anything for the subscription, so there is nothing to refund.",
      statusInProgress:
        "The subscription is being stopped, and we will refund the amount you are entitled to no later than 14 days from the day we received your notice. We will email you if we need anything from you.",
      closing: "If you have questions, write to info@alnyron.dk.",
      footer: SELLER_FOOTER,
    },
    terms: {
      sectionsBeforeWithdrawal: TERMS_EN_BEFORE,
      sectionsAfterWithdrawal: TERMS_EN_AFTER,
      versionLine: "Version {version}.",
    },
  },
};

/**
 * The owner's alert about a withdrawal that needs manual handling (internal,
 * Danish only, ids but no consumer name or email). Not part of the hashed
 * consumer bundle.
 */
export const WITHDRAWAL_ALERT_EMAIL_TEXTS = {
  /** `{reason}`. */
  subject: "Fortrydelse kræver manuel behandling ({reason})",
  intro: "En fortrydelse kunne ikke gennemføres automatisk.",
  /** `{withdrawalId}`, `{subscriptionId}`, `{requestedAt}`, `{reason}`, `{canceledYesNo}`. */
  lines: [
    "Fortrydelse: {withdrawalId}",
    "Abonnement: {subscriptionId}",
    "Modtaget: {requestedAt}",
    "Årsag: {reason}",
    "Abonnementet er stoppet: {canceledYesNo}",
  ],
  /** Whether the consumer's receipt is out (`ack_sent_at`): the first line when it is, else the second. */
  receiptSent: "Kunden har fået kvittering.",
  receiptNotSent: "Kvitteringen er ikke sendt endnu. Tjek ack_sent_at, og send den manuelt, hvis den stadig mangler.",
  /** `{refundDeadline}`. */
  refundDeadline: "Tilbagebetal senest {refundDeadline} (14 dage efter modtagelsen).",
  runbook: 'Fremgangsmåde: workers/payments/README.md, afsnittet "Fortrydelse: manuel behandling".',
  /** What `{canceledYesNo}` stands for. */
  yes: "ja",
  no: "nej",
} as const;

/**
 * The canonical serialization of one language's texts: the input of its
 * digest in {@link WITHDRAWAL_TEXT_SHA256}.
 */
export function withdrawalTextBundle(locale: Locale): string {
  return JSON.stringify(WITHDRAWAL_TEXTS[locale]);
}

/**
 * The sha256 (hex) of {@link withdrawalTextBundle} per text version and
 * language: a recorded consent stores the digest of the texts it was given.
 * Earlier versions stay listed, so a consent recorded under them still
 * resolves after the texts change. Look up a version from outside (Stripe
 * metadata) with {@link withdrawalTextDigest}.
 */
export const WITHDRAWAL_TEXT_SHA256 = {
  "2026-11-14.1": {
    da: "2bf84400d9b6d203cd554494a295ab53cbe92eba464220e8da9ec2ba12bd6aea",
    en: "a759f9c7b49ac9ba8ba35303f6f1a73ada4edcc9261386c8e49b9a7c218dac1b",
  },
} as const satisfies Readonly<Record<string, Readonly<Record<Locale, string>>>>;

/** The digest of `version`'s texts in `locale`, or null when `version` is not a known text version. */
export function withdrawalTextDigest(version: string, locale: Locale): string | null {
  const digests: Readonly<Record<string, Readonly<Record<Locale, string>>>> = WITHDRAWAL_TEXT_SHA256;
  return Object.hasOwn(digests, version) ? (digests[version]?.[locale] ?? null) : null;
}

/**
 * `text` with every `{name}` placeholder replaced by `values[name]`.
 *
 * @throws Error when the text holds a placeholder `values` has no entry for,
 *   so a template never reaches a reader with a brace left in it.
 */
export function fillTemplate(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\{([A-Za-z]+)\}/g, (_match, name: string) => {
    const value = Object.hasOwn(values, name) ? values[name] : undefined;
    if (value === undefined) throw new Error(`withdrawal texts: no value for placeholder ${name}`);
    return value;
  });
}

/**
 * Stripe Checkout's consent checkbox text (`custom_text.terms_of_service_acceptance.message`,
 * markdown): the terms prefix linking `termsUrl`, then the express request.
 */
export function checkoutConsentMessage(locale: Locale, termsUrl: string): string {
  const texts = WITHDRAWAL_TEXTS[locale];
  return `${fillTemplate(texts.termsAcceptPrefix, { termsUrl })} ${texts.consent}`;
}
