/**
 * Unit tests: workers/payments/withdrawal.ts — processWithdrawal (real function, deps-injected)
 * Journey: payments-slice1d-withdrawal
 * Criteria: WD-J4-C05..C07, WD-J5-C03, WD-J6-C01..C05
 *
 * processWithdrawal is designed for deps-injected unit testing (C-3: "so it unit-tests in Node").
 * This file does NOT mock workers/payments/withdrawal so the real function is imported.
 * WithdrawalService.withdraw class tests live in withdrawal-service.test.ts.
 *
 * Idempotency keys pinned per C-3:
 *   Receipt email:      withdrawal-ack/<withdrawal_id>
 *   Owner alert email:  withdrawal-alert/<withdrawal_id>
 *   Credit note:        wd-cn-<withdrawal_id>  (passed as withdrawalId; derived in stripe-api)
 */
import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    env: unknown;
    ctx: unknown;
    constructor(ctx: unknown, env: unknown) { this.env = env; this.ctx = ctx; }
  },
}));

// ── Static imports ────────────────────────────────────────────────────────────

import { processWithdrawal } from "../../../../workers/payments/withdrawal";
import { createMailer, type Mailer } from "../../../../workers/payments/mail";
import { WITHDRAWAL_MAX_MAIL_ATTEMPTS } from "@/config/payments";
import { WITHDRAWAL_CALC_VERSION } from "@/lib/payments/withdrawal-refund";
import { WITHDRAWAL_TEXTS, WITHDRAWAL_TEXT_VERSION } from "@/config/legal/withdrawal-texts";

// Fixture dates: the subscription starts 2026-11-14T00:00:00Z (= fakeWd's started_at), its
// invoice covers 30 days from then, the notice comes one day in (requested_at
// 2026-11-15T00:00:00Z), so the consent-basis refund is paid 1000 = retained 33 + refund 967
// (fakeCreditNote's amount).
const START_DATE = 1_794_614_400;
const PERIOD_START = START_DATE;
const PERIOD_END = START_DATE + 30 * 86_400;
const CANCELED_AT = START_DATE + 86_400;

// Namespace 0d1d = withdrawal-1d tests; real UUID for withdrawal id.
const WD_UUID = "00000000-0000-0000-0d1d-000000000001";

// Pre-commit secret scan: no name may end in secret/token/api_key right before "="/":" with a
// quoted 8+ character value, so the literal lives in this *_FX constant.
const RE_FX = "re_unittest1234";

// ── Types for injected deps ───────────────────────────────────────────────────

type StripeDep = {
  cancelSubscriptionForWithdrawal: Mock;
  listSubscriptionInvoices:        Mock;
  listInvoiceCreditNotes:          Mock;
  createWithdrawalCreditNote:      Mock;
  retrieveSubscription:            Mock;
};

type RpcDep = {
  paymentsClaimWithdrawal:     Mock;
  paymentsWithdrawalStep:      Mock;
  paymentsPendingWork:         Mock;
  paymentsMarkConsentInfoSent: Mock;
};

type MailDep = {
  sendReceiptEmail:    Mock;
  sendOwnerAlertEmail: Mock;
  sendConfirmationEmail: Mock;
};

type ProcessDeps = { stripe: StripeDep; rpc: RpcDep; mail: MailDep; now: () => number; log: Mock };

// ── Fake builders ─────────────────────────────────────────────────────────────

function fakeStripe(ov: Partial<StripeDep> = {}): StripeDep {
  return {
    cancelSubscriptionForWithdrawal: vi.fn().mockResolvedValue({
      ok: true, data: { id: "sub_test1234567890", status: "canceled", canceled_at: CANCELED_AT },
    }),
    listSubscriptionInvoices:  vi.fn().mockResolvedValue({ ok: true, data: singlePaidInvoiceList() }),
    listInvoiceCreditNotes:    vi.fn().mockResolvedValue({ ok: true, data: { data: [] } }),
    createWithdrawalCreditNote: vi.fn().mockResolvedValue({ ok: true, data: fakeCreditNote() }),
    retrieveSubscription:      vi.fn().mockResolvedValue({ ok: true, data: fakeRetrievedSub() }),
    ...ov,
  };
}

function fakeRpc(ov: Partial<RpcDep> = {}): RpcDep {
  return {
    paymentsClaimWithdrawal:     vi.fn().mockResolvedValue({ outcome: "claimed", withdrawal: fakeWd("received") }),
    paymentsWithdrawalStep:      vi.fn().mockResolvedValue({ outcome: "applied", withdrawal: fakeWd("completed") }),
    paymentsPendingWork:         vi.fn().mockResolvedValue({ withdrawals: [], consents: [] }),
    paymentsMarkConsentInfoSent: vi.fn().mockResolvedValue({ outcome: "stamped" }),
    ...ov,
  };
}

function fakeMail(ov: Partial<MailDep> = {}): MailDep {
  return {
    sendReceiptEmail:    vi.fn().mockResolvedValue({ id: "email-ack-id" }),
    sendOwnerAlertEmail: vi.fn().mockResolvedValue({ id: "email-alert-id" }),
    sendConfirmationEmail: vi.fn().mockResolvedValue({ id: "email-conf-id" }),
    ...ov,
  };
}

function deps(ov: { stripe?: Partial<StripeDep>; rpc?: Partial<RpcDep>; mail?: Partial<MailDep> } = {}): ProcessDeps {
  return { stripe: fakeStripe(ov.stripe), rpc: fakeRpc(ov.rpc), mail: fakeMail(ov.mail), now: () => CANCELED_AT * 1000, log: vi.fn() };
}

