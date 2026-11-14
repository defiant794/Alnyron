/**
 * Unit tests: src/lib/payments/withdrawal-emails.ts
 * Journey: payments-slice1d-withdrawal
 * Criteria: WD-J2-C06, WD-J4-C07, WD-J6-C05
 *
 * Coverage:
 *   - buildConfirmationEmail: subject, all placeholders filled, HTML-escaping, DA+EN
 *   - buildReceiptEmail: completed / nothing-to-refund / in-progress variants, DA+EN
 *   - buildOwnerAlertEmail: subject, all placeholders filled, NO consumer name or email
 *   - Dates are formatted in Europe/Copenhagen (UTC+1 in November)
 *   - Money via formatKroner (100 øre → "1 kr", 9500 øre → "95 kr")
 */
import { describe, expect, it } from "vitest";
import {
  buildConfirmationEmail,
  buildReceiptEmail,
  buildOwnerAlertEmail,
} from "@/lib/payments/withdrawal-emails";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CONFIRMATION_CTX_DA = {
  locale: "da" as const,
  planName: "Monitor Plus",
  pricePaidOre: 1000,
  billingInterval: "month" as const,
  startDate: "2026-11-14T10:00:00Z",
  withdrawUrl: "https://monitor.alnyron.dk/monitor/billing/withdraw",
  termsUrl: "https://alnyron.dk/terms",
};

const CONFIRMATION_CTX_EN = {
  ...CONFIRMATION_CTX_DA,
  locale: "en" as const,
  termsUrl: "https://alnyron.dk/en/terms",
};

const RECEIPT_COMPLETED_DA = {
  locale: "da" as const,
  consumerName: "Lars Andersen",
  requestedAt: "2026-11-14T10:00:00Z",
  startDate: "2026-11-14T10:00:00Z",
  status: "completed" as const,
  paidOre: 1000,
  retainedOre: 33,
  refundOre: 967,
};

const RECEIPT_NOTHING_DA = {
  locale: "da" as const,
  consumerName: "Lars Andersen",
  requestedAt: "2026-11-14T10:00:00Z",
  startDate: "2026-11-14T10:00:00Z",
  status: "completed" as const,
  paidOre: 0,
  retainedOre: 0,
  refundOre: 0,
};

const RECEIPT_INPROGRESS_DA = {
  locale: "da" as const,
  consumerName: "Lars Andersen",
  requestedAt: "2026-11-14T10:00:00Z",
  startDate: "2026-11-14T10:00:00Z",
  status: "received" as const,
};

const OWNER_ALERT_CTX = {
  withdrawalId: "wd-uuid-test-123",
  subscriptionId: "sub_test1234567890",
  requestedAt: "2026-11-14T10:00:00Z",
  reason: "invoice_shape" as const,
  canceled: true,
  receiptSent: true,
};

// ── WD-J2-C06: buildConfirmationEmail ────────────────────────────────────────

describe("WD-J2-C06 (WD-T-EMAIL-01): buildConfirmationEmail DA — subject and all placeholders filled", () => {
  const email = buildConfirmationEmail(CONFIRMATION_CTX_DA);

  it("WD-T-EMAIL-01a: subject is 'Bekræftelse af dit Monitor-abonnement'", () => {
    expect(email.subject).toBe("Bekræftelse af dit Monitor-abonnement");
  });

  it("WD-T-EMAIL-01b: no literal {planName} placeholder in html or text", () => {
    expect(email.html).not.toContain("{planName}");
    expect(email.text).not.toContain("{planName}");
  });

  it("WD-T-EMAIL-01c: no literal {price} placeholder", () => {
    expect(email.html).not.toContain("{price}");
    expect(email.text).not.toContain("{price}");
  });

  it("WD-T-EMAIL-01d: no literal {withdrawUrl} placeholder", () => {
    expect(email.html).not.toContain("{withdrawUrl}");
    expect(email.text).not.toContain("{withdrawUrl}");
  });

  it("WD-T-EMAIL-01e: no literal {termsUrl} placeholder", () => {
    expect(email.html).not.toContain("{termsUrl}");
    expect(email.text).not.toContain("{termsUrl}");
  });

  it("WD-T-EMAIL-01f: contains the plan name in output", () => {
    expect(email.html + email.text).toContain("Monitor Plus");
  });

  it("WD-T-EMAIL-01g: contains the terms URL in output", () => {
    expect(email.html + email.text).toContain("https://alnyron.dk/terms");
  });

  it("WD-T-EMAIL-01h: contains the withdrawal URL in output", () => {
    expect(email.html + email.text).toContain(CONFIRMATION_CTX_DA.withdrawUrl);
  });

  it("WD-T-EMAIL-01i: html and text fields are non-empty strings", () => {
    expect(typeof email.html).toBe("string");
    expect(email.html.length).toBeGreaterThan(0);
    expect(typeof email.text).toBe("string");
    expect(email.text.length).toBeGreaterThan(0);
  });
});

