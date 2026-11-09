/**
 * Unit tests: src/lib/monitor/change-email.ts — buildChangeEmail, buildErrorEmail, renderEmail,
 * defangLinks
 * Journey: monitor-engine  ENG-AC1, ENG-AC3; monitor-signup-notice  SNE-AC1i
 *
 * Keys pinned from messages/da.json at runtime (not re-typed literals), except the exact
 * whole-email pins at the end, which type out the copy (and use the typed-out layout in
 * ./email-layout.ts).
 * Covers: subject/heading from MonitorEmail, HTML-escaping of <script>/"/url/label,
 *   ONLY href = siteUrl/monitor/monitors/<id>, page URL never an href,
 *   added/removed sections, noLines fallback, text part, error email shape,
 *   defangLinks (schemes, bare and IDN domains, e-mail addresses incl. adjacent
 *   ones; a dot between two digits kept, a dot with a letter on either side
 *   defanged; text without them unchanged; a 2046-character URL exactly and
 *   100 000-character inputs in linear time) and its use on every
 *   page/user-derived value in both parts of both emails, before HTML escaping;
 *   the whole html and text of a change email (with and without summary lines) and an
 *   error email, pinned exactly (the layout with its button), and renderEmail's layout
 *   without a button (footer spaced by its own margin, no link).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildChangeEmail,
  buildErrorEmail,
  defangLinks,
  renderEmail,
  type EmailContent,
} from "@/lib/monitor/change-email";
import { formatDateTime } from "@/lib/monitor/format";
import { emailDocument } from "./email-layout";

// ── Load MonitorEmail keys from da.json (pins the exact JSON, not re-typed) ──

/** Exact shape of messages/da.json → MonitorEmail, mirroring the contract JSON. */
interface MonitorEmailKeys {
  changeSubject: string;
  changeHeading: string;
  changeIntro: string;
  added: string;
  removed: string;
  noLines: string;
  cta: string;
  footer: string;
  errorSubject: string;
  errorHeading: string;
  errorBody: string;
  errorFooter: string;
}

const daMessages = JSON.parse(
  readFileSync(resolve("messages/da.json"), "utf-8"),
) as Record<string, unknown>;

function getMonitorEmail(): MonitorEmailKeys {
  const me = daMessages["MonitorEmail"];
  if (!me || typeof me !== "object") {
    throw new Error("MonitorEmail namespace missing from messages/da.json");
  }
  // Assigned to named const: MonitorEmail keys are validated by the message-parity test.
  const typed: MonitorEmailKeys = me as MonitorEmailKeys;
  return typed;
}

/** Every href in an email's html, in document order. */
function hrefsOf(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]!);
}

// ── buildChangeEmail — subject and heading from da.json ──────────────────────

describe("buildChangeEmail — ENG-AC1: subject/heading from MonitorEmail keys", () => {
  const ME = getMonitorEmail();

  it("ENG-AC1ce1: subject is MonitorEmail.changeSubject with {name} replaced by label", () => {
    const { subject } = buildChangeEmail({
      eventId: "evt-1",
      monitorId: "mon-1",
      url: "https://example.com/",
      label: "Min side",
      detectedAt: "2026-11-08T10:00:00Z",
      summary: null,
      siteUrl: "https://alnyron.dk",
    });
    // changeSubject = "Ændring på {name}" → "Ændring på Min side"
    expect(subject).toBe(ME.changeSubject.replace("{name}", "Min side"));
  });

  it("ENG-AC1ce2: when label is null, name falls back to displayUrl(url)", () => {
    const { subject } = buildChangeEmail({
      eventId: "evt-2",
      monitorId: "mon-2",
      url: "https://www.example.com/",
      label: null,
      detectedAt: "2026-11-08T10:00:00Z",
      summary: null,
      siteUrl: "https://alnyron.dk",
    });
    // displayUrl drops the scheme and a site root's lone "/"; the name is defanged.
    expect(subject).toBe(ME.changeSubject.replace("{name}", "www[.]example[.]com"));
  });

  it("ENG-AC1ce3: html contains MonitorEmail.changeHeading with {name} replaced", () => {
    const { html } = buildChangeEmail({
      eventId: "evt-3",
      monitorId: "mon-3",
      url: "https://example.com/",
      label: "Test Side",
      detectedAt: "2026-11-08T10:00:00Z",
      summary: null,
      siteUrl: "https://alnyron.dk",
    });
    const expectedHeading = ME.changeHeading.replace("{name}", "Test Side");
    expect(html).toContain(expectedHeading);
  });
});