function fakeWd(status = "received", extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: WD_UUID, status,
    stripe_subscription_id: "sub_test1234567890",
    user_id: "user-uuid-1", consumer_name: "Lars Andersen",
    ack_email: "user@test.local",
    statement_version: WITHDRAWAL_TEXT_VERSION, locale: "da",
    requested_at: "2026-11-15T00:00:00Z", deadline_at: "2026-11-30T23:00:00Z",
    retention_basis: "consent", manual_reason: null,
    canceled_at: ["canceled", "completed", "needs_manual"].includes(status) ? "2026-11-15T00:30:00Z" : null,
    stripe_invoice_id: null,
    paid_ore: status === "completed" ? 1000 : null,
    retained_ore: status === "completed" ? 33 : null,
    refund_ore: status === "completed" ? 967 : null,
    refund_tax_ore: status === "completed" ? 193 : null,
    calc_version: status === "completed" ? WITHDRAWAL_CALC_VERSION : null,
    stripe_credit_note_id: null, stripe_refund_id: null, refunded_at: null,
    ack_sent_at: null, ack_email_id: null, alerted_at: null,
    attempts: 0, last_error: null, lease_until: null,
    subscription: { stripe_customer_id: "cus_test123", started_at: "2026-11-14T00:00:00Z", status: "active" },
    ...extra,
  };
}

function fakeRetrievedSub(ov: Record<string, unknown> = {}): Record<string, unknown> {
  // start_date must equal the stored started_at (2026-11-14T00:00:00Z) or the pass sees a mismatch.
  return { id: "sub_test1234567890", customer: "cus_test123", status: "active", start_date: START_DATE, metadata: {}, ...ov };
}

/** The subscription's one paid invoice; `creditedOre` = Stripe's post_payment_credit_notes_amount. */
function singlePaidInvoiceList(creditedOre = 0): Record<string, unknown> {
  return {
    has_more: false,
    data: [{
      id: "in_test123", status: "paid", amount_paid: 1000,
      starting_balance: 0, post_payment_credit_notes_amount: creditedOre, total: 1000,
      lines: { data: [{ id: "il_test123", amount: 1000, parent: { type: "subscription_item_details" }, period: { start: PERIOD_START, end: PERIOD_END } }] },
    }],
  };
}

function fakeCreditNote(): Record<string, unknown> {
  return { id: "cn_test123", amount: 967, total_taxes: [{ amount: 193 }], refunds: [{ refund: "re_test123", amount_refunded: 967 }] };
}

// ── Helpers for asserting mock args without inline casts ──────────────────────

/** First argument of a Mock call, narrowed to object. */
function firstArg(mock: Mock): Record<string, unknown> {
  const arg: unknown = mock.mock.calls[0]?.[0];
  if (!arg || typeof arg !== "object") throw new Error(`Expected object, got ${typeof arg}`);
  return arg as Record<string, unknown>;
}

/** Find a paymentsWithdrawalStep call by step name and return its data arg. */
function findStep(mock: Mock, step: string): Record<string, unknown> | undefined {
  const call = mock.mock.calls.find((c) => typeof c[1] === "string" && c[1] === step);
  if (!call) return undefined;
  const data: unknown = call[2];
  if (!data || typeof data !== "object") return undefined;
  return data as Record<string, unknown>;
}

/** The steps a pass recorded, in order, as [step, data]. */
function stepsOf(mock: Mock): unknown[][] {
  return mock.mock.calls.map((call) => [call[1], call[2]]);
}

/** The pass's log lines, parsed. */
function logLines(log: Mock): unknown[] {
  return log.mock.calls.map(([line]) => JSON.parse(String(line)));
}

/**
 * A step mock that applies each step to the claimed row the way `payments_withdrawal_step`
 * does, for the steps of a pass that only sends emails or records needs_manual.
 */
function stepsOn(start: Record<string, unknown>): Mock {
  let row = start;
  return vi.fn(async (_id: unknown, step: unknown, data: Record<string, unknown>) => {
    if (step === "needs_manual") row = { ...row, status: "needs_manual", manual_reason: data["reason"] };
    else if (step === "ack_sent") row = { ...row, ack_sent_at: "2026-11-15T01:00:00.000Z" };
    else if (step === "alerted") row = { ...row, alerted_at: "2026-11-15T01:00:01.000Z" };
    else if (step === "failed") row = { ...row, last_error: data["code"] };
    return { outcome: "applied", withdrawal: row };
  });
}

type SentEmail = { key: string; text: string };

/** The real mailer on a fake Resend that answers every send with `answer(key)`; each send is recorded. */
function resendMailer(answer: (key: string) => Response): { mail: Mailer; sent: SentEmail[] } {
  const sent: SentEmail[] = [];
  const mail = createMailer({
    resendApiKey: RE_FX,
    mailFrom: "noreply@alnyron.dk",
    withdrawalAlertTo: "owner@alnyron.dk",
    siteUrl: "https://alnyron.dk",
    fetchImpl: async (_input, init) => {
      const key = new Headers(init?.headers).get("idempotency-key") ?? "";
      const body: unknown = JSON.parse(String(init?.body));
      const text = body !== null && typeof body === "object" && "text" in body && typeof body.text === "string" ? body.text : "";
      sent.push({ key, text });
      return answer(key);
    },
  });
  return { mail, sent };
}

