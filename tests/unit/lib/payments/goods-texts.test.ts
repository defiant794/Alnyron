/**
 * Unit tests: src/config/legal/goods-texts.ts
 * Journey: payments-s2-3d-purchase
 * Criteria: S2-LEGAL-1..9 (S2-T-TXT-01..15; S2-LEGAL-9 = the reservation sentence, method-neutral
 *           per amendment A2-1)
 *
 * Coverage:
 *   - GOODS_TEXT_VERSION constant pin
 *   - GOODS_TEXT_SHA256: 64-hex shape; recompute from JSON.stringify(GOODS_TEXTS[locale])
 *   - Literal sha256 pins — catches text edits without a version bump
 *   - No U+2014 em-dash in any user-facing string (GOODS_TEXTS + GOODS_OWNER_EMAIL_TEXTS)
 *   - Return address: Nyvej 4, 7860 Spøttrup (confirmed by owner)
 *   - CVR 46887433
 *   - Dispatch fact: "3 hverdage"
 *   - Return-shipping fact pinned exactly: the customer pays (both locales)
 *   - Withdrawal notice paragraphs, one literal phrase per topic in both locales: 14 days from
 *     receipt, how to notify, buyer pays return shipping, return within 14 days of the notice,
 *     refund within 14 days (may be withheld until the goods are back), diminished-value deduction
 *   - DA and EN same structural shape: recursive keys and array lengths
 *   - The method-neutral reservation sentence on Checkout, the item page, /terms and the order
 *     confirmation; no consumer text names the card
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GOODS_TEXT_VERSION,
  GOODS_TEXT_SHA256,
  GOODS_TEXTS,
  GOODS_OWNER_EMAIL_TEXTS,
  goodsTextDigest,
  goodsCheckoutConsentMessage,
} from "@/config/legal/goods-texts";

// ── S2-LEGAL-1 (S2-T-TXT-01): version constant pin ───────────────────────────

describe("S2-LEGAL-1 (S2-T-TXT-01): GOODS_TEXT_VERSION is pinned", () => {
  it("equals 'goods-2026-11-14.1'", () => {
    expect(GOODS_TEXT_VERSION).toBe("goods-2026-11-14.1");
  });
});

// ── S2-LEGAL-2 (S2-T-TXT-02..05): sha256 shape + recompute ───────────────────

describe("S2-LEGAL-2 (S2-T-TXT-02..03): GOODS_TEXT_SHA256 — 64-hex shape per locale", () => {
  it.each(["da", "en"] as const)("%s sha256 matches ^[0-9a-f]{64}$", (locale) => {
    const hex = GOODS_TEXT_SHA256[GOODS_TEXT_VERSION]?.[locale];
    expect(typeof hex).toBe("string");
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("S2-LEGAL-2 (S2-T-TXT-04..05): recompute sha256 of JSON.stringify(GOODS_TEXTS[locale])", () => {
  it.each(["da", "en"] as const)("%s: computed hash equals GOODS_TEXT_SHA256 entry", (locale) => {
    const computed = createHash("sha256")
      .update(JSON.stringify(GOODS_TEXTS[locale]))
      .digest("hex");
    expect(computed).toBe(GOODS_TEXT_SHA256[GOODS_TEXT_VERSION]![locale]);
  });
});

// ── S2-LEGAL-2 literal sha256 pins (version bump gate) ───────────────────────
// These pins are written at authoring time (computed from the actual module output).
// Literals computed from the module's goods-2026-11-14.1 texts: any text edit fails here until
// the version is bumped and new digests are added. Re-pinned for amendment A1 (charge on
// dispatch), for amendment A2 (method-neutral reservation sentence, the order confirmation
// is the invoice, credit notes) and for the invoice's buyer block (`buyerHeading`) while
// goods-2026-11-14.1 is still an unreleased draft (no order carries it yet).
describe("S2-LEGAL-2: literal sha256 pins — catch text edits without version bumps", () => {
  it("da sha256 equals the pinned literal of goods-2026-11-14.1", () => {
    expect(GOODS_TEXT_SHA256["goods-2026-11-14.1"].da).toBe(
      "de7a3eb44e13372843ac858165953b479ece1007fe336ee2577f20b2904df715",
    );
  });

  it("en sha256 equals the pinned literal of goods-2026-11-14.1", () => {
    expect(GOODS_TEXT_SHA256["goods-2026-11-14.1"].en).toBe(
      "06f12ffa6070837de72873eac9a1d9615dc9068de396ca820b1877bc82d745bb",
    );
  });
});

// ── S2-LEGAL-9 (S2-T-TXT-12..15): the reservation sentence (amendments A1, A2-1) ─

describe("S2-LEGAL-9 (S2-T-TXT-12..15): the method-neutral reservation sentence on every surface", () => {
  const RESERVED = {
    da: "Beløbet reserveres ved bestillingen og trækkes først, når varen sendes.",
    en: "The amount is reserved when you order and charged only when the goods are sent.",
  } as const;

  it.each(["da", "en"] as const)("S2-T-TXT-12 %s: the Checkout submit line opens with it", (locale) => {
    expect(GOODS_TEXTS[locale].checkoutSubmit.startsWith(RESERVED[locale])).toBe(true);
  });

  it.each(["da", "en"] as const)("S2-T-TXT-13 %s: it is the item page's fifth fact (payment)", (locale) => {
    expect(GOODS_TEXTS[locale].itemPage.facts).toHaveLength(5);
    expect(GOODS_TEXTS[locale].itemPage.facts[4]).toBe(RESERVED[locale]);
  });

  it.each(["da", "en"] as const)("S2-T-TXT-14 %s: the terms state it, and that a withdrawal before dispatch is not charged", (locale) => {
    const terms = GOODS_TEXTS[locale].terms.goodsSections;
    expect(terms).toContain(RESERVED[locale]);
    expect(terms).toContain(
      locale === "da"
        ? "Fortryder du, før varen er sendt, sender vi den ikke og frigiver reservationen, så du ikke bliver trukket."
        : "If you withdraw before the goods are sent, we do not send them and release the reservation, so you are not charged.",
    );
  });

  it.each(["da", "en"] as const)(
    "S2-T-TXT-15 %s: the order confirmation states it, and no consumer text names the card (Klarna and Amazon Pay are offered too)",
    (locale) => {
      expect(GOODS_TEXTS[locale].confirmationEmail.payment).toBe(RESERVED[locale]);
      const bundle = JSON.stringify(GOODS_TEXTS[locale]);
      for (const cardOnly of ["på dit kort", "dit kort", "on your card", "your card", "kortoplysninger", "card details"]) {
        expect(bundle).not.toContain(cardOnly);
      }
    },
  );
});

// ── S2-LEGAL-3 (S2-T-TXT-06): no U+2014 em-dash ─────────────────────────────

describe("S2-LEGAL-3 (S2-T-TXT-06): no U+2014 em-dash in any user-facing string", () => {
  function collectStrings(obj: unknown, path = ""): Array<{ path: string; value: string }> {
    if (typeof obj === "string") return [{ path, value: obj }];
    if (Array.isArray(obj)) return obj.flatMap((v, i) => collectStrings(v, `${path}[${i}]`));
    if (obj && typeof obj === "object") {
      return Object.entries(obj).flatMap(([k, v]) => collectStrings(v, `${path}.${k}`));
    }
    return [];
  }

  it("GOODS_TEXTS has no em-dash (—) in any locale", () => {
    const strings = [
      ...collectStrings(GOODS_TEXTS["da"], "GOODS_TEXTS.da"),
      ...collectStrings(GOODS_TEXTS["en"], "GOODS_TEXTS.en"),
    ];
    const withDash = strings.filter(({ value }) => value.includes("\u2014"));
    expect(withDash).toEqual([]);
  });

  it("GOODS_OWNER_EMAIL_TEXTS has no em-dash (—)", () => {
    const strings = collectStrings(GOODS_OWNER_EMAIL_TEXTS, "GOODS_OWNER_EMAIL_TEXTS");
    const withDash = strings.filter(({ value }) => value.includes("\u2014"));
    expect(withDash).toEqual([]);
  });
});

// ── S2-LEGAL-4 (S2-T-TXT-07): return address ─────────────────────────────────

describe("S2-LEGAL-4 (S2-T-TXT-07): return address contains Nyvej 4, 7860 Spøttrup and CVR 46887433", () => {
  it("DA returnAddress contains Nyvej 4, 7860 Spøttrup", () => {
    const addr = GOODS_TEXTS["da"].returnAddress;
    expect(addr).toContain("Nyvej 4");
    expect(addr).toContain("7860");
    expect(addr).toContain("Spøttrup");
  });

  it("DA returnAddress contains CVR 46887433", () => {
    expect(GOODS_TEXTS["da"].returnAddress).toContain("46887433");
  });
});

// ── S2-LEGAL-5 (S2-T-TXT-08): dispatch time "3 hverdage" ─────────────────────

describe("S2-LEGAL-5 (S2-T-TXT-08): dispatch fact — within 3 working days", () => {
  it.each([
    ["da", "Sendes inden for 3 hverdage"],
    ["en", "Dispatched within 3 working days"],
  ] as const)("%s: the second fact (dispatch) reads %j", (locale, fact) => {
    expect(GOODS_TEXTS[locale].itemPage.facts[1]).toBe(fact);
  });
});

// ── S2-LEGAL-6 (S2-T-TXT-09): buyer pays return shipping ─────────────────────

describe("S2-LEGAL-6 (S2-T-TXT-09): return-shipping fact — buyer pays", () => {
  it.each([
    ["da", "Returfragt betales af kunden"],
    ["en", "Return shipping paid by the customer"],
  ] as const)("%s: the fourth fact (returnShipping) reads %j", (locale, fact) => {
    expect(GOODS_TEXTS[locale].itemPage.facts[3]).toBe(fact);
  });
});

// ── S2-LEGAL-7 (S2-T-TXT-10): withdrawal notice paragraphs ───────────────────

/** One literal phrase per S2-LEGAL-7 topic, per locale. */
const NOTICE_TOPICS = {
  da: [
    ["14 days from receipt", "Fortrydelsesfristen udløber 14 dage efter den dag, hvor du eller en tredjemand, bortset fra transportøren, angivet af dig, får varen i fysisk besiddelse."],
    ["how to notify", 'i en utvetydig erklæring, f.eks. med funktionen "Fortryd aftale her" på vores websted, i en e-mail eller i et brev.'],
    ["buyer pays return shipping", "Du skal afholde de direkte udgifter i forbindelse med returnering af varen. Du betaler altså selv returfragten."],
    ["return within 14 days of the notice", "senest 14 dage efter den dag, hvor du har meddelt os, at du ønsker at fortryde denne aftale."],
    ["refund within 14 days", "senest 14 dage fra den dato, hvor vi har modtaget meddelelse om din beslutning om at fortryde denne aftale."],
    ["refund may be withheld", "Vi kan tilbageholde tilbagebetalingen, indtil vi har modtaget varen retur, eller du har fremlagt dokumentation for at have returneret den, alt efter hvad der sker først."],
    ["diminished-value deduction", "Er varens værdi forringet, kan vi trække værdiforringelsen fra det beløb, vi tilbagebetaler."],
  ],
  en: [
    ["14 days from receipt", "The withdrawal period expires 14 days after the day on which you, or a third party other than the carrier and indicated by you, take physical possession of the goods."],
    ["how to notify", 'by an unequivocal statement, e.g. with the "Withdraw from the contract here" function on our website, by email or by letter.'],
    ["buyer pays return shipping", "You will have to bear the direct cost of returning the goods. In other words, you pay the return shipping yourself."],
    ["return within 14 days of the notice", "not later than 14 days from the day on which you communicate your withdrawal from this contract to us."],
    ["refund within 14 days", "not later than 14 days from the day on which we are informed about your decision to withdraw from this contract."],
    ["refund may be withheld", "We may withhold reimbursement until we have received the goods back or you have supplied evidence of having sent back the goods, whichever is the earliest."],
    ["diminished-value deduction", "If the value of the goods is diminished, we may deduct the diminished value from the amount we reimburse."],
  ],
} as const;

