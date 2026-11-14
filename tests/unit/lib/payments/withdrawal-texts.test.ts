/**
 * Unit tests: src/config/legal/withdrawal-texts.ts
 * Journey: payments-slice1d-withdrawal
 * Criteria: WD-J1-C01, WD-J1-C03, WD-J2-C06
 *
 * Coverage:
 *   - WITHDRAWAL_TEXT_VERSION constant
 *   - WITHDRAWAL_TEXT_SHA256: 64-hex shape; recompute from withdrawalTextBundle; literal pin
 *   - no U+2014 or U+2013 in any string in the module (the consumer texts and the owner alert)
 *   - verbatim pins of every string of sections A to D, DA and EN (notice, onlineWithdrawal,
 *     modelForm, consent, termsAcceptPrefix, checkoutSubmit), as in slice1d-legal-texts-draft.md
 *   - fillTemplate: fills known placeholders; throws on unknown placeholder
 *   - checkoutConsentMessage: contains termsAcceptPrefix + consent text; no dashes; uses termsUrl
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  WITHDRAWAL_ALERT_EMAIL_TEXTS,
  WITHDRAWAL_TEXT_VERSION,
  WITHDRAWAL_TEXT_SHA256,
  WITHDRAWAL_TEXTS,
  withdrawalTextBundle,
  checkoutConsentMessage,
  fillTemplate,
} from "@/config/legal/withdrawal-texts";

// ── Version constant ──────────────────────────────────────────────────────────

describe("WD-J2-C06: WITHDRAWAL_TEXT_VERSION is pinned", () => {
  it("WITHDRAWAL_TEXT_VERSION equals '2026-11-14.1'", () => {
    expect(WITHDRAWAL_TEXT_VERSION).toBe("2026-11-14.1");
  });
});

// ── SHA-256: shape check and recompute ────────────────────────────────────────

describe("WD-J2-C02: WITHDRAWAL_TEXT_SHA256 shape — 64 lowercase hex chars per locale", () => {
  it.each(["da", "en"] as const)("%s sha256 matches ^[0-9a-f]{64}$", (locale) => {
    const hex = WITHDRAWAL_TEXT_SHA256[WITHDRAWAL_TEXT_VERSION]?.[locale];
    expect(typeof hex).toBe("string");
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("WD-J2-C02: recomputes sha256 of withdrawalTextBundle and asserts equality", () => {
  it.each(["da", "en"] as const)("%s: computed hash equals WITHDRAWAL_TEXT_SHA256 entry", (locale) => {
    const computed = createHash("sha256").update(withdrawalTextBundle(locale)).digest("hex");
    expect(computed).toBe(WITHDRAWAL_TEXT_SHA256[WITHDRAWAL_TEXT_VERSION][locale]);
  });
});

describe("WD-J2-C02: pins the literal sha256 of the current version", () => {
  // The literal digests of version 2026-11-14.1: a text edit without a version bump and new
  // digests fails here (the recompute test above alone would follow the edit).
  it("da sha256 literal pin", () => {
    expect(WITHDRAWAL_TEXT_SHA256[WITHDRAWAL_TEXT_VERSION]["da"]).toBe(
      "2bf84400d9b6d203cd554494a295ab53cbe92eba464220e8da9ec2ba12bd6aea",
    );
  });
  it("en sha256 literal pin", () => {
    expect(WITHDRAWAL_TEXT_SHA256[WITHDRAWAL_TEXT_VERSION]["en"]).toBe(
      "a759f9c7b49ac9ba8ba35303f6f1a73ada4edcc9261386c8e49b9a7c218dac1b",
    );
  });
});

// ── No em-dash / en-dash in any string ───────────────────────────────────────

function collectStrings(value: unknown, path: string[] = []): Array<{ path: string; str: string }> {
  if (typeof value === "string") return [{ path: path.join("."), str: value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => collectStrings(v, [...path, String(i)]));
  if (value !== null && typeof value === "object")
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => collectStrings(v, [...path, k]));
  return [];
}

describe("WD-J1-C03: no U+2014 em-dash or U+2013 en-dash in any WITHDRAWAL_TEXTS string", () => {
  it.each(["da", "en"] as const)("%s locale: zero em-dash (U+2014) occurrences", (locale) => {
    const strings = collectStrings(WITHDRAWAL_TEXTS[locale]);
    const hits = strings.filter((s) => s.str.includes("\u2014"));
    expect(hits, `em-dash found at: ${hits.map((h) => h.path).join(", ")}`).toHaveLength(0);
  });

  it.each(["da", "en"] as const)("%s locale: zero en-dash (U+2013) occurrences", (locale) => {
    const strings = collectStrings(WITHDRAWAL_TEXTS[locale]);
    const hits = strings.filter((s) => s.str.includes("\u2013"));
    expect(hits, `en-dash found at: ${hits.map((h) => h.path).join(", ")}`).toHaveLength(0);
  });

  it("the owner alert texts (outside the hashed bundle): no em-dash or en-dash", () => {
    const hits = collectStrings(WITHDRAWAL_ALERT_EMAIL_TEXTS).filter((s) => /[\u2013\u2014]/.test(s.str));
    expect(hits, `dash found at: ${hits.map((h) => h.path).join(", ")}`).toHaveLength(0);
  });
});

// ── Sections A to D: verbatim pins (DA and EN) ───────────────────────────────

/** Sections A to D of slice1d-legal-texts-draft.md, word for word, per language. */
const DRAFT = {
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
  },
} as const;