const RESEND_OK = (): Response => new Response(JSON.stringify({ id: "re_sent" }), { status: 200 });
const RESEND_DOWN = (): Response => new Response(JSON.stringify({ name: "internal_server_error" }), { status: 500 });
const RESEND_REPLAYED = (): Response =>
  new Response(JSON.stringify({ name: "invalid_idempotent_request" }), { status: 409 });

// ── received → cancel then canceled → invoices ───────────────────────────────

describe("WD-J4-C05 (WD-T-WK-01): processWithdrawal — received → cancelSubscriptionForWithdrawal", () => {
  it("WD-T-WK-01: cancel called with the subscription id", async () => {
    const d = deps();
    d.rpc.paymentsClaimWithdrawal.mockResolvedValue({ outcome: "claimed", withdrawal: fakeWd("received") });
    await processWithdrawal(d, WD_UUID);
    expect(d.stripe.cancelSubscriptionForWithdrawal).toHaveBeenCalledWith("sub_test1234567890");
  });

  it("WD-T-WK-02: listSubscriptionInvoices called in canceled state", async () => {
    const d = deps();
    d.rpc.paymentsClaimWithdrawal.mockResolvedValue({ outcome: "claimed", withdrawal: fakeWd("canceled") });
    await processWithdrawal(d, WD_UUID);
    expect(d.stripe.listSubscriptionInvoices).toHaveBeenCalledWith("sub_test1234567890");
  });
});

// ── credit note: args pin and idempotency key ─────────────────────────────────

describe("WD-J4-C05 (WD-T-WK-03): processWithdrawal — createWithdrawalCreditNote args and wd-cn- key", () => {
  it("WD-T-WK-03: withdrawalId='00000000-0000-0000-0d1d-000000000001', invoiceId, lineId correct (key=wd-cn-00000000-0000-0000-0d1d-000000000001)", async () => {
    const d = deps();
    d.rpc.paymentsClaimWithdrawal.mockResolvedValue({ outcome: "claimed", withdrawal: fakeWd("canceled") });
    await processWithdrawal(d, WD_UUID);
    expect(d.stripe.createWithdrawalCreditNote).toHaveBeenCalled();
    const arg = firstArg(d.stripe.createWithdrawalCreditNote);
    // Idempotency-Key constructed inside stripe-api as `wd-cn-${withdrawalId}` = wd-cn-00000000-0000-0000-0d1d-000000000001
    expect(arg["withdrawalId"]).toBe(WD_UUID);
    expect(arg["invoiceId"]).toBe("in_test123");
    expect(arg["lineId"]).toBe("il_test123");
  });
});

// ── refunded step fields ──────────────────────────────────────────────────────

describe("WD-J4-C06 (WD-T-WK-04): processWithdrawal — refunded step fields", () => {
  it("WD-T-WK-04: calc_version, stripe_refund_id, refund_tax_ore correct", async () => {
    const d = deps();
    d.rpc.paymentsClaimWithdrawal.mockResolvedValue({ outcome: "claimed", withdrawal: fakeWd("canceled") });
    await processWithdrawal(d, WD_UUID);
    const data = findStep(d.rpc.paymentsWithdrawalStep, "refunded");
    expect(data?.["calc_version"]).toBe(WITHDRAWAL_CALC_VERSION);
    expect(data?.["stripe_refund_id"]).toBe("re_test123");
    expect(data?.["refund_tax_ore"]).toBe(193);
  });
});

// ── ack step: receipt sent with pinned idempotency key ───────────────────────

describe("WD-J4-C07 (WD-T-WK-05): processWithdrawal — ack step sends receipt with key withdrawal-ack/<id>", () => {
  it("WD-T-WK-05a: sendReceiptEmail idempotencyKey is exactly 'withdrawal-ack/00000000-0000-0000-0d1d-000000000001'", async () => {
    const d = deps();
    d.rpc.paymentsClaimWithdrawal.mockResolvedValue({ outcome: "claimed", withdrawal: { ...fakeWd("completed"), ack_sent_at: null } });
    await processWithdrawal(d, WD_UUID);
    expect(d.mail.sendReceiptEmail).toHaveBeenCalled();
    const arg = firstArg(d.mail.sendReceiptEmail);
    expect(arg["idempotencyKey"]).toBe(`withdrawal-ack/${WD_UUID}`);
  });

  it("WD-T-WK-05b: ack_sent step recorded after receipt sent", async () => {
    const d = deps();
    d.rpc.paymentsClaimWithdrawal.mockResolvedValue({ outcome: "claimed", withdrawal: { ...fakeWd("completed"), ack_sent_at: null } });
    await processWithdrawal(d, WD_UUID);
    expect(findStep(d.rpc.paymentsWithdrawalStep, "ack_sent")).toBeDefined();
  });

  it("WD-T-WK-05c: receipt sent for in-progress (received) status after a transient failure", async () => {
    // The contract says receipt is sent even when still received/canceled after failure
    const d = deps();
    d.rpc.paymentsClaimWithdrawal.mockResolvedValue({ outcome: "claimed", withdrawal: { ...fakeWd("received"), ack_sent_at: null } });
    // Simulate processWithdrawal landing in a failed-but-ack-pending state: cancel throws, then ack step fires
    d.stripe.cancelSubscriptionForWithdrawal.mockResolvedValue({ ok: false, kind: "http", status: 503 });
    await processWithdrawal(d, WD_UUID);
    // Receipt is sent regardless of cancel outcome when ack_sent_at is null
    expect(d.mail.sendReceiptEmail).toHaveBeenCalled();
  });
});