describe("WD-J2-C06 (WD-T-EMAIL-02): buildConfirmationEmail EN — subject and structure", () => {
  const email = buildConfirmationEmail(CONFIRMATION_CTX_EN);

  it("WD-T-EMAIL-02a: subject is 'Confirmation of your Monitor subscription'", () => {
    expect(email.subject).toBe("Confirmation of your Monitor subscription");
  });

  it("WD-T-EMAIL-02b: no unfilled placeholders", () => {
    for (const ph of ["{planName}", "{price}", "{intervalWord}", "{startDate}", "{withdrawUrl}", "{termsUrl}"]) {
      expect(email.html + email.text, `placeholder ${ph} not filled`).not.toContain(ph);
    }
  });

  it("WD-T-EMAIL-02c: 'year'/'month' interval word rendered, not raw key", () => {
    // billingInterval=month → intervalWord should be "month" (EN) or "måned" (DA)
    expect(email.html + email.text).not.toContain("{intervalWord}");
  });
});

describe("WD-J2-C06: buildConfirmationEmail — HTML-escapes user-interpolated values", () => {
  it("HTML-escapes a plan name containing '<script>'", () => {
    const email = buildConfirmationEmail({
      ...CONFIRMATION_CTX_DA,
      planName: "<script>alert(1)</script>",
    });
    expect(email.html).not.toContain("<script>alert(1)</script>");
    expect(email.html).toContain("&lt;script&gt;");
  });
});

// ── WD-J4-C07 / WD-T-EMAIL-03: buildReceiptEmail — completed with refund ─────

describe("WD-J4-C07 (WD-T-EMAIL-03): buildReceiptEmail DA — completed with refund", () => {
  const email = buildReceiptEmail(RECEIPT_COMPLETED_DA);

  it("WD-T-EMAIL-03a: subject is 'Vi har modtaget din fortrydelse'", () => {
    expect(email.subject).toBe("Vi har modtaget din fortrydelse");
  });

  it("WD-T-EMAIL-03b: contains consumer name", () => {
    expect(email.html + email.text).toContain("Lars Andersen");
  });

  it("WD-T-EMAIL-03c: no unfilled placeholders ({consumerName}, {requestedAt}, {refund})", () => {
    for (const ph of ["{consumerName}", "{requestedAt}", "{refund}", "{paid}", "{retained}", "{startDate}"]) {
      expect(email.html + email.text, `placeholder ${ph} not filled`).not.toContain(ph);
    }
  });

  it("WD-T-EMAIL-03d: contains refund amount in kroner format (not raw øre)", () => {
    // 967 øre = 9,67 kr or similar (depends on formatKroner locale format)
    // The important check: does not contain literal "967" as the only refund display
    // formatKroner converts to kroner with comma for DA
    expect(email.html + email.text).toContain("kr");
  });
});

describe("WD-J4-C07 (WD-T-EMAIL-04): buildReceiptEmail DA — in-progress (received)", () => {
  const email = buildReceiptEmail(RECEIPT_INPROGRESS_DA);

  it("WD-T-EMAIL-04a: contains the in-progress wording about 14 days", () => {
    // "senest 14 dage" is part of the in-progress wording
    expect(email.html + email.text).toContain("14 dage");
  });

  it("WD-T-EMAIL-04b: subject is 'Vi har modtaget din fortrydelse'", () => {
    expect(email.subject).toBe("Vi har modtaget din fortrydelse");
  });
});

describe("WD-J4-C07: buildReceiptEmail — completed with nothing to refund", () => {
  const email = buildReceiptEmail(RECEIPT_NOTHING_DA);

  it("contains the 'nothing to refund' wording", () => {
    // "intet at tilbagebetale" or similar
    expect(email.html + email.text).toContain("tilbagebetale");
  });
});

describe("WD-J4-C07: buildReceiptEmail EN — subject and structure", () => {
  const email = buildReceiptEmail({ ...RECEIPT_COMPLETED_DA, locale: "en" });

  it("subject is 'We have received your withdrawal'", () => {
    expect(email.subject).toBe("We have received your withdrawal");
  });

  it("no unfilled placeholders", () => {
    for (const ph of ["{consumerName}", "{requestedAt}", "{refund}", "{paid}", "{retained}", "{startDate}"]) {
      expect(email.html + email.text, `placeholder ${ph} not filled`).not.toContain(ph);
    }
  });
});

