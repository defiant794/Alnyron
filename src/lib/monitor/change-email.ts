import { createTranslator } from "use-intl/core";
import { MonitorEmail } from "../../../messages/da.json";
import { AUTH_LOCALE } from "@/config/auth-areas";
import { monitorDetailPath } from "@/config/monitor";
import { displayUrl, formatDateTime } from "@/lib/monitor/format";

/**
 * The two emails the monitor engine sends about monitored pages ("a page
 * changed" and "we cannot fetch a page"), and the layout and helpers every
 * engine email shares (the owner's signup notice, `signup-notice-email.ts`,
 * too). Pure (no env, no I/O), so the cron Worker and tests share it.
 * Page and user data (label, URL, summary lines) is third-party text: it is
 * defanged ({@link defangLinks}, so mail clients cannot auto-link it) and
 * HTML-escaped everywhere, and the only link is the monitor's detail page on
 * our own site; the monitored URL is shown as text, never as a link.
 */

export type EmailContent = { subject: string; html: string; text: string };

const t = createTranslator({ locale: AUTH_LOCALE, messages: { MonitorEmail }, namespace: "MonitorEmail" });

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escapes `&`, `<`, `>`, `"` and `'` for HTML text and attribute values. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/** `http://` / `https://` in any case: the scheme of a URL a mail client would auto-link. */
const URL_SCHEME = /(h)tt(ps?:\/\/)/giu;

/**
 * The `@` of an e-mail-like token: a local part (letters, combining marks,
 * digits, `._%+-`) matched from the start of its run (the lookbehind), then the
 * `@`, then a domain-like token that is only looked at, not consumed, so the
 * next address's local part may begin right there. The anchor keeps the scan
 * linear: without it the engine would retry a long run of letters from every
 * position inside it (quadratic, milliseconds per call on a 2048-char URL).
 */
const EMAIL_LIKE = /(?<![\p{L}\p{M}\p{N}._%+-])([\p{L}\p{M}\p{N}._%+-]+)@(?=[\p{L}\p{M}\p{N}-]+\.[\p{L}\p{M}\p{N}-])/gu;

/**
 * A domain-like token: runs of letters (with their combining marks, as in IDN
 * labels such as `कि`), digits and hyphens joined by dots, matched from the
 * start of a run (the lookbehind keeps the scan linear, as for
 * {@link EMAIL_LIKE}).
 */
const DOMAIN_LIKE = /(?<![\p{L}\p{M}\p{N}-])[\p{L}\p{M}\p{N}-]+(?:\.[\p{L}\p{M}\p{N}-]+)+/gu;

/**
 * A dot in a domain-like token that is not between two digits. A dot between
 * two digits (a price `1.299`, a date `08.11.2026`, a time `10.30`) cannot
 * start a top-level domain (none is numeric), so it stays.
 */
const LINKABLE_DOT = /(?<!\p{Nd})\.|\.(?!\p{Nd})/gu;

/**
 * Defangs third-party text for an email, so no mail client turns it into a
 * link (a page could otherwise put a phishing URL into a message from our
 * domain): `http(s)://` → `hxxp(s)://`, the `@` of an e-mail-like token →
 * `[at]`, and every `.` inside a domain-like token → `[.]`, except a `.`
 * between two digits. Text without such tokens comes back unchanged. Linear
 * in the length of the text. Applied before HTML escaping.
 */
export function defangLinks(text: string): string {
  return text
    .replace(URL_SCHEME, "$1xx$2")
    .replace(EMAIL_LIKE, "$1[at]")
    .replace(DOMAIN_LIKE, (token) => token.replace(LINKABLE_DOT, "[.]"));
}

/**
 * The added and removed lines of a change summary (`+ line` / `− line`, see
 * `summarizeChange`), defanged: they are text from the monitored page.
 */
function summaryLines(summary: string | null): { added: string[]; removed: string[] } {
  const lines = (summary ?? "").split("\n");
  return {
    added: lines.filter((line) => line.startsWith("+ ")).map((line) => defangLinks(line.slice(2))),
    removed: lines.filter((line) => line.startsWith("\u2212 ")).map((line) => defangLinks(line.slice(2))),
  };
}

/** The one button of an email: its label and the absolute URL (on our own site) it opens. */
type EmailAction = { label: string; url: string };

/** The content of an engine email, to be wrapped in the shared layout ({@link renderEmail}). */
type EmailParts = {
  subject: string;
  heading: string;
  /** Paragraphs and lists between heading and button: escaped HTML. */
  bodyHtml: string;
  /** The same content as plain text. */
  bodyText: string;
  /** The button; without one the email holds no link at all. */
  action?: EmailAction;
  footer: string;
};