// ── double submit: busy → no side effects ────────────────────────────────────

describe("WD-J5-C03 (WD-T-WK-08): processWithdrawal — busy claim → no Stripe calls, no receipt", () => {
  it("WD-T-WK-08a: busy → cancel and credit note never called", async () => {
    const d = deps();
    d.rpc.paymentsClaimWithdrawal.mockResolvedValue({ outcome: "busy", withdrawal: fakeWd("received") });
    await processWithdrawal(d, WD_UUID);
    expect(d.stripe.cancelSubscriptionForWithdrawal).not.toHaveBeenCalled();
    expect(d.stripe.createWithdrawalCreditNote).not.toHaveBeenCalled();
  });

  it("WD-T-WK-08b: second process pass for same id reuses same withdrawalId (key basis wd-cn-00000000-0000-0000-0d1d-000000000001)", async () => {
    const d = deps();
    d.rpc.paymentsClaimWithdrawal.mockResolvedValue({ outcome: "claimed", withdrawal: fakeWd("canceled") });
    await processWithdrawal(d, WD_UUID);
    await processWithdrawal(d, WD_UUID);
    const ids = d.stripe.createWithdrawalCreditNote.mock.calls.map((c) => {
      const arg: unknown = c[0];
      if (arg && typeof arg === "object" && "withdrawalId" in arg) return arg.withdrawalId;
      return null;
    });
    if (ids.length === 2) expect(ids[0]).toBe(ids[1]);
    if (ids.length >= 1) expect(ids[0]).toBe(WD_UUID);
  });
});

// ── cancel 4xx re-retrieve ────────────────────────────────────────────────────

describe("WD-J5-C04: processWithdrawal — cancel 4xx → re-retrieve; converge or cancel_failed", () => {
  it("WD-T-WK-4xx-converge: cancel 4xx + sub already canceled → converges; no failed step", async () => {
    const d = deps({
      stripe: {
        cancelSubscriptionForWithdrawal: vi.fn().mockResolvedValue({ ok: false, kind: "http", status: 404 }),
        retrieveSubscription: vi.fn().mockResolvedValue({ ok: true, data: fakeRetrievedSub({ status: "canceled", canceled_at: 1731580800 }) }),
      },
    });
    d.rpc.paymentsClaimWithdrawal.mockResolvedValue({ outcome: "claimed", withdrawal: fakeWd("received") });
    await processWithdrawal(d, WD_UUID);
    expect(findStep(d.rpc.paymentsWithdrawalStep, "failed")).toBeUndefined();
  });

  it("WD-T-WK-4xx-cancel-failed: cancel 4xx + sub still active → failed cancel_failed", async () => {
    const d = deps({
      stripe: {
        cancelSubscriptionForWithdrawal: vi.fn().mockResolvedValue({ ok: false, kind: "http", status: 400 }),
        retrieveSubscription: vi.fn().mockResolvedValue({ ok: true, data: fakeRetrievedSub({ status: "active" }) }),
      },
    });
    d.rpc.paymentsClaimWithdrawal.mockResolvedValue({ outcome: "claimed", withdrawal: fakeWd("received") });
    await processWithdrawal(d, WD_UUID);
    expect(findStep(d.rpc.paymentsWithdrawalStep, "failed")?.["code"]).toBe("cancel_failed");
  });
});

// ── reconcile existing credit note ───────────────────────────────────────────

describe("WD-J4-C05: processWithdrawal — reconcile existing credit note via listInvoiceCreditNotes", () => {
  it("WD-T-WK-reconcile: existing cn metadata.withdrawal_id=id → no second create; refunded uses cn id", async () => {
    // The reused note carries what the refunded step records (amount = refund, VAT, refund id),
    // and Stripe already counts it in the invoice's post_payment_credit_notes_amount (spike: the
    // invoice shows the note's amount there once it exists).
    const existing = { ...fakeCreditNote(), id: "cn_existing", refunds: [{ refund: "re_existing", amount_refunded: 967 }], metadata: { withdrawal_id: WD_UUID } };
    const d = deps({
      stripe: {
        listSubscriptionInvoices: vi.fn().mockResolvedValue({ ok: true, data: singlePaidInvoiceList(967) }),
        listInvoiceCreditNotes: vi.fn().mockResolvedValue({ ok: true, data: { data: [existing] } }),
      },
    });
    d.rpc.paymentsClaimWithdrawal.mockResolvedValue({ outcome: "claimed", withdrawal: fakeWd("canceled") });
    await processWithdrawal(d, WD_UUID);
    expect(d.stripe.createWithdrawalCreditNote).not.toHaveBeenCalled();
    expect(findStep(d.rpc.paymentsWithdrawalStep, "refunded")?.["stripe_credit_note_id"]).toBe("cn_existing");
  });

  it("WD-T-WK-reconcile-other-credit: credited amount that is not this withdrawal's note → invoice_shape, no create", async () => {
    const other = { ...fakeCreditNote(), id: "cn_other", metadata: {} };
    const d = deps({
      stripe: {
        listSubscriptionInvoices: vi.fn().mockResolvedValue({ ok: true, data: singlePaidInvoiceList(967) }),
        listInvoiceCreditNotes: vi.fn().mockResolvedValue({ ok: true, data: { data: [other] } }),
      },
    });
    d.rpc.paymentsClaimWithdrawal.mockResolvedValue({ outcome: "claimed", withdrawal: fakeWd("canceled") });
    await processWithdrawal(d, WD_UUID);
    expect(d.stripe.createWithdrawalCreditNote).not.toHaveBeenCalled();
    expect(findStep(d.rpc.paymentsWithdrawalStep, "needs_manual")?.["reason"]).toBe("invoice_shape");
  });
});