describe("S2-LEGAL-7 (S2-T-TXT-10): withdrawal notice paragraphs cover all required topics", () => {
  it.each([
    ["da", "Fortrydelsesret"],
    ["en", "Right of withdrawal"],
  ] as const)("%s: the notice is titled %j", (locale, title) => {
    expect(GOODS_TEXTS[locale].notice.title).toBe(title);
  });

  it.each(
    (["da", "en"] as const).flatMap((locale) =>
      NOTICE_TOPICS[locale].map(([topic, phrase]) => [locale, topic, phrase] as const),
    ),
  )("%s: %s", (locale, _topic, phrase) => {
    expect(GOODS_TEXTS[locale].notice.paragraphs.join(" ")).toContain(phrase);
  });
});

// ── S2-LEGAL-8 (S2-T-TXT-11): DA and EN same structural shape ────────────────

/** `value`'s shape: object keys (sorted) and array lengths all the way down; every string is "string". */
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((key) => [key, shape((value as Record<string, unknown>)[key])]),
    );
  }
  return typeof value;
}

describe("S2-LEGAL-8 (S2-T-TXT-11): GOODS_TEXTS DA and EN have the same shape", () => {
  it("DA and EN have the same keys at every depth and arrays of the same length", () => {
    expect(shape(GOODS_TEXTS["en"])).toEqual(shape(GOODS_TEXTS["da"]));
  });
});