// ── buildChangeEmail — HTML escaping of user-derived values ──────────────────

describe("buildChangeEmail — ENG-AC1: HTML-escape <script> and \" in label/url/summary", () => {
  it("ENG-AC1ce4: <script> in label is escaped as &lt;script&gt; in html", () => {
    const { html } = buildChangeEmail({
      eventId: "evt-4",
      monitorId: "mon-4",
      url: "https://example.com/",
      label: '<script>alert(1)</script>',
      detectedAt: "2026-11-08T10:00:00Z",
      summary: null,
      siteUrl: "https://alnyron.dk",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("ENG-AC1ce5: double-quote in label is escaped as &quot; or &#34; in html", () => {
    const { html } = buildChangeEmail({
      eventId: "evt-5",
      monitorId: "mon-5",
      url: "https://example.com/",
      label: 'Site "with" quotes',
      detectedAt: "2026-11-08T10:00:00Z",
      summary: null,
      siteUrl: "https://alnyron.dk",
    });
    // Raw unescaped " must not appear inside HTML attributes/content
    // (acceptable encodings: &quot; or &#34; or &#x22;)
    const unescapedInAttr = html.match(/="[^"]*"with"[^"]*"/);
    expect(unescapedInAttr).toBeNull();
  });

  it("ENG-AC1ce6: < in page URL is escaped in html output", () => {
    const { html } = buildChangeEmail({
      eventId: "evt-6",
      monitorId: "mon-6",
      url: "https://example.com/<path>",
      label: null,
      detectedAt: "2026-11-08T10:00:00Z",
      summary: null,
      siteUrl: "https://alnyron.dk",
    });
    expect(html).not.toContain("<path>");
    expect(html).toContain("&lt;path&gt;");
  });

  it("ENG-AC1ce7: summary lines with < are escaped in html", () => {
    const { html } = buildChangeEmail({
      eventId: "evt-7",
      monitorId: "mon-7",
      url: "https://example.com/",
      label: "Side",
      detectedAt: "2026-11-08T10:00:00Z",
      summary: "+ <script>alert(2)</script>",
      siteUrl: "https://alnyron.dk",
    });
    expect(html).not.toContain("<script>alert(2)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

// ── buildChangeEmail — ONLY href = detail page URL ───────────────────────────

describe("buildChangeEmail — ENG-AC1: only href is siteUrl/monitor/monitors/<id>", () => {
  const ME = getMonitorEmail();

  it("ENG-AC1ce8: html contains exactly one href pointing to the detail page", () => {
    const monitorId = "00000000-0000-0000-0000-000000000011";
    const siteUrl = "https://alnyron.dk";
    const { html } = buildChangeEmail({
      eventId: "evt-8",
      monitorId,
      url: "https://example.com/watched",
      label: "Watched",
      detectedAt: "2026-11-08T10:00:00Z",
      summary: null,
      siteUrl,
    });
    expect(hrefsOf(html)).toEqual([`${siteUrl}/monitor/monitors/${monitorId}`]);
  });

  it("SHIP-AC11a-1: href uses monitor.alnyron.dk siteUrl as base", () => {
    const monitorId = "00000000-0000-0000-0000-000000000011";
    const siteUrl = "https://monitor.alnyron.dk";
    const { html } = buildChangeEmail({
      eventId: "evt-8",
      monitorId,
      url: "https://example.com/watched",
      label: "Watched",
      detectedAt: "2026-11-08T10:00:00Z",
      summary: null,
      siteUrl,
    });
    expect(hrefsOf(html)).toEqual([
      "https://monitor.alnyron.dk/monitor/monitors/00000000-0000-0000-0000-000000000011",
    ]);
  });

  it("ENG-AC1ce9: page URL appears as defanged text in the intro, never as href", () => {
    const { html } = buildChangeEmail({
      eventId: "evt-9",
      monitorId: "mon-9",
      url: "https://example.com/page",
      label: null,
      detectedAt: "2026-11-08T10:00:00Z",
      summary: null,
      siteUrl: "https://alnyron.dk",
    });
    const intro = ME.changeIntro
      .replace("{url}", "hxxps://example[.]com/page")
      .replace("{when}", formatDateTime("2026-11-08T10:00:00Z"));
    expect(html).toContain(`<p style="margin:0;">${intro}</p>`);
    expect(hrefsOf(html)).toEqual(["https://alnyron.dk/monitor/monitors/mon-9"]);
  });
});

// ── buildChangeEmail — added/removed sections ─────────────────────────────────

describe("buildChangeEmail — ENG-AC1: added/removed sections from summary", () => {
  const ME = getMonitorEmail();

  it("ENG-AC1ce10: the '+ ' lines are listed in order under MonitorEmail.added, then the '− ' lines under MonitorEmail.removed", () => {
    const { html } = buildChangeEmail({
      eventId: "evt-10",
      monitorId: "mon-10",
      url: "https://example.com/",
      label: "Side",
      detectedAt: "2026-11-08T10:00:00Z",
      summary: "+ New content line\n+ Second new line\n\u2212 Old content line\n\u2212 Second old line",
      siteUrl: "https://alnyron.dk",
    });
    const intro = ME.changeIntro
      .replace("{url}", "hxxps://example[.]com/")
      .replace("{when}", formatDateTime("2026-11-08T10:00:00Z"));
    const h2 = '<h2 style="margin:20px 0 8px;font-size:16px;color:#0b1d33;">';
    const ul = '<ul style="margin:0;padding-left:20px;">';
    const li = '<li style="margin:0 0 4px;">';
    // Intro paragraph, then the two lists, then the button: one contiguous fragment.
    expect(html).toContain(
      `<p style="margin:0;">${intro}</p>\n` +
        `${h2}${ME.added}</h2>\n${ul}${li}New content line</li>${li}Second new line</li></ul>\n` +
        `${h2}${ME.removed}</h2>\n${ul}${li}Old content line</li>${li}Second old line</li></ul>\n\n` +
        '<p style="margin:28px 0;"><a href="https://alnyron.dk/monitor/monitors/mon-10"',
    );
  });

  it("ENG-AC1ce11: null summary renders MonitorEmail.noLines text", () => {
    const { html } = buildChangeEmail({
      eventId: "evt-11",
      monitorId: "mon-11",
      url: "https://example.com/",
      label: "Side",
      detectedAt: "2026-11-08T10:00:00Z",
      summary: null,
      siteUrl: "https://alnyron.dk",
    });
    expect(html).toContain(ME.noLines); // "Indholdet på siden er ændret."
  });

  it("ENG-AC1ce12: empty summary renders MonitorEmail.noLines text", () => {
    const { html } = buildChangeEmail({
      eventId: "evt-12",
      monitorId: "mon-12",
      url: "https://example.com/",
      label: "Side",
      detectedAt: "2026-11-08T10:00:00Z",
      summary: "",
      siteUrl: "https://alnyron.dk",
    });
    expect(html).toContain(ME.noLines);
  });
});

// ── buildChangeEmail — text part ─────────────────────────────────────────────

describe("buildChangeEmail — ENG-AC1: plain-text part carries same information", () => {
  const ME = getMonitorEmail();

  it("ENG-AC1ce13: text part = heading, intro, added and removed lists, detail link, footer", () => {
    const monitorId = "mon-txt";
    const { text } = buildChangeEmail({
      eventId: "evt-13",
      monitorId,
      url: "https://example.com/",
      label: "Side",
      detectedAt: "2026-11-08T10:00:00Z",
      summary: "+ Ny linje\n\u2212 Gammel linje",
      siteUrl: "https://alnyron.dk",
    });
    expect(text).toBe(
      [
        ME.changeHeading.replace("{name}", "Side"),
        "",
        ME.changeIntro.replace("{url}", "hxxps://example[.]com/").replace("{when}", formatDateTime("2026-11-08T10:00:00Z")),
        "",
        `${ME.added}:`,
        "- Ny linje",
        "",
        `${ME.removed}:`,
        "- Gammel linje",
        "",
        `${ME.cta}: https://alnyron.dk/monitor/monitors/${monitorId}`,
        "",
        ME.footer,
        "",
      ].join("\n"),
    );
  });

  it("ENG-AC1ce14: text part without summary lines says the content changed", () => {
    const { text } = buildChangeEmail({
      eventId: "evt-14",
      monitorId: "mon-14",
      url: "https://example.com/",
      label: "Min overvågning",
      detectedAt: "2026-11-08T10:00:00Z",
      summary: null,
      siteUrl: "https://alnyron.dk",
    });
    expect(text).toBe(
      [
        ME.changeHeading.replace("{name}", "Min overvågning"),
        "",
        ME.changeIntro.replace("{url}", "hxxps://example[.]com/").replace("{when}", formatDateTime("2026-11-08T10:00:00Z")),
        "",
        ME.noLines,
        "",
        `${ME.cta}: https://alnyron.dk/monitor/monitors/mon-14`,
        "",
        ME.footer,
        "",
      ].join("\n"),
    );
  });
});

// ── buildErrorEmail ───────────────────────────────────────────────────────────

describe("buildErrorEmail — ENG-AC3: subject/heading from MonitorEmail error keys", () => {
  const ME = getMonitorEmail();

  it("ENG-AC3ce1: subject is MonitorEmail.errorSubject with {name} replaced", () => {
    const { subject } = buildErrorEmail({
      monitorId: "mon-err-1",
      url: "https://example.com/down",
      label: "Down Side",
      failures: 3,
      siteUrl: "https://alnyron.dk",
    });
    expect(subject).toBe(ME.errorSubject.replace("{name}", "Down Side"));
  });

  it("ENG-AC3ce2: html contains MonitorEmail.errorHeading with {name} replaced", () => {
    const { html } = buildErrorEmail({
      monitorId: "mon-err-2",
      url: "https://example.com/down",
      label: "Down Side",
      failures: 3,
      siteUrl: "https://alnyron.dk",
    });
    const expectedHeading = ME.errorHeading.replace("{name}", "Down Side");
    expect(html).toContain(expectedHeading);
  });

  it("ENG-AC3ce3: html carries MonitorEmail.errorBody with the url and the failure count", () => {
    const { html } = buildErrorEmail({
      monitorId: "mon-err-3",
      url: "https://example.com/down",
      label: "Down Side",
      failures: 7,
      siteUrl: "https://alnyron.dk",
    });
    const body = ME.errorBody.replace("{url}", "hxxps://example[.]com/down").replace("{failures}", "7");
    expect(html).toContain(`<p style="margin:0;">${body}</p>`);
  });

  it("ENG-AC3ce4: error email's only href is the detail page, not the broken URL", () => {
    const { html } = buildErrorEmail({
      monitorId: "mon-err-4",
      url: "https://example.com/down",
      label: null,
      failures: 3,
      siteUrl: "https://alnyron.dk",
    });
    expect(hrefsOf(html)).toEqual(["https://alnyron.dk/monitor/monitors/mon-err-4"]);
  });

  it("ENG-AC3ce5: EmailContent: exact subject and text part (heading, body, detail link, footer)", () => {
    const result: EmailContent = buildErrorEmail({
      monitorId: "mon-err-5",
      url: "https://example.com/down",
      label: "Side",
      failures: 3,
      siteUrl: "https://alnyron.dk",
    });
    expect(result.subject).toBe(ME.errorSubject.replace("{name}", "Side"));
    expect(result.text).toBe(
      [
        ME.errorHeading.replace("{name}", "Side"),
        "",
        ME.errorBody.replace("{url}", "hxxps://example[.]com/down").replace("{failures}", "3"),
        "",
        `${ME.cta}: https://alnyron.dk/monitor/monitors/mon-err-5`,
        "",
        ME.errorFooter,
        "",
      ].join("\n"),
    );
    expect(result.html).toContain(`<title>${result.subject}</title>`);
  });
});

// ── defangLinks — page/user text never becomes a link ───────────────────────

describe("defangLinks — ENG-AC1: schemes, domain-like and e-mail-like tokens are defanged", () => {
  it.each<[input: string, defanged: string]>([
    ["https://evil.example/x", "hxxps://evil[.]example/x"],
    ["http://evil.example", "hxxp://evil[.]example"],
    ["HTTPS://Evil.Example/X", "HxxPS://Evil[.]Example/X"],
    ["Log ind på evil.example i dag", "Log ind på evil[.]example i dag"],
    ["www.login.evil.example/konto", "www[.]login[.]evil[.]example/konto"],
    ["Skriv til support@evil.example", "Skriv til support[at]evil[.]example"],
    ["first.last@evil.example", "first[.]last[at]evil[.]example"],
    ["https://bücher.example/ø", "hxxps://bücher[.]example/ø"],
    ["xn--bcher-kva.example", "xn--bcher-kva[.]example"],
    // A label ending in a combining mark (U+093F, \p{Mc}) right before the dot.
    ["कि.example", "कि[.]example"],
    ["सं@कि.example", "सं[at]कि[.]example"],
    // Every `@` between a local-part character and a domain-like token, also when one address
    // ends where the next begins.
    ["x@y.z@w.v", "x[at]y[.]z[at]w[.]v"],
  ])("ENG-AC1df1: %s → %s", (input, defanged) => {
    expect(defangLinks(input)).toBe(defanged);
  });

  it.each([
    "Min side",
    "Åbningstider: man–fre 9–17. Lukket i weekenden.",
    "user@localhost",
    "",
  ])("ENG-AC1df2: '%s' (no scheme, no dotted token, no e-mail-like token) comes back unchanged", (input) => {
    expect(defangLinks(input)).toBe(input);
  });

  it.each<[input: string, defanged: string]>([
    // A dot between two digits stays: no top-level domain is numeric (prices, dates, times, in
    // any script's decimal digits).
    ["Pris 1.299 kr.", "Pris 1.299 kr."],
    ["Udsalg 08.11.2026 kl. 10.30", "Udsalg 08.11.2026 kl. 10.30"],
    ["१.२", "१.२"],
    // A dotted IPv4 address too (contract §7, review-8 amendment); its scheme is still defanged.
    ["http://10.0.0.1/", "hxxp://10.0.0.1/"],
    // A letter on one side is enough: digit before only, digit after only, mixed in one token.
    ["shop1.dk", "shop1[.]dk"],
    ["a1.b2", "a1[.]b2"],
    ["evil.1example", "evil[.]1example"],
    ["web2.0.evil.example", "web2.0[.]evil[.]example"],
  ])("ENG-AC1df7: %s → %s (a dot between two digits stays)", (input, defanged) => {
    expect(defangLinks(input)).toBe(defanged);
  });

  it("ENG-AC1df8: a 2046-character URL with a dotless path (a monitor URL is at most 2048) comes back exactly", () => {
    const path = "a".repeat(2028);
    expect(defangLinks(`https://a.example/${path}`)).toBe(`hxxps://a[.]example/${path}`);
  });

  // A quadratic scan (a token regex retried from every position inside a run) takes seconds on
  // 100 000 characters; the anchored, linear one about a millisecond. 200 ms leaves CI headroom.
  it.each<[label: string, input: string, defanged: string]>([
    ["one run of letters", "a".repeat(100_000), "a".repeat(100_000)],
    ["letters joined by dots", "a.".repeat(50_000), `${"a[.]".repeat(49_999)}a.`],
    ["digits joined by dots", "1.".repeat(50_000), "1.".repeat(50_000)],
    ["an @ after every letter", "a@".repeat(50_000), "a@".repeat(50_000)],
    ["one @ before a dotless run", `x@${"b".repeat(99_998)}`, `x@${"b".repeat(99_998)}`],
  ])("ENG-AC1df9: %s (100 000 characters) — exact output in under 200 ms", (_label, input, defanged) => {
    const started = performance.now();
    const output = defangLinks(input);
    const elapsed = performance.now() - started;
    expect(output).toBe(defanged);
    expect(elapsed).toBeLessThan(200);
  });
});

describe("buildChangeEmail / buildErrorEmail — ENG-AC1, ENG-AC3: page and user text is defanged in both parts", () => {
  const ME = getMonitorEmail();
  const when = formatDateTime("2026-11-08T10:00:00Z");
  const li = '<li style="margin:0 0 4px;">';

  it("ENG-AC1df3: change email — the URL-derived name, the URL and every summary line; the only link stays the detail page", () => {
    const email = buildChangeEmail({
      eventId: "evt-df3",
      monitorId: "mon-df3",
      url: "https://evil.example/x",
      label: null,
      detectedAt: "2026-11-08T10:00:00Z",
      summary: "+ Log ind på https://evil.example/login\n\u2212 Skriv til support@evil.example",
      siteUrl: "https://alnyron.dk",
    });
    const name = "evil[.]example/x";
    const intro = ME.changeIntro.replace("{url}", "hxxps://evil[.]example/x").replace("{when}", when);
    expect(email.subject).toBe(ME.changeSubject.replace("{name}", name));
    expect(email.text).toBe(
      [
        ME.changeHeading.replace("{name}", name),
        "",
        intro,
        "",
        `${ME.added}:`,
        "- Log ind på hxxps://evil[.]example/login",
        "",
        `${ME.removed}:`,
        "- Skriv til support[at]evil[.]example",
        "",
        `${ME.cta}: https://alnyron.dk/monitor/monitors/mon-df3`,
        "",
        ME.footer,
        "",
      ].join("\n"),
    );
    expect(email.html).toContain(`<title>${ME.changeSubject.replace("{name}", name)}</title>`);
    expect(email.html).toContain(`>${ME.changeHeading.replace("{name}", name)}</h1>`);
    expect(email.html).toContain(`<p style="margin:0;">${intro}</p>`);
    expect(email.html).toContain(`${li}Log ind på hxxps://evil[.]example/login</li>`);
    expect(email.html).toContain(`${li}Skriv til support[at]evil[.]example</li>`);
    expect(email.html).not.toMatch(/evil\.example|support@/);
    expect(hrefsOf(email.html)).toEqual(["https://alnyron.dk/monitor/monitors/mon-df3"]);
  });

  it("ENG-AC1df4: defanging runs before HTML escaping (an injected anchor stays escaped text)", () => {
    const { html } = buildChangeEmail({
      eventId: "evt-df4",
      monitorId: "mon-df4",
      url: "https://example.com/",
      label: "Side",
      detectedAt: "2026-11-08T10:00:00Z",
      summary: '+ <a href="https://evil.example">Klik</a>',
      siteUrl: "https://alnyron.dk",
    });
    expect(html).toContain(`${li}&lt;a href=&quot;hxxps://evil[.]example&quot;&gt;Klik&lt;/a&gt;</li>`);
    expect(hrefsOf(html)).toEqual(["https://alnyron.dk/monitor/monitors/mon-df4"]);
  });

  it("ENG-AC1df5: a user label with a domain-like token is defanged; a label without one is unchanged", () => {
    const base = {
      eventId: "evt-df5",
      monitorId: "mon-df5",
      url: "https://example.com/",
      detectedAt: "2026-11-08T10:00:00Z",
      summary: null,
      siteUrl: "https://alnyron.dk",
    };
    expect(buildChangeEmail({ ...base, label: "Se evil.example" }).subject).toBe(
      ME.changeSubject.replace("{name}", "Se evil[.]example"),
    );
    expect(buildChangeEmail({ ...base, label: "Min side" }).subject).toBe(
      ME.changeSubject.replace("{name}", "Min side"),
    );
  });

  it("ENG-AC3df6: error email — the URL-derived name and the URL in subject, html and text; the only link stays the detail page", () => {
    const email = buildErrorEmail({
      monitorId: "mon-df6",
      url: "https://evil.example/x",
      label: null,
      failures: 3,
      siteUrl: "https://alnyron.dk",
    });
    const name = "evil[.]example/x";
    const body = ME.errorBody.replace("{url}", "hxxps://evil[.]example/x").replace("{failures}", "3");
    expect(email.subject).toBe(ME.errorSubject.replace("{name}", name));
    expect(email.text).toBe(
      [
        ME.errorHeading.replace("{name}", name),
        "",
        body,
        "",
        `${ME.cta}: https://alnyron.dk/monitor/monitors/mon-df6`,
        "",
        ME.errorFooter,
        "",
      ].join("\n"),
    );
    expect(email.html).toContain(`<p style="margin:0;">${body}</p>`);
    expect(email.html).not.toMatch(/evil\.example/);
    expect(hrefsOf(email.html)).toEqual(["https://alnyron.dk/monitor/monitors/mon-df6"]);
  });
});

// ── The whole email, pinned exactly ──────────────────────────────────────────

describe("buildChangeEmail / buildErrorEmail / renderEmail — ENG-AC1, ENG-AC3, SNE-AC1i: the whole email, exactly", () => {
  // Only the date comes from formatDateTime: its exact form depends on the runtime's ICU data.
  const WHEN = formatDateTime("2026-11-08T10:00:00Z");
  const H1 = '<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#0b1d33;">';
  const BUTTON = (url: string) =>
    `<p style="margin:28px 0;"><a href="${url}" style="display:inline-block;padding:12px 20px;background:#3346e8;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;">Se overvågningen</a></p>\n`;
  const FOOTER_AFTER_BUTTON = '<p style="margin:0;font-size:13px;line-height:1.5;color:#5a6778;">';
  const CHANGE_FOOTER =
    "Du får denne mail, fordi du overvåger siden med Alnyron Monitor. Du kan sætte overvågningen på pause eller slette den under Monitor. Vi tjekker kun sidens tekst.";
  const ERROR_FOOTER = "Du får kun denne mail én gang, indtil siden kan hentes igen.";

  it("ENG-AC1ce15: change email with added and removed lines → exact subject, html and text", () => {
    const detailUrl = "https://monitor.alnyron.dk/monitor/monitors/00000000-0000-0000-0000-0000000000c1";
    const email = buildChangeEmail({
      eventId: "evt-pin1",
      monitorId: "00000000-0000-0000-0000-0000000000c1",
      url: "https://example.com/priser",
      label: "Priser & tilbud",
      detectedAt: "2026-11-08T10:00:00Z",
      summary: "+ Ny pris: 1.299 kr.\n\u2212 Gammel pris: 1.499 kr. på shop.example",
      siteUrl: "https://monitor.alnyron.dk",
    });
    expect(email.subject).toBe("Ændring på Priser & tilbud");
    expect(email.html).toBe(
      emailDocument(
        "Ændring på Priser &amp; tilbud",
        `${H1}Priser &amp; tilbud har ændret sig</h1>\n` +
          `<p style="margin:0;">Vi tjekkede hxxps://example[.]com/priser ${WHEN} og fandt ændringer siden sidste tjek.</p>\n` +
          '<h2 style="margin:20px 0 8px;font-size:16px;color:#0b1d33;">Tilføjet</h2>\n' +
          '<ul style="margin:0;padding-left:20px;"><li style="margin:0 0 4px;">Ny pris: 1.299 kr.</li></ul>\n' +
          '<h2 style="margin:20px 0 8px;font-size:16px;color:#0b1d33;">Fjernet</h2>\n' +
          '<ul style="margin:0;padding-left:20px;"><li style="margin:0 0 4px;">Gammel pris: 1.499 kr. på shop[.]example</li></ul>\n' +
          "\n" +
          BUTTON(detailUrl) +
          `${FOOTER_AFTER_BUTTON}${CHANGE_FOOTER}</p>\n`,
      ),
    );
    expect(email.text).toBe(
      "Priser & tilbud har ændret sig\n\n" +
        `Vi tjekkede hxxps://example[.]com/priser ${WHEN} og fandt ændringer siden sidste tjek.\n\n` +
        "Tilføjet:\n- Ny pris: 1.299 kr.\n\n" +
        "Fjernet:\n- Gammel pris: 1.499 kr. på shop[.]example\n\n" +
        `Se overvågningen: ${detailUrl}\n\n` +
        `${CHANGE_FOOTER}\n`,
    );
  });

  it("ENG-AC1ce16: change email without summary lines → exact subject, html and text", () => {
    const detailUrl = "https://alnyron.dk/monitor/monitors/00000000-0000-0000-0000-0000000000c2";
    const email = buildChangeEmail({
      eventId: "evt-pin2",
      monitorId: "00000000-0000-0000-0000-0000000000c2",
      url: "https://www.example.com/",
      label: null,
      detectedAt: "2026-11-08T10:00:00Z",
      summary: null,
      siteUrl: "https://alnyron.dk",
    });
    expect(email.subject).toBe("Ændring på www[.]example[.]com");
    expect(email.html).toBe(
      emailDocument(
        "Ændring på www[.]example[.]com",
        `${H1}www[.]example[.]com har ændret sig</h1>\n` +
          `<p style="margin:0;">Vi tjekkede hxxps://www[.]example[.]com/ ${WHEN} og fandt ændringer siden sidste tjek.</p>\n` +
          '<p style="margin:16px 0 0;">Indholdet på siden er ændret.</p>\n' +
          "\n" +
          BUTTON(detailUrl) +
          `${FOOTER_AFTER_BUTTON}${CHANGE_FOOTER}</p>\n`,
      ),
    );
    expect(email.text).toBe(
      "www[.]example[.]com har ændret sig\n\n" +
        `Vi tjekkede hxxps://www[.]example[.]com/ ${WHEN} og fandt ændringer siden sidste tjek.\n\n` +
        "Indholdet på siden er ændret.\n\n" +
        `Se overvågningen: ${detailUrl}\n\n` +
        `${CHANGE_FOOTER}\n`,
    );
  });

  it("ENG-AC3ce6: error email → exact subject, html and text", () => {
    const detailUrl = "https://monitor.alnyron.dk/monitor/monitors/00000000-0000-0000-0000-0000000000c3";
    const email = buildErrorEmail({
      monitorId: "00000000-0000-0000-0000-0000000000c3",
      url: "https://example.com/down",
      label: "<Min side>",
      failures: 3,
      siteUrl: "https://monitor.alnyron.dk",
    });
    const body =
      "Vi har forsøgt at hente hxxps://example[.]com/down 3 gange i træk uden held. Vi prøver igen, men sjældnere. Tjek, at adressen stadig virker.";
    expect(email.subject).toBe("Vi kan ikke hente <Min side>");
    expect(email.html).toBe(
      emailDocument(
        "Vi kan ikke hente &lt;Min side&gt;",
        `${H1}Vi kan ikke hente &lt;Min side&gt;</h1>\n` +
          `<p style="margin:0;">${body}</p>\n` +
          "\n" +
          BUTTON(detailUrl) +
          `${FOOTER_AFTER_BUTTON}${ERROR_FOOTER}</p>\n`,
      ),
    );
    expect(email.text).toBe(
      `Vi kan ikke hente <Min side>\n\n${body}\n\nSe overvågningen: ${detailUrl}\n\n${ERROR_FOOTER}\n`,
    );
  });

  it("SNE-AC1i-ce1: renderEmail without an action → exact html (no button, footer margin 28px 0 0, no link) and text (no CTA line)", () => {
    const email = renderEmail({
      subject: "Emne",
      heading: "Overskrift & <mere>",
      bodyHtml: '<p style="margin:0;">Brødtekst</p>\n',
      bodyText: "Brødtekst",
      footer: "Fod & <note>",
    });
    expect(email.subject).toBe("Emne");
    expect(email.html).toBe(
      emailDocument(
        "Emne",
        `${H1}Overskrift &amp; &lt;mere&gt;</h1>\n` +
          '<p style="margin:0;">Brødtekst</p>\n' +
          "\n" +
          '<p style="margin:28px 0 0;font-size:13px;line-height:1.5;color:#5a6778;">Fod &amp; &lt;note&gt;</p>\n',
      ),
    );
    expect(email.text).toBe("Overskrift & <mere>\n\nBrødtekst\n\nFod & <note>\n");
  });
});