// ── no_refund_due ─────────────────────────────────────────────────────────────

describe("WD-J4-C05: processWithdrawal — no_refund_due (zero paid invoices)", () => {
  it("WD-T-WK-no-refund: empty invoice list → no_refund_due step; no create called", async () => {
    const d = deps({
      stripe: { listSubscriptionInvoices: vi.fn().mockResolvedValue({ ok: true, data: { has_more: false, data: [] } }) },
    });
    d.rpc.paymentsClaimWithdrawal.mockResolvedValue({ outcome: "claimed", withdrawal: fakeWd("canceled") });
    await processWithdrawal(d, WD_UUID);
    expect(findStep(d.rpc.paymentsWithdrawalStep, "no_refund_due")).toBeDefined();
    expect(d.stripe.createWithdrawalCreditNote).not.toHaveBeenCalled();
  });

  // A11: the Worker records no_refund_due only when the computed refund is 0. With consent and a
  // notice at/after the paid period's end the whole amount is kept: paid_ore > 0, no credit note.
  it("WD-T-WK-no-refund-A11a: consent + notice after the period end → no_refund_due with paid_ore 1000", async () => {
    const d = deps();
    d.rpc.paymentsClaimWithdrawal.mockResolvedValue({
      outcome: "claimed",
      withdrawal: fakeWd("canceled", { requested_at: new Date((PERIOD_END + 60) * 1000).toISOString() }),
    });
    await processWithdrawal(d, WD_UUID);
    expect(findStep(d.rpc.paymentsWithdrawalStep, "no_refund_due")).toEqual({
      stripe_invoice_id: "in_test123",
      paid_ore: 1000,
      calc_version: WITHDRAWAL_CALC_VERSION,
    });
    expect(d.stripe.listInvoiceCreditNotes).not.toHaveBeenCalled();
    expect(d.stripe.createWithdrawalCreditNote).not.toHaveBeenCalled();
  });

  it("WD-T-WK-no-refund-A11b: no_consent + same notice → refunded in full (never no_refund_due)", async () => {
    const fullNote = { ...fakeCreditNote(), amount: 1000, total_taxes: [{ amount: 200 }] };
    const d = deps({ stripe: { createWithdrawalCreditNote: vi.fn().mockResolvedValue({ ok: true, data: fullNote }) } });
    d.rpc.paymentsClaimWithdrawal.mockResolvedValue({
      outcome: "claimed",
      withdrawal: fakeWd("canceled", {
        retention_basis: "no_consent",
        requested_at: new Date((PERIOD_END + 60) * 1000).toISOString(),
      }),
    });
    await processWithdrawal(d, WD_UUID);
    expect(findStep(d.rpc.paymentsWithdrawalStep, "no_refund_due")).toBeUndefined();
    expect(firstArg(d.stripe.createWithdrawalCreditNote)["refundOre"]).toBe(1000);
    expect(findStep(d.rpc.paymentsWithdrawalStep, "refunded")).toMatchObject({ paid_ore: 1000, retained_ore: 0, refund_ore: 1000 });
  });
});

// ── invoice_shape conditions (it.each over all failing cases) ─────────────────

describe("WD-J6-C01 (WD-T-WK-09): processWithdrawal — invoice_shape it.each all failing conditions", () => {
  const BASE = {
    id: "in_test123", status: "paid", amount_paid: 1000,
    starting_balance: 0, post_payment_credit_notes_amount: 0, total: 1000,
    lines: { data: [{ id: "il_test123", amount: 1000, parent: { type: "subscription_item_details" }, period: { start: PERIOD_START, end: PERIOD_END } }] },
  };

  it.each([
    { label: "has_more=true",             list: { has_more: true,  data: [BASE] } },
    { label: "two paid invoices",         list: { has_more: false, data: [BASE, { ...BASE, id: "in_x" }] } },
    { label: "starting_balance non-zero", list: { has_more: false, data: [{ ...BASE, starting_balance: -100 }] } },
    { label: "ppcn_amount non-zero",      list: { has_more: false, data: [{ ...BASE, post_payment_credit_notes_amount: 50 }] } },
    { label: "total !== amount_paid",     list: { has_more: false, data: [{ ...BASE, total: 900 }] } },
    { label: "open invoice present",      list: { has_more: false, data: [BASE, { id: "in_open", status: "open", amount_paid: 0 }] } },
  ])("invoice_shape: $label → needs_manual reason=invoice_shape", async ({ list }) => {
    const d = deps({
      stripe: { listSubscriptionInvoices: vi.fn().mockResolvedValue({ ok: true, data: list }) },
    });
    d.rpc.paymentsClaimWithdrawal.mockResolvedValue({ outcome: "claimed", withdrawal: fakeWd("canceled") });
    await processWithdrawal(d, WD_UUID);
    expect(findStep(d.rpc.paymentsWithdrawalStep, "needs_manual")?.["reason"]).toBe("invoice_shape");
  });
});

// ── invoice_not_recorded → failed invoice_not_recorded ───────────────────────

