/**
 * Minimal Resend client (https://resend.com/docs/api-reference/emails/send-email):
 * one `fetch` POST, no SDK. It reads no environment and logs nothing; the API
 * key is passed in and never appears in a return value, and neither does the
 * recipient or the response body.
 */

import { MONITOR_EMAIL_SEND_TIMEOUT_MS } from "@/config/monitor";

export type EmailMessage = { from: string; to: string; subject: string; html: string; text: string };

/**
 * Why a send failed: `rate_limited` (429, try again later), `quota` (429 for the
 * daily or monthly sending quota), `config` (401/403: bad key or unverified
 * domain), `transient` (409 idempotency conflict, 5xx, network or timeout: the
 * same message with the same idempotency key may be retried) and `rejected`
 * (any other 4xx: retrying the same message cannot help).
 */
export type SendFailure = "rate_limited" | "quota" | "config" | "transient" | "rejected";

export type SendResult = { ok: true; id: string } | { ok: false; kind: SendFailure; status: number | null };

const RESEND_EMAILS_URL = "https://api.resend.com/emails";

/** Resend error names (`name` in a 429 body) that mean the sending quota is used up. */
const QUOTA_ERRORS = new Set(["daily_quota_exceeded", "monthly_quota_exceeded"]);

/** A JSON body's string field, or null when the body is no JSON object or lacks it. */
async function bodyField(response: Response, field: string): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !(field in body)) return null;
    const value: unknown = (body as Record<string, unknown>)[field];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Sends one email through Resend. `idempotencyKey` (at most 256 characters)
 * makes a retry within 24 hours return the first send's result instead of
 * sending again, so a caller may retry a `transient` failure with the same key.
 */
export async function sendEmail(
  apiKey: string,
  message: EmailMessage,
  idempotencyKey: string,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Promise<SendResult> {
  let response: Response;
  try {
    response = await fetchImpl(RESEND_EMAILS_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({
        from: message.from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
      signal: AbortSignal.timeout(MONITOR_EMAIL_SEND_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, kind: "transient", status: null };
  }

  const { status } = response;
  // A 2xx means Resend accepted the email; an id it fails to return is not worth a duplicate send.
  if (status >= 200 && status < 300) return { ok: true, id: (await bodyField(response, "id")) ?? "" };
  if (status === 429) {
    const name = await bodyField(response, "name");
    return { ok: false, kind: name !== null && QUOTA_ERRORS.has(name) ? "quota" : "rate_limited", status };
  }
  await response.body?.cancel().catch(() => {});
  if (status === 401 || status === 403) return { ok: false, kind: "config", status };
  if (status >= 400 && status < 500 && status !== 409) return { ok: false, kind: "rejected", status };
  return { ok: false, kind: "transient", status };
}