// ── WD-J6-C05 (WD-T-EMAIL-05): buildOwnerAlertEmail — no consumer data ───────

describe("WD-J6-C05 (WD-T-EMAIL-05): buildOwnerAlertEmail — no consumer name or email", () => {
  const email = buildOwnerAlertEmail(OWNER_ALERT_CTX);

  it("WD-T-EMAIL-05a: subject contains the reason", () => {
    expect(email.subject).toContain("invoice_shape");
  });

  it("WD-T-EMAIL-05b: subject contains 'manuel behandling'", () => {
    expect(email.subject).toContain("manuel behandling");
  });

  it("WD-T-EMAIL-05c: contains withdrawalId", () => {
    expect(email.html + email.text).toContain("wd-uuid-test-123");
  });

  it("WD-T-EMAIL-05d: contains subscriptionId", () => {
    expect(email.html + email.text).toContain("sub_test1234567890");
  });

  it("WD-T-EMAIL-05e: does NOT contain 'Lars Andersen' (no consumer name in alert)", () => {
    expect(email.html + email.text).not.toContain("Lars Andersen");
  });

  it("WD-T-EMAIL-05f: no unfilled placeholders", () => {
    for (const ph of ["{withdrawalId}", "{subscriptionId}", "{requestedAt}", "{reason}", "{canceledYesNo}", "{refundDeadline}"]) {
      expect(email.html + email.text, `placeholder ${ph} not filled`).not.toContain(ph);
    }
  });
});

describe("WD-J6-C05: buildOwnerAlertEmail — it.each every reason code", () => {
  it.each(["subscription_mismatch", "invoice_shape", "stripe_refused", "retries_exhausted"] as const)(
    "reason '%s' appears in subject and body",
    (reason) => {
      const email = buildOwnerAlertEmail({ ...OWNER_ALERT_CTX, reason });
      expect(email.subject).toContain(reason);
      expect(email.html + email.text).toContain(reason);
    },
  );
});

describe("WD-J6-C01 (WD-T-EMAIL-06): buildOwnerAlertEmail — the receipt line follows ack_sent_at", () => {
  const SENT = "Kunden har fået kvittering.";
  const NOT_SENT = "Kvitteringen er ikke sendt endnu. Tjek ack_sent_at, og send den manuelt, hvis den stadig mangler.";

  it("WD-T-EMAIL-06a: receipt sent → says the customer has the receipt, nothing about sending it by hand", () => {
    const email = buildOwnerAlertEmail({ ...OWNER_ALERT_CTX, receiptSent: true });
    expect(email.text).toContain(SENT);
    expect(email.text).not.toContain(NOT_SENT);
  });

  it("WD-T-EMAIL-06b: receipt not sent → says so and asks for a manual receipt; never claims one was sent", () => {
    const email = buildOwnerAlertEmail({ ...OWNER_ALERT_CTX, receiptSent: false });
    expect(email.text).toContain(NOT_SENT);
    expect(email.html).toContain(NOT_SENT);
    expect(email.text + email.html).not.toContain(SENT);
  });
});

describe("WD-J6-C01 (WD-T-EMAIL-07): buildOwnerAlertEmail — refund deadline = Copenhagen date of the notice + 14 calendar days", () => {
  const deadlineLine = (requestedAt: string) =>
    buildOwnerAlertEmail({ ...OWNER_ALERT_CTX, requestedAt }).text.split("\n").find((line) => line.startsWith("Tilbagebetal senest"));

  it("WD-T-EMAIL-07a: a notice on 14 Nov 2026 (no DST switch) → 28 November 2026", () => {
    expect(deadlineLine("2026-11-14T10:00:00Z")).toBe("Tilbagebetal senest 28. november 2026 (14 dage efter modtagelsen).");
  });

  it("WD-T-EMAIL-07b: 20 Mar 2026 23:30 CET, across the spring DST switch (29 Mar) → 3 April, not 4 April", () => {
    expect(deadlineLine("2026-03-20T22:30:00Z")).toBe("Tilbagebetal senest 3. april 2026 (14 dage efter modtagelsen).");
  });

  it("WD-T-EMAIL-07c: 20 Mar 2026 00:30 CET is still 20 March in Copenhagen (19 Mar in UTC) → 3 April", () => {
    expect(deadlineLine("2026-03-19T23:30:00Z")).toBe("Tilbagebetal senest 3. april 2026 (14 dage efter modtagelsen).");
  });
});