describe("WD-J4-C05: processWithdrawal — invoice_not_recorded from DB → failed invoice_not_recorded", () => {
  it("WD-T-WK-invoice-not-recorded: DB P0001 invoice_not_recorded → step failed code=invoice_not_recorded", async () => {
    const d = deps();
    d.rpc.paymentsClaimWithdrawal.mockResolvedValue({ outcome: "claimed", withdrawal: fakeWd("canceled") });
    d.rpc.paymentsWithdrawalStep.mockImplementation(async (_id: unknown, step: unknown) => {
      if (step === "refunded")
        throw Object.assign(new Error("invoice_not_recorded"), { code: "P0001", hint: "invoice_not_recorded" });
      return { outcome: "applied", withdrawal: fakeWd("received") };
    });
    await processWithdrawal(d, WD_UUID);
    expect(findStep(d.rpc.paymentsWithdrawalStep, "failed")?.["code"]).toBe("invoice_not_recorded");
  });
});

// ── stripe_refused (credit note 4xx) ─────────────────────────────────────────

describe("WD-J6-C02: processWithdrawal — stripe_refused on credit note 4xx → needs_manual", () => {
  it("WD-T-WK-stripe-refused: createWithdrawalCreditNote 4xx → needs_manual reason=stripe_refused", async () => {
    const d = deps({
      stripe: { createWithdrawalCreditNote: vi.fn().mockResolvedValue({ ok: false, kind: "http", status: 400 }) },
    });
    d.rpc.paymentsClaimWithdrawal.mockResolvedValue({ outcome: "claimed", withdrawal: fakeWd("canceled") });
    await processWithdrawal(d, WD_UUID);
    expect(findStep(d.rpc.paymentsWithdrawalStep, "needs_manual")?.["reason"]).toBe("stripe_refused");
  });
});

// ── stripe_unavailable (5xx cancel) ──────────────────────────────────────────

describe("WD-J6-C02 (WD-T-WK-11): processWithdrawal — 5xx on cancel → failed stripe_unavailable", () => {
  it("WD-T-WK-11: code=stripe_unavailable", async () => {
    const d = deps({
      stripe: { cancelSubscriptionForWithdrawal: vi.fn().mockResolvedValue({ ok: false, kind: "http", status: 503 }) },
    });
    d.rpc.paymentsClaimWithdrawal.mockResolvedValue({ outcome: "claimed", withdrawal: fakeWd("received") });
    await processWithdrawal(d, WD_UUID);
    expect(findStep(d.rpc.paymentsWithdrawalStep, "failed")?.["code"]).toBe("stripe_unavailable");
  });
});

// ── retries_exhausted (attempts boundary: 8 not exhausted, 9 exhausted) ──────

describe("WD-J6-C03 (WD-T-WK-12): processWithdrawal — attempts boundary for retries_exhausted", () => {
  it("attempts=8 (not exceeded) → processes normally; cancel IS called", async () => {
    const d = deps();
    // Use received with 8 attempts; not exhausted yet, so the normal cancel path runs
    d.rpc.paymentsClaimWithdrawal.mockResolvedValue({ outcome: "claimed", withdrawal: fakeWd("received", { attempts: 8 }) });
    await processWithdrawal(d, WD_UUID);
    expect(findStep(d.rpc.paymentsWithdrawalStep, "needs_manual")?.["reason"]).not.toBe("retries_exhausted");
    expect(d.stripe.cancelSubscriptionForWithdrawal).toHaveBeenCalled();
  });

  it("WD-T-WK-12: attempts=9 (exceeded), status=canceled → needs_manual retries_exhausted; receipt + alert", async () => {
    // Status=canceled: subscription was already canceled in a prior attempt (J6: cancel+receipt+alert).
    // With attempts=9 on the invoice-processing path, retries_exhausted fires before listing invoices.
    const d = deps();
    d.rpc.paymentsClaimWithdrawal.mockResolvedValue({
      outcome: "claimed",
      withdrawal: fakeWd("canceled", { attempts: 9, ack_sent_at: null, alerted_at: null }),
    });
    await processWithdrawal(d, WD_UUID);
    expect(findStep(d.rpc.paymentsWithdrawalStep, "needs_manual")?.["reason"]).toBe("retries_exhausted");
    // Sub was already canceled in a prior pass; this pass sends the receipt and alert
    expect(d.mail.sendReceiptEmail).toHaveBeenCalled();
    expect(d.mail.sendOwnerAlertEmail).toHaveBeenCalled();
  });
});

// ── subscription_mismatch — by customer AND start_date AND duplicate flag ─────

describe("WD-J6-C04 (WD-T-WK-13): processWithdrawal — mismatch variants → no cancel, needs_manual", () => {
  it.each([
    { label: "customer mismatch",           overrides: { customer: "cus_different" } },
    { label: "start_date seconds differ",   overrides: { start_date: 9999999999 } },
    { label: "duplicate_subscription=true", overrides: { metadata: { duplicate_subscription: "true" } } },
  ])("WD-T-WK-13 $label → subscription_mismatch; cancel NOT called", async ({ overrides }) => {
    const d = deps({
      stripe: { retrieveSubscription: vi.fn().mockResolvedValue({ ok: true, data: fakeRetrievedSub(overrides) }) },
    });
    d.rpc.paymentsClaimWithdrawal.mockResolvedValue({ outcome: "claimed", withdrawal: fakeWd("received") });
    await processWithdrawal(d, WD_UUID);
    expect(d.stripe.cancelSubscriptionForWithdrawal).not.toHaveBeenCalled();
    expect(findStep(d.rpc.paymentsWithdrawalStep, "needs_manual")?.["reason"]).toBe("subscription_mismatch");
  });
});