/** Wraps an email's content in the shared layout (HTML with inline styles, plus a text part). */
export function renderEmail(parts: EmailParts): EmailContent {
  const { action } = parts;
  const actionHtml = action
    ? `<p style="margin:28px 0;"><a href="${escapeHtml(action.url)}" style="display:inline-block;padding:12px 20px;background:#3346e8;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;">${escapeHtml(action.label)}</a></p>\n`
    : "";
  // The button's paragraph spaces the footer from the body; without it the footer does.
  const footerMargin = action ? "0" : "28px 0 0";
  const html = `<!doctype html>
<html lang="da">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(parts.subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f6f8fb;color:#0b1d33;font-family:'Segoe UI',Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fb;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e5e9f0;border-radius:12px;">
<tr><td style="padding:32px 28px;font-size:16px;line-height:1.5;">
<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#0b1d33;">${escapeHtml(parts.heading)}</h1>
${parts.bodyHtml}
${actionHtml}<p style="margin:${footerMargin};font-size:13px;line-height:1.5;color:#5a6778;">${escapeHtml(parts.footer)}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;
  const actionText = action ? `${action.label}: ${action.url}\n\n` : "";
  const text = `${parts.heading}\n\n${parts.bodyText}\n\n${actionText}${parts.footer}\n`;
  return { subject: parts.subject, html, text };
}

/** The button of a monitor email: the monitor's detail page on the site at `siteUrl`. */
function monitorAction(monitorId: string, siteUrl: string): EmailAction {
  return { label: t("cta"), url: new URL(monitorDetailPath(monitorId), siteUrl).href };
}

/** One "Tilføjet"/"Fjernet" list, in HTML and text, or nothing for no lines. */
function lineList(heading: string, lines: readonly string[]): { html: string; text: string } {
  if (lines.length === 0) return { html: "", text: "" };
  const items = lines.map((line) => `<li style="margin:0 0 4px;">${escapeHtml(line)}</li>`).join("");
  return {
    html: `<h2 style="margin:20px 0 8px;font-size:16px;color:#0b1d33;">${escapeHtml(heading)}</h2>\n<ul style="margin:0;padding-left:20px;">${items}</ul>\n`,
    text: `\n\n${heading}:\n${lines.map((line) => `- ${line}`).join("\n")}`,
  };
}

/**
 * The email for one detected change. The engine builds it from the stored event
 * plus the monitor's current URL and label, and sends it to the owner's current
 * address under the key `monitor-event/<event id>`. A retry whose payload
 * changed (the monitor renamed or its URL edited, or the owner's address
 * changed, since the first send) gets Resend's 409 `invalid_idempotent_request`
 * (per Resend's docs as of 2026-11): the event is marked and counted in
 * `emailsRejected`, with no second email, and sending goes on. The first send
 * under that key was most likely delivered (inferred; Resend's docs don't say
 * so). `summary` is the event's summary; without lines the email says the
 * content changed.
 */
export function buildChangeEmail(input: {
  eventId: string;
  monitorId: string;
  url: string;
  label: string | null;
  detectedAt: string;
  summary: string | null;
  siteUrl: string;
}): EmailContent {
  const name = defangLinks(input.label?.trim() || displayUrl(input.url));
  const intro = t("changeIntro", { url: defangLinks(input.url), when: formatDateTime(input.detectedAt) });
  const { added, removed } = summaryLines(input.summary);
  const addedList = lineList(t("added"), added);
  const removedList = lineList(t("removed"), removed);
  const hasLines = added.length > 0 || removed.length > 0;
  const paragraph = `<p style="margin:0;">${escapeHtml(intro)}</p>\n`;

  return renderEmail({
    subject: t("changeSubject", { name }),
    heading: t("changeHeading", { name }),
    bodyHtml: hasLines
      ? `${paragraph}${addedList.html}${removedList.html}`
      : `${paragraph}<p style="margin:16px 0 0;">${escapeHtml(t("noLines"))}</p>\n`,
    bodyText: hasLines ? `${intro}${addedList.text}${removedList.text}` : `${intro}\n\n${t("noLines")}`,
    action: monitorAction(input.monitorId, input.siteUrl),
    footer: t("footer"),
  });
}

/** The one email of an error streak: the page failed `failures` checks in a row. */
export function buildErrorEmail(input: {
  monitorId: string;
  url: string;
  label: string | null;
  failures: number;
  siteUrl: string;
}): EmailContent {
  const name = defangLinks(input.label?.trim() || displayUrl(input.url));
  const body = t("errorBody", { url: defangLinks(input.url), failures: input.failures });
  return renderEmail({
    subject: t("errorSubject", { name }),
    heading: t("errorHeading", { name }),
    bodyHtml: `<p style="margin:0;">${escapeHtml(body)}</p>\n`,
    bodyText: body,
    action: monitorAction(input.monitorId, input.siteUrl),
    footer: t("errorFooter"),
  });
}