describe.each(["da", "en"] as const)("WD-J2-C06: sections A to D (%s) verbatim — from slice1d-legal-texts-draft.md", (locale) => {
  const texts = WITHDRAWAL_TEXTS[locale];
  const draft = DRAFT[locale];

  it("section A (notice): title and all five paragraphs", () => {
    expect(texts.notice).toEqual(draft.notice);
  });

  it("section B (onlineWithdrawal)", () => {
    expect(texts.onlineWithdrawal).toBe(draft.onlineWithdrawal);
  });

  it("section C (modelForm): title, intro and all seven lines", () => {
    expect(texts.modelForm).toEqual(draft.modelForm);
  });

  it("WD-J1-C01: section D (consent, the Checkout prefix and submit line)", () => {
    expect({
      consent: texts.consent,
      termsAcceptPrefix: texts.termsAcceptPrefix,
      checkoutSubmit: texts.checkoutSubmit,
    }).toEqual({
      consent: draft.consent,
      termsAcceptPrefix: draft.termsAcceptPrefix,
      checkoutSubmit: draft.checkoutSubmit,
    });
  });
});

// ── fillTemplate ──────────────────────────────────────────────────────────────

describe("WD-J1-C01: fillTemplate — fills known placeholders; throws on unknown placeholder", () => {
  it("fills a single placeholder", () => {
    expect(fillTemplate("Hello {name}", { name: "World" })).toBe("Hello World");
  });

  it("fills multiple different placeholders", () => {
    expect(fillTemplate("{a} and {b}", { a: "X", b: "Y" })).toBe("X and Y");
  });

  it("fills repeated placeholder once each occurrence", () => {
    expect(fillTemplate("{x} {x}", { x: "Z" })).toBe("Z Z");
  });

  it("throws when a placeholder appears with no matching key", () => {
    expect(() => fillTemplate("Hello {unknown}", {})).toThrow();
  });
});

// ── checkoutConsentMessage ────────────────────────────────────────────────────

describe("WD-J1-C01: checkoutConsentMessage — DA", () => {
  const TERMS_URL_DA = "https://alnyron.dk/terms";
  const msg = checkoutConsentMessage("da", TERMS_URL_DA);

  it("contains the DA consent text verbatim", () => {
    expect(msg).toContain(
      "Jeg anmoder om, at Alnyron påbegynder Monitor-abonnementet med det samme",
    );
  });

  it("contains a markdown link to the terms URL", () => {
    expect(msg).toContain(`[handelsbetingelser](${TERMS_URL_DA})`);
  });

  it("contains 'Jeg accepterer Alnyrons' prefix fragment", () => {
    expect(msg).toContain("Jeg accepterer Alnyrons");
  });

  it("contains no em-dash or en-dash", () => {
    expect(msg).not.toContain("\u2014");
    expect(msg).not.toContain("\u2013");
  });
});

describe("WD-J1-C01: checkoutConsentMessage — EN", () => {
  const TERMS_URL_EN = "https://alnyron.dk/en/terms";
  const msg = checkoutConsentMessage("en", TERMS_URL_EN);

  it("contains the EN consent text verbatim", () => {
    expect(msg).toContain(
      "I request that Alnyron begins the Monitor subscription immediately",
    );
  });

  it("contains a markdown link to the EN terms URL", () => {
    expect(msg).toContain(`[terms and conditions](${TERMS_URL_EN})`);
  });
});