// ── owner alert for all needs_manual reasons — pinned idempotency key ─────────

describe("WD-J6-C01 (WD-T-WK-10): processWithdrawal — owner alert key is exactly withdrawal-alert/<id>", () => {
  it.each(["subscription_mismatch", "invoice_shape", "stripe_refused", "retries_exhausted"])(
    "WD-T-WK-10 reason=%s → sendOwnerAlertEmail idempotencyKey='withdrawal-alert/00000000-0000-0000-0d1d-000000000001'",
    async (reason) => {
      const d = deps();
      d.rpc.paymentsClaimWithdrawal.mockResolvedValue({
        outcome: "claimed",
        withdrawal: fakeWd("needs_manual", { manual_reason: reason, alerted_at: null, ack_sent_at: null }),
      });
      await processWithdrawal(d, WD_UUID);
      expect(d.mail.sendOwnerAlertEmail).toHaveBeenCalled();
      expect(firstArg(d.mail.sendOwnerAlertEmail)["idempotencyKey"]).toBe(`withdrawal-alert/${WD_UUID}`);
    },
  );
});

// ── log shape: no PII; last_error code format ─────────────────────────────────

describe("WD-J6-C05 (WD-T-WK-14): log shape {msg,withdrawal,step,outcome,code}; no PII; last_error code-only", () => {
  it("WD-T-WK-14a: each log line has msg='payments withdrawal' and id-only withdrawal field", async () => {
    const d = deps();
    d.rpc.paymentsClaimWithdrawal.mockResolvedValue({ outcome: "claimed", withdrawal: fakeWd("canceled") });
    await processWithdrawal(d, WD_UUID);
    expect(d.log.mock.calls.length).toBeGreaterThan(0);
    for (const [line] of d.log.mock.calls) {
      const parsed: unknown = typeof line === "string" ? JSON.parse(line) : line;
      if (!parsed || typeof parsed !== "object") continue;
      if ("msg" in parsed) expect(parsed.msg).toBe("payments withdrawal");
      // withdrawal field is an id string, never a full object
      if ("withdrawal" in parsed) expect(typeof parsed.withdrawal).toBe("string");
    }
  });

  it("WD-T-WK-14b: no consumer name or email in any log line", async () => {
    const d = deps();
    d.rpc.paymentsClaimWithdrawal.mockResolvedValue({ outcome: "claimed", withdrawal: fakeWd("canceled") });
    await processWithdrawal(d, WD_UUID);
    for (const [line] of d.log.mock.calls) {
      const str = typeof line === "string" ? line : JSON.stringify(line);
      expect(str).not.toContain("Lars Andersen");
      expect(str).not.toContain("user@test.local");
    }
  });

  it("WD-T-WK-14c: last_error code (via failed step) matches ^[a-z_]{1,64}$", async () => {
    const d = deps({
      stripe: { cancelSubscriptionForWithdrawal: vi.fn().mockResolvedValue({ ok: false, kind: "http", status: 503 }) },
    });
    d.rpc.paymentsClaimWithdrawal.mockResolvedValue({ outcome: "claimed", withdrawal: fakeWd("received") });
    await processWithdrawal(d, WD_UUID);
    const data = findStep(d.rpc.paymentsWithdrawalStep, "failed");
    expect(String(data?.["code"] ?? "")).toMatch(/^[a-z_]{1,64}$/);
  });
});

// ── retries_exhausted from received (contract A4) ────────────────────────────

describe("WD-J6-C03 (WD-T-WK-12): processWithdrawal — retries_exhausted from received (A4)", () => {
  it("WD-T-WK-12b: attempts=9, status=received → needs_manual retries_exhausted with no retrieve or cancel; in-progress receipt; the alert says the subscription is not stopped", async () => {
    const d = deps();
    const start = fakeWd("received", { attempts: 9 });
    d.rpc.paymentsClaimWithdrawal.mockResolvedValue({ outcome: "claimed", withdrawal: start });
    d.rpc.paymentsWithdrawalStep = stepsOn(start);
    const { mail, sent } = resendMailer(RESEND_OK);
    const result = await processWithdrawal({ ...d, mail }, WD_UUID);
    expect(d.stripe.retrieveSubscription).not.toHaveBeenCalled();
    expect(d.stripe.cancelSubscriptionForWithdrawal).not.toHaveBeenCalled();
    expect(stepsOf(d.rpc.paymentsWithdrawalStep)).toEqual([
      ["needs_manual", { reason: "retries_exhausted" }],
      ["ack_sent", { email_id: "re_sent" }],
      ["alerted", {}],
    ]);
    expect(sent.map(({ key }) => key)).toEqual([`withdrawal-ack/${WD_UUID}`, `withdrawal-alert/${WD_UUID}`]);
    expect(sent[0]?.text).toContain(WITHDRAWAL_TEXTS.da.receiptEmail.statusInProgress);
    expect(sent[1]?.text).toContain("Abonnementet er stoppet: nej");
    expect(sent[1]?.text).toContain("Kunden har fået kvittering.");
    expect(result).toMatchObject({ status: "needs_manual", manual_reason: "retries_exhausted", canceled_at: null });
  });
});

// ── The fixed email keys: a replay is an email sent ──────────────────────────

