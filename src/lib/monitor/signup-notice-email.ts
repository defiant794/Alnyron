import { createTranslator } from "use-intl/core";
import { MonitorEmail } from "../../../messages/da.json";
import { AUTH_LOCALE } from "@/config/auth-areas";
import { defangLinks, escapeHtml, renderEmail, type EmailContent } from "@/lib/monitor/change-email";
import { formatDateTime } from "@/lib/monitor/format";

/**
 * The owner's notice of a new confirmed public Monitor account, sent by the
 * cron (`workers/monitor-cron/run.ts`). Pure (no env, no I/O). Built only from
 * the pending-signup row; its `waiting` count can differ on a later run, so a
 * retry under the same idempotency key may carry another payload, which
 * Resend refuses with a 409 (`sendEmail` reports it as a rejection) instead of
 * sending twice. The new account's address is chosen by whoever signed up:
 * it is defanged ({@link defangAddress}) and HTML-escaped, and the email holds
 * no link at all (no button, no URL).
 */

const t = createTranslator({ locale: AUTH_LOCALE, messages: { MonitorEmail }, namespace: "MonitorEmail" });

/**
 * The new account's address for the notice, defanged in full so no mail
 * client turns any part of it into a mailto or web link: {@link defangLinks}
 * over the whole address, local part included (a domain-shaped local part is
 * defanged too: `evil.com@x.dk` → `evil[.]com[at]x[.]dk`), then every `@` it
 * left (one not preceded by an e-mail-like local part, as in `a!@evil.com` →
 * `a![at]evil[.]com`) → `[at]`. `ny.bruger@eksempel.dk` →
 * `ny[.]bruger[at]eksempel[.]dk`. Applied before HTML escaping.
 */
function defangAddress(address: string): string {
  return defangLinks(address).replaceAll("@", "[at]");
}

/**
 * The notice for one new account: its address (`email`), when it was
 * confirmed (`confirmedAt`, ISO), and how many other new accounts this run
 * did not notify (`waiting`; the sentence about them appears only when
 * `waiting` > 0).
 */
export function buildSignupNoticeEmail(input: { email: string; confirmedAt: string; waiting: number }): EmailContent {
  const body = t("signupNoticeBody", { email: defangAddress(input.email), when: formatDateTime(input.confirmedAt) });
  const waiting = input.waiting > 0 ? t("signupNoticeWaiting", { waiting: input.waiting }) : null;
  return renderEmail({
    subject: t("signupNoticeSubject"),
    heading: t("signupNoticeHeading"),
    bodyHtml:
      `<p style="margin:0;">${escapeHtml(body)}</p>\n` +
      (waiting === null ? "" : `<p style="margin:16px 0 0;">${escapeHtml(waiting)}</p>\n`),
    bodyText: waiting === null ? body : `${body}\n\n${waiting}`,
    footer: t("signupNoticeFooter"),
  });
}
