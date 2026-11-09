/**
 * Unit tests: src/lib/monitor/signup-notice-email.ts — buildSignupNoticeEmail
 * Journey: monitor-signup-notice  SNE-AC1i
 *
 * Covers: the whole html and text for waiting = 0 and 2, pinned with toBe (layout, subject,
 *   heading, body sentence, waiting sentence and footer as literal Danish copy; only {when} is
 *   taken from formatDateTime, whose output depends on the runtime's ICU data);
 *   {when} rendered by formatDateTime; waiting=0 → no waiting sentence in html or text;
 *   waiting=1 → Danish "1 anden venter" plural; waiting=3 → "3 andre venter";
 *   user address defanged in full (@ → [at], every domain-like dot in both local part and
 *   domain → [.], except digit.digit) in both html and text, the raw local part absent;
 *   address HTML-escaped when it contains &, <, or ' — only the escaped form appears, not
 *   the raw chars; no <a, href, or http anywhere in html or text.
 *   (All the above are SNE-AC1i.)
 *
 * The en.json parity of the five MonitorEmail signupNotice* keys is pinned by sne0.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSignupNoticeEmail } from "@/lib/monitor/signup-notice-email";
import { formatDateTime } from "@/lib/monitor/format";
import { emailDocument } from "./email-layout";

// ── Helpers ───────────────────────────────────────────────────────────────────

const CONFIRMED_AT = "2026-11-08T10:00:00.000Z";
const USER_EMAIL = "ny.bruger@eksempel.dk";

const FOOTER =
  "Du får denne mail, fordi du er ejer af Alnyron. Vi skriver kun om nye konti, der har bekræftet deres e-mail, og højst én gang pr. konto.";

// ── en.json key parity ────────────────────────────────────────────────────────

describe("buildSignupNoticeEmail — SNE-AC1i: messages/en.json has the same signupNotice* keys as da.json", () => {
  it("SNE-AC1i-sne0: en.json MonitorEmail namespace has the five signupNotice* keys", () => {
    const enMessages = JSON.parse(
      readFileSync(resolve("messages/en.json"), "utf-8"),
    ) as { MonitorEmail?: Record<string, unknown> };
    const monitorEmail = enMessages.MonitorEmail ?? {};
    for (const key of ["signupNoticeSubject", "signupNoticeHeading", "signupNoticeBody", "signupNoticeWaiting", "signupNoticeFooter"]) {
      expect(typeof monitorEmail[key], `en.json MonitorEmail.${key}`).toBe("string");
    }
  });
});

// ── subject/heading — literal Danish copy ────────────────────────────────────

describe("buildSignupNoticeEmail — SNE-AC1i: subject copy", () => {
  it("SNE-AC1i-sne1: subject matches the expected Danish copy", () => {
    const { subject } = buildSignupNoticeEmail({ email: USER_EMAIL, confirmedAt: CONFIRMED_AT, waiting: 0 });
    expect(subject).toBe("Ny konto på Alnyron Monitor");
  });
});

describe("buildSignupNoticeEmail — SNE-AC1i: heading copy in html", () => {
  it("SNE-AC1i-sne2: html contains the expected Danish heading copy", () => {
    const { html } = buildSignupNoticeEmail({ email: USER_EMAIL, confirmedAt: CONFIRMED_AT, waiting: 0 });
    expect(html).toContain("Ny konto på Alnyron Monitor");
  });
});

describe("buildSignupNoticeEmail — SNE-AC1i: body uses defanged email and formatDateTime", () => {
  it("SNE-AC1i-sne3: html body uses formatDateTime(confirmedAt) for the {when} placeholder", () => {
    const when = formatDateTime(CONFIRMED_AT);
    const { html, text } = buildSignupNoticeEmail({ email: USER_EMAIL, confirmedAt: CONFIRMED_AT, waiting: 0 });
    expect(html).toContain(when);
    expect(text).toContain(when);
  });

  it("SNE-AC1i-sne4: html body contains defanged address (local part and domain)", () => {
    // ny.bruger@eksempel.dk → ny[.]bruger[at]eksempel[.]dk (domain-like dots in local part and domain → [.], @ → [at])
    const { html } = buildSignupNoticeEmail({ email: USER_EMAIL, confirmedAt: CONFIRMED_AT, waiting: 0 });
    expect(html).toContain("ny[.]bruger[at]eksempel[.]dk");
  });

  it("SNE-AC1i-sne5: text body contains defanged address (local part and domain)", () => {
    // ny.bruger@eksempel.dk → ny[.]bruger[at]eksempel[.]dk (domain-like dots in local part and domain → [.], @ → [at])
    const { text } = buildSignupNoticeEmail({ email: USER_EMAIL, confirmedAt: CONFIRMED_AT, waiting: 0 });
    expect(text).toContain("ny[.]bruger[at]eksempel[.]dk");
  });
});

describe("buildSignupNoticeEmail — SNE-AC1i: footer copy", () => {
  it("SNE-AC1i-sne6: html ends the card with the literal footer paragraph", () => {
    const { html } = buildSignupNoticeEmail({ email: USER_EMAIL, confirmedAt: CONFIRMED_AT, waiting: 0 });
    expect(html).toContain(`<p style="margin:28px 0 0;font-size:13px;line-height:1.5;color:#5a6778;">${FOOTER}</p>\n</td></tr>`);
  });

  it("SNE-AC1i-sne7: text ends with the literal footer", () => {
    const { text } = buildSignupNoticeEmail({ email: USER_EMAIL, confirmedAt: CONFIRMED_AT, waiting: 0 });
    expect(text.endsWith(`\n\n${FOOTER}\n`)).toBe(true);
  });
});

// ── waiting=0 → no waiting sentence ──────────────────────────────────────────

describe("buildSignupNoticeEmail — SNE-AC1i: waiting=0 → no waiting sentence", () => {
  it("SNE-AC1i-sne8: waiting=0 → 'venter' does not appear in html", () => {
    const { html } = buildSignupNoticeEmail({ email: USER_EMAIL, confirmedAt: CONFIRMED_AT, waiting: 0 });
    expect(html).not.toContain("venter");
  });

  it("SNE-AC1i-sne9: waiting=0 → 'venter' does not appear in text", () => {
    const { text } = buildSignupNoticeEmail({ email: USER_EMAIL, confirmedAt: CONFIRMED_AT, waiting: 0 });
    expect(text).not.toContain("venter");
  });
});

// ── waiting=1 → "1 anden venter" ─────────────────────────────────────────────

describe("buildSignupNoticeEmail — SNE-AC1i: waiting=1 → one-other plural (da)", () => {
  it("SNE-AC1i-sne10: waiting=1 → html contains exact sentence '1 anden venter også på en besked.'", () => {
    const { html } = buildSignupNoticeEmail({ email: USER_EMAIL, confirmedAt: CONFIRMED_AT, waiting: 1 });
    expect(html).toContain("1 anden venter også på en besked.");
  });

  it("SNE-AC1i-sne11: waiting=1 → text contains exact sentence '1 anden venter også på en besked.'", () => {
    const { text } = buildSignupNoticeEmail({ email: USER_EMAIL, confirmedAt: CONFIRMED_AT, waiting: 1 });
    expect(text).toContain("1 anden venter også på en besked.");
  });

  it("SNE-AC1i-sne12: waiting=1 → html does NOT contain 'andre' (would be plural-wrong)", () => {
    const { html } = buildSignupNoticeEmail({ email: USER_EMAIL, confirmedAt: CONFIRMED_AT, waiting: 1 });
    expect(html).not.toContain("andre");
  });
});

// ── waiting=3 → "3 andre venter" ─────────────────────────────────────────────

describe("buildSignupNoticeEmail — SNE-AC1i: waiting=3 → many-others plural (da)", () => {
  it("SNE-AC1i-sne13: waiting=3 → html contains exact sentence '3 andre venter også på en besked.'", () => {
    const { html } = buildSignupNoticeEmail({ email: USER_EMAIL, confirmedAt: CONFIRMED_AT, waiting: 3 });
    expect(html).toContain("3 andre venter også på en besked.");
  });

  it("SNE-AC1i-sne14: waiting=3 → text contains exact sentence '3 andre venter også på en besked.'", () => {
    const { text } = buildSignupNoticeEmail({ email: USER_EMAIL, confirmedAt: CONFIRMED_AT, waiting: 3 });
    expect(text).toContain("3 andre venter også på en besked.");
  });
});

// ── Address defanging — raw @ and domain dots suppressed ──────────────────────

describe("buildSignupNoticeEmail — SNE-AC1i: address defanged, no raw @ or domain in html/text", () => {
  it("SNE-AC1i-sne15: html contains no raw '@' character from the user address", () => {
    const { html } = buildSignupNoticeEmail({ email: USER_EMAIL, confirmedAt: CONFIRMED_AT, waiting: 0 });
    // The address ny.bruger@eksempel.dk must not appear raw; only ny.bruger[at]eksempel[.]dk
    expect(html).not.toContain("@");
  });

  it("SNE-AC1i-sne16: html contains no raw 'eksempel.dk' domain from the user address", () => {
    const { html } = buildSignupNoticeEmail({ email: USER_EMAIL, confirmedAt: CONFIRMED_AT, waiting: 0 });
    expect(html).not.toContain("eksempel.dk");
  });

  it("SNE-AC1i-sne17: text contains no raw '@' character from the user address", () => {
    const { text } = buildSignupNoticeEmail({ email: USER_EMAIL, confirmedAt: CONFIRMED_AT, waiting: 0 });
    expect(text).not.toContain("@");
  });

  it("SNE-AC1i-sne18: text contains no raw 'eksempel.dk' domain from the user address", () => {
    const { text } = buildSignupNoticeEmail({ email: USER_EMAIL, confirmedAt: CONFIRMED_AT, waiting: 0 });
    expect(text).not.toContain("eksempel.dk");
  });
});

// ── Address HTML-escaping when special chars present ─────────────────────────

describe("buildSignupNoticeEmail — SNE-AC1i: address HTML-escaped in html output", () => {
  it("SNE-AC1i-sne19: address with & → exact token 'user&amp;test[at]example[.]com' in html", () => {
    const { html } = buildSignupNoticeEmail({ email: "user&test@example.com", confirmedAt: CONFIRMED_AT, waiting: 0 });
    // defang → user&test[at]example[.]com; HTML-escape → user&amp;test[at]example[.]com
    expect(html).toContain("user&amp;test[at]example[.]com");
    expect(html).not.toContain("user&test[at]");
  });

  it("SNE-AC1i-sne20: address with < → exact token 'user&lt;test[at]example[.]com' in html", () => {
    const { html } = buildSignupNoticeEmail({ email: "user<test@example.com", confirmedAt: CONFIRMED_AT, waiting: 0 });
    // defang → user<test[at]example[.]com; HTML-escape → user&lt;test[at]example[.]com
    expect(html).toContain("user&lt;test[at]example[.]com");
    expect(html).not.toContain("user<test");
  });

  it("SNE-AC1i-sne21: address with ' → exact token \"user&#39;test[at]example[.]com\" in html", () => {
    const { html } = buildSignupNoticeEmail({ email: "user'test@example.com", confirmedAt: CONFIRMED_AT, waiting: 0 });
    // defang → user'test[at]example[.]com; HTML-escape → user&#39;test[at]example[.]com
    expect(html).toContain("user&#39;test[at]example[.]com");
    expect(html).not.toContain("user'test");
  });
});

// ── No links — no <a, href, or http ──────────────────────────────────────────

describe("buildSignupNoticeEmail — SNE-AC1i: html contains no link to user address", () => {
  it("SNE-AC1i-sne22: html contains no <a tag", () => {
    const { html } = buildSignupNoticeEmail({ email: USER_EMAIL, confirmedAt: CONFIRMED_AT, waiting: 0 });
    expect(html.toLowerCase()).not.toContain("<a ");
    expect(html.toLowerCase()).not.toContain("<a\t");
  });

  it("SNE-AC1i-sne23: html contains no href attribute from the user address", () => {
    // The contract says NO link at all: no href attribute may appear in the html.
    const { html } = buildSignupNoticeEmail({ email: USER_EMAIL, confirmedAt: CONFIRMED_AT, waiting: 0 });
    expect([...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!)).toEqual([]);
  });

  it("SNE-AC1i-sne24: html contains no http scheme (no auto-linkable URL)", () => {
    const { html } = buildSignupNoticeEmail({ email: USER_EMAIL, confirmedAt: CONFIRMED_AT, waiting: 0 });
    expect(html.toLowerCase()).not.toContain("http");
  });

  it("SNE-AC1i-sne25: text contains no http scheme", () => {
    const { text } = buildSignupNoticeEmail({ email: USER_EMAIL, confirmedAt: CONFIRMED_AT, waiting: 0 });
    expect(text.toLowerCase()).not.toContain("http");
  });
});

// ── Full-defang: local-part dots suppressed (evil.com@x.dk) ──────────────────

describe("buildSignupNoticeEmail — SNE-AC1i: local-part dots defanged (evil.com@x.dk)", () => {
  it("SNE-AC1i-sne26: html contains exact defanged token 'evil[.]com[at]x[.]dk'", () => {
    const { html } = buildSignupNoticeEmail({ email: "evil.com@x.dk", confirmedAt: CONFIRMED_AT, waiting: 0 });
    expect(html).toContain("evil[.]com[at]x[.]dk");
  });

  it("SNE-AC1i-sne27: text contains exact defanged token 'evil[.]com[at]x[.]dk'", () => {
    const { text } = buildSignupNoticeEmail({ email: "evil.com@x.dk", confirmedAt: CONFIRMED_AT, waiting: 0 });
    expect(text).toContain("evil[.]com[at]x[.]dk");
  });

  it("SNE-AC1i-sne28: html contains no raw '@' for evil.com@x.dk", () => {
    const { html } = buildSignupNoticeEmail({ email: "evil.com@x.dk", confirmedAt: CONFIRMED_AT, waiting: 0 });
    expect(html).not.toContain("@");
  });

  it("SNE-AC1i-sne29: text contains no raw '@' for evil.com@x.dk", () => {
    const { text } = buildSignupNoticeEmail({ email: "evil.com@x.dk", confirmedAt: CONFIRMED_AT, waiting: 0 });
    expect(text).not.toContain("@");
  });
});

// ── Full-defang: no-dot local part (a!@evil.com) ──────────────────────────────

describe("buildSignupNoticeEmail — SNE-AC1i: no-dot local part (a!@evil.com)", () => {
  it("SNE-AC1i-sne30: html contains exact defanged token 'a![at]evil[.]com'", () => {
    const { html } = buildSignupNoticeEmail({ email: "a!@evil.com", confirmedAt: CONFIRMED_AT, waiting: 0 });
    expect(html).toContain("a![at]evil[.]com");
  });

  it("SNE-AC1i-sne31: text contains exact defanged token 'a![at]evil[.]com'", () => {
    const { text } = buildSignupNoticeEmail({ email: "a!@evil.com", confirmedAt: CONFIRMED_AT, waiting: 0 });
    expect(text).toContain("a![at]evil[.]com");
  });

  it("SNE-AC1i-sne32: html contains no raw '@' for a!@evil.com", () => {
    const { html } = buildSignupNoticeEmail({ email: "a!@evil.com", confirmedAt: CONFIRMED_AT, waiting: 0 });
    expect(html).not.toContain("@");
  });

  it("SNE-AC1i-sne33: text contains no raw '@' for a!@evil.com", () => {
    const { text } = buildSignupNoticeEmail({ email: "a!@evil.com", confirmedAt: CONFIRMED_AT, waiting: 0 });
    expect(text).not.toContain("@");
  });
});

// ── The whole email, pinned exactly ──────────────────────────────────────────

describe("buildSignupNoticeEmail — SNE-AC1i: the whole html and text, exactly", () => {
  // Only the date comes from formatDateTime: its exact form depends on the runtime's ICU data.
  const WHEN = formatDateTime(CONFIRMED_AT);
  const HEADING = '<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#0b1d33;">Ny konto på Alnyron Monitor</h1>\n';
  const BODY = `ny[.]bruger[at]eksempel[.]dk har oprettet en konto på Alnyron Monitor og bekræftet sin e-mail ${WHEN}.`;
  const FOOTER_HTML = `<p style="margin:28px 0 0;font-size:13px;line-height:1.5;color:#5a6778;">${FOOTER}</p>\n`;

  it("SNE-AC1i-sne34: waiting=0 → exact html: heading, body sentence, footer; no waiting sentence, no button", () => {
    const { html } = buildSignupNoticeEmail({ email: USER_EMAIL, confirmedAt: CONFIRMED_AT, waiting: 0 });
    expect(html).toBe(
      emailDocument("Ny konto på Alnyron Monitor", `${HEADING}<p style="margin:0;">${BODY}</p>\n\n${FOOTER_HTML}`),
    );
  });

  it("SNE-AC1i-sne35: waiting=0 → exact text", () => {
    const { text } = buildSignupNoticeEmail({ email: USER_EMAIL, confirmedAt: CONFIRMED_AT, waiting: 0 });
    expect(text).toBe(`Ny konto på Alnyron Monitor\n\n${BODY}\n\n${FOOTER}\n`);
  });

  it("SNE-AC1i-sne36: waiting=2 → exact html with the waiting sentence after the body", () => {
    const { html } = buildSignupNoticeEmail({ email: USER_EMAIL, confirmedAt: CONFIRMED_AT, waiting: 2 });
    expect(html).toBe(
      emailDocument(
        "Ny konto på Alnyron Monitor",
        `${HEADING}<p style="margin:0;">${BODY}</p>\n<p style="margin:16px 0 0;">2 andre venter også på en besked.</p>\n\n${FOOTER_HTML}`,
      ),
    );
  });

  it("SNE-AC1i-sne37: waiting=2 → exact text with the waiting sentence after the body", () => {
    const { text } = buildSignupNoticeEmail({ email: USER_EMAIL, confirmedAt: CONFIRMED_AT, waiting: 2 });
    expect(text).toBe(`Ny konto på Alnyron Monitor\n\n${BODY}\n\n2 andre venter også på en besked.\n\n${FOOTER}\n`);
  });

  it("SNE-AC1i-sne38: the raw local part 'ny.bruger' appears in neither html nor text", () => {
    const { html, text } = buildSignupNoticeEmail({ email: USER_EMAIL, confirmedAt: CONFIRMED_AT, waiting: 2 });
    expect(html).not.toContain("ny.bruger");
    expect(text).not.toContain("ny.bruger");
  });
});