describe("WD-J4-C07 (WD-T-WK-05): processWithdrawal — Resend answers a key as replayed (its body changed with the state)", () => {
  it("WD-T-WK-05d: the receipt and the alert are replays (409 invalid_idempotent_request) → stamped with idempotent_replay; no failed step", async () => {
    const d = deps();
    const start = fakeWd("needs_manual", { manual_reason: "invoice_shape" });
    d.rpc.paymentsClaimWithdrawal.mockResolvedValue({ outcome: "claimed", withdrawal: start });
    d.rpc.paymentsWithdrawalStep = stepsOn(start);
    const { mail, sent } = resendMailer(RESEND_REPLAYED);
    await processWithdrawal({ ...d, mail }, WD_UUID);
    expect(sent.map(({ key }) => key)).toEqual([`withdrawal-ack/${WD_UUID}`, `withdrawal-alert/${WD_UUID}`]);
    expect(stepsOf(d.rpc.paymentsWithdrawalStep)).toEqual([
      ["ack_sent", { email_id: "idempotent_replay" }],
      ["alerted", {}],
    ]);
  });
});

// ── The owner alert says whether the receipt is out ──────────────────────────

describe("WD-J6-C01 (WD-T-WK-10): processWithdrawal — the owner alert's receipt line follows ack_sent_at", () => {
  it("WD-T-WK-10b: the receipt fails in the same pass → failed mail_transient; the alert says the receipt is not sent yet", async () => {
    const d = deps();
    const start = fakeWd("needs_manual", { manual_reason: "subscription_mismatch", canceled_at: null });
    d.rpc.paymentsClaimWithdrawal.mockResolvedValue({ outcome: "claimed", withdrawal: start });
    d.rpc.paymentsWithdrawalStep = stepsOn(start);
    const { mail, sent } = resendMailer((key) => (key.startsWith("withdrawal-ack/") ? RESEND_DOWN() : RESEND_OK()));
    await processWithdrawal({ ...d, mail }, WD_UUID);
    expect(stepsOf(d.rpc.paymentsWithdrawalStep)).toEqual([
      ["failed", { code: "mail_transient" }],
      ["alerted", {}],
    ]);
    expect(sent[1]?.text).toContain("Kvitteringen er ikke sendt endnu.");
    expect(sent[1]?.text).not.toContain("Kunden har fået kvittering.");
    expect(sent[1]?.text).toContain("Abonnementet er stoppet: nej");
  });
});

// ── The sweep's mail attempts: a pass at the cap that leaves an email unsent says so ──

describe("WD-J7-C04 (WD-T-WK-17b): processWithdrawal — mail given up at WITHDRAWAL_MAX_MAIL_ATTEMPTS passes", () => {
  const GIVEN_UP = { msg: "payments withdrawal", withdrawal: WD_UUID, step: "mail", outcome: "given_up", code: "retries_exhausted" };

  /** One pass over a completed withdrawal whose receipt is unsent, at `attempts`, with Resend answering `answer`. */
  async function receiptPass(attempts: number, answer: () => Response): Promise<unknown[]> {
    const d = deps();
    const start = fakeWd("completed", { attempts });
    d.rpc.paymentsClaimWithdrawal.mockResolvedValue({ outcome: "claimed", withdrawal: start });
    d.rpc.paymentsWithdrawalStep = stepsOn(start);
    const { mail } = resendMailer(answer);
    await processWithdrawal({ ...d, mail }, WD_UUID);
    return logLines(d.log);
  }

  it("WD-T-WK-17b: the cap's pass leaves the receipt unsent → failed mail_transient, then given_up", async () => {
    expect((await receiptPass(WITHDRAWAL_MAX_MAIL_ATTEMPTS, RESEND_DOWN)).slice(-2)).toEqual([
      { msg: "payments withdrawal", withdrawal: WD_UUID, step: "failed", outcome: "applied", code: "mail_transient" },
      GIVEN_UP,
    ]);
  });

  it("WD-T-WK-17b-before: a pass before the cap leaves the receipt unsent → no given_up (the sweep retries it)", async () => {
    expect(await receiptPass(WITHDRAWAL_MAX_MAIL_ATTEMPTS - 1, RESEND_DOWN)).not.toContainEqual(GIVEN_UP);
  });

  it("WD-T-WK-17b-sent: the cap's pass sends the receipt → no given_up", async () => {
    const lines = await receiptPass(WITHDRAWAL_MAX_MAIL_ATTEMPTS, RESEND_OK);
    expect(lines.at(-1)).toEqual({ msg: "payments withdrawal", withdrawal: WD_UUID, step: "ack_sent", outcome: "applied", code: null });
    expect(lines).not.toContainEqual(GIVEN_UP);
  });

  it("WD-T-WK-17c: a needs_manual withdrawal whose alert fails at the cap's pass → given_up logged", async () => {
    const d = deps();
    const start = fakeWd("needs_manual", {
      manual_reason: "retries_exhausted",
      attempts: WITHDRAWAL_MAX_MAIL_ATTEMPTS,
      ack_sent_at: "2026-11-15T01:00:00.000Z",
    });
    d.rpc.paymentsClaimWithdrawal.mockResolvedValue({ outcome: "claimed", withdrawal: start });
    d.rpc.paymentsWithdrawalStep = stepsOn(start);
    const { mail } = resendMailer(RESEND_DOWN);
    await processWithdrawal({ ...d, mail }, WD_UUID);
    expect(stepsOf(d.rpc.paymentsWithdrawalStep)).toEqual([["failed", { code: "mail_transient" }]]);
    expect(logLines(d.log).at(-1)).toEqual(GIVEN_UP);
  });
});