// ── goodsTextDigest: round-trips version+locale ───────────────────────────────

describe("goodsTextDigest: returns the pinned digest for the current version", () => {
  it.each(["da", "en"] as const)("%s: goodsTextDigest matches GOODS_TEXT_SHA256", (locale) => {
    const digest = goodsTextDigest(GOODS_TEXT_VERSION, locale);
    expect(digest).toBe(GOODS_TEXT_SHA256[GOODS_TEXT_VERSION]![locale]);
  });

  it("unknown version returns null (no digest)", () => {
    expect(goodsTextDigest("goods-unknown-version", "da")).toBeNull();
  });
});

// ── goodsCheckoutConsentMessage: non-empty, contains termsUrl, no em-dash ────

describe("goodsCheckoutConsentMessage: contains termsUrl and no em-dash", () => {
  const TERMS_URL = "https://alnyron.dk/terms";

  it.each(["da", "en"] as const)("%s: message is non-empty and contains termsUrl", (locale) => {
    const msg = goodsCheckoutConsentMessage(locale, TERMS_URL);
    expect(typeof msg).toBe("string");
    expect(msg.length).toBeGreaterThan(10);
    expect(msg).toContain(TERMS_URL);
  });

  it.each(["da", "en"] as const)("%s: message contains no em-dash", (locale) => {
    const msg = goodsCheckoutConsentMessage(locale, TERMS_URL);
    expect(msg).not.toContain("\u2014");
  });
});
